// src-tauri/src/commands/scan.rs
use crate::scanner;
use crate::scanner::{ScanMode, SelectiveRefreshFields};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use once_cell::sync::Lazy;

static CANCEL_FLAG: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

/// Import folders without metadata scanning - just collect and group files
#[tauri::command]
pub async fn import_folders(paths: Vec<String>) -> Result<scanner::ScanResult, String> {
    println!("📁 import_folders called with {} paths (no metadata scan)", paths.len());

    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let result = scanner::import_directories(&paths, Some(CANCEL_FLAG.clone()))
        .await
        .map_err(|e| {
            println!("❌ Import error: {}", e);
            e.to_string()
        })?;

    println!("📊 Import complete: {} groups, {} files", result.groups.len(), result.total_files);

    // DEBUG: Try to serialize to check for cycles
    match serde_json::to_string(&result) {
        Ok(json) => {
            println!("✅ JSON serialization OK, {} bytes", json.len());
        }
        Err(e) => {
            println!("❌ JSON serialization FAILED: {}", e);
            return Err(format!("Serialization error: {}", e));
        }
    }

    Ok(result)
}

/// Scan library with configurable scan mode
/// - scan_mode: "normal", "refresh_metadata", "force_fresh", "selective_refresh", or "super_scanner"
/// - force: Legacy parameter, if true uses force_fresh mode
/// - selective_fields: Optional JSON object specifying which fields to refresh (for selective_refresh mode)
/// - enable_transcription: Whether to transcribe audio intros for book verification
#[tauri::command]
pub async fn scan_library(
    paths: Vec<String>,
    force: Option<bool>,
    scan_mode: Option<String>,
    selective_fields: Option<SelectiveRefreshFields>,
    enable_transcription: Option<bool>
) -> Result<scanner::ScanResult, String> {
    // Determine scan mode from parameters
    let mode = if let Some(mode_str) = scan_mode.as_deref() {
        match mode_str {
            "normal" => ScanMode::Normal,
            "refresh_metadata" => ScanMode::RefreshMetadata,
            "force_fresh" => ScanMode::ForceFresh,
            "selective_refresh" => ScanMode::SelectiveRefresh,
            "super_scanner" => ScanMode::SuperScanner,
            _ => {
                println!("⚠️ Unknown scan mode '{}', using normal", mode_str);
                ScanMode::Normal
            }
        }
    } else if force.unwrap_or(false) {
        // Legacy force=true maps to ForceFresh
        ScanMode::ForceFresh
    } else {
        ScanMode::Normal
    };

    let transcription_enabled = enable_transcription.unwrap_or(false);
    println!("🔍 scan_library called with {} paths (mode={:?}, transcription={})",
        paths.len(), mode, transcription_enabled);

    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let result = scanner::scan_directories_with_options(
        &paths,
        Some(CANCEL_FLAG.clone()),
        mode,
        selective_fields,
        transcription_enabled
    )
        .await
        .map_err(|e| {
            println!("❌ Scan error: {}", e);
            e.to_string()
        })?;

    println!("📊 Scan complete: {} groups, {} files", result.groups.len(), result.total_files);

    // DEBUG: Try to serialize to check for cycles
    match serde_json::to_string(&result) {
        Ok(json) => {
            println!("✅ JSON serialization OK, {} bytes", json.len());
        }
        Err(e) => {
            println!("❌ JSON serialization FAILED: {}", e);
            // Try to find which group causes the issue
            for (i, group) in result.groups.iter().enumerate() {
                match serde_json::to_string(group) {
                    Ok(_) => {}
                    Err(e) => {
                        println!("❌ Group {} ({}) failed: {}", i, group.group_name, e);
                        println!("   Metadata: {:?}", group.metadata);
                    }
                }
            }
            return Err(format!("Serialization error: {}", e));
        }
    }

    Ok(result)
}

/// Rescan specific metadata fields for books
/// Use this to fix incorrect metadata without doing a full rescan
/// Example fields: "authors", "narrators", "description", "series", "genres", "publisher", "cover"
#[tauri::command]
pub async fn rescan_fields(
    paths: Vec<String>,
    fields: Vec<String>,
    enable_transcription: Option<bool>
) -> Result<scanner::ScanResult, String> {
    // Build selective fields from the list
    let mut selective_fields = SelectiveRefreshFields::default();

    for field in &fields {
        match field.to_lowercase().as_str() {
            "authors" | "author" => selective_fields.authors = true,
            "narrators" | "narrator" => selective_fields.narrators = true,
            "description" | "desc" => selective_fields.description = true,
            "series" => selective_fields.series = true,
            "genres" | "genre" => selective_fields.genres = true,
            "publisher" => selective_fields.publisher = true,
            "cover" | "artwork" => selective_fields.cover = true,
            "all" => selective_fields = SelectiveRefreshFields::all_fields(),
            _ => println!("⚠️ Unknown field '{}', ignoring", field),
        }
    }

    if !selective_fields.any_selected() {
        return Err("No valid fields specified. Use: authors, narrators, description, series, genres, publisher, cover, or all".to_string());
    }

    let transcription_enabled = enable_transcription.unwrap_or(false);
    println!("🔄 rescan_fields called with {} paths, fields: {:?}, transcription={}",
        paths.len(), fields, transcription_enabled);

    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let result = scanner::scan_directories_with_options(
        &paths,
        Some(CANCEL_FLAG.clone()),
        ScanMode::SelectiveRefresh,
        Some(selective_fields),
        transcription_enabled
    )
        .await
        .map_err(|e| {
            println!("❌ Rescan error: {}", e);
            e.to_string()
        })?;

    println!("📊 Rescan complete: {} groups, {} files", result.groups.len(), result.total_files);

    Ok(result)
}

#[tauri::command]
pub async fn cancel_scan() -> Result<(), String> {
    println!("Cancel requested - setting flag");
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn get_scan_progress() -> crate::progress::ScanProgress {
    crate::progress::get_progress()
}