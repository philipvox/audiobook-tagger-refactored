// commands/config.rs
// Configuration management commands

use crate::config;

#[tauri::command]
pub fn get_config() -> config::Config {
    config::load_config().unwrap_or_default()
}

#[tauri::command]
pub fn save_config(config: config::Config) -> Result<(), String> {
    config::save_config(&config).map_err(|e| e.to_string())
}
