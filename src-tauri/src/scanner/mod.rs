// src-tauri/src/scanner/mod.rs
pub mod types;
pub mod collector;
pub mod processor;

pub use types::*;
use crate::config::Config;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Import directories without metadata enrichment - just collect and group files
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
    println!("📚 Imported {} books with {} total files (no metadata enrichment)", groups.len(), total_files);

    Ok(ScanResult {
        total_groups: groups.len(),
        total_files,
        groups,
    })
}

pub async fn scan_directories(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<ScanResult, Box<dyn std::error::Error + Send + Sync>> {
    println!("🔍 Starting scan of {} paths", paths.len());

    // ✅ THIS LINE MUST BE HERE
    crate::progress::reset_progress();

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
        cancel_flag.clone()
    ).await?;

    Ok(ScanResult {
        total_groups: processed_groups.len(),
        total_files,
        groups: processed_groups,
    })
}