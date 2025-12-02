// src-tauri/src/scanner/mod.rs
pub mod types;
pub mod collector;
pub mod processor;

pub use types::*;
use crate::config::Config;
use crate::cache;
use crate::cover_art;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use futures::stream::{self, StreamExt};

/// Import directories without metadata enrichment - just collect and group files
/// Also fetches covers for books that have metadata
pub async fn import_directories(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<ScanResult, Box<dyn std::error::Error + Send + Sync>> {
    println!("📁 Starting import of {} paths (no metadata scan)", paths.len());

    crate::progress::reset_progress();

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::SeqCst) {
            println!("Import cancelled before start");
            return Ok(ScanResult {
                groups: vec![],
                total_files: 0,
                total_groups: 0,
            });
        }
    }

    let groups = collector::collect_and_group_files(paths, cancel_flag.clone()).await?;

    if groups.is_empty() {
        println!("No audiobook files found");
        return Ok(ScanResult {
            groups: vec![],
            total_files: 0,
            total_groups: 0,
        });
    }

    let total_files: usize = groups.iter().map(|g| g.files.len()).sum();
    println!("📚 Imported {} books with {} total files", groups.len(), total_files);

    // Fetch covers for imported books that have metadata
    println!("🖼️  Fetching covers for imported books...");
    let groups = fetch_covers_for_groups(groups, cancel_flag).await;

    let covers_count = groups.iter()
        .filter(|g| g.metadata.cover_url.is_some())
        .count();
    println!("✅ Import complete: {} books, {} covers", groups.len(), covers_count);

    Ok(ScanResult {
        total_groups: groups.len(),
        total_files,
        groups,
    })
}

/// Fetch covers for imported groups that have metadata but no cover cached
async fn fetch_covers_for_groups(
    groups: Vec<BookGroup>,
    cancel_flag: Option<Arc<AtomicBool>>
) -> Vec<BookGroup> {
    let total = groups.len();
    let processed = Arc::new(AtomicUsize::new(0));
    let covers_found = Arc::new(AtomicUsize::new(0));

    crate::progress::set_total(total);
    crate::progress::update_progress(0, total, "Fetching covers...");

    let results: Vec<BookGroup> = stream::iter(groups)
        .map(|mut group| {
            let cancel_flag = cancel_flag.clone();
            let processed = processed.clone();
            let covers_found = covers_found.clone();
            let total = total;

            async move {
                // Check cancellation
                if let Some(ref flag) = cancel_flag {
                    if flag.load(Ordering::Relaxed) {
                        return group;
                    }
                }

                // Only fetch cover if we have enough metadata and no cached cover
                let cover_cache_key = format!("cover_{}", group.id);
                let has_cached_cover: bool = cache::get::<(Vec<u8>, String)>(&cover_cache_key).is_some();

                if !has_cached_cover && !group.metadata.title.is_empty() && !group.metadata.author.is_empty() {
                    // Fetch cover
                    let cover_result = cover_art::fetch_and_download_cover(
                        &group.metadata.title,
                        &group.metadata.author,
                        group.metadata.asin.as_deref(),
                        None,
                    ).await;

                    if let Ok(cover) = cover_result {
                        if let Some(ref data) = cover.data {
                            let mime_type = cover.mime_type.clone().unwrap_or_else(|| "image/jpeg".to_string());
                            let _ = cache::set(&cover_cache_key, &(data.clone(), mime_type.clone()));
                            group.metadata.cover_url = cover.url;
                            group.metadata.cover_mime = Some(mime_type);
                            covers_found.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }

                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                let covers = covers_found.load(Ordering::Relaxed);

                if done % 10 == 0 || done == total {
                    crate::progress::update_progress(done, total,
                        &format!("{}/{} books, {} covers", done, total, covers));
                }

                group
            }
        })
        .buffer_unordered(30)  // Fetch 30 covers concurrently for faster imports
        .collect()
        .await;

    results
}

pub async fn scan_directories(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>,
    scan_mode: ScanMode
) -> Result<ScanResult, Box<dyn std::error::Error + Send + Sync>> {
    println!("🔍 Starting scan of {} paths (mode={:?})", paths.len(), scan_mode);

    // ✅ THIS LINE MUST BE HERE
    crate::progress::reset_progress();

    // Clear cache based on scan mode
    match scan_mode {
        ScanMode::ForceFresh => {
            // Full fresh scan - clear all caches
            if let Err(e) = cache::clear() {
                println!("⚠️ Cache clear failed: {}", e);
            } else {
                println!("🗑️ Cache cleared for fresh scan");
            }
        }
        ScanMode::RefreshMetadata | ScanMode::SelectiveRefresh => {
            // Keep API cache but bypass metadata.json
            println!("📄 Refresh mode - using cached API data");
        }
        ScanMode::Normal => {
            // Normal mode - use everything
        }
    }

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::SeqCst) {
            println!("Scan cancelled before start");
            return Ok(ScanResult {
                groups: vec![],
                total_files: 0,
                total_groups: 0,
            });
        }
    }

    let config = Config::load()?;

    let groups = collector::collect_and_group_files(paths, cancel_flag.clone()).await?;

    if groups.is_empty() {
        println!("No audiobook files found");
        return Ok(ScanResult {
            groups: vec![],
            total_files: 0,
            total_groups: 0,
        });
    }

    let total_files: usize = groups.iter().map(|g| g.files.len()).sum();
    println!("📚 Found {} books with {} total files", groups.len(), total_files);

    crate::progress::set_total(groups.len());
    crate::progress::update_progress(0, groups.len(), "Starting processing...");
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let processed_groups = processor::process_all_groups(
        groups,
        &config,
        cancel_flag.clone(),
        scan_mode
    ).await?;

    Ok(ScanResult {
        total_groups: processed_groups.len(),
        total_files,
        groups: processed_groups,
    })
}

/// Legacy wrapper for backward compatibility
pub async fn scan_directories_force(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>,
    force: bool
) -> Result<ScanResult, Box<dyn std::error::Error + Send + Sync>> {
    let scan_mode = if force { ScanMode::ForceFresh } else { ScanMode::Normal };
    scan_directories(paths, cancel_flag, scan_mode).await
}