// commands/rename.rs
// File renaming and preview commands

use crate::{file_rename, scanner};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct RenamePreview {
    old_path: String,
    new_path: String,
    changed: bool,
}

#[tauri::command]
pub async fn preview_rename(
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
pub async fn rename_files(
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
