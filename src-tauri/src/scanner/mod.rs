// src-tauri/src/scanner/mod.rs
pub mod types;
pub mod collector;
pub mod processor;

pub use types::*;
use crate::config::Config;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
pub async fn scan_directories(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<ScanResult, Box<dyn std::error::Error + Send + Sync>> {
    println!("🔍 Starting scan of {} paths", paths.len());
    
    // Reset progress at the very start
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
    
    println!("📁 Collecting files...");
    let groups = collector::collect_and_group_files(paths, cancel_flag.clone()).await?;
    
    if groups.is_empty() {
        println!("No audiobook files found");
        crate::progress::reset_progress();
        return Ok(ScanResult {
            groups: vec![],
            total_files: 0,
            total_groups: 0,
        });
    }
    
    let total_files: usize = groups.iter().map(|g| g.files.len()).sum();
    println!("📚 Found {} books with {} total files", groups.len(), total_files);
    
    // Set total BEFORE processing starts
    crate::progress::set_total(groups.len());
    
    let processed_groups = processor::process_all_groups(
        groups,
        &config,
        cancel_flag.clone()
    ).await?;
    
    // Don't reset immediately - let frontend stop polling first
    // Frontend will reset its own state after 500ms
    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
    crate::progress::reset_progress();
    
    Ok(ScanResult {
        total_groups: processed_groups.len(),
        total_files,
        groups: processed_groups,
    })
}