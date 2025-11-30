use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverArt {
    pub url: Option<String>,
    pub data: Option<Vec<u8>>,
    pub mime_type: Option<String>,
}

/// Source of cover art - used for quality scoring and display
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CoverSource {
    ITunes,
    Audible,
    Amazon,
    GoogleBooks,
    OpenLibrary,
    LibraryThing,
    UserProvided,
    Embedded,
    Unknown,
}

impl std::fmt::Display for CoverSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoverSource::ITunes => write!(f, "iTunes"),
            CoverSource::Audible => write!(f, "Audible"),
            CoverSource::Amazon => write!(f, "Amazon"),
            CoverSource::GoogleBooks => write!(f, "Google Books"),
            CoverSource::OpenLibrary => write!(f, "Open Library"),
            CoverSource::LibraryThing => write!(f, "LibraryThing"),
            CoverSource::UserProvided => write!(f, "User Provided"),
            CoverSource::Embedded => write!(f, "Embedded"),
            CoverSource::Unknown => write!(f, "Unknown"),
        }
    }
}

/// A cover art candidate with quality scoring
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverCandidate {
    pub url: String,
    pub source: CoverSource,
    pub width: u32,
    pub height: u32,
    pub file_size: usize,
    pub quality_score: u8,
    pub book_title: Option<String>,
}

impl CoverCandidate {
    pub fn new(url: String, source: CoverSource) -> Self {
        Self {
            url,
            source,
            width: 0,
            height: 0,
            file_size: 0,
            quality_score: 0,
            book_title: None,
        }
    }

    pub fn with_dimensions(mut self, width: u32, height: u32) -> Self {
        self.width = width;
        self.height = height;
        self
    }

    pub fn with_title(mut self, title: String) -> Self {
        self.book_title = Some(title);
        self
    }

    /// Calculate quality score based on resolution, source trust, and aspect ratio
    pub fn calculate_score(&mut self) {
        let mut score = 0u8;

        // Resolution scoring (max 50 points)
        let min_dim = self.width.min(self.height);
        score += match min_dim {
            2000.. => 50,
            1500..=1999 => 45,
            1000..=1499 => 40,
            500..=999 => 30,
            300..=499 => 20,
            _ => 10,
        };

        // Source trust scoring (max 30 points)
        score += match self.source {
            CoverSource::ITunes => 30,       // Most reliable
            CoverSource::Audible => 28,
            CoverSource::Amazon => 25,
            CoverSource::GoogleBooks => 20,
            CoverSource::OpenLibrary => 15,
            CoverSource::LibraryThing => 15,
            CoverSource::UserProvided => 30, // Trust user
            CoverSource::Embedded => 25,     // Already in file
            CoverSource::Unknown => 5,
        };

        // Aspect ratio scoring (max 20 points)
        // Audiobook covers should be ~1:1 (square) or ~1:1.5 (portrait)
        if self.width > 0 && self.height > 0 {
            let ratio = self.height as f32 / self.width as f32;
            score += if (0.9..=1.1).contains(&ratio) {
                20 // Square (very common for audiobooks)
            } else if (1.3..=1.7).contains(&ratio) {
                18 // Portrait book ratio
            } else if (0.6..=1.4).contains(&ratio) {
                10 // Acceptable
            } else {
                5 // Weird ratio
            };
        }

        self.quality_score = score.min(100);
    }
}

/// Result of multi-source cover search
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverSearchResult {
    pub candidates: Vec<CoverCandidate>,
    pub best_candidate: Option<CoverCandidate>,
}

/// Embed cover art into an audio file
pub fn embed_cover_in_file(
    audio_path: &str,
    cover_data: &[u8],
    mime_type: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let path = Path::new(audio_path);
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "m4a" | "m4b" => embed_cover_m4a(audio_path, cover_data, mime_type),
        "mp3" => embed_cover_mp3(audio_path, cover_data, mime_type),
        "flac" => embed_cover_flac(audio_path, cover_data, mime_type),
        "ogg" | "opus" => embed_cover_vorbis(audio_path, cover_data, mime_type),
        _ => Err(format!("Unsupported format for cover embedding: {}", ext).into())
    }
}

/// Embed cover art in M4A/M4B files
fn embed_cover_m4a(
    audio_path: &str,
    cover_data: &[u8],
    mime_type: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use mp4ameta::{Tag, Data, Fourcc};

    let mut tag = Tag::read_from_path(audio_path)
        .unwrap_or_else(|_| Tag::default());

    // Remove existing cover art
    tag.remove_data_of(&Fourcc(*b"covr"));

    // Add new cover art (use Png or Jpeg based on mime type)
    let cover_data_vec = cover_data.to_vec();
    if mime_type.contains("png") {
        tag.add_data(Fourcc(*b"covr"), Data::Png(cover_data_vec));
    } else {
        tag.add_data(Fourcc(*b"covr"), Data::Jpeg(cover_data_vec));
    }

    tag.write_to_path(audio_path)?;
    println!("   ✅ Cover embedded in M4A/M4B file");
    Ok(())
}

/// Embed cover art in MP3 files using ID3v2
fn embed_cover_mp3(
    audio_path: &str,
    cover_data: &[u8],
    mime_type: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use lofty::prelude::*;
    use lofty::probe::Probe;
    use lofty::picture::{Picture, PictureType, MimeType};

    let mut tagged_file = Probe::open(audio_path)?.read()?;

    let tag = if let Some(t) = tagged_file.primary_tag_mut() {
        t
    } else {
        let tag_type = tagged_file.primary_tag_type();
        tagged_file.insert_tag(lofty::tag::Tag::new(tag_type));
        tagged_file.primary_tag_mut().unwrap()
    };

    // Create picture
    let mime = if mime_type.contains("png") {
        MimeType::Png
    } else {
        MimeType::Jpeg
    };

    let picture = Picture::new_unchecked(
        PictureType::CoverFront,
        Some(mime),
        None,
        cover_data.to_vec()
    );

    // Remove existing pictures
    tag.remove_picture_type(PictureType::CoverFront);

    // Add new picture
    tag.push_picture(picture);

    tagged_file.save_to_path(audio_path, lofty::config::WriteOptions::default())?;
    println!("   ✅ Cover embedded in MP3 file");
    Ok(())
}

/// Embed cover art in FLAC files
fn embed_cover_flac(
    audio_path: &str,
    cover_data: &[u8],
    mime_type: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use lofty::prelude::*;
    use lofty::probe::Probe;
    use lofty::picture::{Picture, PictureType, MimeType};

    let mut tagged_file = Probe::open(audio_path)?.read()?;

    let tag = if let Some(t) = tagged_file.primary_tag_mut() {
        t
    } else {
        let tag_type = tagged_file.primary_tag_type();
        tagged_file.insert_tag(lofty::tag::Tag::new(tag_type));
        tagged_file.primary_tag_mut().unwrap()
    };

    let mime = if mime_type.contains("png") {
        MimeType::Png
    } else {
        MimeType::Jpeg
    };

    let picture = Picture::new_unchecked(
        PictureType::CoverFront,
        Some(mime),
        None,
        cover_data.to_vec()
    );

    tag.remove_picture_type(PictureType::CoverFront);
    tag.push_picture(picture);

    tagged_file.save_to_path(audio_path, lofty::config::WriteOptions::default())?;
    println!("   ✅ Cover embedded in FLAC file");
    Ok(())
}

/// Embed cover art in OGG/Opus files (Vorbis comments)
fn embed_cover_vorbis(
    audio_path: &str,
    cover_data: &[u8],
    mime_type: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use lofty::prelude::*;
    use lofty::probe::Probe;
    use lofty::picture::{Picture, PictureType, MimeType};

    let mut tagged_file = Probe::open(audio_path)?.read()?;

    let tag = if let Some(t) = tagged_file.primary_tag_mut() {
        t
    } else {
        let tag_type = tagged_file.primary_tag_type();
        tagged_file.insert_tag(lofty::tag::Tag::new(tag_type));
        tagged_file.primary_tag_mut().unwrap()
    };

    let mime = if mime_type.contains("png") {
        MimeType::Png
    } else {
        MimeType::Jpeg
    };

    let picture = Picture::new_unchecked(
        PictureType::CoverFront,
        Some(mime),
        None,
        cover_data.to_vec()
    );

    tag.remove_picture_type(PictureType::CoverFront);
    tag.push_picture(picture);

    tagged_file.save_to_path(audio_path, lofty::config::WriteOptions::default())?;
    println!("   ✅ Cover embedded in OGG/Opus file");
    Ok(())
}

/// Save cover art as folder.jpg in the audiobook folder
pub fn save_cover_to_folder(
    folder_path: &str,
    cover_data: &[u8],
    mime_type: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let folder = Path::new(folder_path);

    // Determine extension based on mime type
    let extension = if mime_type.contains("png") { "png" } else { "jpg" };
    let cover_filename = format!("folder.{}", extension);
    let cover_path = folder.join(&cover_filename);

    std::fs::write(&cover_path, cover_data)?;
    println!("   ✅ Cover saved to {}", cover_path.display());

    Ok(cover_path.to_string_lossy().to_string())
}

pub async fn fetch_and_download_cover(
    title: &str,
    author: &str,
    asin: Option<&str>,
    _google_api_key: Option<&str>, // Kept for API compatibility, but unused
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
    
    // No cover found
    println!("   ⚠️  No cover art found from any source");
    Ok(CoverArt {
        url: None,
        data: None,
        mime_type: None,
    })
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

async fn fetch_audible_cover(asin: &str) -> Option<CoverArt> {
    println!("   🎧 Trying Audible cover (ASIN: {})...", asin);
    
    // Try to fetch the Audible product page and extract the actual image URL
    // The ASIN alone doesn't give us the image ID - we need to scrape it
    let product_url = format!("https://www.audible.com/pd/{}", asin);
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .build()
        .ok()?;
    
    let response = client.get(&product_url).send().await.ok()?;
    if !response.status().is_success() {
        println!("   ⚠️  No Audible cover found");
        return None;
    }
    
    let html = response.text().await.ok()?;
    
    // Look for the cover image URL in the page
    // Audible uses patterns like: https://m.media-amazon.com/images/I/XXXXXXXXXX._SL500_.jpg
    if let Some(start) = html.find("https://m.media-amazon.com/images/I/") {
        let substr = &html[start..];
        if let Some(end) = substr.find(".jpg") {
            let image_url = &substr[..end + 4];
            
            // Try to get a higher resolution version
            let high_res_url = image_url
                .replace("._SL500_.", "._SL2400_.")
                .replace("._SL300_.", "._SL2400_.")
                .replace("._SL200_.", "._SL2400_.");
            
            if let Ok(cover) = download_cover(&high_res_url).await {
                if cover.data.is_some() {
                    println!("   ✅ Audible cover found (high-res)");
                    return Some(cover);
                }
            }
            
            // Fallback to original size
            if let Ok(cover) = download_cover(image_url).await {
                if cover.data.is_some() {
                    println!("   ✅ Audible cover found");
                    return Some(cover);
                }
            }
        }
    }
    
    println!("   ⚠️  No Audible cover found");
    None
}

async fn download_cover(url: &str) -> Result<CoverArt, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let response = client.get(url).send().await?;

    if !response.status().is_success() {
        return Ok(CoverArt {
            url: Some(url.to_string()),
            data: None,
            mime_type: None,
        });
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let bytes = response.bytes().await?;

    // Validate it's actually an image (check for common image headers)
    if bytes.len() < 100 {
        return Ok(CoverArt {
            url: Some(url.to_string()),
            data: None,
            mime_type: None,
        });
    }

    // Check for JPEG magic bytes
    let is_jpeg = bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xD8;
    // Check for PNG magic bytes
    let is_png = bytes.len() >= 8
        && bytes[0] == 0x89
        && bytes[1] == 0x50
        && bytes[2] == 0x4E
        && bytes[3] == 0x47;

    if !is_jpeg && !is_png {
        return Ok(CoverArt {
            url: Some(url.to_string()),
            data: None,
            mime_type: None,
        });
    }

    let mime_type = if is_png {
        Some("image/png".to_string())
    } else {
        content_type.or_else(|| Some("image/jpeg".to_string()))
    };

    Ok(CoverArt {
        url: Some(url.to_string()),
        data: Some(bytes.to_vec()),
        mime_type,
    })
}

// ============================================================================
// NEW COVER SOURCES
// ============================================================================

/// Fetch cover from Open Library using ISBN
/// URL: https://covers.openlibrary.org/b/isbn/{ISBN}-L.jpg
/// Sizes: S (small), M (medium), L (large ~500px)
pub async fn fetch_openlibrary_cover(isbn: &str) -> Option<CoverCandidate> {
    println!("   📖 Trying Open Library cover (ISBN: {})...", isbn);

    // Clean ISBN - remove hyphens and spaces
    let clean_isbn = isbn.replace(['-', ' '], "");
    if clean_isbn.is_empty() {
        return None;
    }

    // Try large size first
    let url = format!("https://covers.openlibrary.org/b/isbn/{}-L.jpg", clean_isbn);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;

    // First do a HEAD request to check if image exists and get size
    let response = client.head(&url).send().await.ok()?;

    if !response.status().is_success() {
        println!("   ⚠️  No Open Library cover found");
        return None;
    }

    // Check content-length to detect placeholder images (usually very small)
    let content_length = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);

    // Open Library returns a 1x1 transparent gif for missing covers (~43 bytes)
    if content_length < 1000 {
        println!("   ⚠️  Open Library returned placeholder image");
        return None;
    }

    let mut candidate = CoverCandidate::new(url, CoverSource::OpenLibrary)
        .with_dimensions(500, 500); // Approximate L size
    candidate.file_size = content_length;
    candidate.calculate_score();

    println!("   ✅ Open Library cover found");
    Some(candidate)
}

/// Fetch cover from LibraryThing using ISBN and dev key
/// URL: https://covers.librarything.com/devkey/{KEY}/large/isbn/{ISBN}
/// Requires free developer key from LibraryThing
pub async fn fetch_librarything_cover(isbn: &str, dev_key: &str) -> Option<CoverCandidate> {
    println!("   📚 Trying LibraryThing cover (ISBN: {})...", isbn);

    if dev_key.is_empty() {
        println!("   ⚠️  No LibraryThing dev key configured");
        return None;
    }

    // Clean ISBN
    let clean_isbn = isbn.replace(['-', ' '], "");
    if clean_isbn.is_empty() {
        return None;
    }

    // Try large size
    let url = format!(
        "https://covers.librarything.com/devkey/{}/large/isbn/{}",
        dev_key, clean_isbn
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;

    // HEAD request to check if image exists
    let response = client.head(&url).send().await.ok()?;

    if !response.status().is_success() {
        println!("   ⚠️  No LibraryThing cover found");
        return None;
    }

    // Check content-length - LibraryThing returns a small placeholder for missing covers
    let content_length = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);

    if content_length < 1000 {
        println!("   ⚠️  LibraryThing returned placeholder image");
        return None;
    }

    let mut candidate = CoverCandidate::new(url, CoverSource::LibraryThing)
        .with_dimensions(500, 750); // Approximate large size
    candidate.file_size = content_length;
    candidate.calculate_score();

    println!("   ✅ LibraryThing cover found");
    Some(candidate)
}

// ============================================================================
// COVER CACHING BY ISBN/ASIN
// ============================================================================

/// Cache key for cover by ISBN
pub fn cover_cache_key_isbn(isbn: &str) -> String {
    let clean = isbn.replace(['-', ' '], "");
    format!("cover_isbn_{}", clean)
}

/// Cache key for cover by ASIN
pub fn cover_cache_key_asin(asin: &str) -> String {
    format!("cover_asin_{}", asin)
}

/// Get cached cover by ISBN
pub fn get_cached_cover_by_isbn(isbn: &str) -> Option<(Vec<u8>, String)> {
    let key = cover_cache_key_isbn(isbn);
    crate::cache::get::<(Vec<u8>, String)>(&key)
}

/// Get cached cover by ASIN
pub fn get_cached_cover_by_asin(asin: &str) -> Option<(Vec<u8>, String)> {
    let key = cover_cache_key_asin(asin);
    crate::cache::get::<(Vec<u8>, String)>(&key)
}

/// Cache cover by ISBN
pub fn cache_cover_by_isbn(isbn: &str, data: &[u8], mime_type: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let key = cover_cache_key_isbn(isbn);
    crate::cache::set(&key, &(data.to_vec(), mime_type.to_string()))
}

/// Cache cover by ASIN
pub fn cache_cover_by_asin(asin: &str, data: &[u8], mime_type: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let key = cover_cache_key_asin(asin);
    crate::cache::set(&key, &(data.to_vec(), mime_type.to_string()))
}

/// Try to get cover from cache first, then download if not found
pub async fn get_or_download_cover(
    title: &str,
    author: &str,
    isbn: Option<&str>,
    asin: Option<&str>,
) -> Option<(Vec<u8>, String)> {
    // Try cache first
    if let Some(isbn_str) = isbn {
        if let Some(cached) = get_cached_cover_by_isbn(isbn_str) {
            println!("   ✅ Cover found in cache (ISBN: {})", isbn_str);
            return Some(cached);
        }
    }
    if let Some(asin_str) = asin {
        if let Some(cached) = get_cached_cover_by_asin(asin_str) {
            println!("   ✅ Cover found in cache (ASIN: {})", asin_str);
            return Some(cached);
        }
    }

    // Search for cover
    let result = search_all_cover_sources(title, author, isbn, asin).await;

    if let Some(best) = result.best_candidate {
        // Download the best cover
        if let Ok((data, mime, _w, _h)) = download_and_validate_cover(&best.url).await {
            // Cache it
            if let Some(isbn_str) = isbn {
                let _ = cache_cover_by_isbn(isbn_str, &data, &mime);
            }
            if let Some(asin_str) = asin {
                let _ = cache_cover_by_asin(asin_str, &data, &mime);
            }
            return Some((data, mime));
        }
    }

    None
}

/// Build Amazon direct image URL from ASIN
/// URL patterns: https://images-na.ssl-images-amazon.com/images/P/{ASIN}.01._SCLZZZZZZZ_.jpg
/// Sizes: SL500 (500px), SL1500 (1500px), SL2400 (2400px)
pub fn build_amazon_image_urls(asin: &str) -> Vec<CoverCandidate> {
    let mut candidates = Vec::new();

    // Primary Amazon image URL pattern (media-amazon)
    let sizes = [
        ("_SL2400_", 2400u32),
        ("_SL1500_", 1500u32),
        ("_SL500_", 500u32),
    ];

    for (suffix, size) in sizes {
        // Note: Amazon image URLs require the actual image ID, not just ASIN
        // The ASIN alone doesn't directly map to an image URL
        // These URLs are constructed for when we get the image ID from Audible scraping
        let url = format!(
            "https://m.media-amazon.com/images/I/{}{}.jpg",
            asin, suffix
        );

        let mut candidate = CoverCandidate::new(url, CoverSource::Amazon)
            .with_dimensions(size, size);
        candidate.calculate_score();
        candidates.push(candidate);
    }

    candidates
}

/// Extract and enhance Google Books cover URL with higher resolution
/// Replaces zoom=1 with zoom=3 for higher resolution
pub fn enhance_google_books_cover_url(url: &str) -> String {
    let mut enhanced = url.to_string();

    // Remove any edge=curl parameter that distorts the image
    enhanced = enhanced.replace("&edge=curl", "");

    // Upgrade zoom level for higher resolution
    if enhanced.contains("zoom=1") {
        enhanced = enhanced.replace("zoom=1", "zoom=3");
    } else if enhanced.contains("zoom=0") {
        enhanced = enhanced.replace("zoom=0", "zoom=3");
    } else if !enhanced.contains("zoom=") {
        // Add zoom parameter if not present
        if enhanced.contains('?') {
            enhanced.push_str("&zoom=3");
        } else {
            enhanced.push_str("?zoom=3");
        }
    }

    // Ensure HTTPS
    if enhanced.starts_with("http://") {
        enhanced = enhanced.replacen("http://", "https://", 1);
    }

    enhanced
}

/// Fetch cover from Google Books API
pub async fn fetch_google_books_cover(title: &str, author: &str) -> Option<CoverCandidate> {
    println!("   📚 Trying Google Books cover...");

    let query = format!("intitle:{} inauthor:{}", title, author);
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&maxResults=1",
        urlencoding::encode(&query)
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;

    let response = client.get(&url).send().await.ok()?;

    if !response.status().is_success() {
        println!("   ⚠️  Google Books API error");
        return None;
    }

    let json: serde_json::Value = response.json().await.ok()?;

    let items = json["items"].as_array()?;
    let first_item = items.first()?;
    let volume_info = &first_item["volumeInfo"];
    let image_links = &volume_info["imageLinks"];

    // Try to get the best available image
    let cover_url = image_links["extraLarge"]
        .as_str()
        .or_else(|| image_links["large"].as_str())
        .or_else(|| image_links["medium"].as_str())
        .or_else(|| image_links["small"].as_str())
        .or_else(|| image_links["thumbnail"].as_str())?;

    let enhanced_url = enhance_google_books_cover_url(cover_url);
    let book_title = volume_info["title"].as_str().map(|s| s.to_string());

    // Estimate dimensions based on which size we got
    let (width, height) = if image_links["extraLarge"].is_string() {
        (800, 1200)
    } else if image_links["large"].is_string() {
        (600, 900)
    } else if image_links["medium"].is_string() {
        (400, 600)
    } else {
        (200, 300)
    };

    let mut candidate = CoverCandidate::new(enhanced_url, CoverSource::GoogleBooks)
        .with_dimensions(width, height);
    if let Some(title) = book_title {
        candidate = candidate.with_title(title);
    }
    candidate.calculate_score();

    println!("   ✅ Google Books cover found");
    Some(candidate)
}

/// Multi-source cover search - searches all sources and returns ranked candidates
pub async fn search_all_cover_sources(
    title: &str,
    author: &str,
    isbn: Option<&str>,
    asin: Option<&str>,
) -> CoverSearchResult {
    // Try to load LibraryThing dev key from config
    let librarything_key = crate::config::load_config()
        .ok()
        .and_then(|c| c.librarything_dev_key);

    search_all_cover_sources_with_key(title, author, isbn, asin, librarything_key.as_deref()).await
}

/// Multi-source cover search with explicit LibraryThing key
pub async fn search_all_cover_sources_with_key(
    title: &str,
    author: &str,
    isbn: Option<&str>,
    asin: Option<&str>,
    librarything_key: Option<&str>,
) -> CoverSearchResult {
    println!("   🖼️  Searching all cover sources...");

    let mut candidates = Vec::new();

    // Use tokio::join! for parallel fetching
    let (itunes_result, audible_result, google_result, openlibrary_result, librarything_result) = tokio::join!(
        fetch_itunes_candidates(title, author),
        async {
            if let Some(asin_str) = asin {
                fetch_audible_candidates(asin_str).await
            } else {
                Vec::new()
            }
        },
        fetch_google_books_cover(title, author),
        async {
            if let Some(isbn_str) = isbn {
                fetch_openlibrary_cover(isbn_str).await
            } else {
                None
            }
        },
        async {
            if let (Some(isbn_str), Some(key)) = (isbn, librarything_key) {
                fetch_librarything_cover(isbn_str, key).await
            } else {
                None
            }
        }
    );

    // Collect all candidates
    candidates.extend(itunes_result);
    candidates.extend(audible_result);
    if let Some(google) = google_result {
        candidates.push(google);
    }
    if let Some(openlibrary) = openlibrary_result {
        candidates.push(openlibrary);
    }
    if let Some(librarything) = librarything_result {
        candidates.push(librarything);
    }

    // Add Amazon direct URLs if we have ASIN
    if let Some(asin_str) = asin {
        candidates.extend(build_amazon_image_urls(asin_str));
    }

    // Sort by quality score (highest first)
    candidates.sort_by(|a, b| b.quality_score.cmp(&a.quality_score));

    let best = candidates.first().cloned();

    println!("   📊 Found {} cover candidates", candidates.len());

    CoverSearchResult {
        candidates,
        best_candidate: best,
    }
}

/// Fetch cover candidates from iTunes
async fn fetch_itunes_candidates(title: &str, author: &str) -> Vec<CoverCandidate> {
    println!("   🍎 Searching iTunes/Apple Books...");

    let search_query = format!("{} {}", title, author);
    let search_url = format!(
        "https://itunes.apple.com/search?term={}&media=audiobook&entity=audiobook&limit=5",
        urlencoding::encode(&search_query)
    );

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let response = match client.get(&search_url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };

    let json: serde_json::Value = match response.json().await {
        Ok(j) => j,
        Err(_) => return Vec::new(),
    };

    let results = match json["results"].as_array() {
        Some(r) => r,
        None => return Vec::new(),
    };

    let mut candidates = Vec::new();

    for result in results.iter().take(5) {
        if let Some(artwork_url) = result["artworkUrl100"].as_str() {
            let high_res_url = artwork_url
                .replace("100x100", "2048x2048")
                .replace("100x100bb", "2048x2048bb");

            let book_name = result["collectionName"]
                .as_str()
                .unwrap_or("Unknown")
                .to_string();

            let mut candidate = CoverCandidate::new(high_res_url, CoverSource::ITunes)
                .with_dimensions(2048, 2048)
                .with_title(book_name);
            candidate.calculate_score();
            candidates.push(candidate);
        }
    }

    if !candidates.is_empty() {
        println!("   ✅ Found {} iTunes covers", candidates.len());
    }

    candidates
}

/// Fetch cover candidates from Audible
async fn fetch_audible_candidates(asin: &str) -> Vec<CoverCandidate> {
    println!("   🎧 Searching Audible (ASIN: {})...", asin);

    let product_url = format!("https://www.audible.com/pd/{}", asin);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .build() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let response = match client.get(&product_url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };

    let html = match response.text().await {
        Ok(h) => h,
        Err(_) => return Vec::new(),
    };

    let mut candidates = Vec::new();

    // Look for the cover image URL in the page
    if let Some(start) = html.find("https://m.media-amazon.com/images/I/") {
        let substr = &html[start..];
        if let Some(end) = substr.find(".jpg") {
            let base_url = &substr[..end];

            // Extract the image ID (removing any size suffix)
            let image_id = base_url
                .replace("https://m.media-amazon.com/images/I/", "")
                .split('.')
                .next()
                .unwrap_or("")
                .to_string();

            if !image_id.is_empty() {
                // Create candidates with different sizes
                let sizes = [
                    ("_SL2400_", 2400u32),
                    ("_SL1500_", 1500u32),
                    ("_SL500_", 500u32),
                ];

                for (suffix, size) in sizes {
                    let url = format!(
                        "https://m.media-amazon.com/images/I/{}{}.jpg",
                        image_id, suffix
                    );

                    let mut candidate = CoverCandidate::new(url, CoverSource::Audible)
                        .with_dimensions(size, size);
                    candidate.calculate_score();
                    candidates.push(candidate);
                }
            }
        }
    }

    if !candidates.is_empty() {
        println!("   ✅ Found {} Audible covers", candidates.len());
    }

    candidates
}

/// Download and validate a cover image, returning dimensions and size
pub async fn download_and_validate_cover(
    url: &str,
) -> Result<(Vec<u8>, String, u32, u32), Box<dyn std::error::Error + Send + Sync>> {
    let cover = download_cover(url).await?;

    let data = cover.data.ok_or("No image data")?;
    let mime = cover.mime_type.unwrap_or_else(|| "image/jpeg".to_string());

    // Get dimensions from the image data
    let (width, height) = get_image_dimensions_from_data(&data);

    // Validate it's not a placeholder (too small or wrong dimensions)
    if width < 50 || height < 50 {
        return Err("Image too small - likely a placeholder".into());
    }

    Ok((data, mime, width, height))
}

/// Extract image dimensions from raw image data
pub fn get_image_dimensions_from_data(data: &[u8]) -> (u32, u32) {
    // Check for JPEG
    if data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8 {
        let mut i = 2;
        while i < data.len().saturating_sub(9) {
            if data[i] == 0xFF {
                let marker = data[i + 1];
                // SOF0, SOF1, SOF2 markers contain dimensions
                if marker == 0xC0 || marker == 0xC1 || marker == 0xC2 {
                    let height = ((data[i + 5] as u32) << 8) | (data[i + 6] as u32);
                    let width = ((data[i + 7] as u32) << 8) | (data[i + 8] as u32);
                    return (width, height);
                }
                if marker != 0x00 && marker != 0xFF && i + 3 < data.len() {
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
        return (width, height);
    }

    (0, 0)
}

/// Known placeholder image hashes to reject
/// These are common "no cover" images that sources return
const PLACEHOLDER_HASHES: &[u64] = &[
    // Common blank/placeholder image hashes (computed using simple sum)
    // Add more as they're discovered
    0,
];

/// Check if image data is a known placeholder
pub fn is_placeholder_image(data: &[u8]) -> bool {
    // Check minimum size
    if data.len() < 1000 {
        return true;
    }

    // Simple hash for comparison
    let hash: u64 = data.iter().map(|&b| b as u64).sum();

    if PLACEHOLDER_HASHES.contains(&hash) {
        return true;
    }

    // Check dimensions
    let (width, height) = get_image_dimensions_from_data(data);
    if width < 50 || height < 50 {
        return true;
    }

    false
}