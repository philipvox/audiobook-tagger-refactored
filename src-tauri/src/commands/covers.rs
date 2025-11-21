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
    isbn: Option<String>,
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
    
    // PRIORITY 3: Try Open Library if ISBN available
    if let Some(ref isbn_str) = isbn {
        if let Some(option) = try_open_library_options(isbn_str).await {
            options.push(option);
        }
    }
    
    // PRIORITY 4: Try Open Library by search if no ISBN
    if isbn.is_none() {
        if let Some(ol_options) = try_open_library_search(&title, &author).await {
            options.extend(ol_options);
        }
    }
    
    Ok(options)
}
#[tauri::command]
pub async fn download_cover_from_url(
    group_id: String,
    url: String,
) -> Result<CoverResult, String> {
    println!("📥 Downloading cover from: {}", url);
    
    let client = reqwest::Client::new();
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(bytes) = response.bytes().await {
                let data = bytes.to_vec();
                let mime_type = "image/jpeg".to_string();
                
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
        _ => Err("Failed to download image".to_string()),
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

async fn try_open_library_options(isbn: &str) -> Option<CoverOption> {
    let url = format!("https://covers.openlibrary.org/b/isbn/{}-L.jpg", isbn);
    
    // Try to fetch and get dimensions
    let client = reqwest::Client::new();
    if let Ok(response) = client.head(&url).send().await {
        if response.status().is_success() {
            return Some(CoverOption {
                url,
                source: "Open Library".to_string(),
                width: 0,
                height: 0,
                size_estimate: "Large (High Quality)".to_string(),
            });
        }
    }
    
    None
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
                            
                            options.push(CoverOption {
                                url: high_res_url,
                                source: "iTunes/Apple Books".to_string(),
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

async fn try_open_library_search(title: &str, author: &str) -> Option<Vec<CoverOption>> {
    let search_query = format!("{} {}", title, author);
    let search_url = format!(
        "https://openlibrary.org/search.json?q={}&limit=3",
        urlencoding::encode(&search_query)
    );
    
    let client = reqwest::Client::new();
    match client.get(&search_url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(docs) = json["docs"].as_array() {
                    let mut options = Vec::new();
                    
                    for doc in docs.iter().take(3) {
                        if let Some(cover_id) = doc["cover_i"].as_i64() {
                            options.push(CoverOption {
                                url: format!("https://covers.openlibrary.org/b/id/{}-L.jpg", cover_id),
                                source: "Open Library".to_string(),
                                width: 0,
                                height: 0,
                                size_estimate: "Large".to_string(),
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

fn get_image_dimensions(data: &[u8]) -> (Option<u32>, Option<u32>) {
    if data.len() < 24 {
        return (None, None);
    }
    
    // Check for PNG
    if &data[0..8] == b"\x89PNG\r\n\x1a\n" {
        if data.len() >= 24 {
            let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
            let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
            return (Some(width), Some(height));
        }
    }
    
    (None, None)
}