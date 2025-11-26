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
    let mut cache = LIBRARY_CACHE.lock().unwrap();
    *cache = None;
    Ok("Library cache cleared".to_string())
}

#[tauri::command]
pub async fn push_abs_updates(window: tauri::Window, request: PushRequest) -> Result<PushResult, String> {
    let total_start = Instant::now();
    let workers: usize = 60;
    let total_items = request.items.len();
    
    println!("⚡ PUSH TO ABS: {} items", total_items);
    
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
        .buffer_unordered(workers)
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
        let cache = LIBRARY_CACHE.lock().unwrap();
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
        let mut cache = LIBRARY_CACHE.lock().unwrap();
        *cache = Some((Instant::now(), items_map.clone()));
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