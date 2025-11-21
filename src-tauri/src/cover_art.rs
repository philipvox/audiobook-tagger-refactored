use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverArt {
    pub url: Option<String>,
    pub data: Option<Vec<u8>>,
    pub mime_type: Option<String>,
}
pub async fn fetch_and_download_cover(
    title: &str,
    author: &str,
    asin: Option<&str>,
    google_api_key: Option<&str>,
) -> Result<CoverArt, Box<dyn std::error::Error + Send + Sync>> {
    println!("   🖼️  Searching for cover art...");
    
    // PRIORITY 1: iTunes/Apple Books (highest quality, up to 2048x2048, most consistent)
    if let Some(cover) = fetch_itunes_cover(title, author).await {
        return Ok(cover);
    }
    
    // PRIORITY 2: Audible (high quality, up to 2400x2400, but requires ASIN)
    if let Some(asin_str) = asin {
        if let Some(cover) = fetch_audible_cover(asin_str).await {
            return Ok(cover);
        }
    }
    
    // PRIORITY 3: Google Books (good quality, various sizes)
    if let Some(api_key) = google_api_key {
        if let Some(cover) = fetch_google_books_cover(title, author, api_key).await {
            return Ok(cover);
        }
    }
    
    // PRIORITY 4: Open Library (decent quality, free fallback)
    if let Some(cover) = fetch_open_library_cover(title, author).await {
        return Ok(cover);
    }
    
    // No cover found
    println!("   ⚠️  No cover art found from any source");
    Ok(CoverArt {
        url: None,
        data: None,
        mime_type: None,
    })
}

async fn fetch_audible_cover(asin: &str) -> Option<CoverArt> {
    println!("   🎧 Trying Audible cover (ASIN: {})...", asin);
    
    // Audible has predictable cover URLs
    let sizes = [
        ("_SL2400_", "2400x2400 (Best)"),
        ("_SL1500_", "1500x1500"),
        ("_SL500_", "500x500"),
    ];
    
    for (size_code, size_desc) in sizes {
        let url = format!(
            "https://m.media-amazon.com/images/I/{}{}jpg",
            asin, size_code
        );
        
        if let Ok(cover) = download_cover(&url).await {
            if cover.data.is_some() {
                println!("   ✅ Audible cover found: {}", size_desc);
                return Some(cover);
            }
        }
    }
    
    println!("   ⚠️  No Audible cover found");
    None
}

async fn fetch_google_books_cover(
    title: &str,
    author: &str,
    api_key: &str,
) -> Option<CoverArt> {
    println!("   📚 Trying Google Books cover...");
    
    let query = format!("intitle:{} inauthor:{}", title, author);
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&key={}",
        urlencoding::encode(&query),
        api_key
    );
    
    let client = reqwest::Client::new();
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(items) = json["items"].as_array() {
                    if let Some(first_item) = items.first() {
                        let image_links = &first_item["volumeInfo"]["imageLinks"];
                        
                        // Try different sizes, largest first
                        let size_keys = [
                            "extraLarge",
                            "large", 
                            "medium",
                            "small",
                            "thumbnail"
                        ];
                        
                        for key in size_keys {
                            if let Some(url_str) = image_links[key].as_str() {
                                // Enhance URL for max quality
                                let enhanced_url = url_str
                                    .replace("http://", "https://")
                                    .replace("zoom=1", "zoom=3")
                                    .replace("&edge=curl", "");
                                
                                if let Ok(cover) = download_cover(&enhanced_url).await {
                                    if cover.data.is_some() {
                                        println!("   ✅ Google Books cover found: {}", key);
                                        return Some(cover);
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
    
    println!("   ⚠️  No Google Books cover found");
    None
}

async fn fetch_open_library_cover(title: &str, author: &str) -> Option<CoverArt> {
    println!("   📖 Trying Open Library cover...");
    
    // Search for the book to get ISBN or OLID
    let search_query = format!("{} {}", title, author);
    let search_url = format!(
        "https://openlibrary.org/search.json?q={}&limit=1",
        urlencoding::encode(&search_query)
    );
    
    let client = reqwest::Client::new();
    match client.get(&search_url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(docs) = json["docs"].as_array() {
                    if let Some(first_doc) = docs.first() {
                        // Try ISBN first
                        if let Some(isbn_array) = first_doc["isbn"].as_array() {
                            if let Some(isbn) = isbn_array.first().and_then(|v| v.as_str()) {
                                let cover_url = format!(
                                    "https://covers.openlibrary.org/b/isbn/{}-L.jpg",
                                    isbn
                                );
                                
                                if let Ok(cover) = download_cover(&cover_url).await {
                                    if cover.data.is_some() {
                                        println!("   ✅ Open Library cover found (ISBN)");
                                        return Some(cover);
                                    }
                                }
                            }
                        }
                        
                        // Try OLID
                        if let Some(cover_id) = first_doc["cover_i"].as_i64() {
                            let cover_url = format!(
                                "https://covers.openlibrary.org/b/id/{}-L.jpg",
                                cover_id
                            );
                            
                            if let Ok(cover) = download_cover(&cover_url).await {
                                if cover.data.is_some() {
                                    println!("   ✅ Open Library cover found (ID)");
                                    return Some(cover);
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    
    println!("   ⚠️  No Open Library cover found");
    None
}

async fn fetch_itunes_cover(title: &str, author: &str) -> Option<CoverArt> {
    println!("   🍎 Trying iTunes/Apple Books cover...");
    
    let search_query = format!("{} {}", title, author);
    let search_url = format!(
        "https://itunes.apple.com/search?term={}&media=audiobook&entity=audiobook&limit=1",
        urlencoding::encode(&search_query)
    );
    
    let client = reqwest::Client::new();
    match client.get(&search_url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(results) = json["results"].as_array() {
                    if let Some(first_result) = results.first() {
                        if let Some(artwork_url) = first_result["artworkUrl100"].as_str() {
                            // Replace size to get maximum quality
                            let high_res_url = artwork_url
                                .replace("100x100", "2048x2048")
                                .replace("100x100bb", "2048x2048bb");
                            
                            if let Ok(cover) = download_cover(&high_res_url).await {
                                if cover.data.is_some() {
                                    println!("   ✅ iTunes cover found");
                                    return Some(cover);
                                }
                            }
                            
                            // Fallback to original size
                            if let Ok(cover) = download_cover(artwork_url).await {
                                if cover.data.is_some() {
                                    println!("   ✅ iTunes cover found (standard)");
                                    return Some(cover);
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    
    println!("   ⚠️  No iTunes cover found");
    None
}
async fn download_cover(url: &str) -> Result<CoverArt, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    
    let response = client.get(url).send().await?;
    
    if !response.status().is_success() {
        return Err("Failed to download cover".into());
    }
    
    // Get content type before consuming response
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string(); // Convert to owned String here
    
    let bytes = response.bytes().await?;
    let data = bytes.to_vec();
    
    // Validate it's actually an image
    if data.len() < 100 {
        return Err("Image too small".into());
    }
    
    Ok(CoverArt {
        url: Some(url.to_string()),
        data: Some(data),
        mime_type: Some(content_type), // Now using owned String
    })
}