// src-tauri/src/cache.rs - Complete replacement
use once_cell::sync::Lazy;
use sled::Db;
use std::sync::RwLock;

// Use RwLock instead of Mutex for better read concurrency
// Multiple readers can access cache simultaneously, only writes need exclusive access
static CACHE_DB: Lazy<RwLock<Db>> = Lazy::new(|| {
    let cache_path = dirs::home_dir()
        .unwrap()
        .join("Library/Application Support/Audiobook Tagger/cache");

    RwLock::new(sled::open(cache_path).expect("Failed to open cache database"))
});

pub fn get<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    // Use read lock - allows multiple concurrent readers
    let cache = CACHE_DB.read().ok()?;
    let bytes = cache.get(key.as_bytes()).ok()??;
    bincode::deserialize(&bytes).ok()
}

pub fn set<T: serde::Serialize>(key: &str, value: &T) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Use write lock - exclusive access for writes
    let cache = CACHE_DB.write().map_err(|e| format!("Cache lock error: {}", e))?;
    let bytes = bincode::serialize(value)?;
    cache.insert(key.as_bytes(), bytes)?;
    Ok(())
}

pub fn clear() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cache = CACHE_DB.write().map_err(|e| format!("Cache lock error: {}", e))?;
    cache.clear()?;
    Ok(())
}

pub fn count() -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let cache = CACHE_DB.read().map_err(|e| format!("Cache lock error: {}", e))?;
    Ok(cache.len())
}