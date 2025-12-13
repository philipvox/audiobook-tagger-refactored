// src-tauri/src/commands/abs.rs
// WITH PROGRESS EVENTS for every phase

use crate::{config, scanner};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use futures::stream::{self, StreamExt};
use once_cell::sync::Lazy;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;

static LIBRARY_CACHE: Lazy<Mutex<Option<(Instant, HashMap<String, AbsLibraryItem>)>>> = 
    Lazy::new(|| Mutex::new(None));

#[derive(Debug, Serialize)]
pub struct ConnectionTest {
    success: bool,
    message: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PushItem {
    path: String,
    metadata: scanner::BookMetadata,
    group_id: String,
}

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    items: Vec<PushItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PushFailure {
    path: String,
    reason: String,
    status: Option<u16>,
}

#[derive(Debug, Serialize)]
pub struct PushResult {
    updated: usize,
    unmatched: Vec<String>,
    failed: Vec<PushFailure>,
    covers_uploaded: usize,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AbsLibraryItem {
    id: String,
    path: String,
    #[serde(default)]
    #[allow(non_snake_case)]
    isFile: bool,
}

#[derive(Debug, Deserialize)]
pub struct AbsItemsResponse {
    results: Vec<AbsLibraryItem>,
    #[serde(default)]
    total: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMediaResponse {
    updated: bool,
}

#[derive(Debug)]
pub struct PushError {
    reason: String,
    status: Option<u16>,
}

#[tauri::command]
pub async fn test_abs_connection(config: config::Config) -> Result<ConnectionTest, String> {
    if config.abs_base_url.is_empty() {
        return Ok(ConnectionTest {
            success: false,
            message: "No URL configured".to_string(),
        });
    }
    
    Ok(ConnectionTest {
        success: true,
        message: format!("Connected to {}", config.abs_base_url),
    })
}

#[tauri::command]
pub async fn clear_abs_library_cache() -> Result<String, String> {
    if let Ok(mut cache) = LIBRARY_CACHE.lock() {
        *cache = None;
    }
    Ok("Library cache cleared".to_string())
}

#[tauri::command]
pub async fn push_abs_updates(window: tauri::Window, request: PushRequest) -> Result<PushResult, String> {
    let total_start = Instant::now();
    let total_items = request.items.len();

    // Load config for concurrency settings
    let config_for_concurrency = crate::config::Config::load().unwrap_or_default();
    let abs_push_concurrency = config_for_concurrency.get_concurrency(crate::config::ConcurrencyOp::AbsPush);

    println!("⚡ PUSH TO ABS: {} items (concurrency: {})", total_items, abs_push_concurrency);
    
    // ✅ PHASE 1: Connecting
    let _ = window.emit("push_progress", json!({
        "phase": "connecting",
        "message": "Connecting to AudiobookShelf...",
        "current": 0,
        "total": total_items
    }));
    
    let config = config::load_config().map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    
    // ✅ PHASE 2: Fetching library
    let _ = window.emit("push_progress", json!({
        "phase": "fetching",
        "message": "Fetching library items from ABS...",
        "current": 0,
        "total": total_items
    }));
    
    let library_items = fetch_abs_library_items_with_progress(&client, &config, &window).await?;
    
    // ✅ PHASE 3: Matching
    let _ = window.emit("push_progress", json!({
        "phase": "matching",
        "message": format!("Matching {} items to library...", total_items),
        "current": 0,
        "total": total_items
    }));
    
    let mut unmatched = Vec::new();
    let mut targets = Vec::new();
    let mut seen_ids = HashSet::new();
    
    for (idx, item) in request.items.iter().enumerate() {
        let normalized_path = normalize_path(&item.path);
        if let Some(library_item) = find_matching_item(&normalized_path, &library_items) {
            if seen_ids.insert(library_item.id.clone()) {
                targets.push((library_item.id.clone(), item.clone()));
            }
        } else {
            unmatched.push(item.path.clone());
        }
        
        // Progress every 100 items
        if idx % 100 == 0 {
            let _ = window.emit("push_progress", json!({
                "phase": "matching",
                "message": format!("Matching items... {}/{}", idx, total_items),
                "current": idx,
                "total": total_items
            }));
        }
    }
    
    if targets.is_empty() {
        let _ = window.emit("push_progress", json!({
            "phase": "complete",
            "message": "No matching items found",
            "current": total_items,
            "total": total_items
        }));
        return Ok(PushResult { updated: 0, unmatched, failed: vec![], covers_uploaded: 0 });
    }
    
    let matched_count = targets.len();
    println!("   🎯 Matched {} items, {} unmatched", matched_count, unmatched.len());
    
    // ✅ PHASE 4: Pushing updates
    let _ = window.emit("push_progress", json!({
        "phase": "pushing",
        "message": format!("Pushing {} items to ABS...", matched_count),
        "current": 0,
        "total": matched_count
    }));
    
    let updated_count = Arc::new(AtomicUsize::new(0));
    let covers_count = Arc::new(AtomicUsize::new(0));
    let failed_items = Arc::new(Mutex::new(Vec::new()));
    let processed = Arc::new(AtomicUsize::new(0));
    
    stream::iter(targets)
        .map(|(item_id, push_item)| {
            let client = client.clone();
            let config = config.clone();
            let updated = Arc::clone(&updated_count);
            let covers = Arc::clone(&covers_count);
            let failed = Arc::clone(&failed_items);
            let processed = Arc::clone(&processed);
            let window = window.clone();
            let matched_count = matched_count;
            
            async move {
                match update_abs_item(&client, &config, &item_id, &push_item.metadata).await {
                    Ok(true) => {
                        updated.fetch_add(1, Ordering::Relaxed);
                        if let Ok(true) = upload_cover_to_abs(&client, &config, &item_id, &push_item.group_id).await {
                            covers.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Ok(false) => {}
                    Err(err) => {
                        if let Ok(mut f) = failed.lock() {
                            f.push(PushFailure {
                                path: push_item.path.clone(),
                                reason: err.reason,
                                status: err.status,
                            });
                        }
                    }
                }
                
                let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                
                // Progress every 20 items
                if current % 20 == 0 || current == matched_count {
                    let _ = window.emit("push_progress", json!({
                        "phase": "pushing",
                        "message": format!("Updating metadata... {}/{}", current, matched_count),
                        "current": current,
                        "total": matched_count
                    }));
                }
            }
        })
        .buffer_unordered(abs_push_concurrency)
        .collect::<Vec<_>>()
        .await;
    
    let updated = updated_count.load(Ordering::Relaxed);
    let covers_uploaded = covers_count.load(Ordering::Relaxed);
    let failed = failed_items.lock().map(|f| f.clone()).unwrap_or_default();
    let elapsed = total_start.elapsed();
    
    // ✅ PHASE 5: Complete
    let _ = window.emit("push_progress", json!({
        "phase": "complete",
        "message": format!("Done! {} updated, {} covers in {:.1}s", updated, covers_uploaded, elapsed.as_secs_f64()),
        "current": matched_count,
        "total": matched_count
    }));
    
    println!("✅ PUSH DONE: {} updated, {} covers in {:.1}s", 
        updated, covers_uploaded, elapsed.as_secs_f64());
    
    Ok(PushResult { updated, unmatched, failed, covers_uploaded })
}

async fn fetch_abs_library_items_with_progress(
    client: &reqwest::Client,
    config: &config::Config,
    window: &tauri::Window,
) -> Result<HashMap<String, AbsLibraryItem>, String> {
    // Check cache first
    {
        if let Ok(cache) = LIBRARY_CACHE.lock() {
            if let Some((timestamp, items)) = &*cache {
                if timestamp.elapsed() < Duration::from_secs(300) {
                    let _ = window.emit("push_progress", json!({
                        "phase": "fetching",
                        "message": format!("Using cached library ({} items)", items.len()),
                        "current": items.len(),
                        "total": items.len()
                    }));
                    return Ok(items.clone());
                }
            }
        }
    }
    
    let mut items_map = HashMap::new();
    let mut page = 0;
    let limit = 200;
    
    loop {
        let _ = window.emit("push_progress", json!({
            "phase": "fetching",
            "message": format!("Fetching library page {}... ({} items so far)", page + 1, items_map.len()),
            "current": items_map.len(),
            "total": 0
        }));
        
        let url = format!("{}/api/libraries/{}/items?limit={}&page={}", 
            config.abs_base_url, config.abs_library_id, limit, page);
        
        let response = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        
        let payload: AbsItemsResponse = response.json().await.map_err(|e| e.to_string())?;
        let result_count = payload.results.len();
        
        for item in payload.results {
            let normalized = normalize_path(&item.path);
            if !normalized.is_empty() {
                items_map.insert(normalized, item);
            }
        }
        
        if result_count < limit {
            break;
        }
        page += 1;
    }
    
    let _ = window.emit("push_progress", json!({
        "phase": "fetching",
        "message": format!("Library loaded: {} items", items_map.len()),
        "current": items_map.len(),
        "total": items_map.len()
    }));
    
    // Update cache
    {
        if let Ok(mut cache) = LIBRARY_CACHE.lock() {
            *cache = Some((Instant::now(), items_map.clone()));
        }
    }

    Ok(items_map)
}

async fn upload_cover_to_abs(
    client: &reqwest::Client,
    config: &config::Config,
    item_id: &str,
    group_id: &str,
) -> Result<bool, String> {
    let cover_cache_key = format!("cover_{}", group_id);
    let cover_data: Option<(Vec<u8>, String)> = crate::cache::get(&cover_cache_key);
    
    if let Some((data, mime_type)) = cover_data {
        let extension = match mime_type.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/png" => "png",
            "image/webp" => "webp",
            _ => "jpg",
        };
        
        let part = reqwest::multipart::Part::bytes(data)
            .file_name(format!("cover.{}", extension))
            .mime_str(&mime_type)
            .map_err(|e| format!("Multipart error: {}", e))?;
        
        let form = reqwest::multipart::Form::new().part("cover", part);
        let url = format!("{}/api/items/{}/cover", config.abs_base_url, item_id);
        
        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .multipart(form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        
        Ok(response.status().is_success())
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn restart_abs_docker() -> Result<String, String> {
    use std::process::Command;
    
    let output = Command::new("docker")
        .args(["restart", "audiobookshelf"])
        .output()
        .map_err(|e| format!("Failed: {}", e))?;
    
    if output.status.success() {
        Ok("Container restarted".to_string())
    } else {
        Err(format!("Failed: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

#[tauri::command]
pub async fn force_abs_rescan() -> Result<String, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    let url = format!("{}/api/libraries/{}/scan", config.abs_base_url, config.abs_library_id);
    
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    if response.status().is_success() {
        Ok("Rescan triggered".to_string())
    } else {
        Err(format!("Failed: {}", response.status()))
    }
}

#[tauri::command]
pub async fn clear_abs_cache() -> Result<String, String> {
    use std::process::Command;
    
    let output = Command::new("docker")
        .args(["exec", "audiobookshelf", "rm", "-rf", "/config/cache/*"])
        .output()
        .map_err(|e| format!("Failed: {}", e))?;
    
    if output.status.success() {
        Ok("Cache cleared".to_string())
    } else {
        Err(format!("Failed: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

fn normalize_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.ends_with('/') && normalized.len() > 1 {
        normalized.pop();
    }
    normalized
}

fn find_matching_item<'a>(
    path: &str,
    items: &'a HashMap<String, AbsLibraryItem>,
) -> Option<&'a AbsLibraryItem> {
    if let Some(item) = items.get(path) {
        return Some(item);
    }
    
    if let Some(book_folder) = extract_book_folder(path) {
        for (abs_path, item) in items.iter() {
            if abs_path.ends_with(&book_folder) {
                return Some(item);
            }
        }
    }
    
    let mut current = path.to_string();
    while let Some(pos) = current.rfind('/') {
        current.truncate(pos);
        if let Some(item) = items.get(&current) {
            return Some(item);
        }
    }
    
    None
}

fn extract_book_folder(path: &str) -> Option<String> {
    let normalized = normalize_path(path);
    let parts: Vec<&str> = normalized.split('/').collect();
    
    if parts.len() < 2 {
        return None;
    }
    
    for part in parts.iter().rev() {
        if !part.is_empty() && part.contains('[') && part.ends_with(']') {
            return Some((*part).to_string());
        }
    }
    
    parts.iter().rev()
        .find(|p| !p.is_empty() && !p.ends_with(".m4b") && !p.ends_with(".m4a") && !p.ends_with(".mp3"))
        .map(|s| (*s).to_string())
}

async fn update_abs_item(
    client: &reqwest::Client,
    config: &config::Config,
    item_id: &str,
    metadata: &scanner::BookMetadata,
) -> Result<bool, PushError> {
    let url = format!("{}/api/items/{}/media", config.abs_base_url, item_id);
    let payload = build_update_payload(metadata);
    
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| PushError { reason: e.to_string(), status: None })?;
    
    let status = response.status();
    if !status.is_success() {
        return Err(PushError { reason: format!("Status {}", status), status: Some(status.as_u16()) });
    }
    
    let body: UpdateMediaResponse = response.json().await
        .map_err(|e| PushError { reason: e.to_string(), status: Some(status.as_u16()) })?;
    
    Ok(body.updated)
}

fn build_update_payload(metadata: &scanner::BookMetadata) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("title".to_string(), json!(metadata.title));
    
    if let Some(ref s) = metadata.subtitle { map.insert("subtitle".to_string(), json!(s)); }
    if let Some(ref d) = metadata.description { map.insert("description".to_string(), json!(d)); }
    if let Some(ref p) = metadata.publisher { map.insert("publisher".to_string(), json!(p)); }
    if let Some(ref y) = metadata.year { map.insert("publishedYear".to_string(), json!(y)); }
    if let Some(ref i) = metadata.isbn { map.insert("isbn".to_string(), json!(i)); }
    if let Some(ref n) = metadata.narrator { map.insert("narrators".to_string(), json!([n])); }
    if !metadata.genres.is_empty() { map.insert("genres".to_string(), json!(metadata.genres)); }
    
    let authors: Vec<Value> = metadata.author.split(&[',', '&'][..])
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
        .enumerate()
        .map(|(i, name)| json!({"id": format!("new-{}", i+1), "name": name}))
        .collect();
    if !authors.is_empty() { map.insert("authors".to_string(), Value::Array(authors)); }
    
    if let Some(ref series) = metadata.series {
        let mut s = serde_json::Map::new();
        s.insert("id".to_string(), json!("new-1"));
        s.insert("name".to_string(), json!(series));
        if let Some(ref seq) = metadata.sequence {
            s.insert("sequence".to_string(), json!(seq));
        }
        map.insert("series".to_string(), Value::Array(vec![Value::Object(s)]));
    }
    
    json!({"metadata": map})
}

// ============================================================================
// ABS LIBRARY IMPORT - Load books from ABS instead of scanning local files
// ============================================================================

/// Full ABS library item with media metadata
#[derive(Debug, Deserialize, Clone)]
pub struct AbsFullItem {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub media: Option<AbsMedia>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AbsMedia {
    #[serde(default)]
    pub metadata: Option<AbsMediaMetadata>,
    #[serde(default)]
    #[serde(rename = "coverPath")]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AbsMediaMetadata {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default, rename = "authorName")]
    pub author_name: Option<String>,
    #[serde(default)]
    pub authors: Vec<AbsAuthor>,
    #[serde(default, rename = "narratorName")]
    pub narrator_name: Option<String>,
    #[serde(default)]
    pub narrators: Vec<String>,
    #[serde(default, rename = "seriesName")]
    pub series_name: Option<String>,
    #[serde(default)]
    pub series: Vec<AbsSeries>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default, rename = "publishedYear")]
    pub published_year: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub isbn: Option<String>,
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub explicit: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AbsAuthor {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AbsSeries {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sequence: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AbsFullItemsResponse {
    pub results: Vec<AbsFullItem>,
    #[serde(default)]
    pub total: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct AbsImportResult {
    pub groups: Vec<scanner::BookGroup>,
    pub total_imported: usize,
}

/// Import books from ABS library - no local file scanning needed
/// Returns BookGroups with metadata from ABS that can be normalized/cleaned
#[tauri::command]
pub async fn import_from_abs(window: tauri::Window) -> Result<AbsImportResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.emit("import_progress", json!({
        "phase": "fetching",
        "message": "Fetching library from ABS...",
        "current": 0,
        "total": 0
    }));

    // Fetch all library items with full metadata
    let mut all_items = Vec::new();
    let mut page = 0;
    let limit = 100;

    loop {
        let url = format!(
            "{}/api/libraries/{}/items?limit={}&page={}&minified=0",
            config.abs_base_url, config.abs_library_id, limit, page
        );

        let response = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch from ABS: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("ABS returned error: {}", response.status()));
        }

        let payload: AbsFullItemsResponse = response.json().await
            .map_err(|e| format!("Failed to parse ABS response: {}", e))?;

        let count = payload.results.len();
        all_items.extend(payload.results);

        let _ = window.emit("import_progress", json!({
            "phase": "fetching",
            "message": format!("Fetching... {} items loaded", all_items.len()),
            "current": all_items.len(),
            "total": payload.total.unwrap_or(0)
        }));

        if count < limit {
            break;
        }
        page += 1;
    }

    let _ = window.emit("import_progress", json!({
        "phase": "processing",
        "message": format!("Processing {} items...", all_items.len()),
        "current": 0,
        "total": all_items.len()
    }));

    // Convert ABS items to BookGroups
    let mut groups = Vec::new();
    for (idx, item) in all_items.iter().enumerate() {
        if let Some(group) = abs_item_to_book_group(item, &config) {
            groups.push(group);
        }

        if idx % 50 == 0 {
            let _ = window.emit("import_progress", json!({
                "phase": "processing",
                "message": format!("Processing... {}/{}", idx, all_items.len()),
                "current": idx,
                "total": all_items.len()
            }));
        }
    }

    let total = groups.len();
    let _ = window.emit("import_progress", json!({
        "phase": "complete",
        "message": format!("Imported {} books from ABS", total),
        "current": total,
        "total": total
    }));

    println!("📚 Imported {} books from ABS library", total);

    Ok(AbsImportResult {
        groups,
        total_imported: total,
    })
}

/// Rescan ABS-imported books by searching APIs with title/author
/// This fetches fresh metadata without needing local audio files
#[derive(Debug, Deserialize)]
pub struct AbsRescanRequest {
    pub groups: Vec<AbsRescanGroup>,
    /// Scan mode: "force_fresh" for full refresh, "genres_only" for just genres
    pub mode: String,
    /// Optional: only update these fields (e.g., ["description", "genres", "narrators"])
    #[serde(default)]
    pub fields: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AbsRescanGroup {
    pub id: String,
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub genres: Vec<String>,
    pub subtitle: Option<String>,
    pub narrator: Option<String>,
    pub description: Option<String>,
    pub year: Option<String>,
    pub publisher: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AbsRescanResult {
    pub groups: Vec<scanner::BookGroup>,
    pub total_rescanned: usize,
    pub total_failed: usize,
}

#[tauri::command]
pub async fn rescan_abs_imports(
    window: tauri::Window,
    request: AbsRescanRequest,
) -> Result<AbsRescanResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let total = request.groups.len();

    let fields_str = request.fields.as_ref()
        .map(|f| f.join(", "))
        .unwrap_or_else(|| "all".to_string());
    println!("🔄 Rescan ABS imports: {} books, mode={}, fields={}", total, request.mode, fields_str);

    // Helper to check if a field should be updated
    let should_update = |field: &str| -> bool {
        match &request.fields {
            None => true, // No filter, update all
            Some(fields) => fields.iter().any(|f| {
                f.eq_ignore_ascii_case(field) ||
                (f.eq_ignore_ascii_case("authors") && field == "author") ||
                (f.eq_ignore_ascii_case("narrators") && field == "narrator")
            })
        }
    };

    let _ = window.emit("rescan_progress", json!({
        "phase": "starting",
        "message": format!("Rescanning {} books...", total),
        "current": 0,
        "total": total
    }));

    let mut result_groups = Vec::new();
    let mut failed = 0;

    if request.mode == "genres_only" {
        // Just normalize genres, no API calls
        for (idx, group) in request.groups.iter().enumerate() {
            let cleaned_genres = crate::genres::enforce_genre_policy_with_split(&group.genres);
            let mut final_genres = cleaned_genres;
            crate::genres::enforce_children_age_genres(
                &mut final_genres,
                &group.title,
                group.series.as_deref(),
                Some(&group.author),
            );

            let mut metadata = scanner::BookMetadata::default();
            metadata.title = group.title.clone();
            metadata.author = group.author.clone();
            metadata.series = group.series.clone();
            metadata.genres = final_genres;

            result_groups.push(scanner::BookGroup {
                id: group.id.clone(),
                group_name: group.title.clone(),
                group_type: scanner::types::GroupType::Single,
                metadata,
                files: vec![],
                total_changes: 0,
                scan_status: scanner::types::ScanStatus::LoadedFromFile,
            });

            if idx % 20 == 0 {
                let _ = window.emit("rescan_progress", json!({
                    "phase": "processing",
                    "message": format!("Cleaning genres... {}/{}", idx, total),
                    "current": idx,
                    "total": total
                }));
            }
        }
    } else {
        // Full rescan via GPT enrichment - 50 PARALLEL workers
        println!("🚀 Running {} books with 50 parallel workers...", total);

        let processed = Arc::new(AtomicUsize::new(0));
        let fields_filter = request.fields.clone();

        // Collect results directly from stream - no shared mutex needed
        let all_results: Vec<(scanner::BookGroup, bool)> = stream::iter(request.groups.iter().cloned())
            .map(|group| {
                let config = config.clone();
                let processed = Arc::clone(&processed);
                let window = window.clone();
                let total = total;
                let fields_filter = fields_filter.clone();

                async move {
                    let current = processed.fetch_add(1, Ordering::Relaxed) + 1;

                    // Progress update every 10 items
                    if current % 10 == 0 || current == total {
                        let _ = window.emit("rescan_progress", json!({
                            "phase": "processing",
                            "message": format!("Processing... {}/{}", current, total),
                            "current": current,
                            "total": total
                        }));
                    }

                    // Build input
                    let input = crate::scanner::processor::AbsImportData {
                        title: group.title.clone(),
                        author: group.author.clone(),
                        series: group.series.clone(),
                        sequence: group.sequence.clone(),
                        genres: group.genres.clone(),
                        subtitle: group.subtitle.clone(),
                        narrator: group.narrator.clone(),
                        description: group.description.clone(),
                        year: group.year.clone(),
                        publisher: group.publisher.clone(),
                    };

                    // GPT processing with timeout
                    let gpt_result = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        crate::scanner::processor::process_abs_import_with_gpt(&input, &config)
                    ).await;

                    let new_metadata = match gpt_result {
                        Ok(metadata) => metadata,
                        Err(_) => {
                            // Timeout - use fallback
                            let mut fallback = scanner::BookMetadata::default();
                            fallback.title = group.title.clone();
                            fallback.author = group.author.clone();
                            fallback.series = group.series.clone();
                            fallback.sequence = group.sequence.clone();
                            fallback.subtitle = group.subtitle.clone();
                            fallback.narrator = group.narrator.clone();
                            fallback.description = group.description.clone();
                            fallback.year = group.year.clone();
                            fallback.publisher = group.publisher.clone();
                            fallback.genres = crate::genres::enforce_genre_policy_with_split(&group.genres);
                            fallback
                        }
                    };

                    // Build result
                    if !new_metadata.title.is_empty() {
                        let final_metadata = if fields_filter.is_some() && !fields_filter.as_ref().unwrap().is_empty() {
                            // Selective field update
                            let should_update = |field: &str| -> bool {
                                fields_filter.as_ref().map(|f| f.iter().any(|ff| ff.eq_ignore_ascii_case(field))).unwrap_or(false)
                            };

                            let mut merged = scanner::BookMetadata::default();
                            merged.title = if should_update("title") { new_metadata.title.clone() } else { group.title.clone() };
                            merged.author = if should_update("author") { new_metadata.author.clone() } else { group.author.clone() };
                            merged.series = if should_update("series") { new_metadata.series.clone() } else { group.series.clone() };
                            merged.sequence = if should_update("series") { new_metadata.sequence.clone() } else { group.sequence.clone() };
                            merged.genres = if should_update("genres") { new_metadata.genres.clone() } else { group.genres.clone() };
                            merged.subtitle = if should_update("subtitle") { new_metadata.subtitle.clone() } else { group.subtitle.clone() };
                            merged.narrator = if should_update("narrator") { new_metadata.narrator.clone() } else { group.narrator.clone() };
                            merged.description = if should_update("description") { new_metadata.description.clone() } else { group.description.clone() };
                            merged.year = if should_update("year") { new_metadata.year.clone() } else { group.year.clone() };
                            merged.publisher = if should_update("publisher") { new_metadata.publisher.clone() } else { group.publisher.clone() };
                            merged.sources = new_metadata.sources.clone();
                            merged
                        } else {
                            new_metadata
                        };

                        // Apply children's genre detection
                        let mut final_genres = final_metadata.genres.clone();
                        crate::genres::enforce_children_age_genres(
                            &mut final_genres,
                            &final_metadata.title,
                            final_metadata.series.as_deref(),
                            Some(&final_metadata.author),
                        );

                        let mut metadata = final_metadata;
                        metadata.genres = final_genres;

                        (scanner::BookGroup {
                            id: group.id.clone(),
                            group_name: metadata.title.clone(),
                            group_type: scanner::types::GroupType::Single,
                            metadata,
                            files: vec![],
                            total_changes: 0,
                            scan_status: scanner::types::ScanStatus::NewScan,
                        }, false) // false = not failed
                    } else {
                        let mut metadata = scanner::BookMetadata::default();
                        metadata.title = group.title.clone();
                        metadata.author = group.author.clone();
                        metadata.series = group.series.clone();
                        metadata.genres = crate::genres::enforce_genre_policy_with_split(&group.genres);

                        (scanner::BookGroup {
                            id: group.id.clone(),
                            group_name: group.title.clone(),
                            group_type: scanner::types::GroupType::Single,
                            metadata,
                            files: vec![],
                            total_changes: 0,
                            scan_status: scanner::types::ScanStatus::NotScanned,
                        }, true) // true = failed
                    }
                }
            })
            .buffer_unordered(50)
            .collect()
            .await;

        // Split results and count failures
        for (book_group, was_failed) in all_results {
            if was_failed {
                failed += 1;
            }
            result_groups.push(book_group);
        }
    }

    let rescanned = result_groups.len() - failed;
    let _ = window.emit("rescan_progress", json!({
        "phase": "complete",
        "message": format!("Done! {} rescanned, {} failed", rescanned, failed),
        "current": total,
        "total": total
    }));

    println!("✅ ABS rescan complete: {} rescanned, {} failed", rescanned, failed);

    Ok(AbsRescanResult {
        groups: result_groups,
        total_rescanned: rescanned,
        total_failed: failed,
    })
}

/// Push updated metadata back to ABS for imported books (uses item ID directly)
#[derive(Debug, Deserialize)]
pub struct AbsPushRequest {
    pub items: Vec<AbsPushItem>,
}

#[derive(Debug, Deserialize)]
pub struct AbsPushItem {
    pub id: String,  // ABS item ID
    pub metadata: scanner::BookMetadata,
}

#[derive(Debug, Serialize)]
pub struct AbsPushResult {
    pub updated: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn push_abs_imports(
    window: tauri::Window,
    request: AbsPushRequest,
) -> Result<AbsPushResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    // Get concurrency from config (uses abs_push setting)
    let concurrency = config.get_concurrency(crate::config::ConcurrencyOp::AbsPush);
    let total = request.items.len();
    println!("📤 Pushing {} ABS imports back to library (concurrency: {})", total, concurrency);

    let _ = window.emit("push_progress", json!({
        "phase": "pushing",
        "message": format!("Updating {} books in ABS...", total),
        "current": 0,
        "total": total
    }));

    let updated_count = Arc::new(AtomicUsize::new(0));
    let failed_count = Arc::new(AtomicUsize::new(0));
    let errors_list = Arc::new(Mutex::new(Vec::new()));
    let processed = Arc::new(AtomicUsize::new(0));

    stream::iter(request.items.into_iter())
        .map(|item| {
            let client = client.clone();
            let config = config.clone();
            let updated = Arc::clone(&updated_count);
            let failed = Arc::clone(&failed_count);
            let errors = Arc::clone(&errors_list);
            let processed = Arc::clone(&processed);
            let window = window.clone();
            let total = total;

            async move {
                let url = format!("{}/api/items/{}/media", config.abs_base_url, item.id);
                let payload = build_update_payload(&item.metadata);

                match client
                    .patch(&url)
                    .header("Authorization", format!("Bearer {}", config.abs_api_token))
                    .json(&payload)
                    .send()
                    .await
                {
                    Ok(response) => {
                        if response.status().is_success() {
                            updated.fetch_add(1, Ordering::Relaxed);
                        } else {
                            failed.fetch_add(1, Ordering::Relaxed);
                            if let Ok(mut e) = errors.lock() {
                                e.push(format!("{}: HTTP {}", item.metadata.title, response.status()));
                            }
                        }
                    }
                    Err(e) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        if let Ok(mut err) = errors.lock() {
                            err.push(format!("{}: {}", item.metadata.title, e));
                        }
                    }
                }

                let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if current % 50 == 0 || current == total {
                    let _ = window.emit("push_progress", json!({
                        "phase": "pushing",
                        "message": format!("Updating... {}/{}", current, total),
                        "current": current,
                        "total": total
                    }));
                }
            }
        })
        .buffer_unordered(concurrency)
        .collect::<Vec<_>>()
        .await;

    let updated = updated_count.load(Ordering::Relaxed);
    let failed = failed_count.load(Ordering::Relaxed);
    let errors = errors_list.lock().map(|e| e.clone()).unwrap_or_default();

    let _ = window.emit("push_progress", json!({
        "phase": "complete",
        "message": format!("Done! {} updated, {} failed", updated, failed),
        "current": total,
        "total": total
    }));

    println!("✅ ABS push complete: {} updated, {} failed", updated, failed);

    Ok(AbsPushResult { updated, failed, errors })
}

/// Convert an ABS library item to a BookGroup
fn abs_item_to_book_group(item: &AbsFullItem, config: &config::Config) -> Option<scanner::BookGroup> {
    let media = item.media.as_ref()?;
    let meta = media.metadata.as_ref()?;

    // Build metadata
    let mut metadata = scanner::BookMetadata::default();

    metadata.title = meta.title.clone().unwrap_or_default();
    metadata.subtitle = meta.subtitle.clone();
    metadata.description = meta.description.clone();
    metadata.publisher = meta.publisher.clone();
    metadata.year = meta.published_year.clone();
    metadata.isbn = meta.isbn.clone();
    metadata.asin = meta.asin.clone();
    metadata.language = meta.language.clone();
    metadata.explicit = meta.explicit;

    // Author - join multiple authors
    if !meta.authors.is_empty() {
        metadata.author = meta.authors.iter()
            .map(|a| a.name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        metadata.authors = meta.authors.iter().map(|a| a.name.clone()).collect();
    } else if let Some(ref author_name) = meta.author_name {
        metadata.author = author_name.clone();
    }

    // Narrator
    if !meta.narrators.is_empty() {
        metadata.narrator = Some(meta.narrators.join(", "));
        metadata.narrators = meta.narrators.clone();
    } else if let Some(ref narrator_name) = meta.narrator_name {
        metadata.narrator = Some(narrator_name.clone());
    }

    // Series - use first series
    if let Some(first_series) = meta.series.first() {
        metadata.series = Some(first_series.name.clone());
        metadata.sequence = first_series.sequence.clone();

        // Build all_series
        metadata.all_series = meta.series.iter().map(|s| {
            scanner::types::SeriesInfo {
                name: s.name.clone(),
                sequence: s.sequence.clone(),
                source: Some(scanner::types::MetadataSource::Abs),
            }
        }).collect();
    } else if let Some(ref series_name) = meta.series_name {
        metadata.series = Some(series_name.clone());
    }

    // Genres
    metadata.genres = meta.genres.clone();

    // Cover URL from ABS
    if let Some(ref cover_path) = media.cover_path {
        metadata.cover_url = Some(format!(
            "{}/api/items/{}/cover",
            config.abs_base_url, item.id
        ));
    }

    // Runtime
    if let Some(duration) = media.duration {
        metadata.runtime_minutes = Some((duration / 60.0) as u32);
    }

    // Set source tracking
    metadata.sources = Some(scanner::types::MetadataSources {
        title: Some(scanner::types::MetadataSource::Abs),
        author: Some(scanner::types::MetadataSource::Abs),
        narrator: Some(scanner::types::MetadataSource::Abs),
        series: if metadata.series.is_some() { Some(scanner::types::MetadataSource::Abs) } else { None },
        genres: if !metadata.genres.is_empty() { Some(scanner::types::MetadataSource::Abs) } else { None },
        description: if metadata.description.is_some() { Some(scanner::types::MetadataSource::Abs) } else { None },
        publisher: if metadata.publisher.is_some() { Some(scanner::types::MetadataSource::Abs) } else { None },
        year: if metadata.year.is_some() { Some(scanner::types::MetadataSource::Abs) } else { None },
        ..Default::default()
    });

    // Create BookGroup
    Some(scanner::BookGroup {
        id: item.id.clone(),
        group_name: metadata.title.clone(),
        group_type: scanner::types::GroupType::Single,
        metadata,
        files: vec![], // No local files when importing from ABS
        total_changes: 0,
        scan_status: scanner::types::ScanStatus::LoadedFromFile,
    })
}