// src-tauri/src/commands/tags.rs
use crate::{config, scanner, tag_inspector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Emitter;

#[derive(Debug, Deserialize)]
pub struct WriteRequest {
    pub file_ids: Vec<String>,
    pub files: HashMap<String, FileData>,
    pub backup: bool,
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
    pub path: String,
    pub changes: HashMap<String, scanner::MetadataChange>,
}

#[tauri::command]
pub async fn write_tags(
    window: tauri::Window,
    request: WriteRequest
) -> Result<WriteResult, String> {
    let total = request.file_ids.len();
    let backup = request.backup;
    
    let config = config::load_config().unwrap_or_default();
    let max_workers = config.max_workers.max(1);
    
    println!("🚀 Writing {} files with {} parallel workers", total, max_workers);
    
    // Build files_to_write from request
    let files_to_write: Vec<_> = request.file_ids.iter()
        .filter_map(|file_id| {
            request.files.get(file_id).map(|file_data| {
                (file_id.clone(), file_data.path.clone(), file_data.changes.clone())
            })
        })
        .collect();
    
    let semaphore = Arc::new(tokio::sync::Semaphore::new(max_workers));
    let completed = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();
    
    for (file_id, path, changes) in files_to_write {
        let sem = Arc::clone(&semaphore);
        let completed_clone = Arc::clone(&completed);
        let window_clone = window.clone();
        
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            
            // ✅ Use spawn_blocking for true parallel I/O
            let result = tokio::task::spawn_blocking(move || {
                crate::tags::write_file_tags_sync(&path, &changes, backup)
            }).await.unwrap_or_else(|e| Err(anyhow::anyhow!("Task error: {}", e)));
            
            let current = completed_clone.fetch_add(1, Ordering::SeqCst) + 1;
            
            // Emit progress every 10 files or on completion for efficiency
            if current % 10 == 0 || current == total {
                let _ = window_clone.emit("write_progress", serde_json::json!({
                    "current": current,
                    "total": total
                }));
            }
            
            (file_id, result)
        });
        
        handles.push(handle);
    }
    
    // Collect results
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
                    errors.push(WriteError {
                        file_id,
                        path: file_data.path.clone(),
                        error: e.to_string(),
                    });
                }
            }
        }
    }
    
    println!("✅ Write complete: {} success, {} failed", success, failed);
    
    Ok(WriteResult { success, failed, errors })
}

#[tauri::command]
pub async fn inspect_file_tags(file_path: String) -> Result<tag_inspector::RawTags, String> {
    tag_inspector::inspect_file_tags(&file_path).map_err(|e| e.to_string())
}