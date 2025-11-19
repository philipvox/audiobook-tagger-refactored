// src-tauri/src/cover_art.rs
use serde::{Deserialize, Serialize};
use anyhow::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverArt {
    pub url: Option<String>,
    pub data: Option<Vec<u8>>,
    pub mime_type: Option<String>,
}

impl CoverArt {
    pub fn new() -> Self {
        Self {
            url: None,
            data: None,
            mime_type: None,
        }
    }
}

/// Fetch cover art URL from Google Books
pub async fn fetch_cover_url_from_google(
    title: &str,
    author: &str,
    api_key: &str,
) -> Result<Option<String>> {
    println!("   🖼️  Searching for cover art...");
    
    let query = format!("intitle:{} inauthor:{}", title, author);
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&key={}",
        urlencoding::encode(&query),
        api_key
    );
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    
    let response = client.get(&url).send().await?;
    
    if !response.status().is_success() {
        println!("   ⚠️  Google Books API error: {}", response.status());
        return Ok(None);
    }
    
    #[derive(Deserialize)]
    struct Response {
        #[serde(default)]
        items: Vec<Item>,
    }
    
    #[derive(Deserialize)]
    struct Item {
        #[serde(rename = "volumeInfo")]
        volume_info: VolumeInfo,
    }
    
    #[derive(Deserialize)]
    struct VolumeInfo {
        #[serde(rename = "imageLinks")]
        image_links: Option<ImageLinks>,
    }
    
    #[derive(Deserialize)]
    struct ImageLinks {
        thumbnail: Option<String>,
        #[serde(rename = "smallThumbnail")]
        small_thumbnail: Option<String>,
        small: Option<String>,
        medium: Option<String>,
        large: Option<String>,
        #[serde(rename = "extraLarge")]
        extra_large: Option<String>,
    }
    
    let books: Response = response.json().await?;
    
    if let Some(book) = books.items.first() {
        if let Some(links) = &book.volume_info.image_links {
            // Try to get highest quality available
            let cover_url = links.extra_large.clone()
                .or_else(|| links.large.clone())
                .or_else(|| links.medium.clone())
                .or_else(|| links.small.clone())
                .or_else(|| links.thumbnail.clone())
                .or_else(|| links.small_thumbnail.clone());
            
            if let Some(url) = cover_url {
                println!("   ✅ Found cover URL: {}", url);
                return Ok(Some(url));
            }
        }
    }
    
    println!("   ⚠️  No cover image found");
    Ok(None)
}

/// Download cover image from URL
pub async fn download_cover_image(url: &str) -> Result<(Vec<u8>, String)> {
    println!("   📥 Downloading cover from: {}", url);
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    
    let response = client.get(url).send().await?;
    
    if !response.status().is_success() {
        anyhow::bail!("Failed to download: {}", response.status());
    }
    
    // Detect MIME type from Content-Type header
    let mime_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    
    let bytes = response.bytes().await?;
    
    println!("   ✅ Downloaded {} bytes ({})", bytes.len(), mime_type);
    
    Ok((bytes.to_vec(), mime_type))
}

/// Fetch cover art from Audible
pub async fn fetch_cover_from_audible(asin: &str) -> Result<Option<String>> {
    // Audible covers follow a predictable URL pattern
    let cover_url = format!("https://m.media-amazon.com/images/I/{}._SL500_.jpg", asin);
    
    // Verify the URL exists
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?;
    
    let response = client.head(&cover_url).send().await?;
    
    if response.status().is_success() {
        println!("   ✅ Found Audible cover: {}", cover_url);
        Ok(Some(cover_url))
    } else {
        Ok(None)
    }
}

/// Fetch and download complete cover art
pub async fn fetch_and_download_cover(
    title: &str,
    author: &str,
    asin: Option<&str>,
    google_api_key: Option<&str>,
) -> Result<CoverArt> {
    let mut cover = CoverArt::new();
    
    // Try Audible first if ASIN is available
    if let Some(asin_str) = asin {
        if let Ok(Some(url)) = fetch_cover_from_audible(asin_str).await {
            cover.url = Some(url.clone());
            
            if let Ok((data, mime)) = download_cover_image(&url).await {
                cover.data = Some(data);
                cover.mime_type = Some(mime);
                return Ok(cover);
            }
        }
    }
    
    // Try Google Books
    if let Some(api_key) = google_api_key {
        if let Ok(Some(url)) = fetch_cover_url_from_google(title, author, api_key).await {
            cover.url = Some(url.clone());
            
            if let Ok((data, mime)) = download_cover_image(&url).await {
                cover.data = Some(data);
                cover.mime_type = Some(mime);
                return Ok(cover);
            }
        }
    }
    
    Ok(cover)
}

/// Resize image to reasonable size for embedding (optional optimization)
pub fn resize_cover_if_needed(data: &[u8], max_size: usize) -> Vec<u8> {
    if data.len() <= max_size {
        return data.to_vec();
    }
    
    // For now, just return as-is
    // TODO: Add image resizing with image crate if needed
    println!("   ℹ️  Cover is {} bytes (consider resizing)", data.len());
    data.to_vec()
}