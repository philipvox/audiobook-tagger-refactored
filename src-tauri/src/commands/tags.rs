// src-tauri/src/commands/tags.rs
// COMPLETE REPLACEMENT FILE

use crate::{config, scanner, tag_inspector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Emitter;
use futures::stream::{self, StreamExt};

#[derive(Debug, Deserialize)]
pub struct WriteRequest {
    pub file_ids: Vec<String>,
    pub files: HashMap<String, FileData>,
    pub backup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteResult {
    pub success: usize,
    pub failed: usize,
    pub errors: Vec<WriteError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    
    println!("🚀 Writing {} files with {} workers", total, max_workers);
    
    // Build files list
    let files_to_write: Vec<_> = request.file_ids.iter()
        .filter_map(|file_id| {
            request.files.get(file_id).map(|file_data| {
                (file_id.clone(), file_data.path.clone(), file_data.changes.clone())
            })
        })
        .collect();
    
    let completed = Arc::new(AtomicUsize::new(0));
    let success_count = Arc::new(AtomicUsize::new(0));
    let failed_count = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
    
    // ✅ STREAMING - only max_workers at a time
    stream::iter(files_to_write)
        .map(|(file_id, path, changes)| {
            let window = window.clone();
            let completed = Arc::clone(&completed);
            let success_count = Arc::clone(&success_count);
            let failed_count = Arc::clone(&failed_count);
            let errors = Arc::clone(&errors);
            
            async move {
                let path_for_write = path.clone();
                let result = tokio::task::spawn_blocking(move || {
                    crate::tags::write_file_tags_sync(&path_for_write, &changes, backup)
                }).await.unwrap_or_else(|e| Err(anyhow::anyhow!("Task error: {}", e)));
                
                let current = completed.fetch_add(1, Ordering::SeqCst) + 1;
                
                match result {
                    Ok(()) => {
                        success_count.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(e) => {
                        failed_count.fetch_add(1, Ordering::SeqCst);
                        errors.lock().unwrap().push(WriteError {
                            file_id: file_id.clone(),
                            path: path.clone(),
                            error: e.to_string(),
                        });
                    }
                }
                
                // Progress every 50 files
                if current % 50 == 0 || current == total {
                    let _ = window.emit("write_progress", serde_json::json!({
                        "current": current,
                        "total": total
                    }));
                }
            }
        })
        .buffer_unordered(max_workers)
        .collect::<Vec<_>>()
        .await;
    
    let success = success_count.load(Ordering::SeqCst);
    let failed = failed_count.load(Ordering::SeqCst);
    let all_errors = errors.lock().unwrap().clone();
    
    println!("✅ Complete: {} success, {} failed", success, failed);
    
    Ok(WriteResult { success, failed, errors: all_errors })
}

#[tauri::command]
pub async fn inspect_file_tags(file_path: String) -> Result<tag_inspector::RawTags, String> {
    tag_inspector::inspect_file_tags(&file_path).map_err(|e| e.to_string())
}