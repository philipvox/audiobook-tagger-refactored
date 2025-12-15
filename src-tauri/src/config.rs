// src-tauri/src/config.rs - Complete replacement
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A custom metadata provider configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomProvider {
    pub name: String,           // Display name (e.g., "Goodreads")
    pub provider_id: String,    // Provider ID for abs-agg (e.g., "goodreads")
    pub base_url: String,       // Base URL (e.g., "https://provider.vito0912.de")
    pub auth_token: Option<String>, // Auth token if required
    pub enabled: bool,          // Whether to use this provider
    #[serde(default)]
    pub priority: i32,          // Higher = searched first (default 0)
}

impl CustomProvider {
    pub fn new_abs_agg(name: &str, provider_id: &str) -> Self {
        Self {
            name: name.to_string(),
            provider_id: provider_id.to_string(),
            base_url: "https://provider.vito0912.de".to_string(),
            auth_token: Some("abs".to_string()),
            enabled: true,
            priority: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub abs_base_url: String,
    pub abs_api_token: String,
    pub abs_library_id: String,
    pub openai_api_key: Option<String>,
    #[serde(default, skip_serializing)]
    pub google_books_api_key: Option<String>, // Deprecated: No longer used, kept for backwards compat
    pub librarything_dev_key: Option<String>,
    #[serde(default, skip_serializing)]
    pub max_workers: usize, // Deprecated: replaced by performance_preset and concurrency overrides
    pub backup_tags: bool,
    pub genre_enforcement: bool,

    // Performance settings
    #[serde(default = "default_preset")]
    pub performance_preset: String, // "conservative", "balanced", "performance", "extreme"

    // Individual concurrency overrides (None = use preset-derived value)
    #[serde(default)]
    pub concurrency_metadata: Option<usize>,
    #[serde(default)]
    pub concurrency_super_scanner: Option<usize>,
    #[serde(default)]
    pub concurrency_json_writes: Option<usize>,
    #[serde(default)]
    pub concurrency_abs_push: Option<usize>,
    #[serde(default)]
    pub concurrency_file_scan: Option<usize>,

    // Custom metadata providers (abs-agg, etc.)
    #[serde(default = "default_custom_providers")]
    pub custom_providers: Vec<CustomProvider>,
}

fn default_preset() -> String {
    "balanced".to_string()
}

/// Default custom providers - abs-agg community providers
fn default_custom_providers() -> Vec<CustomProvider> {
    vec![
        // Goodreads - excellent for series info, ratings, descriptions
        CustomProvider {
            name: "Goodreads".to_string(),
            provider_id: "goodreads".to_string(),
            base_url: "https://provider.vito0912.de".to_string(),
            auth_token: Some("abs".to_string()),
            enabled: true,
            priority: 100, // High priority - best for series/descriptions
        },
        // Hardcover - modern book database, clean data
        CustomProvider {
            name: "Hardcover".to_string(),
            provider_id: "hardcover".to_string(),
            base_url: "https://provider.vito0912.de".to_string(),
            auth_token: Some("abs".to_string()),
            enabled: true,
            priority: 90,
        },
        // Storytel - audiobook-specific metadata
        CustomProvider {
            name: "Storytel".to_string(),
            provider_id: "storytel/language:en".to_string(),
            base_url: "https://provider.vito0912.de".to_string(),
            auth_token: Some("abs".to_string()),
            enabled: true,
            priority: 80,
        },
        // Graphic Audio - full-cast audio productions
        CustomProvider {
            name: "Graphic Audio".to_string(),
            provider_id: "graphicaudio".to_string(),
            base_url: "https://provider.vito0912.de".to_string(),
            auth_token: Some("abs".to_string()),
            enabled: true,
            priority: 70,
        },
        // Big Finish - Doctor Who and audio dramas
        CustomProvider {
            name: "Big Finish".to_string(),
            provider_id: "bigfinish".to_string(),
            base_url: "https://provider.vito0912.de".to_string(),
            auth_token: Some("abs".to_string()),
            enabled: true,
            priority: 60,
        },
        // LibriVox - public domain audiobooks
        CustomProvider {
            name: "LibriVox".to_string(),
            provider_id: "librivox".to_string(),
            base_url: "https://provider.vito0912.de".to_string(),
            auth_token: Some("abs".to_string()),
            enabled: false, // Disabled by default - mainly for public domain
            priority: 50,
        },
    ]
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
            performance_preset: "balanced".to_string(),
            concurrency_metadata: None,
            concurrency_super_scanner: None,
            concurrency_json_writes: None,
            concurrency_abs_push: None,
            concurrency_file_scan: None,
            custom_providers: default_custom_providers(),
        }
    }
}

/// Concurrency operation types
#[derive(Debug, Clone, Copy)]
pub enum ConcurrencyOp {
    Metadata,       // Metadata enrichment (API calls)
    SuperScanner,   // Super Scanner mode (thorough, slower)
    JsonWrites,     // Writing metadata.json files
    AbsPush,        // Pushing to AudiobookShelf
    FileScan,       // Scanning directories for files
}

impl Config {
    /// Get the effective concurrency limit for an operation.
    /// Checks for user override first, then derives from preset.
    pub fn get_concurrency(&self, op: ConcurrencyOp) -> usize {
        // Check if user has set an override
        let override_val = match op {
            ConcurrencyOp::Metadata => self.concurrency_metadata,
            ConcurrencyOp::SuperScanner => self.concurrency_super_scanner,
            ConcurrencyOp::JsonWrites => self.concurrency_json_writes,
            ConcurrencyOp::AbsPush => self.concurrency_abs_push,
            ConcurrencyOp::FileScan => self.concurrency_file_scan,
        };

        if let Some(val) = override_val {
            return val.max(1); // Ensure at least 1
        }

        // Get base values for "balanced" preset
        // These are tuned for a good balance of speed and system load
        // abs_push reduced to 5 to avoid overwhelming ABS server (causes 502 errors)
        let (metadata, super_scanner, json_writes, abs_push, file_scan) = (20, 8, 100, 5, 16);

        // Get multiplier based on preset
        // Higher multipliers allow more parallel operations but use more system resources
        let multiplier = match self.performance_preset.as_str() {
            "conservative" => 0.5,   // Half speed, minimal system impact
            "balanced" => 1.0,       // Default values
            "performance" => 2.0,    // 2x parallel operations
            "extreme" => 6.0,        // Maximum parallelism - uses all CPU/IO
            _ => 1.0, // Default to balanced for unknown presets
        };

        let base_value = match op {
            ConcurrencyOp::Metadata => metadata,
            ConcurrencyOp::SuperScanner => super_scanner,
            ConcurrencyOp::JsonWrites => json_writes,
            ConcurrencyOp::AbsPush => abs_push,
            ConcurrencyOp::FileScan => file_scan,
        };

        // Apply multiplier and ensure at least 1
        ((base_value as f64 * multiplier).round() as usize).max(1)
    }

    /// Get preset-derived default values (for UI to show what the preset would use)
    pub fn get_preset_defaults(&self) -> (usize, usize, usize, usize, usize) {
        let multiplier = match self.performance_preset.as_str() {
            "conservative" => 0.5,
            "balanced" => 1.0,
            "performance" => 2.0,
            "extreme" => 4.0,
            _ => 1.0,
        };

        let scale = |base: usize| ((base as f64 * multiplier).round() as usize).max(1);

        (
            scale(15),  // metadata
            scale(5),   // super_scanner
            scale(100), // json_writes
            scale(60),  // abs_push
            scale(10),  // file_scan
        )
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