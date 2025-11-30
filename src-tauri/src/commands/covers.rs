use std::fs;
use std::path::Path;
use serde::{Serialize, Deserialize};
use anyhow::Result;
use crate::cover_art::{
    CoverSource, CoverCandidate, CoverSearchResult,
    search_all_cover_sources, download_and_validate_cover,
    get_image_dimensions_from_data,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct CoverResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CoverData {
    pub data: Vec<u8>,
    pub mime_type: String,
    pub size_kb: usize,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source: Option<String>,
}

#[tauri::command]
pub async fn get_cover_for_group(group_id: String) -> Result<Option<CoverData>, String> {
    let cache_key = format!("cover_{}", group_id);

    if let Some((cover_data, mime_type)) = crate::cache::get::<(Vec<u8>, String)>(&cache_key) {
        let size_kb = cover_data.len() / 1024;

        // Try to get image dimensions
        let (width, height) = get_image_dimensions(&cover_data);

        // Try to get source from cache
        let source_key = format!("cover_source_{}", group_id);
        let source = crate::cache::get::<String>(&source_key);

        Ok(Some(CoverData {
            data: cover_data,
            mime_type,
            size_kb,
            width,
            height,
            source,
        }))
    } else {
        Ok(None)
    }
}

fn get_image_dimensions(data: &[u8]) -> (Option<u32>, Option<u32>) {
    // Check for JPEG
    if data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8 {
        // Simple JPEG dimension extraction - look for SOF0 marker
        let mut i = 2;
        while i < data.len() - 9 {
            if data[i] == 0xFF {
                let marker = data[i + 1];
                // SOF0, SOF1, SOF2 markers contain dimensions
                if marker == 0xC0 || marker == 0xC1 || marker == 0xC2 {
                    let height = ((data[i + 5] as u32) << 8) | (data[i + 6] as u32);
                    let width = ((data[i + 7] as u32) << 8) | (data[i + 8] as u32);
                    return (Some(width), Some(height));
                }
                // Skip to next marker
                if marker != 0x00 && marker != 0xFF {
                    let len = ((data[i + 2] as usize) << 8) | (data[i + 3] as usize);
                    i += len + 2;
                } else {
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
    }
    
    // Check for PNG
    if data.len() >= 24 && data[0] == 0x89 && data[1] == 0x50 {
        let width = ((data[16] as u32) << 24) 
            | ((data[17] as u32) << 16) 
            | ((data[18] as u32) << 8) 
            | (data[19] as u32);
        let height = ((data[20] as u32) << 24) 
            | ((data[21] as u32) << 16) 
            | ((data[22] as u32) << 8) 
            | (data[23] as u32);
        return (Some(width), Some(height));
    }
    
    (None, None)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CoverOption {
    pub url: String,
    pub source: String,
    pub width: u32,
    pub height: u32,
    pub size_estimate: String,
    pub quality_score: u8,
    pub book_title: Option<String>,
}

impl From<CoverCandidate> for CoverOption {
    fn from(candidate: CoverCandidate) -> Self {
        let size_estimate = match candidate.width.min(candidate.height) {
            2000.. => "Extra Large (Best Quality)".to_string(),
            1500..=1999 => "Large".to_string(),
            1000..=1499 => "Medium-Large".to_string(),
            500..=999 => "Medium".to_string(),
            _ => "Small".to_string(),
        };

        CoverOption {
            url: candidate.url,
            source: candidate.source.to_string(),
            width: candidate.width,
            height: candidate.height,
            size_estimate,
            quality_score: candidate.quality_score,
            book_title: candidate.book_title,
        }
    }
}

#[tauri::command]
pub async fn search_cover_options(
    title: String,
    author: String,
    isbn: Option<String>,
    asin: Option<String>,
) -> Result<Vec<CoverOption>, String> {
    println!("🎨 Searching all cover sources: {} by {}", title, author);

    // Use the new multi-source search
    let result = search_all_cover_sources(
        &title,
        &author,
        isbn.as_deref(),
        asin.as_deref(),
    ).await;

    // Convert candidates to CoverOptions
    let options: Vec<CoverOption> = result.candidates
        .into_iter()
        .map(CoverOption::from)
        .collect();

    println!("🎨 Found {} cover options", options.len());
    Ok(options)
}

/// Search covers from all sources and return detailed results
#[tauri::command]
pub async fn search_covers_multi_source(
    title: String,
    author: String,
    isbn: Option<String>,
    asin: Option<String>,
) -> Result<CoverSearchResult, String> {
    println!("🎨 Multi-source cover search: {} by {}", title, author);

    let result = search_all_cover_sources(
        &title,
        &author,
        isbn.as_deref(),
        asin.as_deref(),
    ).await;

    Ok(result)
}

#[tauri::command]
pub async fn download_cover_from_url(
    group_id: String,
    url: String,
    source: Option<String>,
) -> Result<CoverResult, String> {
    println!("📥 Downloading cover from: {}", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(bytes) = response.bytes().await {
                let data = bytes.to_vec();

                // Validate it's a real image
                if data.len() < 100 {
                    return Err("Downloaded file too small - may be a placeholder".to_string());
                }

                // Determine mime type from magic bytes
                let is_png = data.len() >= 8
                    && data[0] == 0x89
                    && data[1] == 0x50
                    && data[2] == 0x4E
                    && data[3] == 0x47;
                let is_jpeg = data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8;

                if !is_png && !is_jpeg {
                    return Err("Downloaded file is not a valid image".to_string());
                }

                let mime_type = if is_png {
                    "image/png".to_string()
                } else {
                    "image/jpeg".to_string()
                };

                // Get dimensions for logging
                let (width, height) = get_image_dimensions_from_data(&data);
                let size_kb = data.len() / 1024;
                println!("   ✅ Downloaded: {}x{} ({} KB)", width, height, size_kb);

                let cache_key = format!("cover_{}", group_id);
                crate::cache::set(&cache_key, &(data, mime_type))
                    .map_err(|e| e.to_string())?;

                // Also cache the source if provided
                if let Some(src) = source {
                    let source_key = format!("cover_source_{}", group_id);
                    let _ = crate::cache::set(&source_key, &src);
                }

                Ok(CoverResult {
                    success: true,
                    message: format!("Cover downloaded successfully ({}x{}, {} KB)", width, height, size_kb),
                })
            } else {
                Err("Failed to read image data".to_string())
            }
        }
        Ok(response) => Err(format!("HTTP error: {}", response.status())),
        Err(e) => Err(format!("Request failed: {}", e)),
    }
}

#[tauri::command]
pub async fn set_cover_from_file(
    group_id: String,
    image_path: String,
) -> Result<CoverResult, String> {
    let path = Path::new(&image_path);
    
    if !path.exists() {
        return Ok(CoverResult {
            success: false,
            message: "File not found".to_string(),
        });
    }

    let image_data = fs::read(path).map_err(|e| e.to_string())?;
    
    let mime_type = match path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };

    let cache_key = format!("cover_{}", group_id);
    crate::cache::set(&cache_key, &(image_data, mime_type.to_string()))
        .map_err(|e| e.to_string())?;

    Ok(CoverResult {
        success: true,
        message: "Cover uploaded successfully".to_string(),
    })
}