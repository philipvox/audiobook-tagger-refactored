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

                // Check for cached cover or load from folder
                let cover_cache_key = format!("cover_{}", group.id);
                let mut has_cached_cover: bool = cache::get::<(Vec<u8>, String)>(&cover_cache_key).is_some();

                // If no cached cover, try to load from folder first (cover.jpg, cover.png, etc.)
                if !has_cached_cover {
                    if let Some(first_file) = group.files.first() {
                        if let Some(folder) = std::path::Path::new(&first_file.path).parent() {
                            for filename in &["cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.png"] {
                                let cover_path = folder.join(filename);
                                if cover_path.exists() {
                                    if let Ok(data) = std::fs::read(&cover_path) {
                                        let mime = if filename.ends_with(".png") { "image/png" } else { "image/jpeg" };
                                        let _ = cache::set(&cover_cache_key, &(data, mime.to_string()));
                                        group.metadata.cover_url = Some(cover_path.to_string_lossy().to_string());
                                        group.metadata.cover_mime = Some(mime.to_string());
                                        has_cached_cover = true;
                                        covers_found.fetch_add(1, Ordering::Relaxed);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                // If still no cover and we have metadata, fetch from APIs
                if !has_cached_cover && !group.metadata.title.is_empty() && !group.metadata.author.is_empty() {
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
        .buffer_unordered(10)  // Moderate concurrency to avoid API rate limiting
        .collect()
        .await;

    results
}

pub async fn scan_directories(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>,
    scan_mode: ScanMode
) -> Result<ScanResult, Box<dyn std::error::Error + Send + Sync>> {
    scan_directories_with_options(paths, cancel_flag, scan_mode, None).await
}

/// Scan directories with selective refresh options
/// selective_fields: If provided with SelectiveRefresh mode, only these fields will be refreshed
pub async fn scan_directories_with_options(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>,
    scan_mode: ScanMode,
    selective_fields: Option<SelectiveRefreshFields>
) -> Result<ScanResult, Box<dyn std::error::Error + Send + Sync>> {
    let fields_desc = if let Some(ref fields) = selective_fields {
        let mut selected = Vec::new();
        if fields.all { selected.push("all"); }
        else {
            if fields.authors { selected.push("authors"); }
            if fields.narrators { selected.push("narrators"); }
            if fields.description { selected.push("description"); }
            if fields.series { selected.push("series"); }
            if fields.genres { selected.push("genres"); }
            if fields.publisher { selected.push("publisher"); }
            if fields.cover { selected.push("cover"); }
        }
        format!(" [fields: {}]", selected.join(", "))
    } else {
        String::new()
    };
    println!("🔍 Starting scan of {} paths (mode={:?}){}", paths.len(), scan_mode, fields_desc);

    // ✅ THIS LINE MUST BE HERE
    crate::progress::reset_progress();

    // Clear cache based on scan mode
    match scan_mode {
        ScanMode::ForceFresh | ScanMode::SuperScanner => {
            // Full fresh scan or Super Scanner - clear all caches
            if let Err(e) = cache::clear() {
                println!("⚠️ Cache clear failed: {}", e);
            } else {
                println!("🗑️ Cache cleared for {} scan", if scan_mode == ScanMode::SuperScanner { "super" } else { "fresh" });
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

    // Route to appropriate processor based on scan mode
    let processed_groups = if scan_mode == ScanMode::SuperScanner {
        // SuperScanner uses dedicated high-accuracy processor
        processor::process_all_groups_super_scanner(
            groups,
            &config,
            cancel_flag.clone(),
        ).await?
    } else {
        // All other modes use standard processor
        processor::process_all_groups_with_options(
            groups,
            &config,
            cancel_flag.clone(),
            scan_mode,
            selective_fields
        ).await?
    };

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