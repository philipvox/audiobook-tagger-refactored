// src-tauri/src/commands/tags.rs
// ULTRA-FAST: Write metadata.json files instead of modifying audio tags

use crate::{scanner, tag_inspector};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Emitter;
use futures::stream::{self, StreamExt};
use std::path::Path;

/// Stores information needed to undo a write operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoEntry {
    pub folder_path: String,
    pub original_content: Option<String>,  // None if file didn't exist
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoState {
    pub entries: Vec<UndoEntry>,
    pub write_timestamp: u64,
    pub books_written: usize,
}

impl Default for UndoState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            write_timestamp: 0,
            books_written: 0,
        }
    }
}

/// Global undo state - stores the last write operation for undo
static UNDO_STATE: Lazy<Mutex<UndoState>> = Lazy::new(|| Mutex::new(UndoState::default()));

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

    // Load config for concurrency settings
    let config = crate::config::Config::load().unwrap_or_default();
    let json_write_concurrency = config.get_concurrency(crate::config::ConcurrencyOp::JsonWrites);

    println!("⚡ FAST JSON WRITE: {} files (concurrency: {})", total_files, json_write_concurrency);
    
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

    // ✅ PHASE 1.5: Save undo state BEFORE writing
    let _ = window.emit("write_progress", serde_json::json!({
        "phase": "preparing_undo",
        "message": "Saving original state for undo capability...",
        "current": 0,
        "total": total_books
    }));

    let undo_entries: Vec<UndoEntry> = books_vec.iter()
        .map(|(folder_path, _)| {
            let json_path = Path::new(folder_path).join("metadata.json");
            let original_content = if json_path.exists() {
                std::fs::read_to_string(&json_path).ok()
            } else {
                None
            };
            UndoEntry {
                folder_path: folder_path.clone(),
                original_content,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            }
        })
        .collect();

    // Store undo state before writing
    if let Ok(mut undo_state) = UNDO_STATE.lock() {
        *undo_state = UndoState {
            entries: undo_entries,
            write_timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            books_written: total_books,
        };
    }

    println!("   💾 Saved undo state for {} book folders", total_books);
    
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

                let write_result = write_metadata_json(&json_path, &metadata);

                // Try to save cover art if available
                // The cover is cached by book_id during scanning
                if let Some(cover_url_change) = changes.get("cover_url") {
                    if !cover_url_change.new.is_empty() {
                        // Try to find cached cover by looking for a matching cache entry
                        // The cache key format is "cover_{book_id}" but we don't have book_id here
                        // Instead, try to download and save the cover from the URL
                        let _ = save_cover_to_folder(&folder_path, &cover_url_change.new).await;
                    }
                }

                match write_result {
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
        .buffer_unordered(json_write_concurrency)
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
    // CRITICAL FIX: Use the new JSON array fields for proper data transfer
    // Previously used splitting which lost data and caused empty values

    // Title - must ALWAYS be present
    let title = changes.get("title")
        .map(|c| c.new.clone())
        .unwrap_or_default();

    // Authors - use the pre-serialized JSON array from calculate_changes
    let authors: Vec<String> = changes.get("authors_json")
        .and_then(|c| serde_json::from_str(&c.new).ok())
        .unwrap_or_else(|| {
            // Fallback: split from single author field
            changes.get("author")
                .map(|c| {
                    c.new.split(" & ")
                        .flat_map(|part| part.split(", "))
                        .map(|a| a.trim().to_string())
                        .filter(|a| !a.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        });

    // Narrators - use the pre-serialized JSON array from calculate_changes
    let narrators: Vec<String> = changes.get("narrators_json")
        .and_then(|c| serde_json::from_str(&c.new).ok())
        .unwrap_or_else(|| {
            // Fallback: split from single narrator field (semicolon-separated)
            changes.get("narrator")
                .map(|c| {
                    c.new.replace("Narrated by ", "")
                        .split("; ")
                        .map(|n| n.trim().to_string())
                        .filter(|n| !n.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        });

    // Genres - use the pre-serialized JSON array from calculate_changes
    let genres: Vec<String> = changes.get("genres_json")
        .and_then(|c| serde_json::from_str(&c.new).ok())
        .unwrap_or_else(|| {
            // Fallback: split from comma-separated genre field
            changes.get("genre")
                .map(|c| {
                    c.new.split(", ")
                        .map(|g| g.trim().to_string())
                        .filter(|g| !g.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        });

    // Series
    let series_name = changes.get("series").map(|c| c.new.clone());
    let sequence = changes.get("sequence").map(|c| c.new.clone());

    let series = if let Some(name) = series_name {
        if !name.is_empty() {
            vec![AbsSeries { name, sequence }]
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    // Language - only use if explicitly provided (don't default to English for non-English books)
    let language = changes.get("language")
        .map(|c| c.new.clone())
        .filter(|l| !l.is_empty());

    AbsMetadata {
        title,
        subtitle: changes.get("subtitle").map(|c| c.new.clone()).filter(|s| !s.is_empty()),
        authors,
        narrators,
        series,
        genres,
        published_year: changes.get("year").map(|c| c.new.clone()).filter(|y| !y.is_empty()),
        publisher: changes.get("publisher").map(|c| c.new.clone()).filter(|p| !p.is_empty()),
        description: changes.get("description").map(|c| c.new.clone()).filter(|d| !d.is_empty()),
        isbn: changes.get("isbn").map(|c| c.new.clone()).filter(|i| !i.is_empty()),
        language,
    }
}

fn write_metadata_json(path: &Path, metadata: &AbsMetadata) -> Result<(), String> {
    let json = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("JSON serialize error: {}", e))?;

    std::fs::write(path, json)
        .map_err(|e| format!("Write error: {}", e))?;

    Ok(())
}

/// Download and save cover art to the book folder as cover.jpg/cover.png
async fn save_cover_to_folder(folder_path: &str, cover_url: &str) -> Result<(), String> {
    // Skip if cover.jpg or cover.png already exists
    let cover_jpg = Path::new(folder_path).join("cover.jpg");
    let cover_png = Path::new(folder_path).join("cover.png");
    if cover_jpg.exists() || cover_png.exists() {
        return Ok(());
    }

    // Download the cover
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client.get(cover_url).send().await
        .map_err(|e| format!("Failed to download cover: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Cover download failed with status: {}", response.status()));
    }

    let content_type = response.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let bytes = response.bytes().await
        .map_err(|e| format!("Failed to read cover data: {}", e))?;

    // Validate it's an image
    if bytes.len() < 100 {
        return Err("Cover image too small".to_string());
    }

    // Determine file extension based on mime type
    let extension = if content_type.contains("png") { "png" } else { "jpg" };
    let cover_path = Path::new(folder_path).join(format!("cover.{}", extension));

    std::fs::write(&cover_path, &bytes)
        .map_err(|e| format!("Failed to write cover file: {}", e))?;

    println!("   🖼️  Saved cover to {}", cover_path.display());
    Ok(())
}

#[tauri::command]
pub async fn inspect_file_tags(file_path: String) -> Result<tag_inspector::RawTags, String> {
    tag_inspector::inspect_file_tags(&file_path).map_err(|e| e.to_string())
}

/// Get undo status - returns info about the last write operation that can be undone
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoStatus {
    pub available: bool,
    pub books_count: usize,
    pub timestamp: u64,
    pub age_seconds: u64,
}

#[tauri::command]
pub async fn get_undo_status() -> Result<UndoStatus, String> {
    let undo_state = UNDO_STATE.lock()
        .map_err(|e| format!("Failed to lock undo state: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let age_seconds = now.saturating_sub(undo_state.write_timestamp);

    // Undo is available if we have entries and they're less than 1 hour old
    let available = !undo_state.entries.is_empty() && age_seconds < 3600;

    Ok(UndoStatus {
        available,
        books_count: undo_state.books_written,
        timestamp: undo_state.write_timestamp,
        age_seconds,
    })
}

/// Undo the last write operation - restores original metadata.json files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoResult {
    pub success: usize,
    pub failed: usize,
    pub restored: usize,
    pub deleted: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn undo_last_write(window: tauri::Window) -> Result<UndoResult, String> {
    // Get and clear the undo state
    let undo_state = {
        let mut state = UNDO_STATE.lock()
            .map_err(|e| format!("Failed to lock undo state: {}", e))?;
        std::mem::take(&mut *state)
    };

    if undo_state.entries.is_empty() {
        return Err("No write operation to undo".to_string());
    }

    let total = undo_state.entries.len();
    let mut success = 0;
    let mut failed = 0;
    let mut restored = 0;
    let mut deleted = 0;
    let mut errors = Vec::new();

    println!("⏪ UNDO: Restoring {} book folders...", total);

    let _ = window.emit("undo_progress", serde_json::json!({
        "phase": "undoing",
        "message": format!("Undoing changes to {} book folders...", total),
        "current": 0,
        "total": total
    }));

    for (idx, entry) in undo_state.entries.iter().enumerate() {
        let json_path = Path::new(&entry.folder_path).join("metadata.json");

        let result = match &entry.original_content {
            Some(content) => {
                // Restore original content
                match std::fs::write(&json_path, content) {
                    Ok(()) => {
                        restored += 1;
                        Ok(())
                    }
                    Err(e) => Err(format!("{}: {}", json_path.display(), e))
                }
            }
            None => {
                // File didn't exist before - delete it
                if json_path.exists() {
                    match std::fs::remove_file(&json_path) {
                        Ok(()) => {
                            deleted += 1;
                            Ok(())
                        }
                        Err(e) => Err(format!("{}: {}", json_path.display(), e))
                    }
                } else {
                    Ok(()) // Already doesn't exist
                }
            }
        };

        match result {
            Ok(()) => success += 1,
            Err(e) => {
                failed += 1;
                errors.push(e);
            }
        }

        // Progress every 50 items
        if (idx + 1) % 50 == 0 || idx + 1 == total {
            let _ = window.emit("undo_progress", serde_json::json!({
                "phase": "undoing",
                "message": format!("Restoring... {}/{}", idx + 1, total),
                "current": idx + 1,
                "total": total
            }));
        }
    }

    let _ = window.emit("undo_progress", serde_json::json!({
        "phase": "complete",
        "message": format!("Undo complete: {} restored, {} deleted", restored, deleted),
        "current": total,
        "total": total
    }));

    println!("✅ UNDO COMPLETE: {} restored, {} deleted, {} failed", restored, deleted, failed);

    Ok(UndoResult {
        success,
        failed,
        restored,
        deleted,
        errors,
    })
}

/// Clear undo state (e.g., after confirming changes are good)
#[tauri::command]
pub async fn clear_undo_state() -> Result<(), String> {
    if let Ok(mut state) = UNDO_STATE.lock() {
        *state = UndoState::default();
    }
    println!("🗑️ Cleared undo state");
    Ok(())
}