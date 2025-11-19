// src-tauri/src/scanner/processor.rs - Complete with tag reading and change detection
use super::types::*;
use super::metadata;
use crate::config::Config;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Semaphore;

pub async fn process_all_groups(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    
    let max_workers = config.max_workers;
    let semaphore = Arc::new(Semaphore::new(max_workers));
    
    println!("⚙️  Processing {} groups with {} workers", groups.len(), max_workers);
    
    let mut results = Vec::new();
    
    for group in groups {
        if let Some(ref flag) = cancel_flag {
            if flag.load(Ordering::SeqCst) {
                println!("Processing cancelled");
                break;
            }
        }
        
        let _permit = semaphore.acquire().await.unwrap();
        
        match process_book_group(group, config, cancel_flag.clone()).await {
            Ok(processed) => results.push(processed),
            Err(e) => {
                eprintln!("Failed to process group: {}", e);
            }
        }
    }
    
    Ok(results)
}

async fn process_book_group(
    mut group: BookGroup,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<BookGroup, Box<dyn std::error::Error + Send + Sync>> {
    
    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::SeqCst) {
            return Ok(group);
        }
    }
    
    // 1. Enrich metadata
    let enriched_metadata = metadata::enrich_metadata(&group, config).await?;
    group.metadata = enriched_metadata;
    
    // 2. Read existing tags and calculate changes
    group.total_changes = calculate_changes(&mut group);
    
    Ok(group)
}

fn calculate_changes(group: &mut BookGroup) -> usize {
    use lofty::probe::Probe;
    use lofty::tag::Accessor;
    
    let mut total_changes = 0;
    
    for file in &mut group.files {
        file.changes.clear();
        
        // Read existing tags
        let existing_tags = match Probe::open(&file.path) {
            Ok(probe) => match probe.read() {
                Ok(tagged) => {
                    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
                    tag.map(|t| {
                        (
                            t.title().map(|s| s.to_string()),
                            t.artist().map(|s| s.to_string()),
                        )
                    })
                },
                Err(_) => None,
            },
            Err(_) => None,
        };
        
        // Compare and build changes
        if let Some((existing_title, existing_author)) = existing_tags {
            if existing_title.as_deref() != Some(&group.metadata.title) {
                file.changes.insert("title".to_string(), MetadataChange {
                    old: existing_title.unwrap_or_default(),
                    new: group.metadata.title.clone(),
                });
                total_changes += 1;
            }
            
            if existing_author.as_deref() != Some(&group.metadata.author) {
                file.changes.insert("author".to_string(), MetadataChange {
                    old: existing_author.unwrap_or_default(),
                    new: group.metadata.author.clone(),
                });
                total_changes += 1;
            }
        } else {
            // No existing tags, mark as all new
            file.changes.insert("title".to_string(), MetadataChange {
                old: String::new(),
                new: group.metadata.title.clone(),
            });
            file.changes.insert("author".to_string(), MetadataChange {
                old: String::new(),
                new: group.metadata.author.clone(),
            });
            total_changes += 2;
        }
        
        // Add other fields if they exist
        if let Some(ref narrator) = group.metadata.narrator {
            file.changes.insert("narrator".to_string(), MetadataChange {
                old: String::new(),
                new: narrator.clone(),
            });
            total_changes += 1;
        }
        
        if !group.metadata.genres.is_empty() {
            file.changes.insert("genre".to_string(), MetadataChange {
                old: String::new(),
                new: group.metadata.genres.join(", "),
            });
            total_changes += 1;
        }
    }
    
    total_changes
}