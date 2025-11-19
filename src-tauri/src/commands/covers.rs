use std::fs;
use std::path::Path;
use serde::{Serialize, Deserialize};
use anyhow::Result;

#[derive(Debug, Serialize, Deserialize)]
pub struct CoverResult {
    pub success: bool,
    pub message: String,
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

    // Read the image file
    let image_data = fs::read(path).map_err(|e| e.to_string())?;
    
    // Detect MIME type from extension
    let mime_type = match path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };

    // Store in cache for this group
    let cache_key = format!("cover_{}", group_id);
    crate::cache::set(&cache_key, &(image_data, mime_type.to_string()))
        .map_err(|e| e.to_string())?;

    Ok(CoverResult {
        success: true,
        message: "Cover uploaded successfully".to_string(),
    })
}

#[tauri::command]
pub async fn fetch_better_cover(
    group_id: String,
    title: String,
    author: String,
    isbn: Option<String>,
) -> Result<CoverResult, String> {
    println!("🎨 Fetching better cover for: {} by {}", title, author);

    // Try multiple sources in order of quality
    let cover_data = if let Some(ref isbn_str) = isbn {
        // 1. Try Open Library (highest quality)
        try_open_library_cover(isbn_str).await
            // 2. Try Google Books with large size
            .or_else(|| try_google_books_large(&title, &author).await)
    } else {
        // Try Google Books with large size
        try_google_books_large(&title, &author).await
    };

    if let Some((data, mime)) = cover_data {
        let cache_key = format!("cover_{}", group_id);
        crate::cache::set(&cache_key, &(data, mime))
            .map_err(|e| e.to_string())?;

        Ok(CoverResult {
            success: true,
            message: "Found better cover".to_string(),
        })
    } else {
        Ok(CoverResult {
            success: false,
            message: "No better cover found".to_string(),
        })
    }
}

async fn try_open_library_cover(isbn: &str) -> Option<(Vec<u8>, String)> {
    // Open Library provides high-res covers
    let url = format!("https://covers.openlibrary.org/b/isbn/{}-L.jpg", isbn);
    
    println!("   📖 Trying Open Library: {}", url);
    
    let client = reqwest::Client::new();
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(bytes) = response.bytes().await {
                if bytes.len() > 10000 { // Minimum 10KB for valid image
                    println!("   ✅ Found high-res cover from Open Library");
                    return Some((bytes.to_vec(), "image/jpeg".to_string()));
                }
            }
        }
        _ => {}
    }
    
    None
}

async fn try_google_books_large(title: &str, author: &str) -> Option<(Vec<u8>, String)> {
    let query = format!("intitle:{} inauthor:{}", title, author);
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}",
        urlencoding::encode(&query)
    );

    println!("   📚 Trying Google Books (large)");

    let client = reqwest::Client::new();
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(items) = json["items"].as_array() {
                    if let Some(first_item) = items.first() {
                        // Try to get the largest available image
                        let image_links = &first_item["volumeInfo"]["imageLinks"];
                        
                        // Try in order of size: extraLarge, large, medium, thumbnail
                        for size in &["extraLarge", "large", "medium", "thumbnail"] {
                            if let Some(url_str) = image_links[size].as_str() {
                                // Force https and request larger image
                                let https_url = url_str.replace("http://", "https://")
                                    .replace("zoom=1", "zoom=3")
                                    .replace("&edge=curl", "");
                                
                                println!("   🔍 Found {} cover: {}", size, https_url);
                                
                                if let Ok(img_response) = client.get(&https_url).send().await {
                                    if let Ok(bytes) = img_response.bytes().await {
                                        if bytes.len() > 10000 {
                                            println!("   ✅ Downloaded {} cover ({} KB)", size, bytes.len() / 1024);
                                            return Some((bytes.to_vec(), "image/jpeg".to_string()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }

    None
}