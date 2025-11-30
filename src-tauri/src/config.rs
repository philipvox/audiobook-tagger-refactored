// src-tauri/src/config.rs - Complete replacement
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub abs_base_url: String,
    pub abs_api_token: String,
    pub abs_library_id: String,
    pub openai_api_key: Option<String>,
    pub google_books_api_key: Option<String>,
    pub librarything_dev_key: Option<String>,
    pub max_workers: usize,
    pub backup_tags: bool,
    pub genre_enforcement: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            abs_base_url: "http://localhost:13378".to_string(),
            abs_api_token: String::new(),
            abs_library_id: String::new(),
            openai_api_key: None,
            google_books_api_key: None,
            librarything_dev_key: None,
            max_workers: 10,
            backup_tags: true,
            genre_enforcement: true,
        }
    }
}

impl Config {
    pub fn load() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let config_path = Self::get_config_path()?;
        
        if config_path.exists() {
            let contents = std::fs::read_to_string(&config_path)?;
            let config: Config = serde_json::from_str(&contents)?;
            Ok(config)
        } else {
            Ok(Config::default())
        }
    }
    
    pub fn save(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let config_path = Self::get_config_path()?;
        
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&config_path, json)?;
        
        Ok(())
    }
    
    fn get_config_path() -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
        let home = dirs::home_dir().ok_or("Could not find home directory")?;
        let config_dir = home.join("Library/Application Support/Audiobook Tagger");
        Ok(config_dir.join("config.json"))
    }
}

pub fn load_config() -> Result<Config, Box<dyn std::error::Error + Send + Sync>> {
    Config::load()
}

pub fn save_config(config: &Config) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    config.save()
}