use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverArt {
    pub url: Option<String>,
    pub data: Option<Vec<u8>>,
    pub mime_type: Option<String>,
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