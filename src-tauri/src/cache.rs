// src-tauri/src/cache.rs - Complete replacement
use once_cell::sync::Lazy;
use sled::Db;
use std::sync::Mutex;

static CACHE_DB: Lazy<Mutex<Db>> = Lazy::new(|| {
    let cache_path = dirs::home_dir()
        .unwrap()
        .join("Library/Application Support/Audiobook Tagger/cache");
    
    Mutex::new(sled::open(cache_path).expect("Failed to open cache database"))
});

pub fn get<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    let cache = CACHE_DB.lock().unwrap();
    let bytes = cache.get(key.as_bytes()).ok()??;
    bincode::deserialize(&bytes).ok()
}

pub fn set<T: serde::Serialize>(key: &str, value: &T) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cache = CACHE_DB.lock().unwrap();
    let bytes = bincode::serialize(value)?;
    cache.insert(key.as_bytes(), bytes)?;
    Ok(())
}

pub fn clear() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cache = CACHE_DB.lock().unwrap();
    cache.clear()?;
    Ok(())
}