// src-tauri/src/commands/duplicates.rs
// Tauri commands for duplicate audiobook detection and management

use crate::duplicate_finder::{
    self, DuplicateGroup, DuplicateBook, DuplicateScanOptions, DuplicateScanResult,
};

/// Scan library for duplicate audiobooks
#[tauri::command]
pub async fn scan_for_duplicates(
    library_path: String,
    check_exact_titles: Option<bool>,
    check_similar_titles: Option<bool>,
    check_asin: Option<bool>,
    check_duration: Option<bool>,
    similarity_threshold: Option<f64>,
) -> Result<DuplicateScanResult, String> {
    println!("🔍 Starting duplicate scan for: {}", library_path);

    let options = DuplicateScanOptions {
        check_exact_titles: check_exact_titles.unwrap_or(true),
        check_similar_titles: check_similar_titles.unwrap_or(true),
        check_asin: check_asin.unwrap_or(true),
        check_duration: check_duration.unwrap_or(true),
        similarity_threshold: similarity_threshold.unwrap_or(0.85),
        duration_tolerance_seconds: 60,
    };

    // Run in blocking task since it does filesystem operations
    tokio::task::spawn_blocking(move || {
        duplicate_finder::scan_for_duplicates(&library_path, &options)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Get detailed information about a specific duplicate group
#[tauri::command]
pub async fn get_duplicate_details(
    folder_path: String,
) -> Result<DuplicateBook, String> {
    println!("📖 Getting details for: {}", folder_path);

    let path = std::path::Path::new(&folder_path);
    if !path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    // Collect info about this folder
    let mut audio_files: Vec<(String, u64)> = Vec::new();
    let mut has_metadata = false;
    let mut cover_path: Option<String> = None;

    let entries = std::fs::read_dir(path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_lowercase();

        if entry.path().is_file() {
            if file_name.ends_with(".mp3") || file_name.ends_with(".m4a")
                || file_name.ends_with(".m4b") || file_name.ends_with(".flac") {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                audio_files.push((file_name.clone(), size));
            }

            if file_name == "metadata.json" {
                has_metadata = true;
            }

            if file_name.starts_with("cover.") || file_name.starts_with("folder.") {
                let ext = file_name.rsplit('.').next().unwrap_or("");
                if ["jpg", "jpeg", "png", "webp", "gif"].contains(&ext) {
                    cover_path = Some(entry.path().to_string_lossy().to_string());
                }
            }
        }
    }

    let has_cover = cover_path.is_some();

    // Get metadata
    let (title, author, narrator) = if has_metadata {
        let metadata_path = path.join("metadata.json");
        if let Ok(content) = std::fs::read_to_string(&metadata_path) {
            #[derive(serde::Deserialize)]
            struct Metadata {
                #[serde(default)]
                title: Option<String>,
                // Support both "author" (string) and "authors" (array)
                #[serde(default)]
                author: Option<String>,
                #[serde(default)]
                authors: Option<Vec<String>>,
                #[serde(default)]
                narrator: Option<String>,
                #[serde(default)]
                narrators: Option<Vec<String>>,
            }
            if let Ok(m) = serde_json::from_str::<Metadata>(&content) {
                let title = m.title.unwrap_or_default();
                let author = m.authors
                    .and_then(|a| if a.is_empty() { None } else { Some(a.join(", ")) })
                    .or(m.author)
                    .unwrap_or_default();
                let narrator = m.narrators
                    .and_then(|n| if n.is_empty() { None } else { Some(n.join(", ")) })
                    .or(m.narrator);
                (title, author, narrator)
            } else {
                (String::new(), String::new(), None)
            }
        } else {
            (String::new(), String::new(), None)
        }
    } else {
        // Parse from folder name
        let folder_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        if folder_name.contains(" - ") {
            let parts: Vec<&str> = folder_name.splitn(2, " - ").collect();
            (parts.get(1).unwrap_or(&"").to_string(), parts.get(0).unwrap_or(&"").to_string(), None)
        } else {
            (folder_name.to_string(), String::new(), None)
        }
    };

    let total_size: u64 = audio_files.iter().map(|(_, s)| s).sum();
    let audio_format = audio_files.first().map(|(name, _)| {
        if name.ends_with(".m4b") { "m4b".to_string() }
        else if name.ends_with(".m4a") { "m4a".to_string() }
        else if name.ends_with(".mp3") { "mp3".to_string() }
        else { "unknown".to_string() }
    });

    // Check if in correct author folder
    let path_lower = folder_path.to_lowercase();
    let author_lower = author.to_lowercase();
    let in_correct_folder = if author.is_empty() {
        true  // Can't verify
    } else {
        // Check if author name appears in folder path
        let author_normalized = author_lower.replace(",", "").replace(".", "");
        path_lower.contains(&author_normalized) ||
            author_lower.split_whitespace()
                .filter(|w| w.len() > 2)
                .any(|w| path_lower.contains(w))
    };

    // Calculate quality score
    let mut quality_score = 0.0;
    if in_correct_folder { quality_score += 50.0; }  // Highest priority
    if has_metadata { quality_score += 30.0; }
    if has_cover { quality_score += 20.0; }
    if let Some(ref fmt) = audio_format {
        match fmt.as_str() {
            "m4b" => quality_score += 15.0,
            "m4a" => quality_score += 10.0,
            _ => {}
        }
    }
    quality_score += (total_size as f64 / (1024.0 * 1024.0 * 100.0)).min(20.0);
    if audio_files.len() == 1 { quality_score += 10.0; }

    Ok(DuplicateBook {
        folder_path: folder_path.clone(),
        title,
        author,
        narrator,
        duration_seconds: Some((total_size / (1024 * 1024)) * 60),  // Rough estimate
        file_count: audio_files.len(),
        total_size_bytes: total_size,
        has_cover,
        cover_path,
        has_metadata_file: has_metadata,
        quality_score,
        audio_format,
        in_correct_folder,
    })
}

/// Delete a duplicate permanently
#[tauri::command]
pub async fn delete_duplicate(
    folder_path: String,
) -> Result<(), String> {
    println!("🗑️ Deleting: {}", folder_path);

    tokio::task::spawn_blocking(move || {
        duplicate_finder::delete_book_folder(&folder_path)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Move a duplicate to system trash
#[tauri::command]
pub async fn move_duplicate_to_trash(
    folder_path: String,
) -> Result<(), String> {
    println!("🗑️ Moving to trash: {}", folder_path);

    tokio::task::spawn_blocking(move || {
        duplicate_finder::move_to_trash(&folder_path)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
