// commands/scan.rs
// Library scanning and progress tracking commands

use crate::{config, scanner};
use serde_json::json;

#[tauri::command]
pub async fn scan_library(
    _window: tauri::Window,
    paths: Vec<String>,
) -> Result<serde_json::Value, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    
    let api_key = if config.openai_api_key.is_empty() {
        None
    } else {
        Some(config.openai_api_key)
    };
    
    let groups = scanner::scan_directory(
        &paths[0], 
        api_key,
        config.skip_unchanged,
        None
    )
    .await
    .map_err(|e| e.to_string())?;
    
    Ok(json!({
        "groups": groups
    }))
}

#[tauri::command]
pub async fn cancel_scan() -> Result<(), String> {
    scanner::set_cancellation_flag(true);
    Ok(())
}

#[tauri::command]
pub async fn get_scan_progress() -> Result<serde_json::Value, String> {
    Ok(json!({
        "current": crate::progress::get_current_progress(),
        "total": crate::progress::get_total_files(),
        "current_file": crate::progress::get_current_file()
    }))
}
