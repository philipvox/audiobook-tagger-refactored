use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedMetadata {
    // Store the FINAL merged metadata to skip GPT merge on cache hit
    pub final_metadata: crate::scanner::BookMetadata,
    pub timestamp: u64,
}

#[derive(Clone)]
pub struct MetadataCache {
    db: sled::Db,
}

impl MetadataCache {
    pub fn new() -> Result<Self> {
        let cache_dir = dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("audiobook-tagger");
        std::fs::create_dir_all(&cache_dir)?;
        
        let db = sled::open(cache_dir.join("metadata_cache"))?;
        Ok(Self { db })
    }
    
    pub fn get(&self, title: &str, author: &str) -> Option<CachedMetadata> {
        let key = format!("{}:{}", title.to_lowercase(), author.to_lowercase());
        let value = self.db.get(key).ok()??;
        bincode::deserialize(&value).ok()
    }
    
    pub fn set(&self, title: &str, author: &str, metadata: CachedMetadata) -> Result<()> {
        let key = format!("{}:{}", title.to_lowercase(), author.to_lowercase());
        let value = bincode::serialize(&metadata)
            .map_err(|e| anyhow::anyhow!("{}", e))?;
        self.db.insert(key, value)?;
        self.db.flush()?;
        Ok(())
    }
    
    pub fn clear(&self) -> Result<()> {
        self.db.clear()?;
        Ok(())
    }
}