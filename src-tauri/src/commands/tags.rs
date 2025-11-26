// src-tauri/src/commands/tags.rs
// ULTRA-FAST: Write metadata.json files instead of modifying audio tags

use crate::{scanner, tag_inspector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Emitter;
use futures::stream::{self, StreamExt};
use std::path::Path;

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

// AudiobookShelf metadata.json format
#[derive(Debug, Serialize)]
struct AbsMetadata {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    authors: Vec<String>,
    narrators: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    series: Vec<AbsSeries>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    genres: Vec<String>,
    #[serde(rename = "publishedYear", skip_serializing_if = "Option::is_none")]
    published_year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    isbn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
}

#[derive(Debug, Serialize)]
struct AbsSeries {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sequence: Option<String>,
}

#[tauri::command]
pub async fn write_tags(
    window: tauri::Window,
    request: WriteRequest
) -> Result<WriteResult, String> {
    let total_files = request.file_ids.len();
    
    println!("⚡ FAST JSON WRITE: {} files", total_files);
    
    // ✅ PHASE 1: Grouping files
    let _ = window.emit("write_progress", serde_json::json!({
        "phase": "grouping",
        "message": format!("Grouping {} files by book folder...", total_files),
        "current": 0,
        "total": total_files
    }));
    
    // Group files by their parent directory (book folder)
    let mut books: HashMap<String, Vec<(String, String, HashMap<String, scanner::MetadataChange>)>> = HashMap::new();
    
    for (idx, file_id) in request.file_ids.iter().enumerate() {
        if let Some(file_data) = request.files.get(file_id) {
            let path = Path::new(&file_data.path);
            if let Some(parent) = path.parent() {
                let parent_str = parent.to_string_lossy().to_string();
                books.entry(parent_str)
                    .or_insert_with(Vec::new)
                    .push((file_id.clone(), file_data.path.clone(), file_data.changes.clone()));
            }
        }
        
        // Progress every 500 files
        if idx % 500 == 0 {
            let _ = window.emit("write_progress", serde_json::json!({
                "phase": "grouping",
                "message": format!("Grouping files... {}/{}", idx, total_files),
                "current": idx,
                "total": total_files
            }));
        }
    }
    
    let total_books = books.len();
    println!("   📚 {} unique book folders", total_books);
    
    // ✅ PHASE 2: Writing JSON files
    let _ = window.emit("write_progress", serde_json::json!({
        "phase": "writing",
        "message": format!("Writing metadata.json to {} book folders...", total_books),
        "current": 0,
        "total": total_books
    }));
    
    let start_time = std::time::Instant::now();
    let completed = Arc::new(AtomicUsize::new(0));
    let success_count = Arc::new(AtomicUsize::new(0));
    let failed_count = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
    
    // Process each book folder - write ONE metadata.json per book
    let books_vec: Vec<_> = books.into_iter().collect();
    
    stream::iter(books_vec)
        .map(|(folder_path, files)| {
            let completed = Arc::clone(&completed);
            let success_count = Arc::clone(&success_count);
            let failed_count = Arc::clone(&failed_count);
            let errors = Arc::clone(&errors);
            let window = window.clone();
            let total_books = total_books;
            
            async move {
                // Get metadata from first file's changes
                let (file_id, file_path, changes) = &files[0];
                
                // Build metadata from changes
                let metadata = build_metadata_from_changes(changes);
                
                // Write metadata.json to the book folder
                let json_path = Path::new(&folder_path).join("metadata.json");
                
                match write_metadata_json(&json_path, &metadata) {
                    Ok(()) => {
                        success_count.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => {
                        failed_count.fetch_add(1, Ordering::Relaxed);
                        if let Ok(mut errs) = errors.lock() {
                            errs.push(WriteError {
                                file_id: file_id.clone(),
                                path: file_path.clone(),
                                error: e,
                            });
                        }
                    }
                }
                
                let current = completed.fetch_add(1, Ordering::Relaxed) + 1;
                
                // Progress every 50 books
                if current % 50 == 0 || current == total_books {
                    let _ = window.emit("write_progress", serde_json::json!({
                        "phase": "writing",
                        "message": format!("Writing metadata.json... {}/{}", current, total_books),
                        "current": current,
                        "total": total_books
                    }));
                }
            }
        })
        .buffer_unordered(100)  // 100 concurrent JSON writes - super fast!
        .collect::<Vec<_>>()
        .await;
    
    let elapsed = start_time.elapsed();
    let success = success_count.load(Ordering::Relaxed);
    let failed = failed_count.load(Ordering::Relaxed);
    let all_errors = errors.lock().map(|e| e.clone()).unwrap_or_default();
    let books_per_sec = success as f64 / elapsed.as_secs_f64();
    
    // ✅ PHASE 3: Complete
    let _ = window.emit("write_progress", serde_json::json!({
        "phase": "complete",
        "message": format!("Done! {} books in {:.1}s ({:.0}/sec)", success, elapsed.as_secs_f64(), books_per_sec),
        "current": total_books,
        "total": total_books
    }));
    
    println!("✅ JSON WRITE DONE: {} books in {:.1}s ({:.0} books/sec)", 
        success, elapsed.as_secs_f64(), books_per_sec);
    
    Ok(WriteResult { success, failed, errors: all_errors })
}

fn build_metadata_from_changes(changes: &HashMap<String, scanner::MetadataChange>) -> AbsMetadata {
    let title = changes.get("title")
        .map(|c| c.new.clone())
        .unwrap_or_default();
    
    let author = changes.get("author")
        .map(|c| c.new.clone())
        .unwrap_or_default();
    
    let authors: Vec<String> = author
        .split(&[',', '&'][..])
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect();
    
    let narrator = changes.get("narrator")
        .map(|c| c.new.replace("Narrated by ", "").trim().to_string());
    
    let narrators: Vec<String> = narrator
        .map(|n| vec![n])
        .unwrap_or_default();
    
    let genres: Vec<String> = changes.get("genre")
        .map(|c| c.new.split(", ").map(|g| g.to_string()).collect())
        .unwrap_or_default();
    
    let series_name = changes.get("series").map(|c| c.new.clone());
    let sequence = changes.get("sequence").map(|c| c.new.clone());
    
    let series = if let Some(name) = series_name {
        vec![AbsSeries { name, sequence }]
    } else {
        vec![]
    };
    
    AbsMetadata {
        title,
        subtitle: changes.get("subtitle").map(|c| c.new.clone()),
        authors,
        narrators,
        series,
        genres,
        published_year: changes.get("year").map(|c| c.new.clone()),
        publisher: changes.get("publisher").map(|c| c.new.clone()),
        description: changes.get("description").map(|c| c.new.clone()),
        isbn: changes.get("isbn").map(|c| c.new.clone()),
        language: Some("en".to_string()),
    }
}

fn write_metadata_json(path: &Path, metadata: &AbsMetadata) -> Result<(), String> {
    let json = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("JSON serialize error: {}", e))?;
    
    std::fs::write(path, json)
        .map_err(|e| format!("Write error: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub async fn inspect_file_tags(file_path: String) -> Result<tag_inspector::RawTags, String> {
    tag_inspector::inspect_file_tags(&file_path).map_err(|e| e.to_string())
}