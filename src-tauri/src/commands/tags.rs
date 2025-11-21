use crate::{config, scanner, tag_inspector, tags};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};  // ✅ Added Ordering here
use std::sync::Mutex;
use std::time::{Duration, Instant};  // ✅ Added this
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
    
    let files_to_write: Vec<(String, String, HashMap<String, scanner::MetadataChange>)> = request.file_ids.iter()
        .filter_map(|file_id| {
            request.files.get(file_id).map(|file_data| {
                (file_id.clone(), file_data.path.clone(), file_data.changes.clone())
            })
        })
        .collect();
    
    let start_time = std::time::Instant::now();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(max_workers));
    let completed = Arc::new(AtomicUsize::new(0));
    
    // Throttle progress events - only emit every 10 files or every 100ms
    let last_emit = Arc::new(Mutex::new(Instant::now()));
    let emit_interval = Duration::from_millis(100);
    
    let mut handles = Vec::new();

    for (file_id, path, changes) in files_to_write {
        let sem = Arc::clone(&semaphore);
        let completed_clone = Arc::clone(&completed);
        let window_clone = window.clone();
        let total_clone = total;
        let last_emit_clone = Arc::clone(&last_emit);
        
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            let result = tags::write_file_tags(&path, &changes, backup, None).await;  // ✅ Added None
            
            // Increment counter
            let current = completed_clone.fetch_add(1, Ordering::SeqCst) + 1;
            
            // Throttle: Only emit every 10 files OR every 100ms
            let should_emit = {
                let mut last = last_emit_clone.lock().unwrap();
                let now = Instant::now();
                
                if current % 10 == 0 || now.duration_since(*last) >= emit_interval || current == total_clone {
                    *last = now;
                    true
                } else {
                    false
                }
            };
            
            if should_emit {
                let _ = window_clone.emit("write_progress", serde_json::json!({
                    "current": current,
                    "total": total_clone
                }));
            }
            
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
pub async fn inspect_file_tags(file_path: String) -> Result<tag_inspector::RawTags, String> {
    tag_inspector::inspect_file_tags(&file_path).map_err(|e| e.to_string())
}