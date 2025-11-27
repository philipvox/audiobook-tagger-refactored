use std::fs;
use std::path::Path;
use serde::{Serialize, Deserialize};
use anyhow::Result;

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
}

#[tauri::command]
pub async fn get_cover_for_group(group_id: String) -> Result<Option<CoverData>, String> {
    let cache_key = format!("cover_{}", group_id);
    
    if let Some((cover_data, mime_type)) = crate::cache::get::<(Vec<u8>, String)>(&cache_key) {
        let size_kb = cover_data.len() / 1024;
        
        // Try to get image dimensions
        let (width, height) = get_image_dimensions(&cover_data);
        
        Ok(Some(CoverData {
            data: cover_data,
            mime_type,
            size_kb,
            width,
            height,
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
}

#[tauri::command]
pub async fn search_cover_options(
    title: String,
    author: String,
    _isbn: Option<String>, // Kept for API compatibility, unused
    asin: Option<String>,
) -> Result<Vec<CoverOption>, String> {
    let mut options = Vec::new();
    
    println!("🎨 Searching for cover options: {} by {}", title, author);
    
    // PRIORITY 1: Try iTunes/Apple Books FIRST (best quality and most reliable)
    if let Some(itunes_options) = try_itunes_options(&title, &author).await {
        options.extend(itunes_options);
    }
    
    // PRIORITY 2: Try Audible if ASIN available (also excellent quality)
    if let Some(ref asin_str) = asin {
        let audible_options = vec![
            CoverOption {
                url: format!("https://m.media-amazon.com/images/I/{}_SL2400_.jpg", asin_str),
                source: "Audible".to_string(),
                width: 2400,
                height: 2400,
                size_estimate: "Extra Large (Best Quality)".to_string(),
            },
            CoverOption {
                url: format!("https://m.media-amazon.com/images/I/{}_SL1500_.jpg", asin_str),
                source: "Audible".to_string(),
                width: 1500,
                height: 1500,
                size_estimate: "Large".to_string(),
            },
        ];
        options.extend(audible_options);
    }
    
    Ok(options)
}

async fn try_itunes_options(title: &str, author: &str) -> Option<Vec<CoverOption>> {
    let search_query = format!("{} {}", title, author);
    let search_url = format!(
        "https://itunes.apple.com/search?term={}&media=audiobook&entity=audiobook&limit=3",
        urlencoding::encode(&search_query)
    );
    
    let client = reqwest::Client::new();
    match client.get(&search_url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(results) = json["results"].as_array() {
                    let mut options = Vec::new();
                    
                    for result in results.iter().take(3) {
                        if let Some(artwork_url) = result["artworkUrl100"].as_str() {
                            let high_res_url = artwork_url
                                .replace("100x100", "2048x2048")
                                .replace("100x100bb", "2048x2048bb");
                            
                            // Get the book title from the result for better identification
                            let book_name = result["collectionName"]
                                .as_str()
                                .unwrap_or("Unknown")
                                .to_string();
                            
                            options.push(CoverOption {
                                url: high_res_url,
                                source: format!("iTunes: {}", book_name),
                                width: 2048,
                                height: 2048,
                                size_estimate: "High Resolution".to_string(),
                            });
                        }
                    }
                    
                    if !options.is_empty() {
                        return Some(options);
                    }
                }
            }
        }
        _ => {}
    }
    
    None
}

#[tauri::command]
pub async fn download_cover_from_url(
    group_id: String,
    url: String,
) -> Result<CoverResult, String> {
    println!("📥 Downloading cover from: {}", url);
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(bytes) = response.bytes().await {
                let data = bytes.to_vec();
                
                // Determine mime type from magic bytes
                let mime_type = if data.len() >= 8 
                    && data[0] == 0x89 
                    && data[1] == 0x50 
                    && data[2] == 0x4E 
                    && data[3] == 0x47 
                {
                    "image/png".to_string()
                } else {
                    "image/jpeg".to_string()
                };
                
                let cache_key = format!("cover_{}", group_id);
                crate::cache::set(&cache_key, &(data, mime_type))
                    .map_err(|e| e.to_string())?;
                
                Ok(CoverResult {
                    success: true,
                    message: "Cover downloaded successfully".to_string(),
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