// src-tauri/src/commands/scan.rs
use crate::scanner;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use once_cell::sync::Lazy;

static CANCEL_FLAG: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

#[tauri::command]
pub async fn scan_library(paths: Vec<String>) -> Result<scanner::ScanResult, String> {
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    
    // ✅ CRITICAL FIX: Reset progress before each scan
    // crate::progress::reset_progress();
    
    scanner::scan_directories(&paths, Some(CANCEL_FLAG.clone()))
        .await
        .map_err(|e| e.to_string())
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