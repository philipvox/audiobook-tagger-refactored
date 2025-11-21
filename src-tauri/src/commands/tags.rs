use crate::{config, scanner, tags, tag_inspector};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicUsize;
use tauri::Emitter;

#[derive(Debug, Deserialize)]
pub struct WriteRequest {
    file_ids: Vec<String>,
    files: HashMap<String, FileData>,
    backup: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WriteResult {
    pub success: usize,
    pub failed: usize,
    pub errors: Vec<WriteError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WriteError {
    pub file_id: String,
    pub path: String,
    pub error: String,
}

#[derive(Debug, Deserialize)]
pub struct FileData {
    path: String,
    changes: HashMap<String, scanner::MetadataChange>,
    group_id: Option<String>,
}

#[tauri::command]
pub async fn write_tags(
    window: tauri::Window, 
    request: WriteRequest
) -> Result<tags::WriteResult, String> {
    let total = request.file_ids.len();
    let config = config::load_config().unwrap_or_default();
    let max_workers = config.max_workers.max(1);
    let backup = request.backup;
    
    println!("🚀 Writing {} files with {} parallel workers", total, max_workers);
    
    // Emit initial progress
    let _ = window.emit("write_progress", serde_json::json!({
        "current": 0,
        "total": total
    }));
    
    let files_to_write: Vec<(String, String, HashMap<String, scanner::MetadataChange>, Option<String>)> = request.file_ids.iter()
        .filter_map(|file_id| {
            request.files.get(file_id).map(|file_data| {
                (file_id.clone(), file_data.path.clone(), file_data.changes.clone(), file_data.group_id.clone())
            })
        })
        .collect();
    
    // Track which groups we've already saved covers for (thread-safe)
    let processed_groups = Arc::new(Mutex::new(HashSet::new()));
    
    let start_time = std::time::Instant::now();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(max_workers));
    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut handles = Vec::new();

    for (file_id, path, changes, group_id) in files_to_write {
        let sem = Arc::clone(&semaphore);
        let completed_clone = Arc::clone(&completed);
        let window_clone = window.clone();
        let total_clone = total;
        let processed_groups_clone = Arc::clone(&processed_groups);
        
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            
            // Check if we should save cover for this group (only once per group)
            let group_id_for_cover = if let Some(ref gid) = group_id {
                let mut processed = processed_groups_clone.lock().unwrap();
                if !processed.contains(gid) {
                    processed.insert(gid.clone());
                    Some(gid.clone())
                } else {
                    None
                }
            } else {
                None
            };
            
            let result = tags::write_file_tags(&path, &changes, backup, group_id_for_cover.as_deref()).await;
            
            let current = completed_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let _ = window_clone.emit("write_progress", serde_json::json!({
                "current": current,
                "total": total_clone
            }));
            
            println!("📝 Progress: {}/{}", current, total_clone);
            
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
    
    // Emit final progress
    let _ = window.emit("write_progress", serde_json::json!({
        "current": total,
        "total": total
    }));
    
    let elapsed = start_time.elapsed();
    let rate = total as f64 / elapsed.as_secs_f64();
    println!("⚡ Write performance: {:.1} files/sec, total time: {:?}", rate, elapsed);
    
    Ok(tags::WriteResult { success, failed, errors })
}

#[tauri::command]
pub async fn inspect_file_tags(file_path: String) -> Result<tag_inspector::RawTags, String> {
    tag_inspector::inspect_file_tags(&file_path).map_err(|e| e.to_string())
}