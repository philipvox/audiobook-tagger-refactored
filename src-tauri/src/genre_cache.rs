use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

static GENRE_CACHE: Lazy<Mutex<HashMap<String, Vec<String>>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

static METADATA_CACHE: Lazy<Mutex<HashMap<String, crate::genres::CleanedMetadata>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

pub fn get_cached(genres: &[String]) -> Option<Vec<String>> {
    let cache = GENRE_CACHE.lock().unwrap();
    let key = genres.join("|");
    cache.get(&key).cloned()
}

pub fn set_cached(genres: &[String], mapped: Vec<String>) {
    let mut cache = GENRE_CACHE.lock().unwrap();
    let key = genres.join("|");
    cache.insert(key, mapped);
}

pub fn get_metadata_cached(key: &str) -> Option<crate::genres::CleanedMetadata> {
    let cache = METADATA_CACHE.lock().unwrap();
    cache.get(key).cloned()
}

pub fn set_metadata_cached(key: &str, metadata: crate::genres::CleanedMetadata) {
    let mut cache = METADATA_CACHE.lock().unwrap();
    cache.insert(key.to_string(), metadata);
}
