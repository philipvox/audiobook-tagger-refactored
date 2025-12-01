// src-tauri/src/commands/scan.rs
use crate::scanner;
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

#[tauri::command]
pub async fn scan_library(paths: Vec<String>, force: Option<bool>) -> Result<scanner::ScanResult, String> {
    let force = force.unwrap_or(false);
    println!("🔍 scan_library called with {} paths (force={})", paths.len(), force);

    CANCEL_FLAG.store(false, Ordering::SeqCst);

    // FORCE cache clear every time to prevent stale data issues
    if let Err(e) = crate::cache::clear() {
        println!("⚠️ Cache clear failed: {}", e);
    } else {
        println!("🗑️ Cache cleared successfully");
    }

    let result = scanner::scan_directories(&paths, Some(CANCEL_FLAG.clone()), force)
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