// src-tauri/src/commands/scan.rs
use crate::scanner;
use crate::scanner::ScanMode;
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
/// - scan_mode: "normal", "refresh_metadata", "force_fresh", or "selective_refresh"
/// - force: Legacy parameter, if true uses force_fresh mode
#[tauri::command]
pub async fn scan_library(
    paths: Vec<String>,
    force: Option<bool>,
    scan_mode: Option<String>
) -> Result<scanner::ScanResult, String> {
    // Determine scan mode from parameters
    let mode = if let Some(mode_str) = scan_mode {
        match mode_str.as_str() {
            "normal" => ScanMode::Normal,
            "refresh_metadata" => ScanMode::RefreshMetadata,
            "force_fresh" => ScanMode::ForceFresh,
            "selective_refresh" => ScanMode::SelectiveRefresh,
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

    println!("🔍 scan_library called with {} paths (mode={:?})", paths.len(), mode);

    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let result = scanner::scan_directories(&paths, Some(CANCEL_FLAG.clone()), mode)
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