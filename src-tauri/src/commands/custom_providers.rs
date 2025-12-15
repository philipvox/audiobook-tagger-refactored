// src-tauri/src/commands/custom_providers.rs
// Tauri commands for custom metadata providers

use crate::config::{load_config, save_config, CustomProvider};
use crate::custom_providers::{
    search_custom_providers, get_available_abs_agg_providers, CustomProviderResult
};
use serde::{Deserialize, Serialize};

/// Available provider info for UI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableProvider {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// Get list of available abs-agg providers
#[tauri::command]
pub fn get_available_providers() -> Vec<AvailableProvider> {
    get_available_abs_agg_providers()
        .into_iter()
        .map(|(id, name, desc)| AvailableProvider {
            id: id.to_string(),
            name: name.to_string(),
            description: desc.to_string(),
        })
        .collect()
}

/// Get configured custom providers
#[tauri::command]
pub fn get_custom_providers() -> Result<Vec<CustomProvider>, String> {
    let config = load_config().map_err(|e| e.to_string())?;
    Ok(config.custom_providers)
}

/// Update custom providers configuration
#[tauri::command]
pub fn set_custom_providers(providers: Vec<CustomProvider>) -> Result<(), String> {
    let mut config = load_config().map_err(|e| e.to_string())?;
    config.custom_providers = providers;
    save_config(&config).map_err(|e| e.to_string())?;
    Ok(())
}

/// Add a new custom provider
#[tauri::command]
pub fn add_custom_provider(provider: CustomProvider) -> Result<(), String> {
    let mut config = load_config().map_err(|e| e.to_string())?;

    // Check if provider with same ID already exists
    if config.custom_providers.iter().any(|p| p.provider_id == provider.provider_id) {
        return Err(format!("Provider '{}' already exists", provider.provider_id));
    }

    config.custom_providers.push(provider);
    save_config(&config).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a custom provider
#[tauri::command]
pub fn remove_custom_provider(provider_id: String) -> Result<(), String> {
    let mut config = load_config().map_err(|e| e.to_string())?;
    config.custom_providers.retain(|p| p.provider_id != provider_id);
    save_config(&config).map_err(|e| e.to_string())?;
    Ok(())
}

/// Toggle provider enabled state
#[tauri::command]
pub fn toggle_provider(provider_id: String, enabled: bool) -> Result<(), String> {
    let mut config = load_config().map_err(|e| e.to_string())?;

    if let Some(provider) = config.custom_providers.iter_mut().find(|p| p.provider_id == provider_id) {
        provider.enabled = enabled;
        save_config(&config).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Provider '{}' not found", provider_id))
    }
}

/// Test search with a specific provider
#[tauri::command]
pub async fn test_provider(provider_id: String, title: String, author: String) -> Result<Option<CustomProviderResult>, String> {
    let config = load_config().map_err(|e| e.to_string())?;

    // Create a temporary config with only the selected provider enabled
    let mut test_config = config.clone();
    for p in &mut test_config.custom_providers {
        p.enabled = p.provider_id == provider_id;
    }

    let results = search_custom_providers(&test_config, &title, &author).await;
    Ok(results.into_iter().next())
}

/// Search all enabled custom providers
#[tauri::command]
pub async fn search_all_custom_providers(title: String, author: String) -> Result<Vec<CustomProviderResult>, String> {
    let config = load_config().map_err(|e| e.to_string())?;
    let results = search_custom_providers(&config, &title, &author).await;
    Ok(results)
}

/// Add an abs-agg preset provider by ID
#[tauri::command]
pub fn add_abs_agg_provider(provider_id: String) -> Result<(), String> {
    let available = get_available_abs_agg_providers();

    let (id, name, _) = available.iter()
        .find(|(id, _, _)| *id == provider_id)
        .ok_or_else(|| format!("Unknown abs-agg provider: {}", provider_id))?;

    let provider = CustomProvider::new_abs_agg(name, id);
    add_custom_provider(provider)
}

/// Reset providers to defaults
#[tauri::command]
pub fn reset_providers_to_defaults() -> Result<(), String> {
    let mut config = load_config().map_err(|e| e.to_string())?;
    config.custom_providers = crate::config::Config::default().custom_providers;
    save_config(&config).map_err(|e| e.to_string())?;
    Ok(())
}
