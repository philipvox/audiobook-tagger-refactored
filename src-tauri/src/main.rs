#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod scanner;
mod tags;
mod genres;
mod genre_cache;
mod metadata;
mod processor;
mod audible;
mod cache;
mod progress;  // ADD THIS LINE
mod tag_inspector;
mod audible_auth;
mod file_rename;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tauri::Emitter;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

#[derive(Debug, Serialize, Deserialize)]
struct RenamePreview {
    old_path: String,
    new_path: String,
    changed: bool,
}

#[tauri::command]
async fn preview_rename(
    file_path: String,
    metadata: scanner::BookMetadata,
) -> Result<RenamePreview, String> {
    use std::path::Path;
    
    let path = Path::new(&file_path);
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("m4b");
    
    let new_filename = file_rename::generate_filename(&file_rename::BookMetadata {
        title: metadata.title.clone(),
        author: metadata.author.clone(),
        series: metadata.series.clone(),
        sequence: metadata.sequence.clone(),
        year: metadata.year.clone(),
    }, ext);
    
    let new_path = path.with_file_name(&new_filename);
    
    Ok(RenamePreview {
        old_path: file_path.clone(),
        new_path: new_path.to_string_lossy().to_string(),
        changed: file_path != new_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn rename_files(
    files: Vec<(String, scanner::BookMetadata)>,
) -> Result<Vec<RenamePreview>, String> {
    let mut results = Vec::new();
    
    for (file_path, metadata) in files {
        let rename_meta = file_rename::BookMetadata {
            title: metadata.title.clone(),
            author: metadata.author.clone(),
            series: metadata.series.clone(),
            sequence: metadata.sequence.clone(),
            year: metadata.year.clone(),
        };
        
        match file_rename::rename_and_reorganize_file(
            &file_path,
            &rename_meta,
            false,
            None,
        ).await {
            Ok(result) => {
                results.push(RenamePreview {
                    old_path: result.old_path,
                    new_path: result.new_path,
                    changed: result.success,
                });
            }
            Err(e) => {
                return Err(format!("Failed to rename {}: {}", file_path, e));
            }
        }
    }
    
    Ok(results)
}

#[tauri::command]
fn get_config() -> config::Config {
    config::load_config().unwrap_or_default()
}

#[tauri::command]
fn save_config(config: config::Config) -> Result<(), String> {
    config::save_config(&config).map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_library(
    _window: tauri::Window,
    paths: Vec<String>,
) -> Result<serde_json::Value, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    
    let api_key = if config.openai_api_key.is_empty() {
        None
    } else {
        Some(config.openai_api_key)
    };
    
    let groups = scanner::scan_directory(
        &paths[0], 
        api_key,
        config.skip_unchanged,
        None
    )
    .await
    .map_err(|e| e.to_string())?;
    
    Ok(serde_json::json!({
        "groups": groups
    }))
}
#[derive(Debug, Deserialize)]
struct WriteRequest {
    file_ids: Vec<String>,
    files: HashMap<String, FileData>,
    backup: bool,
}

#[derive(Debug, Deserialize)]
struct FileData {
    path: String,
    changes: HashMap<String, scanner::FieldChange>,
}

#[derive(Debug, Deserialize, Clone)]
struct PushItem {
    path: String,
    metadata: scanner::BookMetadata,
}

#[derive(Debug, Deserialize)]
struct PushRequest {
    items: Vec<PushItem>,
}

#[derive(Debug, Serialize)]
struct PushFailure {
    path: String,
    reason: String,
    status: Option<u16>,
}

#[derive(Debug, Serialize)]
struct PushResult {
    updated: usize,
    unmatched: Vec<String>,
    failed: Vec<PushFailure>,
}

#[derive(Debug, Deserialize, Clone)]
struct AbsLibraryItem {
    id: String,
    path: String,
    #[serde(default)]
    isFile: bool,
}

#[derive(Debug, Deserialize)]
struct AbsItemsResponse {
    results: Vec<AbsLibraryItem>,
    #[serde(default)]
    total: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct UpdateMediaResponse {
    updated: bool,
}
#[tauri::command]
async fn write_tags(window: tauri::Window, request: WriteRequest) -> Result<tags::WriteResult, String> {
    let total = request.file_ids.len();
    let config = config::load_config().unwrap_or_default();
    let max_workers = config.max_workers.max(1);
    let backup = request.backup;  // EXTRACT THIS BEFORE THE LOOP
    
    println!("🚀 Writing {} files with {} parallel workers", total, max_workers);
    
    let files_to_write: Vec<_> = request.file_ids.iter()
        .filter_map(|file_id| {
            request.files.get(file_id).map(|file_data| {
                (file_id.clone(), file_data.path.clone(), file_data.changes.clone())
            })
        })
        .collect();
    
    let start_time = std::time::Instant::now();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(max_workers));
    let completed = Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();

    for (file_id, path, changes) in files_to_write {
        let sem = Arc::clone(&semaphore);
        let completed_clone = Arc::clone(&completed);
        let window_clone = window.clone();
        
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            let result = tags::write_file_tags(&path, &changes, backup).await;
            
            // Emit progress after each file completes
            let current = completed_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let _ = window_clone.emit("write_progress", serde_json::json!({
                "current": current,
                "total": total
            }));
            
            (file_id, result)
        });
        
        handles.push(handle);
    }
    
    let mut success = 0;
    let mut failed = 0;
    let mut errors = Vec::new();
    
    for handle in handles {
        let (file_id, result) = handle.await.unwrap();
        
        match result {
            Ok(_) => success += 1,
            Err(e) => {
                failed += 1;
                if let Some(file_data) = request.files.get(&file_id) {
                    errors.push(tags::WriteError {
                        file_id,
                        path: file_data.path.clone(),
                        error: e.to_string(),
                    });
                }
            }
        }
    }
    
    let elapsed = start_time.elapsed();
    let rate = total as f64 / elapsed.as_secs_f64();
    println!("⚡ Write performance: {:.1} files/sec, total time: {:?}", rate, elapsed);
    
    Ok(tags::WriteResult { success, failed, errors })
}
#[tauri::command]
async fn test_abs_connection(config: config::Config) -> Result<ConnectionTest, String> {
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

#[derive(Debug, Serialize, Deserialize)]
struct ConnectionTest {
    success: bool,
    message: String,
}

#[derive(Debug)]
struct PushError {
    reason: String,
    status: Option<u16>,
}

#[tauri::command]
async fn inspect_file_tags(file_path: String) -> Result<tag_inspector::RawTags, String> {
    tag_inspector::inspect_file_tags(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_cache() -> Result<String, String> {
    cache::MetadataCache::new()
        .map_err(|e| e.to_string())?
        .clear()
        .map_err(|e| e.to_string())?;
    Ok("Cache cleared successfully".to_string())
}

#[tauri::command]
async fn restart_abs_docker() -> Result<String, String> {
    use std::process::Command;
    
    let output = Command::new("docker")
        .args(&["restart", "audiobookshelf"])
        .output()
        .map_err(|e| format!("Failed to execute docker command: {}", e))?;
    
    if output.status.success() {
        Ok("Container restarted successfully".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Docker restart failed: {}", stderr))
    }
}

#[tauri::command]
async fn force_abs_rescan() -> Result<String, String> {
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
        Ok("Library rescan triggered".to_string())
    } else {
        Err(format!("Failed to trigger rescan: {}", response.status()))
    }
}

#[tauri::command]
async fn clear_abs_cache() -> Result<String, String> {
    use std::process::Command;
    
    let output = Command::new("docker")
        .args(&["exec", "audiobookshelf", "rm", "-rf", "/config/cache/*"])
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;
    
    if output.status.success() {
        Ok("Cache cleared successfully".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to clear cache: {}", stderr))
    }
}

#[derive(Debug, Deserialize)]
struct LibraryFilterData {
    genres: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct LibraryItem {
    id: String,
    media: Media,
}

#[derive(Debug, Deserialize)]
struct Media {
    metadata: ItemMetadata,
}

#[derive(Debug, Deserialize)]
struct ItemMetadata {
    genres: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct LibraryItemsResponse {
    results: Vec<LibraryItem>,
}
#[tauri::command]
async fn cancel_scan() -> Result<(), String> {
    // Set a global cancellation flag
    crate::scanner::set_cancellation_flag(true);
    Ok(())
}
#[tauri::command]
async fn clear_all_genres() -> Result<String, String> {
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
    let all_dropdown_genres = filter_data.genres;
    
    let items_url = format!("{}/api/libraries/{}/items?limit=1000", config.abs_base_url, config.abs_library_id);
    let items_response = client
        .get(&items_url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    let items: LibraryItemsResponse = items_response.json().await.map_err(|e| e.to_string())?;
    
    let mut used_genres: HashSet<String> = HashSet::new();
    for item in items.results {
        if let Some(genres) = item.media.metadata.genres {
            used_genres.extend(genres);
        }
    }
    
    let unused_genres: Vec<String> = all_dropdown_genres
        .into_iter()
        .filter(|g| !used_genres.contains(g))
        .collect();
    
    if unused_genres.is_empty() {
        return Ok("No unused genres found".to_string());
    }
    
    let mut deleted_count = 0;
    for genre in &unused_genres {
        let delete_url = format!("{}/api/me/item/{}", config.abs_base_url, urlencoding::encode(genre));
        if let Ok(resp) = client.delete(&delete_url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await {
            if resp.status().is_success() {
                deleted_count += 1;
            }
        }
    }
    
    Ok(format!("Removed {} unused genres", deleted_count))
}

#[tauri::command]
async fn normalize_genres() -> Result<String, String> {
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
            
            let normalized_genres = genres::enforce_genre_policy_basic(current_genres);
            
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

#[tauri::command]
async fn push_abs_updates(request: PushRequest) -> Result<PushResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    let library_items = fetch_abs_library_items(&client, &config).await?;
    
    println!("📊 AudiobookShelf has {} items", library_items.len());
    println!("📋 Sample paths from AudiobookShelf (first 10):");
    for (idx, (path, item)) in library_items.iter().take(10).enumerate() {
        println!("  {}. [{}] {}", idx + 1, item.id, path);
    }
    println!();
    
    let mut unmatched = Vec::new();
    let mut targets = Vec::new();
    let mut seen_ids = HashSet::new();
    
    for item in &request.items {
        let normalized_path = normalize_path(&item.path);
        println!("🔍 Looking for: '{}'", normalized_path);
        
        if let Some(library_item) = find_matching_item(&normalized_path, &library_items) {
            println!("   ✅ Found match: [{}] {}", library_item.id, library_item.path);
            if seen_ids.insert(library_item.id.clone()) {
                targets.push((library_item.id.clone(), item.clone()));
            }
        } else {
            println!("   ❌ No match found");
            unmatched.push(item.path.clone());
        }
    }
    
    let mut failed = Vec::new();
    let mut updated = 0;
    
    for (item_id, push_item) in targets {
        match update_abs_item(&client, &config, &item_id, &push_item.metadata).await {
            Ok(true) => updated += 1,
            Ok(false) => {},
            Err(err) => {
                failed.push(PushFailure {
                    path: push_item.path.clone(),
                    reason: err.reason,
                    status: err.status,
                });
            }
        }
    }
    
    Ok(PushResult { updated, unmatched, failed })
}

async fn fetch_abs_library_items(
    client: &reqwest::Client,
    config: &config::Config,
) -> Result<HashMap<String, AbsLibraryItem>, String> {
    let mut items_map = HashMap::new();
    let mut page = 0;
    let limit = 200;
    
    loop {
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
    
    Ok(items_map)
}

fn normalize_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.ends_with('/') && normalized.len() > 1 {
        normalized.pop();
    }
    normalized
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
    
    if let Some(last) = parts.iter().rev().find(|p| !p.is_empty() && !p.ends_with(".m4b") && !p.ends_with(".m4a") && !p.ends_with(".mp3")) {
        return Some((*last).to_string());
    }
    
    None
}

fn find_matching_item<'a>(
    path: &str,
    items: &'a HashMap<String, AbsLibraryItem>,
) -> Option<&'a AbsLibraryItem> {
    if let Some(item) = items.get(path) {
        return Some(item);
    }
    
    if let Some(book_folder) = extract_book_folder(path) {
        println!("   📁 Extracted folder: '{}'", book_folder);
        
        for (abs_path, item) in items.iter() {
            if abs_path.ends_with(&book_folder) {
                println!("   ✨ Matched via folder name: '{}'", abs_path);
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
        .map_err(|e| PushError {
            reason: e.to_string(),
            status: None,
        })?;
    
    let status = response.status();
    if !status.is_success() {
        return Err(PushError {
            reason: format!("Status {}", status),
            status: Some(status.as_u16()),
        });
    }
    
    let body: UpdateMediaResponse = response.json().await.map_err(|e| PushError {
        reason: e.to_string(),
        status: Some(status.as_u16()),
    })?;
    
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

#[tauri::command]
async fn login_to_audible(email: String, password: String, country_code: String) -> Result<String, String> {
    audible_auth::login_audible(&email, &password, &country_code).map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_audible_installed() -> Result<bool, String> {
    audible_auth::check_audible_status().map_err(|e| e.to_string())
}
#[tauri::command]
async fn get_scan_progress() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "current": crate::progress::get_current_progress(),
        "total": crate::progress::get_total_files(),
        "current_file": crate::progress::get_current_file()
    }))
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            write_tags,
            get_config,
            save_config,
            test_abs_connection,
            clear_cache,
            restart_abs_docker,
            force_abs_rescan,
            clear_abs_cache,
            clear_all_genres,
            normalize_genres,
            push_abs_updates,
            login_to_audible,
            check_audible_installed,
            inspect_file_tags,
            preview_rename,
            rename_files,
            get_scan_progress,
            cancel_scan,

        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}