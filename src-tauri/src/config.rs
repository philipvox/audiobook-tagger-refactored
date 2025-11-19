use serde::{Deserialize, Serialize};
use anyhow::Result;
use std::path::PathBuf;
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub abs_base_url: String,
    pub abs_api_token: String,
    pub abs_library_id: String,
    pub openai_api_key: String,
    pub google_books_api_key: String,
    pub backup_tags: bool,
    pub genre_enforcement: bool,
    pub audible_enabled: bool,
    pub audible_cli_path: String,
    pub max_workers: usize,
    pub skip_unchanged: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            abs_base_url: String::from("http://localhost:13378"),
            abs_api_token: String::new(),
            abs_library_id: String::new(),
            openai_api_key: String::new(),
            google_books_api_key: String::new(),
            backup_tags: true,
            genre_enforcement: true,
            audible_enabled: false,
            audible_cli_path: String::from("/Users/philip/.local/bin/audible"),
            max_workers: 10,
            skip_unchanged: false,
        }
    }
}

pub fn get_config_path() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("No home directory"))?;
    let config_dir = home
        .join("Library")
        .join("Application Support")
        .join("Audiobook Tagger");
    
    fs::create_dir_all(&config_dir)?;
    Ok(config_dir.join("config.json"))
}

pub fn load_config() -> Result<Config> {
    let config_path = get_config_path()?;
    if !config_path.exists() {
        return Ok(Config::default());
    }
    let contents = fs::read_to_string(config_path)?;
    let config: Config = serde_json::from_str(&contents)?;
    Ok(config)
}

pub fn save_config(config: &Config) -> Result<()> {
    let config_path = get_config_path()?;
    let contents = serde_json::to_string_pretty(config)?;
    fs::write(config_path, contents)?;
    Ok(())
}
