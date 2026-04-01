// commands/ollama.rs
// Tauri commands for managing the bundled Ollama local AI installation.

use crate::ollama_manager;

/// Get current Ollama status (installed, running, models, etc.)
#[tauri::command]
pub async fn ollama_get_status() -> Result<ollama_manager::OllamaStatus, String> {
    Ok(ollama_manager::get_status().await)
}

/// Get available model presets for the UI picker
#[tauri::command]
pub fn ollama_get_model_presets() -> Vec<ollama_manager::ModelPreset> {
    ollama_manager::MODEL_PRESETS.to_vec()
}

/// Download and install Ollama binary
#[tauri::command]
pub async fn ollama_install(app_handle: tauri::AppHandle) -> Result<String, String> {
    ollama_manager::install(app_handle).await
}

/// Cancel an in-progress install/download
#[tauri::command]
pub fn ollama_cancel_install() {
    ollama_manager::cancel_install();
}

/// Uninstall Ollama (delete binary + all models)
#[tauri::command]
pub async fn ollama_uninstall() -> Result<String, String> {
    ollama_manager::uninstall().await
}

/// Start the Ollama server
#[tauri::command]
pub async fn ollama_start() -> Result<String, String> {
    ollama_manager::start().await
}

/// Stop the Ollama server
#[tauri::command]
pub async fn ollama_stop() -> Result<String, String> {
    ollama_manager::stop().await
}

/// Pull (download) a model
#[tauri::command]
pub async fn ollama_pull_model(app_handle: tauri::AppHandle, model_name: String) -> Result<String, String> {
    ollama_manager::pull_model(app_handle, &model_name).await
}

/// Delete a model
#[tauri::command]
pub async fn ollama_delete_model(model_name: String) -> Result<String, String> {
    ollama_manager::delete_model(&model_name).await
}

/// Get disk usage of the Ollama data directory
#[tauri::command]
pub fn ollama_get_disk_usage() -> Result<u64, String> {
    ollama_manager::get_disk_usage()
}

/// Enable local AI mode: start Ollama, pull model if needed, update config
#[tauri::command]
pub async fn ollama_enable(app_handle: tauri::AppHandle, model_name: String) -> Result<String, String> {
    // Ensure Ollama is running
    if !ollama_manager::is_running().await {
        ollama_manager::start().await?;
    }

    // Check if the model is already installed
    let models = ollama_manager::list_models().await.unwrap_or_default();
    let has_model = models.iter().any(|m| m.name == model_name || m.name.starts_with(&format!("{}:", model_name.split(':').next().unwrap_or(""))));

    if !has_model {
        // Pull the model
        ollama_manager::pull_model(app_handle, &model_name).await?;
    }

    // Update config
    let mut config = crate::config::load_config().map_err(|e| e.to_string())?;
    ollama_manager::configure_for_local(&mut config, &model_name);
    crate::config::save_config(&config).map_err(|e| e.to_string())?;

    Ok(format!("Local AI enabled with model '{}'", model_name))
}

/// Disable local AI mode: revert config to remote/manual
#[tauri::command]
pub async fn ollama_disable() -> Result<String, String> {
    let mut config = crate::config::load_config().map_err(|e| e.to_string())?;
    ollama_manager::configure_for_remote(&mut config);
    crate::config::save_config(&config).map_err(|e| e.to_string())?;

    // Optionally stop Ollama to free resources
    let _ = ollama_manager::stop().await;

    Ok("Local AI disabled".to_string())
}
