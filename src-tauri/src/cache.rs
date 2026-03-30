// src-tauri/src/cache.rs
use once_cell::sync::Lazy;
use sled::Db;
use std::path::PathBuf;

// Sled is internally thread-safe — no external lock needed.
// flush_every_ms batches writes instead of flushing per-insert.
static CACHE_DB: Lazy<Db> = Lazy::new(|| {
    let cache_path = cache_dir().join("db");

    sled::Config::new()
        .path(cache_path)
        .flush_every_ms(Some(1000)) // batch flushes every 1s instead of per-write
        .cache_capacity(64 * 1024 * 1024) // 64MB in-memory page cache
        .open()
        .expect("Failed to open cache database")
});

/// Shared HTTP client for all GPT/API calls (reuses TCP connections)
static SHARED_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .pool_max_idle_per_host(10)
        .build()
        .expect("Failed to create shared HTTP client")
});

fn cache_dir() -> PathBuf {
    let app_dir = dirs::home_dir()
        .unwrap()
        .join("Library/Application Support/Audiobook Tagger");

    // Migrate: old sled DB lived at "cache" (a directory of sled files).
    // We now use "cache2/" as a proper parent directory for db + covers.
    let dir = app_dir.join("cache2");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn covers_dir() -> PathBuf {
    let dir = cache_dir().join("covers");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Get a reference to the shared HTTP client
pub fn shared_client() -> &'static reqwest::Client {
    &SHARED_CLIENT
}

pub fn get<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    let bytes = CACHE_DB.get(key.as_bytes()).ok()??;
    bincode::deserialize(&bytes).ok()
}

pub fn set<T: serde::Serialize>(key: &str, value: &T) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let bytes = bincode::serialize(value)?;
    CACHE_DB.insert(key.as_bytes(), bytes)?;
    Ok(())
}

pub fn clear() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    CACHE_DB.clear()?;
    // Also clear cover files
    if let Ok(entries) = std::fs::read_dir(covers_dir()) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

pub fn count() -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    Ok(CACHE_DB.len())
}

/// Get approximate disk size of the cache database in bytes
pub fn disk_size() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    let db_path = cache_dir().join("db");
    let mut total = 0u64;
    if db_path.exists() {
        for entry in walkdir::WalkDir::new(&db_path).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    // Add cover files
    let covers = covers_dir();
    if covers.exists() {
        for entry in std::fs::read_dir(&covers).into_iter().flatten().flatten() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(total)
}

/// Remove cache entries matching a prefix. Returns number of entries removed.
pub fn prune_prefix(prefix: &str) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let mut removed = 0;
    for item in CACHE_DB.scan_prefix(prefix.as_bytes()) {
        if let Ok((key, _)) = item {
            CACHE_DB.remove(&key)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Get cache statistics: entry count, approximate disk size, and cover count
pub fn stats() -> Result<CacheStats, Box<dyn std::error::Error + Send + Sync>> {
    let entry_count = CACHE_DB.len();
    let disk_bytes = disk_size()?;
    let cover_count = std::fs::read_dir(covers_dir())
        .map(|entries| entries.filter_map(|e| e.ok()).count())
        .unwrap_or(0);
    Ok(CacheStats { entry_count, disk_bytes, cover_count })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CacheStats {
    pub entry_count: usize,
    pub disk_bytes: u64,
    pub cover_count: usize,
}

/// Iterate all keys with a given prefix, returning (key_string, raw_bytes) pairs
pub fn scan_prefix(prefix: &str) -> Vec<(String, Vec<u8>)> {
    CACHE_DB
        .scan_prefix(prefix.as_bytes())
        .filter_map(|item| {
            let (k, v) = item.ok()?;
            let key = String::from_utf8(k.to_vec()).ok()?;
            Some((key, v.to_vec()))
        })
        .collect()
}

// --- Cover image caching via filesystem ---

fn cover_path(key: &str) -> PathBuf {
    // Sanitize key for filesystem
    let safe: String = key.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    covers_dir().join(&safe)
}

/// Check if a cover exists in the filesystem cache
pub fn has_cover(key: &str) -> bool {
    cover_path(key).exists()
}

/// Get cover data + mime type from filesystem cache
pub fn get_cover(key: &str) -> Option<(Vec<u8>, String)> {
    let path = cover_path(key);
    let data = std::fs::read(&path).ok()?;
    // Store mime type in a sidecar key (tiny, fine for sled)
    let mime: String = get(&format!("{}_mime", key)).unwrap_or_else(|| "image/jpeg".to_string());
    Some((data, mime))
}

/// Store cover data + mime type to filesystem cache
pub fn set_cover(key: &str, data: &[u8], mime_type: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let path = cover_path(key);
    std::fs::write(&path, data)?;
    set(&format!("{}_mime", key), &mime_type.to_string())?;
    Ok(())
}
