// src-tauri/src/commands/abs_cache.rs
// Tauri commands for centralized ABS cache operations

use crate::{abs_cache, config};
use serde::Serialize;
use serde_json::json;
use tauri::Emitter;

// ============================================================================
// RESPONSE TYPES
// ============================================================================

#[derive(Debug, Serialize)]
pub struct CacheRefreshResult {
    pub success: bool,
    pub total_items: usize,
    pub items_with_files: usize,
    pub items_with_chapters: usize,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct CacheStatusResult {
    pub is_loaded: bool,
    pub is_stale: bool,
    pub stats: abs_cache::CacheStats,
}

/// Simplified item for frontend display
#[derive(Debug, Serialize, Clone)]
pub struct CachedItemSummary {
    pub id: String,
    pub path: String,
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub narrator: Option<String>,
    pub duration_seconds: Option<f64>,
    pub size_bytes: Option<u64>,
    pub file_count: usize,
    pub chapter_count: usize,
    pub has_cover: bool,
    pub genres: Vec<String>,
}

/// Full item data for detailed view
#[derive(Debug, Serialize)]
pub struct CachedItemDetail {
    pub item: abs_cache::CachedAbsItem,
    pub formatted_duration: String,
    pub formatted_size: String,
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Refresh the ABS cache - fetches all library data including files and chapters
#[tauri::command]
pub async fn refresh_abs_cache(window: tauri::Window) -> Result<CacheRefreshResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;

    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() {
        return Err("ABS not configured. Please set URL and API token in settings.".to_string());
    }

    let _ = window.emit("abs_cache_progress", json!({
        "phase": "starting",
        "message": "Starting cache refresh...",
        "current": 0,
        "total": 0
    }));

    // Progress callback
    let window_clone = window.clone();
    let progress_callback: Box<dyn Fn(String, usize, usize) + Send + Sync> = Box::new(move |message, current, total| {
        let _ = window_clone.emit("abs_cache_progress", json!({
            "phase": "loading",
            "message": message,
            "current": current,
            "total": total
        }));
    });

    match abs_cache::refresh_cache(&config, Some(progress_callback)).await {
        Ok(total) => {
            let stats = abs_cache::get_cache_stats();

            let _ = window.emit("abs_cache_progress", json!({
                "phase": "complete",
                "message": format!("Cache loaded: {} items", total),
                "current": total,
                "total": total
            }));

            Ok(CacheRefreshResult {
                success: true,
                total_items: stats.total_items,
                items_with_files: stats.items_with_files,
                items_with_chapters: stats.items_with_chapters,
                message: format!(
                    "Loaded {} items ({} with files, {} with chapters)",
                    stats.total_items, stats.items_with_files, stats.items_with_chapters
                ),
            })
        }
        Err(e) => {
            let _ = window.emit("abs_cache_progress", json!({
                "phase": "error",
                "message": e.clone(),
                "current": 0,
                "total": 0
            }));

            Err(e)
        }
    }
}

/// Get cache status without refreshing
#[tauri::command]
pub async fn get_abs_cache_status() -> Result<CacheStatusResult, String> {
    let stats = abs_cache::get_cache_stats();
    let is_stale = abs_cache::is_cache_stale(300); // 5 minutes

    Ok(CacheStatusResult {
        is_loaded: stats.total_items > 0,
        is_stale,
        stats,
    })
}

/// Get all cached items as summaries (for list view)
#[tauri::command]
pub async fn get_cached_items() -> Result<Vec<CachedItemSummary>, String> {
    let items = abs_cache::get_all_items();

    let summaries: Vec<CachedItemSummary> = items.into_iter().map(|item| {
        let author = item.metadata.authors
            .iter()
            .map(|a| a.name.clone())
            .collect::<Vec<_>>()
            .join(", ");

        let (series, sequence) = item.metadata.series.first()
            .map(|s| (Some(s.name.clone()), s.sequence.clone()))
            .unwrap_or((None, None));

        let narrator = if !item.metadata.narrators.is_empty() {
            Some(item.metadata.narrators.join(", "))
        } else {
            None
        };

        CachedItemSummary {
            id: item.id,
            path: item.path,
            title: item.metadata.title.unwrap_or_default(),
            author,
            series,
            sequence,
            narrator,
            duration_seconds: item.duration,
            size_bytes: item.size,
            file_count: item.audio_files.len(),
            chapter_count: item.chapters.len(),
            has_cover: item.cover_path.is_some(),
            genres: item.metadata.genres,
        }
    }).collect();

    Ok(summaries)
}

/// Get a single cached item with full details
#[tauri::command]
pub async fn get_cached_item(id: String) -> Result<CachedItemDetail, String> {
    let item = abs_cache::get_item(&id)
        .ok_or_else(|| format!("Item '{}' not found in cache", id))?;

    let formatted_duration = format_duration(item.duration.unwrap_or(0.0));
    let formatted_size = format_bytes(item.size.unwrap_or(0));

    Ok(CachedItemDetail {
        item,
        formatted_duration,
        formatted_size,
    })
}

/// Get files for a specific cached item
#[tauri::command]
pub async fn get_cached_item_files(id: String) -> Result<Vec<abs_cache::CachedAudioFile>, String> {
    let item = abs_cache::get_item(&id)
        .ok_or_else(|| format!("Item '{}' not found in cache", id))?;

    Ok(item.audio_files)
}

/// Get chapters for a specific cached item
#[tauri::command]
pub async fn get_cached_item_chapters(id: String) -> Result<Vec<abs_cache::CachedChapter>, String> {
    let item = abs_cache::get_item(&id)
        .ok_or_else(|| format!("Item '{}' not found in cache", id))?;

    Ok(item.chapters)
}

/// Clear the cache
#[tauri::command]
pub async fn clear_abs_full_cache() -> Result<String, String> {
    abs_cache::clear_cache();
    Ok("Cache cleared".to_string())
}

/// Invalidate cache (mark as stale, requiring refresh on next access)
#[tauri::command]
pub async fn invalidate_abs_cache() -> Result<String, String> {
    abs_cache::invalidate_cache();
    Ok("Cache invalidated".to_string())
}

/// Search cached items by title or author
#[tauri::command]
pub async fn search_cached_items(query: String) -> Result<Vec<CachedItemSummary>, String> {
    let query_lower = query.to_lowercase();
    let items = abs_cache::get_all_items();

    let matches: Vec<CachedItemSummary> = items.into_iter()
        .filter(|item| {
            let title_match = item.metadata.title
                .as_ref()
                .map(|t| t.to_lowercase().contains(&query_lower))
                .unwrap_or(false);

            let author_match = item.metadata.authors
                .iter()
                .any(|a| a.name.to_lowercase().contains(&query_lower));

            let series_match = item.metadata.series
                .iter()
                .any(|s| s.name.to_lowercase().contains(&query_lower));

            title_match || author_match || series_match
        })
        .map(|item| {
            let author = item.metadata.authors
                .iter()
                .map(|a| a.name.clone())
                .collect::<Vec<_>>()
                .join(", ");

            let (series, sequence) = item.metadata.series.first()
                .map(|s| (Some(s.name.clone()), s.sequence.clone()))
                .unwrap_or((None, None));

            let narrator = if !item.metadata.narrators.is_empty() {
                Some(item.metadata.narrators.join(", "))
            } else {
                None
            };

            CachedItemSummary {
                id: item.id,
                path: item.path,
                title: item.metadata.title.unwrap_or_default(),
                author,
                series,
                sequence,
                narrator,
                duration_seconds: item.duration,
                size_bytes: item.size,
                file_count: item.audio_files.len(),
                chapter_count: item.chapters.len(),
                has_cover: item.cover_path.is_some(),
                genres: item.metadata.genres,
            }
        })
        .collect();

    Ok(matches)
}

/// Get unprocessed items (missing DNA tags or incomplete metadata)
#[tauri::command]
pub async fn get_unprocessed_abs_items() -> Result<Vec<UnprocessedItem>, String> {
    let items = abs_cache::get_unprocessed_items();

    let mut results: Vec<UnprocessedItem> = items.into_iter().map(|(item, reasons)| {
        let author = item.metadata.authors
            .iter()
            .map(|a| a.name.clone())
            .collect::<Vec<_>>()
            .join(", ");

        UnprocessedItem {
            id: item.id,
            path: item.path,
            title: item.metadata.title.unwrap_or_default(),
            author,
            reasons,
            has_dna: item.metadata.tags.iter().any(|t| t.starts_with("dna:")),
            has_genres: !item.metadata.genres.is_empty(),
            has_description: item.metadata.description.map_or(false, |d| !d.is_empty()),
            has_narrator: !item.metadata.narrators.is_empty(),
            has_series: !item.metadata.series.is_empty(),
            has_cover: item.cover_path.is_some(),
            tag_count: item.metadata.tags.len(),
        }
    }).collect();

    results.sort_by(|a, b| a.title.cmp(&b.title));

    Ok(results)
}

#[derive(Debug, Serialize, Clone)]
pub struct UnprocessedItem {
    pub id: String,
    pub path: String,
    pub title: String,
    pub author: String,
    pub reasons: Vec<String>,
    pub has_dna: bool,
    pub has_genres: bool,
    pub has_description: bool,
    pub has_narrator: bool,
    pub has_series: bool,
    pub has_cover: bool,
    pub tag_count: usize,
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn format_duration(seconds: f64) -> String {
    let total_seconds = seconds as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;

    if hours > 0 {
        format!("{}h {}m", hours, minutes)
    } else {
        format!("{}m", minutes)
    }
}

fn format_bytes(bytes: u64) -> String {
    const GB: u64 = 1024 * 1024 * 1024;
    const MB: u64 = 1024 * 1024;
    const KB: u64 = 1024;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

// ============================================================================
// AUTO-REFRESH UTILITY
// ============================================================================

/// Utility function to refresh cache if stale - called internally after push operations
pub async fn auto_refresh_if_needed(config: &config::Config) -> Result<(), String> {
    if abs_cache::is_cache_stale(60) {  // Refresh if older than 1 minute after push
        println!("🔄 Auto-refreshing ABS cache after push...");
        abs_cache::refresh_cache(config, None).await?;
    }
    Ok(())
}

/// Mark cache as needing refresh (call after push operations)
pub fn mark_cache_dirty() {
    abs_cache::invalidate_cache();
}
