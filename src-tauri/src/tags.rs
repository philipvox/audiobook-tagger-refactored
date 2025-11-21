use anyhow::Result;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag, TagItem, ItemValue};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Debug, Serialize, Deserialize)]
pub struct WriteResult {
    pub success: usize,
    pub failed: usize,
    pub errors: Vec<WriteError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WriteError {
    pub file_id: String,
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WriteRequest {
    pub file_ids: Vec<String>,
    pub files: HashMap<String, FileData>,
    pub backup: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileData {
    pub path: String,
    pub changes: HashMap<String, crate::scanner::MetadataChange>,
    pub group_id: Option<String>,
}

pub async fn write_files_parallel(
    files: Vec<(String, std::collections::HashMap<String, crate::scanner::FieldChange>)>,
    backup: bool,
    max_concurrent: usize,
) -> Result<Vec<Result<(), anyhow::Error>>> {
    let semaphore = Arc::new(Semaphore::new(max_concurrent));
    let mut handles = Vec::new();
    
    for (path, changes) in files {
        let sem = Arc::clone(&semaphore);
        let path_clone = path.clone();
        let changes_clone = changes.clone();
        
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            write_file_tags(&path_clone, &changes_clone, backup, None).await
        });
        
        handles.push(handle);
    }
    
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.unwrap());
    }
    
    Ok(results)
}

pub async fn write_file_tags(
    file_path: &str,
    changes: &std::collections::HashMap<String, crate::scanner::FieldChange>,
    backup: bool,
    group_id: Option<&str>,
) -> Result<()> {
    let path = Path::new(file_path);
    
    if !path.exists() {
        anyhow::bail!("File does not exist: {}", file_path);
    }
    
    let metadata = std::fs::metadata(path)?;
    if metadata.len() == 0 {
        anyhow::bail!("File is empty (0 bytes)");
    }
    
    if backup {
        let backup_path = path.with_extension(
            format!("{}.backup", path.extension().unwrap_or_default().to_string_lossy())
        );
        std::fs::copy(path, &backup_path)?;
    }
    
    // Try to get cover art from cache if group_id provided
    if let Some(gid) = group_id {
        if let Err(e) = save_cover_to_folder(file_path, gid).await {
            println!("⚠️  Failed to save cover: {}", e);
        }
    }
    
    let tagged_file = match Probe::open(path) {
        Ok(probe) => probe,
        Err(e) => anyhow::bail!("Cannot open file (may be corrupted): {}", e),
    };
    let mut file_content = match tagged_file.read() {
        Ok(content) => content,
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("fill whole buffer") || err_str.contains("UnexpectedEof") {
                anyhow::bail!("File appears corrupted or has invalid tags. Try re-encoding this file or removing existing tags first.");
            }
            anyhow::bail!("Failed to read file tags: {}", e);
        }
    };
    
    let tag = if let Some(t) = file_content.primary_tag_mut() {
        t
    } else {
        let tag_type = file_content.primary_tag_type();
        file_content.insert_tag(Tag::new(tag_type));
        file_content.primary_tag_mut().unwrap()
    };
    
    for (field, change) in changes {
        match field.as_str() {
            "title" => {
                tag.remove_key(&ItemKey::TrackTitle);
                tag.set_title(change.new.clone());
            },
            "artist" | "author" => {
                tag.remove_key(&ItemKey::TrackArtist);
                tag.set_artist(change.new.clone());
            },
            "album" => {
                tag.remove_key(&ItemKey::AlbumTitle);
                tag.set_album(change.new.clone());
            },
            "genre" => {
                tag.remove_key(&ItemKey::Genre);
                
                let genres: Vec<&str> = change.new
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();
                
                for genre in &genres {
                    let item = TagItem::new(
                        ItemKey::Genre,
                        ItemValue::Text(genre.to_string())
                    );
                    tag.push(item);
                }
            },
            "narrator" => {
                tag.remove_key(&ItemKey::Composer);
                tag.insert_text(ItemKey::Composer, change.new.clone());
                tag.remove_key(&ItemKey::Comment);
            },
            "description" | "comment" => {
                if !change.new.to_lowercase().contains("narrated by") {
                    tag.set_comment(change.new.clone());
                }
            },
            "year" => {
                if let Ok(year) = change.new.parse::<u32>() {
                    tag.set_year(year);
                }
            },
            "series" => {
                tag.insert_text(ItemKey::Unknown("SERIES".to_string()), change.new.clone());
                tag.insert_text(ItemKey::Unknown("series".to_string()), change.new.clone());
            },
            "sequence" => {
                tag.insert_text(ItemKey::Unknown("SERIES-PART".to_string()), change.new.clone());
                tag.insert_text(ItemKey::Unknown("series-part".to_string()), change.new.clone());
            },
            _ => {}
        }
    }
    
    file_content.save_to_path(path, lofty::config::WriteOptions::default())
        .map_err(|e| anyhow::anyhow!("Failed to save tags: {}", e))?;
    
    Ok(())
}
async fn save_cover_to_folder(file_path: &str, group_id: &str) -> Result<()> {
    let cache_key = format!("cover_{}", group_id);
    
    if let Some(cover_tuple) = crate::cache::get::<(Vec<u8>, String)>(&cache_key) {
        let (cover_data, mime_type) = cover_tuple;
        
        let file_path_obj = Path::new(file_path);
        let folder = file_path_obj.parent().ok_or_else(|| anyhow::anyhow!("No parent folder"))?;
        
        let extension = match mime_type.as_str() {
            "image/png" => "png",
            "image/webp" => "webp",
            _ => "jpg",
        };
        
        let cover_path = folder.join(format!("cover.{}", extension));
        
        tokio::fs::write(&cover_path, &cover_data).await?;
        println!("   🎨 Saved cover to: {}", cover_path.display());
    }
    
    Ok(())
}

pub fn verify_genres(file_path: &str) -> Result<Vec<String>> {
    let tagged_file = Probe::open(file_path)?.read()?;
    let tag = tagged_file.primary_tag().ok_or_else(|| anyhow::anyhow!("No tag found"))?;
    
    let genres: Vec<String> = tag
        .get_strings(&ItemKey::Genre)
        .map(|s| s.to_string())
        .collect();
    
    Ok(genres)
}