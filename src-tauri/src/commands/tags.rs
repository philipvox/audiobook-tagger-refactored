// src-tauri/src/commands/tags.rs
use crate::{scanner, tag_inspector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    window: tauri::Window,  // ✅ Add window parameter
    request: WriteRequest
) -> Result<WriteResult, String> {
    let total = request.file_ids.len();
    let backup = request.backup;
    
    println!("🚀 Writing {} files", total);
    
    let mut success = 0;
    let mut failed = 0;
    let mut errors = Vec::new();
    
    for (index, file_id) in request.file_ids.iter().enumerate() {
        if let Some(file_data) = request.files.get(file_id) {
            match crate::tags::write_file_tags(&file_data.path, &file_data.changes, backup).await {
                Ok(_) => success += 1,
                Err(e) => {
                    failed += 1;
                    errors.push(WriteError {
                        file_id: file_id.clone(),
                        path: file_data.path.clone(),
                        error: e.to_string(),
                    });
                }
            }
            
            // ✅ Emit progress after each file
            let _ = window.emit("write_progress", serde_json::json!({
                "current": index + 1,
                "total": total
            }));
        }
    }
    
    println!("✅ Write complete: {} success, {} failed", success, failed);
    
    Ok(WriteResult { success, failed, errors })
}

#[tauri::command]
pub async fn inspect_file_tags(file_path: String) -> Result<tag_inspector::RawTags, String> {
    tag_inspector::inspect_file_tags(&file_path).map_err(|e| e.to_string())
}