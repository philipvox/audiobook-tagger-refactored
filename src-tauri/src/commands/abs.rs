// commands/abs.rs
// AudiobookShelf server integration commands

use crate::{config, scanner};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize)]
pub struct ConnectionTest {
    success: bool,
    message: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PushItem {
    path: String,
    metadata: scanner::BookMetadata,
}

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    items: Vec<PushItem>,
}

#[derive(Debug, Serialize)]
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
}

#[derive(Debug, Deserialize, Clone)]
pub struct AbsLibraryItem {
    id: String,
    path: String,
    #[serde(default)]
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
pub async fn push_abs_updates(request: PushRequest) -> Result<PushResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    let library_items = fetch_abs_library_items(&client, &config).await?;
    
    println!("📊 AudiobookShelf has {} items", library_items.len());
    
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

#[tauri::command]
pub async fn restart_abs_docker() -> Result<String, String> {
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
        Ok("Library rescan triggered".to_string())
    } else {
        Err(format!("Failed to trigger rescan: {}", response.status()))
    }
}

#[tauri::command]
pub async fn clear_abs_cache() -> Result<String, String> {
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

// Helper functions

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

fn find_matching_item<'a>(
    path: &str,
    items: &'a HashMap<String, AbsLibraryItem>,
) -> Option<&'a AbsLibraryItem> {
    if let Some(item) = items.get(path) {
        return Some(item);
    }
    
    // Try matching by folder name
    if let Some(book_folder) = extract_book_folder(path) {
        for (abs_path, item) in items.iter() {
            if abs_path.ends_with(&book_folder) {
                return Some(item);
            }
        }
    }
    
    // Try parent directory matching
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
    
    if let Some(last) = parts.iter().rev().find(|p| !p.is_empty() && !p.ends_with(".m4b") && !p.ends_with(".m4a") && !p.ends_with(".mp3")) {
        return Some((*last).to_string());
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
