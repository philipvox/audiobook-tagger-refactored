// src-tauri/src/commands/maintenance.rs - Complete file
use crate::{config, genres};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;

#[derive(Debug, Deserialize)]
struct LibraryFilterData {
    genres: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct LibraryItem {
    id: String,
    media: Media,
    #[serde(rename = "libraryFiles", default)]
    library_files: Vec<LibraryFile>,
}

#[derive(Debug, Deserialize, Clone)]
struct LibraryFile {
    #[serde(rename = "ino")]
    _ino: Option<String>,
    metadata: FileMetadata,
}

#[derive(Debug, Deserialize, Clone)]
struct FileMetadata {
    filename: Option<String>,
    ext: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Media {
    metadata: ItemMetadata,
    #[serde(rename = "audioFiles", default)]
    audio_files: Vec<AudioFileInfo>,
}

#[derive(Debug, Deserialize)]
struct AudioFileInfo {
    metadata: Option<AudioFileMetadata>,
}

#[derive(Debug, Deserialize)]
struct AudioFileMetadata {
    #[serde(rename = "tagArtist")]
    tag_artist: Option<String>,
    #[serde(rename = "tagAlbumArtist")]
    tag_album_artist: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ItemMetadata {
    genres: Option<Vec<String>>,
    title: Option<String>,
    #[serde(rename = "authorName")]
    author_name: Option<String>,
    authors: Option<Vec<AuthorInfo>>,
}

#[derive(Debug, Deserialize)]
struct AuthorInfo {
    name: String,
}

#[derive(Debug, Deserialize)]
struct LibraryItemsResponse {
    results: Vec<LibraryItem>,
}

#[tauri::command]
pub async fn clear_cache() -> Result<String, String> {
    crate::cache::clear().map_err(|e| e.to_string())?;
    Ok("Cache cleared successfully".to_string())
}

/// Get cache statistics
#[tauri::command]
pub async fn get_cache_stats() -> Result<String, String> {
    // Get count of cached items from sled
    let count = crate::cache::count().unwrap_or(0);
    Ok(format!("{} cached entries", count))
}

/// Clear unused genres from AudiobookShelf
/// This removes genres from the dropdown that are not assigned to any book
#[tauri::command]
pub async fn clear_all_genres() -> Result<String, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;

    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() || config.abs_library_id.is_empty() {
        return Err("AudiobookShelf not configured".to_string());
    }

    let client = reqwest::Client::new();

    // Fetch all genres from the filter/dropdown data
    let filter_url = format!("{}/api/libraries/{}/filterdata", config.abs_base_url, config.abs_library_id);
    let filter_response = client
        .get(&filter_url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch filter data: {}", e))?;

    if !filter_response.status().is_success() {
        return Err(format!("Failed to fetch filter data: {}", filter_response.status()));
    }

    let filter_data: LibraryFilterData = filter_response.json().await.map_err(|e| e.to_string())?;
    let all_dropdown_genres: HashSet<String> = filter_data.genres.into_iter().collect();
    let initial_genre_count = all_dropdown_genres.len();

    // Fetch ALL library items with pagination to find which genres are actually in use
    let mut used_genres: HashSet<String> = HashSet::new();
    let mut page = 0;
    let limit = 500;

    loop {
        let items_url = format!(
            "{}/api/libraries/{}/items?limit={}&page={}",
            config.abs_base_url, config.abs_library_id, limit, page
        );

        let items_response = client
            .get(&items_url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch items page {}: {}", page, e))?;

        if !items_response.status().is_success() {
            return Err(format!("Failed to fetch items: {}", items_response.status()));
        }

        let items: LibraryItemsResponse = items_response.json().await.map_err(|e| e.to_string())?;
        let batch_size = items.results.len();

        // Collect genres from this batch
        for item in items.results {
            if let Some(genres) = item.media.metadata.genres {
                used_genres.extend(genres);
            }
        }

        // Check if we've fetched all items
        if batch_size < limit {
            break;
        }
        page += 1;

        // Safety limit to prevent infinite loops
        if page > 100 {
            println!("⚠️ Reached page limit, library may have >50,000 items");
            break;
        }
    }

    // Find unused genres (in dropdown but not assigned to any book)
    let unused_genres: Vec<String> = all_dropdown_genres
        .iter()
        .filter(|g| !used_genres.contains(*g))
        .cloned()
        .collect();

    if unused_genres.is_empty() {
        return Ok(format!(
            "No unused genres found - all {} genres are assigned to at least one book",
            initial_genre_count
        ));
    }

    println!("📋 Found {} unused genres: {:?}", unused_genres.len(), unused_genres);

    // Step 1: Purge the library cache to clear stale filterdata
    let cache_url = format!("{}/api/libraries/{}/purge-cache", config.abs_base_url, config.abs_library_id);
    let cache_result = client
        .post(&cache_url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await;

    match &cache_result {
        Ok(resp) if resp.status().is_success() => {
            println!("✅ Library cache purged successfully");
        }
        Ok(resp) => {
            println!("⚠️ Cache purge returned status: {}", resp.status());
        }
        Err(e) => {
            println!("⚠️ Cache purge failed: {}", e);
        }
    }

    // Step 2: Wait briefly for cache to clear
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Step 3: Force filterdata rebuild by making a fresh request
    let rebuild_response = client
        .get(&filter_url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await;

    // Step 4: Verify the genres were removed
    let final_genre_count = match rebuild_response {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<LibraryFilterData>().await {
                Ok(data) => {
                    let remaining_unused: Vec<&String> = unused_genres
                        .iter()
                        .filter(|g| data.genres.contains(g))
                        .collect();

                    if remaining_unused.is_empty() {
                        println!("✅ All {} unused genres successfully removed", unused_genres.len());
                        Some((data.genres.len(), true))
                    } else {
                        println!("⚠️ {} genres still remain in dropdown", remaining_unused.len());
                        Some((data.genres.len(), false))
                    }
                }
                Err(_) => None,
            }
        }
        _ => None,
    };

    match final_genre_count {
        Some((new_count, true)) => {
            Ok(format!(
                "Successfully cleared {} unused genres! ({} → {} genres in dropdown)",
                unused_genres.len(),
                initial_genre_count,
                new_count
            ))
        }
        Some((new_count, false)) => {
            // Genres still present after cache purge - they may still be assigned to items
            // or embedded in file tags. Do NOT trigger a scan as that would re-import from files.
            Ok(format!(
                "Found {} genres not currently assigned to books: {}. Cache purged but genres remain - they may be embedded in audio file tags. Use 'Write Tags' after scanning to update file tags, or restart ABS to fully clear the cache.",
                unused_genres.len(),
                unused_genres.join(", ")
            ))
        }
        None => {
            Ok(format!(
                "Purged cache for {} unused genres: {}. Refresh the ABS page to see updated genre list.",
                unused_genres.len(),
                unused_genres.join(", ")
            ))
        }
    }
}

/// Check if a genre string contains combined genres that need splitting
fn is_combined_genre(genre: &str) -> bool {
    genre.contains(" / ") || genre.contains(", ") || genre.contains(" & ")
}

/// Get genre statistics from AudiobookShelf
#[tauri::command]
pub async fn get_genre_stats() -> Result<String, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;

    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() || config.abs_library_id.is_empty() {
        return Err("AudiobookShelf not configured".to_string());
    }

    let client = reqwest::Client::new();
    let filter_url = format!("{}/api/libraries/{}/filterdata", config.abs_base_url, config.abs_library_id);

    let filter_response = client
        .get(&filter_url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch filter data: {}", e))?;

    if !filter_response.status().is_success() {
        return Err(format!("Failed to fetch filter data: {}", filter_response.status()));
    }

    let filter_data: LibraryFilterData = filter_response.json().await.map_err(|e| e.to_string())?;
    let total_genres = filter_data.genres.len();

    // Count genres that need normalization:
    // 1. Combined genres (contain separators like ", " or " / ")
    // 2. Non-approved genres that don't map to approved list
    let needs_normalization: Vec<&String> = filter_data.genres.iter()
        .filter(|g| {
            // Check if it's a combined genre string
            if is_combined_genre(g) {
                return true;
            }
            // Check if it doesn't map to an approved genre
            genres::map_genre_basic(g).is_none() || genres::map_genre_basic(g).as_ref() != Some(*g)
        })
        .collect();

    Ok(format!("{} genres in library, {} need normalization", total_genres, needs_normalization.len()))
}

#[tauri::command]
pub async fn normalize_genres() -> Result<String, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    
    let url = format!("{}/api/libraries/{}/items?limit=1000", config.abs_base_url, config.abs_library_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    let items: LibraryItemsResponse = response.json().await.map_err(|e| e.to_string())?;
    
    let mut updated_count = 0;
    let mut skipped_count = 0;
    
    for item in items.results {
        if let Some(current_genres) = &item.media.metadata.genres {
            if current_genres.is_empty() {
                skipped_count += 1;
                continue;
            }
            
            // Use split-aware normalization to handle combined genre strings
            let normalized_genres = genres::enforce_genre_policy_with_split(current_genres);
            
            if normalized_genres != *current_genres {
                let update_url = format!("{}/api/items/{}/media", config.abs_base_url, item.id);
                if let Ok(resp) = client
                    .patch(&update_url)
                    .header("Authorization", format!("Bearer {}", config.abs_api_token))
                    .json(&json!({"metadata": {"genres": normalized_genres}}))
                    .send()
                    .await {
                    if resp.status().is_success() {
                        updated_count += 1;
                    }
                }
            } else {
                skipped_count += 1;
            }
        }
    }
    
    Ok(format!("Normalized {} items, skipped {}", updated_count, skipped_count))
}

/// Get author statistics - find potential mismatches
#[tauri::command]
pub async fn get_author_stats() -> Result<String, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;

    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() || config.abs_library_id.is_empty() {
        return Err("AudiobookShelf not configured".to_string());
    }

    let client = reqwest::Client::new();
    let url = format!("{}/api/libraries/{}/items?limit=1000", config.abs_base_url, config.abs_library_id);

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let items: LibraryItemsResponse = response.json().await.map_err(|e| e.to_string())?;

    // Count books by author
    let mut author_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for item in &items.results {
        let abs_author = item.media.metadata.author_name.clone()
            .or_else(|| item.media.metadata.authors.as_ref()
                .and_then(|a| a.first().map(|x| x.name.clone())))
            .unwrap_or_else(|| "Unknown".to_string());
        *author_counts.entry(abs_author).or_insert(0) += 1;
    }

    // Find suspicious counts (authors with way too many books)
    let suspicious: Vec<_> = author_counts.iter()
        .filter(|(_, &count)| count > 50)
        .collect();

    if suspicious.is_empty() {
        Ok(format!("{} items, no suspicious author counts found", items.results.len()))
    } else {
        let suspicious_list: Vec<String> = suspicious.iter()
            .map(|(author, count)| format!("{}: {}", author, count))
            .collect();
        Ok(format!("{} items, suspicious: {}", items.results.len(), suspicious_list.join(", ")))
    }
}

/// Read author from audio file tags
fn read_author_from_file(path: &str) -> Option<String> {
    use lofty::probe::Probe;
    use lofty::file::TaggedFileExt;
    use lofty::tag::{Accessor, ItemKey};

    let tagged_file = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged_file.primary_tag()?;

    // Try album artist first (more reliable for audiobooks), then artist
    tag.get_string(&ItemKey::AlbumArtist)
        .map(|s| s.to_string())
        .or_else(|| tag.artist().map(|s| s.to_string()))
}
/// Fix author mismatches by reading actual file tags from disk
/// This will update ABS entries where the author doesn't match the file tags
#[tauri::command]
pub async fn fix_author_mismatches() -> Result<String, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;

    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() || config.abs_library_id.is_empty() {
        return Err("AudiobookShelf not configured".to_string());
    }

    let client = reqwest::Client::new();
    // Fetch items with their file paths
    let url = format!("{}/api/libraries/{}/items?limit=1000", config.abs_base_url, config.abs_library_id);

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let items: LibraryItemsResponse = response.json().await.map_err(|e| e.to_string())?;

    let mut fixed_count = 0;
    let mut skipped_count = 0;
    let mut no_file_count = 0;
    let mut error_count = 0;

    // Known famous authors that are often wrongly assigned
    let suspicious_authors = [
        "j.k. rowling", "jk rowling", "j. k. rowling",
        "stephen king", "james patterson", "john grisham",
        "dan brown", "agatha christie",
    ];

    for item in &items.results {
        // Get current ABS author
        let abs_author = item.media.metadata.author_name.clone()
            .or_else(|| item.media.metadata.authors.as_ref()
                .and_then(|a| a.first().map(|x| x.name.clone())))
            .unwrap_or_default();

        // Get file path from library_files
        let file_path = item.library_files.iter()
            .find(|f| {
                f.metadata.ext.as_ref()
                    .map(|e| ["m4b", "m4a", "mp3", "flac", "ogg", "opus"].contains(&e.to_lowercase().as_str()))
                    .unwrap_or(false)
            })
            .and_then(|f| f.metadata.path.clone());

        let Some(path) = file_path else {
            no_file_count += 1;
            continue;
        };

        // Read actual file tags from disk
        let file_author = match read_author_from_file(&path) {
            Some(author) if !author.is_empty() && author.to_lowercase() != "unknown" => author,
            _ => {
                skipped_count += 1;
                continue;
            }
        };

        // Check if this is a mismatch
        let abs_lower = abs_author.to_lowercase();
        let file_lower = file_author.to_lowercase();

        // Check if ABS has a suspicious famous author but file has different author
        let abs_is_suspicious = suspicious_authors.iter().any(|&s| abs_lower.contains(s));
        let file_is_same_suspicious = suspicious_authors.iter().any(|&s| {
            abs_lower.contains(s) && file_lower.contains(s)
        });

        // Only fix if:
        // 1. ABS has a famous author that's different from the file, OR
        // 2. Authors don't match and file author is valid
        let should_fix = if abs_is_suspicious && !file_is_same_suspicious {
            // Famous author mismatch - definitely fix
            println!("🔧 Fixing famous author mismatch: '{}' -> '{}' for '{}'",
                abs_author, file_author, item.media.metadata.title.as_deref().unwrap_or("Unknown"));
            true
        } else if !crate::normalize::authors_match(&file_author, &abs_author) {
            // General mismatch
            println!("🔧 Fixing author mismatch: '{}' -> '{}' for '{}'",
                abs_author, file_author, item.media.metadata.title.as_deref().unwrap_or("Unknown"));
            true
        } else {
            false
        };

        if should_fix {
            // Update ABS with the correct author from file tags
            let update_url = format!("{}/api/items/{}/media", config.abs_base_url, item.id);
            match client
                .patch(&update_url)
                .header("Authorization", format!("Bearer {}", config.abs_api_token))
                .json(&json!({
                    "metadata": {
                        "authors": [{"name": file_author}]
                    }
                }))
                .send()
                .await {
                Ok(resp) if resp.status().is_success() => {
                    fixed_count += 1;
                }
                Ok(resp) => {
                    println!("❌ Failed to update {}: {}", item.id, resp.status());
                    error_count += 1;
                }
                Err(e) => {
                    println!("❌ Error updating {}: {}", item.id, e);
                    error_count += 1;
                }
            }
        } else {
            skipped_count += 1;
        }
    }

    Ok(format!("Fixed {} mismatches, skipped {} (matched), {} no audio file, {} errors",
        fixed_count, skipped_count, no_file_count, error_count))
}