// src-tauri/src/abs_cache.rs
// Centralized ABS library cache - stores all data from ABS in memory
// Provides single source of truth for all ABS operations

use crate::config;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ============================================================================
// CACHE STORAGE
// ============================================================================

/// Global cache of ABS library data
static ABS_CACHE: Lazy<Mutex<AbsCacheState>> = Lazy::new(|| {
    Mutex::new(AbsCacheState {
        items: HashMap::new(),
        last_refresh: None,
        library_id: None,
    })
});

#[derive(Debug, Clone)]
pub struct AbsCacheState {
    pub items: HashMap<String, CachedAbsItem>,
    pub last_refresh: Option<Instant>,
    pub library_id: Option<String>,
}

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/// Comprehensive cached item with all data from ABS
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedAbsItem {
    pub id: String,
    pub path: String,
    #[serde(rename = "libraryId")]
    pub library_id: String,

    // Metadata
    pub metadata: CachedMetadata,

    // Audio files with details
    pub audio_files: Vec<CachedAudioFile>,

    // Chapters
    pub chapters: Vec<CachedChapter>,

    // Cover info
    pub cover_path: Option<String>,
    pub cover_url: Option<String>,

    // Durations and size
    pub duration: Option<f64>,  // Total duration in seconds
    pub size: Option<u64>,      // Total size in bytes

    // Timestamps
    #[serde(rename = "addedAt")]
    pub added_at: Option<i64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CachedMetadata {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub authors: Vec<CachedPerson>,
    pub narrators: Vec<String>,
    pub series: Vec<CachedSeries>,
    pub genres: Vec<String>,
    pub tags: Vec<String>,
    #[serde(rename = "publishedYear")]
    pub published_year: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
    pub asin: Option<String>,
    pub language: Option<String>,
    pub explicit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedPerson {
    pub id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedSeries {
    pub id: Option<String>,
    pub name: String,
    pub sequence: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedAudioFile {
    pub index: i32,
    pub ino: Option<String>,
    pub filename: String,
    pub path: String,
    #[serde(rename = "relPath")]
    pub rel_path: Option<String>,

    // Technical details
    pub format: Option<String>,
    pub duration: Option<f64>,      // Duration in seconds
    pub size: Option<u64>,          // Size in bytes
    pub bitrate: Option<u32>,       // Bitrate in kbps
    pub codec: Option<String>,
    pub channels: Option<u32>,
    #[serde(rename = "sampleRate")]
    pub sample_rate: Option<u32>,

    // Embedded metadata from file tags
    #[serde(rename = "metaTags")]
    pub meta_tags: Option<FileMetaTags>,

    // Timestamps
    #[serde(rename = "addedAt")]
    pub added_at: Option<i64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FileMetaTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    #[serde(rename = "albumArtist")]
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track: Option<String>,
    pub comment: Option<String>,
    pub composer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedChapter {
    pub id: i32,
    pub start: f64,     // Start time in seconds
    pub end: f64,       // End time in seconds
    pub title: String,
}

// ============================================================================
// API RESPONSE TYPES (for deserialization)
// ============================================================================

#[derive(Debug, Deserialize)]
struct AbsItemResponse {
    id: String,
    path: String,
    #[serde(rename = "libraryId")]
    library_id: String,
    media: Option<AbsMediaResponse>,
    #[serde(rename = "addedAt")]
    added_at: Option<i64>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AbsMediaResponse {
    metadata: Option<Value>,
    #[serde(rename = "coverPath")]
    cover_path: Option<String>,
    #[serde(rename = "audioFiles", default)]
    audio_files: Vec<Value>,
    #[serde(default)]
    chapters: Vec<Value>,
    duration: Option<f64>,
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct AbsItemsPageResponse {
    results: Vec<Value>,
    total: Option<usize>,
    limit: Option<usize>,
    page: Option<usize>,
}

// ============================================================================
// CACHE OPERATIONS
// ============================================================================

/// Refresh the entire ABS library cache
/// Fetches all items with full details including files and chapters
pub async fn refresh_cache(
    config: &config::Config,
    progress_callback: Option<Box<dyn Fn(String, usize, usize) + Send + Sync>>,
) -> Result<usize, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() {
        return Err("ABS not configured".to_string());
    }

    // Phase 1: Fetch all item IDs
    if let Some(ref cb) = progress_callback {
        cb("Fetching library items...".to_string(), 0, 0);
    }

    let mut all_items: HashMap<String, CachedAbsItem> = HashMap::new();
    let mut page = 0;
    let limit = 100;
    let mut total_items = 0;

    // First pass: get basic item data
    loop {
        let url = format!(
            "{}/api/libraries/{}/items?limit={}&page={}&expanded=1&include=chapters,audioFiles",
            config.abs_base_url, config.abs_library_id, limit, page
        );

        let response = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch library: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("ABS returned error: {}", response.status()));
        }

        let page_response: AbsItemsPageResponse = response.json().await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        let count = page_response.results.len();
        if total_items == 0 {
            total_items = page_response.total.unwrap_or(0);
        }

        // Parse each item
        for item_value in page_response.results {
            if let Some(cached) = parse_item_from_value(&item_value, config) {
                all_items.insert(cached.id.clone(), cached);
            }
        }

        if let Some(ref cb) = progress_callback {
            cb(
                format!("Loaded {} items...", all_items.len()),
                all_items.len(),
                total_items,
            );
        }

        if count < limit {
            break;
        }
        page += 1;
    }

    // Phase 2: For items missing chapters/files, fetch individual details
    let items_needing_details: Vec<String> = all_items
        .values()
        .filter(|item| item.audio_files.is_empty() && item.chapters.is_empty())
        .map(|item| item.id.clone())
        .collect();

    if !items_needing_details.is_empty() {
        if let Some(ref cb) = progress_callback {
            cb(
                format!("Fetching details for {} items...", items_needing_details.len()),
                all_items.len(),
                total_items,
            );
        }

        // Fetch individual item details in parallel (10 concurrent)
        use futures::stream::{self, StreamExt};

        let detail_results: Vec<(String, Option<CachedAbsItem>)> = stream::iter(items_needing_details)
            .map(|item_id| {
                let client = client.clone();
                let config = config.clone();
                async move {
                    let result = fetch_single_item(&client, &config, &item_id).await;
                    (item_id, result.ok())
                }
            })
            .buffer_unordered(10)
            .collect()
            .await;

        for (item_id, maybe_item) in detail_results {
            if let Some(item) = maybe_item {
                all_items.insert(item_id, item);
            }
        }
    }

    let total = all_items.len();

    // Update cache
    {
        let mut cache = ABS_CACHE.lock().map_err(|_| "Cache lock failed")?;
        cache.items = all_items;
        cache.last_refresh = Some(Instant::now());
        cache.library_id = Some(config.abs_library_id.clone());
    }

    if let Some(ref cb) = progress_callback {
        cb(format!("Cache loaded: {} items", total), total, total);
    }

    println!("📚 ABS Cache refreshed: {} items loaded", total);
    Ok(total)
}

/// Fetch a single item with full details
async fn fetch_single_item(
    client: &reqwest::Client,
    config: &config::Config,
    item_id: &str,
) -> Result<CachedAbsItem, String> {
    let url = format!(
        "{}/api/items/{}?expanded=1&include=chapters,audioFiles",
        config.abs_base_url, item_id
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch item: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Item fetch failed: {}", response.status()));
    }

    let item_value: Value = response.json().await
        .map_err(|e| format!("Failed to parse item: {}", e))?;

    parse_item_from_value(&item_value, config)
        .ok_or_else(|| "Failed to parse item data".to_string())
}

/// Parse a single item from JSON value
fn parse_item_from_value(value: &Value, config: &config::Config) -> Option<CachedAbsItem> {
    let id = value.get("id")?.as_str()?.to_string();
    let path = value.get("path")?.as_str()?.to_string();
    let library_id = value.get("libraryId")
        .and_then(|v| v.as_str())
        .unwrap_or(&config.abs_library_id)
        .to_string();

    let media = value.get("media")?;

    // Parse metadata
    let metadata = parse_metadata(media.get("metadata"));

    // Parse audio files
    let audio_files = parse_audio_files(media.get("audioFiles"));

    // Parse chapters
    let chapters = parse_chapters(media.get("chapters"));

    // Cover info
    let cover_path = media.get("coverPath")
        .and_then(|v| v.as_str())
        .map(String::from);

    let cover_url = if cover_path.is_some() {
        Some(format!("{}/api/items/{}/cover", config.abs_base_url, id))
    } else {
        None
    };

    // Duration and size
    let duration = media.get("duration").and_then(|v| v.as_f64());
    let size = media.get("size").and_then(|v| v.as_u64());

    // Timestamps
    let added_at = value.get("addedAt").and_then(|v| v.as_i64());
    let updated_at = value.get("updatedAt").and_then(|v| v.as_i64());

    // Merge item-level tags into metadata tags (ABS stores tags at item level)
    let item_level_tags: Vec<String> = value.get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let media_level_tags: Vec<String> = media.get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let mut metadata = metadata;
    // Use item-level tags first, fall back to media-level, then metadata-level
    if !item_level_tags.is_empty() {
        metadata.tags = item_level_tags;
    } else if !media_level_tags.is_empty() {
        metadata.tags = media_level_tags;
    }
    // else keep whatever parse_metadata found in metadata.tags

    Some(CachedAbsItem {
        id,
        path,
        library_id,
        metadata,
        audio_files,
        chapters,
        cover_path,
        cover_url,
        duration,
        size,
        added_at,
        updated_at,
    })
}

fn parse_metadata(metadata: Option<&Value>) -> CachedMetadata {
    let Some(meta) = metadata else {
        return CachedMetadata::default();
    };

    // Parse authors - handle both string and object formats
    let authors: Vec<CachedPerson> = meta.get("authors")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().filter_map(|a| {
                if let Some(name) = a.as_str() {
                    Some(CachedPerson { id: None, name: name.to_string() })
                } else if let Some(obj) = a.as_object() {
                    Some(CachedPerson {
                        id: obj.get("id").and_then(|v| v.as_str()).map(String::from),
                        name: obj.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    })
                } else {
                    None
                }
            }).collect()
        })
        .unwrap_or_default();

    // Parse narrators - array of strings
    let narrators: Vec<String> = meta.get("narrators")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Parse series - handle various formats
    let series: Vec<CachedSeries> = meta.get("series")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().filter_map(|s| {
                if let Some(obj) = s.as_object() {
                    let name = obj.get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if name.is_empty() {
                        return None;
                    }
                    let sequence = obj.get("sequence").and_then(|v| {
                        if let Some(s) = v.as_str() {
                            if !s.is_empty() { Some(s.to_string()) } else { None }
                        } else if let Some(n) = v.as_f64() {
                            if n.fract() == 0.0 {
                                Some((n as i64).to_string())
                            } else {
                                Some(format!("{:.1}", n))
                            }
                        } else if let Some(n) = v.as_i64() {
                            Some(n.to_string())
                        } else {
                            None
                        }
                    });
                    Some(CachedSeries {
                        id: obj.get("id").and_then(|v| v.as_str()).map(String::from),
                        name,
                        sequence,
                    })
                } else {
                    None
                }
            }).collect()
        })
        .unwrap_or_default();

    // Parse genres
    let genres: Vec<String> = meta.get("genres")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Parse tags
    let tags: Vec<String> = meta.get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    CachedMetadata {
        title: meta.get("title").and_then(|v| v.as_str()).map(String::from),
        subtitle: meta.get("subtitle").and_then(|v| v.as_str()).map(String::from),
        authors,
        narrators,
        series,
        genres,
        tags,
        published_year: meta.get("publishedYear").and_then(|v| v.as_str()).map(String::from),
        publisher: meta.get("publisher").and_then(|v| v.as_str()).map(String::from),
        description: meta.get("description").and_then(|v| v.as_str()).map(String::from),
        isbn: meta.get("isbn").and_then(|v| v.as_str()).map(String::from),
        asin: meta.get("asin").and_then(|v| v.as_str()).map(String::from),
        language: meta.get("language").and_then(|v| v.as_str()).map(String::from),
        explicit: meta.get("explicit").and_then(|v| v.as_bool()),
    }
}

fn parse_audio_files(files: Option<&Value>) -> Vec<CachedAudioFile> {
    let Some(arr) = files.and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    arr.iter().filter_map(|f| {
        let obj = f.as_object()?;

        // Parse meta tags if present
        let meta_tags = obj.get("metaTags").and_then(|mt| mt.as_object()).map(|mt| {
            FileMetaTags {
                title: mt.get("tagTitle").and_then(|v| v.as_str()).map(String::from),
                artist: mt.get("tagArtist").and_then(|v| v.as_str()).map(String::from),
                album: mt.get("tagAlbum").and_then(|v| v.as_str()).map(String::from),
                album_artist: mt.get("tagAlbumArtist").and_then(|v| v.as_str()).map(String::from),
                genre: mt.get("tagGenre").and_then(|v| v.as_str()).map(String::from),
                year: mt.get("tagYear").and_then(|v| v.as_str()).map(String::from),
                track: mt.get("tagTrack").and_then(|v| v.as_str()).map(String::from),
                comment: mt.get("tagComment").and_then(|v| v.as_str()).map(String::from),
                composer: mt.get("tagComposer").and_then(|v| v.as_str()).map(String::from),
            }
        });

        Some(CachedAudioFile {
            index: obj.get("index").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            ino: obj.get("ino").and_then(|v| v.as_str()).map(String::from),
            filename: obj.get("metadata")
                .and_then(|m| m.get("filename"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            path: obj.get("metadata")
                .and_then(|m| m.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            rel_path: obj.get("metadata")
                .and_then(|m| m.get("relPath"))
                .and_then(|v| v.as_str())
                .map(String::from),
            format: obj.get("format").and_then(|v| v.as_str()).map(String::from),
            duration: obj.get("duration").and_then(|v| v.as_f64()),
            size: obj.get("metadata")
                .and_then(|m| m.get("size"))
                .and_then(|v| v.as_u64()),
            bitrate: obj.get("bitRate").and_then(|v| v.as_u64()).map(|v| v as u32),
            codec: obj.get("codec").and_then(|v| v.as_str()).map(String::from),
            channels: obj.get("channels").and_then(|v| v.as_u64()).map(|v| v as u32),
            sample_rate: obj.get("sampleRate").and_then(|v| v.as_u64()).map(|v| v as u32),
            meta_tags,
            added_at: obj.get("addedAt").and_then(|v| v.as_i64()),
            updated_at: obj.get("updatedAt").and_then(|v| v.as_i64()),
        })
    }).collect()
}

fn parse_chapters(chapters: Option<&Value>) -> Vec<CachedChapter> {
    let Some(arr) = chapters.and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    arr.iter().filter_map(|c| {
        let obj = c.as_object()?;
        Some(CachedChapter {
            id: obj.get("id").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            start: obj.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0),
            end: obj.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0),
            title: obj.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
    }).collect()
}

// ============================================================================
// CACHE ACCESS FUNCTIONS
// ============================================================================

/// Get a single item from cache by ID
pub fn get_item(id: &str) -> Option<CachedAbsItem> {
    ABS_CACHE.lock().ok()?.items.get(id).cloned()
}

/// Get all items from cache
pub fn get_all_items() -> Vec<CachedAbsItem> {
    ABS_CACHE.lock().ok()
        .map(|cache| cache.items.values().cloned().collect())
        .unwrap_or_default()
}

/// Get items by path prefix
pub fn get_items_by_path_prefix(prefix: &str) -> Vec<CachedAbsItem> {
    ABS_CACHE.lock().ok()
        .map(|cache| {
            cache.items.values()
                .filter(|item| item.path.starts_with(prefix))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Find item by path (exact or partial match)
pub fn find_by_path(path: &str) -> Option<CachedAbsItem> {
    let normalized = path.trim().replace('\\', "/");
    ABS_CACHE.lock().ok()?.items.values()
        .find(|item| {
            let item_path = item.path.replace('\\', "/");
            item_path == normalized || item_path.ends_with(&normalized) || normalized.ends_with(&item_path)
        })
        .cloned()
}

/// Get cache stats
pub fn get_cache_stats() -> CacheStats {
    let cache = match ABS_CACHE.lock() {
        Ok(c) => c,
        Err(_) => return CacheStats::default(),
    };

    let total_items = cache.items.len();
    let items_with_chapters = cache.items.values()
        .filter(|item| !item.chapters.is_empty())
        .count();
    let items_with_files = cache.items.values()
        .filter(|item| !item.audio_files.is_empty())
        .count();
    let total_files: usize = cache.items.values()
        .map(|item| item.audio_files.len())
        .sum();
    let total_size: u64 = cache.items.values()
        .filter_map(|item| item.size)
        .sum();
    let age_seconds = cache.last_refresh
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0);

    CacheStats {
        total_items,
        items_with_chapters,
        items_with_files,
        total_files,
        total_size_bytes: total_size,
        age_seconds,
        library_id: cache.library_id.clone(),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CacheStats {
    pub total_items: usize,
    pub items_with_chapters: usize,
    pub items_with_files: usize,
    pub total_files: usize,
    pub total_size_bytes: u64,
    pub age_seconds: u64,
    pub library_id: Option<String>,
}

/// Check if cache is stale (older than threshold)
pub fn is_cache_stale(max_age_seconds: u64) -> bool {
    ABS_CACHE.lock().ok()
        .map(|cache| {
            cache.last_refresh
                .map(|t| t.elapsed().as_secs() > max_age_seconds)
                .unwrap_or(true)
        })
        .unwrap_or(true)
}

/// Clear the cache
pub fn clear_cache() {
    if let Ok(mut cache) = ABS_CACHE.lock() {
        cache.items.clear();
        cache.last_refresh = None;
        cache.library_id = None;
    }
}

/// Update a single item in cache (e.g., after push)
pub fn update_item(item: CachedAbsItem) {
    if let Ok(mut cache) = ABS_CACHE.lock() {
        cache.items.insert(item.id.clone(), item);
    }
}

/// Get unprocessed items (missing DNA tags or incomplete metadata)
pub fn get_unprocessed_items() -> Vec<(CachedAbsItem, Vec<String>)> {
    ABS_CACHE.lock().ok()
        .map(|cache| {
            cache.items.values()
                .filter_map(|item| {
                    let mut reasons = Vec::new();

                    // Check for DNA tags
                    let has_dna = item.metadata.tags.iter().any(|t| t.starts_with("dna:"));
                    if !has_dna {
                        reasons.push("No DNA tags".to_string());
                    }

                    // Check metadata completeness
                    if item.metadata.genres.is_empty() {
                        reasons.push("No genres".to_string());
                    }
                    if item.metadata.description.as_ref().map_or(true, |d| d.is_empty()) {
                        reasons.push("No description".to_string());
                    }
                    if item.metadata.narrators.is_empty() {
                        reasons.push("No narrator".to_string());
                    }
                    if item.metadata.series.is_empty() {
                        reasons.push("No series".to_string());
                    }

                    if reasons.is_empty() {
                        None
                    } else {
                        Some((item.clone(), reasons))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Invalidate cache (mark as stale without clearing)
pub fn invalidate_cache() {
    if let Ok(mut cache) = ABS_CACHE.lock() {
        cache.last_refresh = None;
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_stats_default() {
        let stats = CacheStats::default();
        assert_eq!(stats.total_items, 0);
        assert_eq!(stats.total_files, 0);
    }

    #[test]
    fn test_parse_metadata_empty() {
        let meta = parse_metadata(None);
        assert!(meta.title.is_none());
        assert!(meta.authors.is_empty());
    }

    #[test]
    fn test_parse_metadata_basic() {
        let json = serde_json::json!({
            "title": "Test Book",
            "authors": [{"name": "Test Author"}],
            "narrators": ["Test Narrator"],
            "series": [{"name": "Test Series", "sequence": "1"}],
            "genres": ["Fiction"],
        });

        let meta = parse_metadata(Some(&json));
        assert_eq!(meta.title, Some("Test Book".to_string()));
        assert_eq!(meta.authors.len(), 1);
        assert_eq!(meta.authors[0].name, "Test Author");
        assert_eq!(meta.narrators, vec!["Test Narrator".to_string()]);
        assert_eq!(meta.series.len(), 1);
        assert_eq!(meta.series[0].name, "Test Series");
        assert_eq!(meta.series[0].sequence, Some("1".to_string()));
        assert_eq!(meta.genres, vec!["Fiction".to_string()]);
    }

    #[test]
    fn test_parse_chapters() {
        let json = serde_json::json!([
            {"id": 0, "start": 0.0, "end": 100.5, "title": "Chapter 1"},
            {"id": 1, "start": 100.5, "end": 200.0, "title": "Chapter 2"},
        ]);

        let chapters = parse_chapters(Some(&json));
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title, "Chapter 1");
        assert_eq!(chapters[0].start, 0.0);
        assert_eq!(chapters[0].end, 100.5);
        assert_eq!(chapters[1].title, "Chapter 2");
    }
}
