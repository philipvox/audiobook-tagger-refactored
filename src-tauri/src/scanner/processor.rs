// src-tauri/src/scanner/processor.rs
// IMPROVED VERSION - Smart Series Handling + Normalization
// GPT validates/chooses from candidates instead of inventing series names
// API/GPT sources are now prioritized over file metadata to prevent corrupted tags from overriding

use super::types::{AudioFile, BookGroup, BookMetadata, MetadataChange, MetadataConfidence, MetadataSource, MetadataSources, ScanStatus, ScanMode, SelectiveRefreshFields, SeriesInfo};
use crate::audible::{AudibleMetadata, AudibleSeries};
use crate::cache;
use crate::config::Config;
use crate::normalize;
use futures::stream::{self, StreamExt};
use indexmap::IndexSet;
use lofty::probe::Probe;
use lofty::tag::Accessor;
use lofty::file::TaggedFileExt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::future::Future;
use std::time::Duration;

#[derive(Clone, Debug)]
struct FileTags {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    comment: Option<String>,
    year: Option<String>,
}

#[derive(Clone)]
struct RawFileData {
    path: String,
    filename: String,
    #[allow(dead_code)]
    parent_dir: String,
    tags: FileTags,
}

/// Cross-validation result between multiple sources
#[derive(Debug, Clone, Default)]
struct SourceValidation {
    title_confidence: u8,
    author_confidence: u8,
    narrator_confidence: u8,
    series_confidence: u8,
    conflicts: Vec<String>,
}

/// Retry wrapper for API calls with exponential backoff
/// Used by SuperScanner mode for maximum reliability
async fn with_retry<T, F, Fut>(
    operation_name: &str,
    max_retries: u32,
    base_delay_ms: u64,
    mut operation: F,
) -> Option<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    for attempt in 0..=max_retries {
        if attempt > 0 {
            let delay = base_delay_ms * 2u64.pow(attempt - 1);
            println!("   ⏳ Retry {} for {} (waiting {}ms)", attempt, operation_name, delay);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }

        match operation().await {
            Some(result) => {
                if attempt > 0 {
                    println!("   ✅ {} succeeded on retry {}", operation_name, attempt);
                }
                return Some(result);
            }
            None => {
                if attempt < max_retries {
                    println!("   ⚠️ {} attempt {} failed, will retry...", operation_name, attempt + 1);
                }
            }
        }
    }
    println!("   ❌ {} failed after {} retries", operation_name, max_retries + 1);
    None
}

/// Simple string similarity check for titles
fn titles_similar(a: &str, b: &str) -> bool {
    let a = a.trim().to_lowercase();
    let b = b.trim().to_lowercase();
    if a == b { return true; }
    // Check if one contains the other (for subtitle variations)
    if a.contains(&b) || b.contains(&a) { return true; }
    // Check word overlap
    let a_words: std::collections::HashSet<&str> = a.split_whitespace().collect();
    let b_words: std::collections::HashSet<&str> = b.split_whitespace().collect();
    let overlap = a_words.intersection(&b_words).count();
    let total = a_words.len().max(b_words.len());
    if total > 0 && overlap as f32 / total as f32 > 0.7 { return true; }
    false
}

/// Simple author name matching
fn authors_similar(a: &str, b: &str) -> bool {
    let a = a.trim().to_lowercase();
    let b = b.trim().to_lowercase();
    if a == b { return true; }
    // Check if one contains the other
    if a.contains(&b) || b.contains(&a) { return true; }
    // Check last name match
    let a_parts: Vec<&str> = a.split_whitespace().collect();
    let b_parts: Vec<&str> = b.split_whitespace().collect();
    if let (Some(a_last), Some(b_last)) = (a_parts.last(), b_parts.last()) {
        if a_last == b_last { return true; }
    }
    false
}

/// Cross-validate metadata from multiple sources to detect conflicts
/// Returns confidence scores and a list of conflicts for GPT to resolve
fn cross_validate_sources(
    folder_meta: &BookMetadata,
    audible: Option<&AudibleMetadata>,
) -> SourceValidation {
    let mut validation = SourceValidation::default();
    let mut title_matches = 0u8;
    let mut author_matches = 0u8;

    // Compare titles
    let folder_title = folder_meta.title.to_lowercase();
    if let Some(aud) = audible {
        if let Some(ref aud_title) = aud.title {
            if titles_similar(&folder_title, aud_title) {
                title_matches += 1;
            } else {
                validation.conflicts.push(format!(
                    "Title mismatch: Folder='{}' vs Audible='{}'",
                    folder_meta.title, aud_title
                ));
            }
        }
    }

    // Compare authors
    let folder_author = folder_meta.author.to_lowercase();
    if let Some(aud) = audible {
        let aud_authors: Vec<String> = aud.authors.iter().map(|a| a.to_lowercase()).collect();
        if aud_authors.iter().any(|a| authors_similar(&folder_author, a)) {
            author_matches += 1;
        } else if !aud.authors.is_empty() {
            validation.conflicts.push(format!(
                "Author mismatch: Folder='{}' vs Audible='{:?}'",
                folder_meta.author, aud.authors
            ));
        }
    }

    // Calculate confidence based on source agreement
    let num_sources = (audible.is_some() as u8) + 1; // +1 for folder
    validation.title_confidence = if num_sources > 0 { ((title_matches + 1) * 100) / num_sources } else { 50 };
    validation.author_confidence = if num_sources > 0 { ((author_matches + 1) * 100) / num_sources } else { 50 };

    // Narrator confidence (only from Audible)
    validation.narrator_confidence = if audible.map(|a| !a.narrators.is_empty()).unwrap_or(false) {
        90 // Audible is authoritative for narrators
    } else {
        0
    };

    // Series confidence - check if sources agree
    let mut series_names: Vec<String> = vec![];
    if let Some(aud) = audible {
        for s in &aud.series {
            series_names.push(s.name.to_lowercase());
        }
    }
    if let Some(ref folder_series) = folder_meta.series {
        series_names.push(folder_series.to_lowercase());
    }

    // Dedupe and check agreement
    series_names.sort();
    series_names.dedup();
    validation.series_confidence = match series_names.len() {
        0 => 0,   // No series found
        1 => 85,  // Single source
        _ => {
            // Check if series names are similar
            let first = &series_names[0];
            if series_names.iter().all(|s| titles_similar(s, first)) {
                95 // Sources agree
            } else {
                validation.conflicts.push(format!("Series conflict: {:?}", series_names));
                50 // Conflict
            }
        }
    };

    validation
}

/// Calculate confidence scores based on metadata sources
/// Returns a MetadataConfidence struct with per-field and overall scores
fn calculate_confidence_scores(
    metadata: &BookMetadata,
    validation: Option<&SourceValidation>,
) -> MetadataConfidence {
    let sources = metadata.sources.as_ref();

    // Helper to score a source (0-100)
    fn source_score(source: Option<&MetadataSource>) -> u8 {
        match source {
            Some(MetadataSource::Manual) => 100,
            Some(MetadataSource::Audible) | Some(MetadataSource::Abs) | Some(MetadataSource::CustomProvider) => 95,
            Some(MetadataSource::Gpt) => 85,
            Some(MetadataSource::ITunes) => 80,
            Some(MetadataSource::Folder) => 60,
            Some(MetadataSource::FileTag) => 40,
            Some(MetadataSource::Unknown) | None => 30,
        }
    }

    // Calculate per-field confidence
    let title_conf = if let Some(v) = validation {
        // Use cross-validation result if available
        v.title_confidence.max(source_score(sources.and_then(|s| s.title.as_ref())))
    } else {
        source_score(sources.and_then(|s| s.title.as_ref()))
    };

    let author_conf = if let Some(v) = validation {
        v.author_confidence.max(source_score(sources.and_then(|s| s.author.as_ref())))
    } else {
        source_score(sources.and_then(|s| s.author.as_ref()))
    };

    let narrator_conf = if let Some(v) = validation {
        v.narrator_confidence.max(source_score(sources.and_then(|s| s.narrator.as_ref())))
    } else {
        source_score(sources.and_then(|s| s.narrator.as_ref()))
    };

    let series_conf = if let Some(v) = validation {
        v.series_confidence.max(source_score(sources.and_then(|s| s.series.as_ref())))
    } else {
        // If no series, give 100% confidence (confident there's no series)
        if metadata.series.is_none() {
            100
        } else {
            source_score(sources.and_then(|s| s.series.as_ref()))
        }
    };

    // Collect sources used
    let mut sources_used = Vec::new();
    if let Some(s) = sources {
        let add_source = |src: Option<&MetadataSource>, list: &mut Vec<String>| {
            if let Some(source) = src {
                let name = match source {
                    MetadataSource::Audible => "Audible",
                    MetadataSource::Abs => "AudiobookShelf",
                    MetadataSource::CustomProvider => "Goodreads/Hardcover",
                    MetadataSource::Gpt => "AI",
                    MetadataSource::ITunes => "iTunes",
                    MetadataSource::Folder => "Folder",
                    MetadataSource::FileTag => "File Tags",
                    MetadataSource::Manual => "Manual",
                    MetadataSource::Unknown => "Unknown",
                };
                if !list.contains(&name.to_string()) {
                    list.push(name.to_string());
                }
            }
        };
        add_source(s.title.as_ref(), &mut sources_used);
        add_source(s.author.as_ref(), &mut sources_used);
        add_source(s.narrator.as_ref(), &mut sources_used);
        add_source(s.series.as_ref(), &mut sources_used);
        add_source(s.genres.as_ref(), &mut sources_used);
    }

    // Calculate overall confidence (weighted average)
    // Title and author are most important
    let overall = (
        (title_conf as u16 * 30) +      // 30% weight
        (author_conf as u16 * 25) +     // 25% weight
        (narrator_conf as u16 * 15) +   // 15% weight
        (series_conf as u16 * 15) +     // 15% weight
        (source_score(sources.and_then(|s| s.genres.as_ref())) as u16 * 15) // 15% weight
    ) / 100;

    // Boost confidence if we have data from multiple trusted sources
    let trusted_sources = sources_used.iter()
        .filter(|s| matches!(s.as_str(), "Audible" | "AudiobookShelf" | "AI"))
        .count();
    let overall = if trusted_sources >= 2 {
        (overall as u8).saturating_add(5).min(100)
    } else {
        overall as u8
    };

    // Penalize if there are conflicts
    let overall = if let Some(v) = validation {
        if !v.conflicts.is_empty() {
            overall.saturating_sub((v.conflicts.len() as u8) * 10)
        } else {
            overall
        }
    } else {
        overall
    };

    MetadataConfidence {
        title: title_conf,
        author: author_conf,
        narrator: narrator_conf,
        series: series_conf,
        overall,
        sources_used,
    }
}

fn read_file_tags(path: &str) -> FileTags {
    read_file_tags_sync(path)
}

/// Synchronous file tag reading - used internally
fn read_file_tags_sync(path: &str) -> FileTags {
    let tagged_file = match Probe::open(path).and_then(|p| p.read()) {
        Ok(f) => f,
        Err(_) => return FileTags {
            title: None, artist: None, album: None,
            genre: None, comment: None, year: None,
        },
    };

    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

    match tag {
        Some(t) => FileTags {
            title: t.title().map(|s| s.to_string()),
            artist: t.artist().map(|s| s.to_string()),
            album: t.album().map(|s| s.to_string()),
            genre: t.genre().map(|s| s.to_string()),
            comment: t.comment().map(|s| s.to_string()),
            year: t.year().map(|y| y.to_string()),
        },
        None => FileTags {
            title: None, artist: None, album: None,
            genre: None, comment: None, year: None,
        },
    }
}

/// Async file tag reading using spawn_blocking to avoid blocking the async runtime
async fn read_file_tags_async(path: String) -> FileTags {
    tokio::task::spawn_blocking(move || read_file_tags_sync(&path))
        .await
        .unwrap_or_else(|_| FileTags {
            title: None, artist: None, album: None,
            genre: None, comment: None, year: None,
        })
}

/// Read tags for multiple files in parallel
async fn read_all_file_tags_parallel(paths: Vec<String>, concurrency: usize) -> Vec<(String, FileTags)> {
    stream::iter(paths)
        .map(|path| {
            let p = path.clone();
            async move {
                let tags = read_file_tags_async(p.clone()).await;
                (p, tags)
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await
}

/// Normalize a single series name - clean up but preserve identity
fn normalize_series_name(name: &str) -> String {
    let mut normalized = name.trim().to_string();

    // Remove trailing junk like "(Book", "(Books", etc.
    let patterns_to_remove = [
        " (Book", "(Book", " (Books", "(Books",
        " - Book", "- Book",
        ", Book",
    ];
    for pattern in &patterns_to_remove {
        if let Some(pos) = normalized.find(pattern) {
            normalized = normalized[..pos].trim().to_string();
        }
    }

    // Remove trailing comma
    if normalized.ends_with(',') {
        normalized = normalized[..normalized.len()-1].trim().to_string();
    }

    // Remove common suffixes (case-insensitive)
    let suffixes = [" Series", " Trilogy", " Saga", " Chronicles", " Collection", " Books"];
    for suffix in &suffixes {
        if normalized.to_lowercase().ends_with(&suffix.to_lowercase()) {
            normalized = normalized[..normalized.len() - suffix.len()].to_string();
        }
    }

    // Handle series names that include book titles - extract just the series part
    // Pattern: "Book Title - Series Name" or "Series Name - Book Title"
    let normalized_lower = normalized.to_lowercase();

    // Harry Potter - should just be "Harry Potter", not "Harry Potter and the..."
    if normalized_lower.starts_with("harry potter") {
        // If it contains "and the", it's probably a book title being used as series
        if normalized_lower.contains(" and the ") {
            return "Harry Potter".to_string();
        }
    }

    // Stormlight Archive - handle "Words of Radiance - The Stormlight Archive" pattern
    if normalized_lower.contains("stormlight archive") {
        return "The Stormlight Archive".to_string();
    }

    // Handle "Book Title - Series Name" pattern (common in Audible)
    if normalized.contains(" - ") {
        let parts: Vec<&str> = normalized.split(" - ").collect();
        if parts.len() == 2 {
            // Usually the series name is shorter than the book title
            // Or contains words like "Series", "Chronicles", etc.
            let part1 = parts[0].trim();
            let part2 = parts[1].trim();

            // If part2 looks more like a series name, use it
            let part2_lower = part2.to_lowercase();
            if part2_lower.contains("series") || part2_lower.contains("chronicle")
               || part2_lower.contains("saga") || part2.len() < part1.len() {
                normalized = part2.to_string();
            } else {
                // Otherwise use part1
                normalized = part1.to_string();
            }
        }
    }

    normalized.trim().to_string()
}

/// Extract series from a series name - CONSERVATIVE approach
/// Returns a SINGLE series entry in most cases. Only splits for very specific known cases.
/// e.g., "Magic Tree House: Merlin Missions" -> ["Merlin Missions"] (use sub-series only)
/// e.g., "A Song of Ice and Fire" -> ["A Song of Ice and Fire"]
fn extract_all_series_from_name(name: &str, position: Option<&str>) -> Vec<(String, Option<String>)> {
    let normalized = name.trim();
    let name_lower = normalized.to_lowercase();

    // Known sub-series mappings - map to the MORE SPECIFIC series name only
    // We don't want to create multiple series entries, just use the right one
    let subseries_mappings = [
        // (pattern, preferred_series_name)
        ("merlin missions", "Merlin Missions"),
        ("magic tree house fact tracker", "Magic Tree House Fact Tracker"),
        ("magic tree house: super edition", "Magic Tree House Super Edition"),
        ("magic tree house super edition", "Magic Tree House Super Edition"),
    ];

    // Check for known sub-series - return just the specific sub-series
    for (pattern, preferred) in &subseries_mappings {
        if name_lower.contains(pattern) {
            return vec![(preferred.to_string(), position.map(|s| s.to_string()))];
        }
    }

    // For colon-separated names, keep the FULL name as-is (don't split)
    // The colon is usually part of the series name, not a parent/child separator
    // e.g., "Star Wars: The High Republic" should stay as one series

    // Just normalize and return the single series
    vec![(normalize_series_name(normalized), position.map(|s| s.to_string()))]
}

pub async fn process_all_groups(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    scan_mode: ScanMode,
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    process_all_groups_with_options(groups, config, cancel_flag, scan_mode, None, false).await
}

/// Process all groups with optional selective refresh fields
pub async fn process_all_groups_with_options(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    scan_mode: ScanMode,
    selective_fields: Option<SelectiveRefreshFields>,
    enable_transcription: bool,
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    let total = groups.len();
    let start_time = std::time::Instant::now();

    println!("🚀 Processing {} book groups (mode={:?})...", total, scan_mode);

    // Start progress tracking with timer for ETA calculation
    crate::progress::start_scan(total);

    let processed = Arc::new(AtomicUsize::new(0));
    let covers_found = Arc::new(AtomicUsize::new(0));
    let concurrency = config.get_concurrency(crate::config::ConcurrencyOp::Metadata);
    let config = Arc::new(config.clone());
    let selective_fields = Arc::new(selective_fields);

    // Process with controlled concurrency
    let results: Vec<BookGroup> = stream::iter(groups)
        .map(|group| {
            let config = config.clone();
            let cancel_flag = cancel_flag.clone();
            let processed = processed.clone();
            let covers_found = covers_found.clone();
            let selective_fields = selective_fields.clone();
            let total = total;
            let scan_mode = scan_mode;
            let enable_transcription = enable_transcription;

            async move {
                let result = process_book_group_with_options(
                    group,
                    &config,
                    cancel_flag,
                    covers_found.clone(),
                    scan_mode,
                    (*selective_fields).clone(),
                    enable_transcription,
                ).await;

                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                let covers = covers_found.load(Ordering::Relaxed);

                // Update progress every book for responsive parallel updates
                // ETA is calculated automatically in progress module
                crate::progress::update_progress_with_covers(done, total,
                    &format!("{}/{} books ({} covers)", done, total, covers),
                    covers
                );

                result
            }
        })
        .buffer_unordered(concurrency)
        .filter_map(|r| async { r.ok() })
        .collect()
        .await;

    let elapsed = start_time.elapsed();
    let final_covers = covers_found.load(Ordering::Relaxed);
    let books_per_sec = results.len() as f64 / elapsed.as_secs_f64();

    println!("✅ Done: {} books, {} covers in {:.1}s ({:.1}/sec)",
        results.len(), final_covers, elapsed.as_secs_f64(), books_per_sec);

    Ok(results)
}

async fn process_book_group(
    group: BookGroup,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    covers_found: Arc<AtomicUsize>,
    scan_mode: ScanMode,
) -> Result<BookGroup, Box<dyn std::error::Error + Send + Sync>> {
    process_book_group_with_options(group, config, cancel_flag, covers_found, scan_mode, None, false).await
}

/// Process a single book group with optional selective refresh
/// When selective_fields is provided, only those fields will be refreshed from API sources
/// All other fields will be preserved from the existing metadata
async fn process_book_group_with_options(
    mut group: BookGroup,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    covers_found: Arc<AtomicUsize>,
    scan_mode: ScanMode,
    selective_fields: Option<SelectiveRefreshFields>,
    enable_transcription: bool,
) -> Result<BookGroup, Box<dyn std::error::Error + Send + Sync>> {

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // Store existing metadata for selective refresh
    let existing_metadata = group.metadata.clone();

    // Handle skip logic based on scan mode
    match scan_mode {
        ScanMode::Normal => {
            // SKIP API CALLS if metadata was loaded from existing metadata.json
            // BUT still fetch cover if missing
            if group.scan_status == ScanStatus::LoadedFromFile {
                // Check if cover is actually in cache (not just URL in metadata)
                let cover_cache_key = format!("cover_{}", group.id);
                let has_cached_cover = cache::get::<(Vec<u8>, String)>(&cover_cache_key).is_some();

                if has_cached_cover {
                    println!("   ⚡ Skipping API calls for '{}' (metadata.json + cover cached)", group.metadata.title);
                    let file_concurrency = config.get_concurrency(crate::config::ConcurrencyOp::FileScan);
                    group.total_changes = calculate_changes_async(&mut group, file_concurrency).await;
                    return Ok(group);
                } else {
                    // Need to fetch cover even though we have metadata.json
                    println!("   📷 Will fetch cover for '{}' (metadata.json exists but no cover cached)", group.metadata.title);
                    // Continue to cover fetch section but skip metadata fetching
                    // Since we have metadata.json, we can use it directly for cover search
                    let asin = group.metadata.asin.clone();
                    match crate::cover_art::fetch_and_download_cover(
                        &group.metadata.title,
                        &group.metadata.author,
                        asin.as_deref(),
                        None,
                    ).await {
                        Ok(cover) if cover.data.is_some() => {
                            if let Some(ref data) = cover.data {
                                let mime_type = cover.mime_type.clone().unwrap_or_else(|| "image/jpeg".to_string());
                                let _ = cache::set(&cover_cache_key, &(data.clone(), mime_type));
                                covers_found.fetch_add(1, Ordering::Relaxed);
                                group.metadata.cover_url = cover.url;
                                group.metadata.cover_mime = cover.mime_type;
                                println!("   ✅ Cover found for '{}'", group.metadata.title);
                            }
                        }
                        _ => {
                            println!("   ⚠️  No cover found for '{}'", group.metadata.title);
                        }
                    }
                    let file_concurrency = config.get_concurrency(crate::config::ConcurrencyOp::FileScan);
                    group.total_changes = calculate_changes_async(&mut group, file_concurrency).await;
                    return Ok(group);
                }
            }
        }
        ScanMode::RefreshMetadata => {
            // Bypass metadata.json but use cached API results
            if group.scan_status == ScanStatus::LoadedFromFile {
                println!("   🔄 Refresh metadata for '{}' (bypassing metadata.json, using API cache)", group.metadata.title);
                // Don't return - continue to process but API calls will use cache
            }
        }
        ScanMode::ForceFresh => {
            // Full rescan - ignore metadata.json AND clear caches (handled in mod.rs)
            if group.scan_status == ScanStatus::LoadedFromFile {
                println!("   🔄 Force fresh rescan for '{}' (ignoring metadata.json and cache)", group.metadata.title);
            }
        }
        ScanMode::SelectiveRefresh => {
            // Selective refresh - bypass metadata.json, use cache for non-selected fields
            if group.scan_status == ScanStatus::LoadedFromFile {
                let fields_str = if let Some(ref fields) = selective_fields {
                    let mut f = Vec::new();
                    if fields.all { f.push("all"); }
                    else {
                        if fields.authors { f.push("authors"); }
                        if fields.narrators { f.push("narrators"); }
                        if fields.description { f.push("description"); }
                        if fields.series { f.push("series"); }
                        if fields.genres { f.push("genres"); }
                    }
                    f.join(", ")
                } else {
                    "none".to_string()
                };
                println!("   🔄 Selective refresh for '{}' (fields: {})", group.metadata.title, fields_str);
            }
        }
        ScanMode::SuperScanner => {
            // SuperScanner mode: Maximum accuracy - handled by separate function
            // This case should not be reached as SuperScanner uses process_group_super_scanner
            println!("   🔬 Super Scanner for '{}' (max accuracy mode)", group.metadata.title);
        }
    }

    // Use the first file's parent directory path for cache key to ensure uniqueness
    // This prevents collisions when different directories have the same folder name
    let parent_path = std::path::Path::new(&group.files[0].path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| group.group_name.clone());
    let cache_key = format!("book_{}", parent_path);

    // For selective refresh, don't use full cache - we need fresh API data for specific fields
    // For normal modes, check cache first
    if scan_mode != ScanMode::SelectiveRefresh {
        if let Some(cached_metadata) = cache::get::<BookMetadata>(&cache_key) {
            group.metadata = cached_metadata;
            group.scan_status = ScanStatus::NewScan; // Mark as scanned (from cache)

            // IMPORTANT: Even with cached metadata, we need to check/fetch covers
            let cover_cache_key = format!("cover_{}", group.id);
            let has_cover = cache::get::<(Vec<u8>, String)>(&cover_cache_key).is_some();

            if !has_cover && !group.metadata.title.is_empty() {
                println!("   📷 Fetching cover for cached book: '{}'", group.metadata.title);
                let asin = group.metadata.asin.clone();
                match crate::cover_art::fetch_and_download_cover(
                    &group.metadata.title,
                    &group.metadata.author,
                    asin.as_deref(),
                    None,
                ).await {
                    Ok(cover) if cover.data.is_some() => {
                        if let Some(ref data) = cover.data {
                            let mime_type = cover.mime_type.clone().unwrap_or_else(|| "image/jpeg".to_string());
                            let _ = cache::set(&cover_cache_key, &(data.clone(), mime_type));
                            covers_found.fetch_add(1, Ordering::Relaxed);
                            group.metadata.cover_url = cover.url;
                            group.metadata.cover_mime = cover.mime_type;
                            // Update cached metadata with cover info
                            let _ = cache::set(&cache_key, &group.metadata);
                        }
                    }
                    _ => {
                        println!("   ⚠️  No cover found for '{}'", group.metadata.title);
                    }
                }
            }

            let file_concurrency = config.get_concurrency(crate::config::ConcurrencyOp::FileScan);
            group.total_changes = calculate_changes_async(&mut group, file_concurrency).await;
            return Ok(group);
        }
    }

    // Read first file's tags
    let sample_file = &group.files[0];
    let file_tags = read_file_tags(&sample_file.path);

    let raw_file = RawFileData {
        path: sample_file.path.clone(),
        filename: sample_file.filename.clone(),
        parent_dir: std::path::Path::new(&sample_file.path)
            .parent()
            .unwrap_or(std::path::Path::new(""))
            .to_string_lossy()
            .to_string(),
        tags: file_tags.clone(),
    };

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // For selective refresh, use existing metadata as base for title/author
    // unless we're refreshing authors specifically
    let (extracted_title, extracted_author) = if scan_mode == ScanMode::SelectiveRefresh
        && !existing_metadata.title.is_empty()
        && selective_fields.as_ref().map(|f| !f.authors && !f.all).unwrap_or(true)
    {
        // Use existing title/author for searching APIs
        (existing_metadata.title.clone(), existing_metadata.author.clone())
    } else {
        // Extract title/author with INVERTED PRIORITY:
        // First try folder name (reliable), then GPT/API validation, file tags are LAST resort
        extract_book_info_with_priority(
            &raw_file,
            &group.group_name,
            config.openai_api_key.as_deref()
        ).await
    };

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // AUDIO TRANSCRIPTION: Extract title/author from narrator's spoken intro
    // This provides very accurate search terms when the narrator announces the book
    let transcription = if enable_transcription && config.openai_api_key.is_some() {
        transcribe_for_search(&group, config).await
    } else {
        None
    };

    // Use transcription results if available and confident
    let (trans_title, trans_author) = if let Some(ref t) = transcription {
        let title = t.extracted_title.clone().filter(|s| !s.is_empty());
        let author = t.extracted_author.clone().filter(|s| !s.is_empty());
        if title.is_some() || author.is_some() {
            println!("   🎤 Transcription found: title={:?}, author={:?}, confidence={}",
                title, author, t.confidence);
        }
        (title, author)
    } else {
        (None, None)
    };

    // PRE-SEARCH CLEANING: Use GPT to clean messy folder names before ABS search
    // This dramatically improves search hit rates
    // If transcription provided better results, use those instead
    let (search_title, search_author) = if trans_title.is_some() && transcription.as_ref().map(|t| t.confidence >= 60).unwrap_or(false) {
        // High-confidence transcription (has title + author) - use it directly
        println!("   🎤 Using transcription for search (confidence >= 60)");
        (
            trans_title.unwrap_or_else(|| extracted_title.clone()),
            trans_author.unwrap_or_else(|| extracted_author.clone()),
        )
    } else if trans_title.is_some() && transcription.as_ref().map(|t| t.confidence >= 40).unwrap_or(false) {
        // Moderate confidence transcription (has title but maybe no author) - use title from transcription
        let trans_t = trans_title.unwrap();
        println!("   🎤 Using transcription title for search: '{}' (confidence >= 40)", trans_t);
        (
            trans_t,
            trans_author.unwrap_or_else(|| extracted_author.clone()),
        )
    } else {
        // Fall back to GPT cleaning of folder name
        clean_title_for_search(
            &extracted_title,
            &extracted_author,
            &group.group_name,
            config.openai_api_key.as_deref(),
        ).await
    };

    // Fetch metadata via ABS (preferred) or direct Audible scraping (fallback)
    // Using the CLEANED title/author for better search results
    let audible_data = fetch_metadata_via_abs(&search_title, &search_author, config).await;

    // Log what we got from Audible
    println!("📊 Data sources for '{}' (searched as: '{}'):", extracted_title, search_title);
    println!("   Audible: {}", if audible_data.is_some() { "✅ Found" } else { "❌ None" });
    if let Some(ref aud) = audible_data {
        if !aud.series.is_empty() {
            println!("   Audible series: {:?}", aud.series);
        }
        println!("   Audible authors: {:?}", aud.authors);
        println!("   Audible narrators: {:?}", aud.narrators);
    }

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // Determine if we need GPT enrichment (Audible failed)
    let needs_gpt_enrichment = audible_data.is_none();

    // Store ASIN and cover URL for cover search (may be None if Audible failed)
    // Extract these BEFORE audible_data is consumed by the merge functions
    let asin = audible_data.as_ref().and_then(|d| d.asin.clone());
    let pre_fetched_cover_url = audible_data.as_ref().and_then(|d| d.cover_url.clone());

    // NOTE: Cover fetch is now done AFTER GPT enrichment to use corrected title
    let should_fetch_cover = selective_fields.as_ref().map(|f| f.cover || f.all).unwrap_or(true);

    // PERFORMANCE: Check if Audible data is complete enough to skip GPT entirely
    let audible_is_complete = audible_data.as_ref().map(|d| {
        d.title.is_some() &&
        !d.authors.is_empty() &&
        !d.narrators.is_empty() &&
        d.description.as_ref().map(|desc| desc.len() > 50).unwrap_or(false)
    }).unwrap_or(false);

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // Merge metadata with IMPROVED priority: API/GPT first, file tags LAST
    let mut final_metadata = if audible_is_complete && config.openai_api_key.is_none() {
        // FAST PATH: Audible has complete data and no GPT key, skip entirely
        println!("   ⚡ Fast path: Complete Audible data, no GPT needed");
        create_metadata_from_audible(&extracted_title, &extracted_author, audible_data.unwrap())
    } else if needs_gpt_enrichment {
        enrich_with_gpt(
            &group.group_name,
            &extracted_title,
            &extracted_author,
            &file_tags,
            config.openai_api_key.as_deref(),
            Some(&sample_file.path),
        ).await
    } else {
        merge_all_with_gpt_improved(
            &group.group_name,
            &extracted_title,
            &extracted_author,
            &file_tags,
            audible_data,
            config.openai_api_key.as_deref()
        ).await
    };

    // For selective refresh, merge only the requested fields with existing metadata
    if scan_mode == ScanMode::SelectiveRefresh {
        final_metadata = merge_selective_fields(existing_metadata, final_metadata, selective_fields);
    }

    // NOW fetch cover art using the CORRECTED title from GPT (if any)
    // This ensures we search with "Black House" not "1_ Part I - Welcome to Coulee Country"
    // Use pre_fetched_cover_url from ABS metadata to avoid duplicate API calls
    if should_fetch_cover {
        let search_title = &final_metadata.title;
        let search_author = &final_metadata.author;
        let search_asin = asin.as_deref().or(final_metadata.asin.as_deref());

        println!("   🖼️  Searching for cover: '{}' by '{}'", search_title, search_author);

        match crate::cover_art::fetch_and_download_cover_with_url(
            search_title,
            search_author,
            search_asin,
            pre_fetched_cover_url.as_deref(),
        ).await {
            Ok(cover) if cover.data.is_some() => {
                if let Some(ref data) = cover.data {
                    let cover_cache_key = format!("cover_{}", group.id);
                    let mime_type = cover.mime_type.clone().unwrap_or_else(|| "image/jpeg".to_string());
                    let _ = cache::set(&cover_cache_key, &(data.clone(), mime_type));
                    covers_found.fetch_add(1, Ordering::Relaxed);
                }
                final_metadata.cover_url = cover.url;
                final_metadata.cover_mime = cover.mime_type;
            }
            _ => {
                println!("   ⚠️  No cover found for '{}'", search_title);
            }
        }
    }

    group.metadata = final_metadata;

    // Calculate and store confidence scores
    group.metadata.confidence = Some(calculate_confidence_scores(&group.metadata, None));

    // Cache the result
    let _ = cache::set(&cache_key, &group.metadata);

    // Mark as newly scanned
    group.scan_status = ScanStatus::NewScan;

    // Calculate changes - use parallel file reading for performance
    let file_concurrency = config.get_concurrency(crate::config::ConcurrencyOp::FileScan);
    group.total_changes = calculate_changes_async(&mut group, file_concurrency).await;

    Ok(group)
}

/// Merge only the selected fields from new_metadata into existing_metadata
/// Fields not selected are preserved from existing_metadata
fn merge_selective_fields(
    existing: BookMetadata,
    new: BookMetadata,
    fields: Option<SelectiveRefreshFields>,
) -> BookMetadata {
    let fields = match fields {
        Some(f) if f.any_selected() => f,
        _ => return existing, // No fields selected, keep existing
    };

    let mut result = existing.clone();
    let mut sources = result.sources.clone().unwrap_or_default();

    // If 'all' is selected, replace everything
    if fields.all {
        return new;
    }

    // Selectively replace fields
    if fields.authors {
        result.author = new.author;
        result.authors = new.authors;
        if let Some(ref new_sources) = new.sources {
            sources.author = new_sources.author;
        }
        println!("   📝 Updated authors from API");
    }

    if fields.narrators {
        result.narrator = new.narrator;
        result.narrators = new.narrators;
        if let Some(ref new_sources) = new.sources {
            sources.narrator = new_sources.narrator;
        }
        println!("   📝 Updated narrators from API");
    }

    if fields.description {
        result.description = new.description;
        if let Some(ref new_sources) = new.sources {
            sources.description = new_sources.description;
        }
        println!("   📝 Updated description from API");
    }

    if fields.series {
        result.series = new.series;
        result.sequence = new.sequence;
        if let Some(ref new_sources) = new.sources {
            sources.series = new_sources.series;
            sources.sequence = new_sources.sequence;
        }
        println!("   📝 Updated series from API");
    }

    if fields.genres {
        result.genres = new.genres;
        if let Some(ref new_sources) = new.sources {
            sources.genres = new_sources.genres;
        }
        println!("   📝 Updated genres from API");
    }

    if fields.publisher {
        result.publisher = new.publisher;
        if let Some(ref new_sources) = new.sources {
            sources.publisher = new_sources.publisher;
        }
        println!("   📝 Updated publisher from API");
    }

    if fields.cover {
        result.cover_url = new.cover_url;
        result.cover_mime = new.cover_mime;
        if let Some(ref new_sources) = new.sources {
            sources.cover = new_sources.cover;
        }
        println!("   📝 Updated cover from API");
    }

    result.sources = Some(sources);
    result
}

/// Extract book info with INVERTED priority: folder name first, GPT validation, file tags LAST
/// This prevents corrupted file tags from overriding correct metadata
async fn extract_book_info_with_priority(
    sample_file: &RawFileData,
    folder_name: &str,
    api_key: Option<&str>
) -> (String, String) {
    // STEP 1: Parse folder name for title/author (most reliable)
    // Also clean any chapter prefixes in case it's a chapter subfolder that wasn't detected
    let (raw_folder_title, folder_author) = parse_folder_for_book_info(folder_name);
    let folder_title = clean_chapter_prefix(&raw_folder_title);

    // STEP 2: Read file tags (may be corrupted)
    let file_title = sample_file.tags.title.clone();
    let file_artist = sample_file.tags.artist.clone();

    // STEP 3: Decide priority
    // If folder name gives us a clear title/author, use that
    // If file tags match folder pattern, they're probably good
    // If file tags differ significantly from folder, prefer folder (file may be corrupted)

    let final_title: String;
    let final_author: String;

    // Trust folder name over file tags for author (common corruption point)
    if !folder_author.is_empty() && folder_author.to_lowercase() != "unknown" {
        final_author = folder_author.clone();
        println!("   📁 Using folder author: '{}'", final_author);

        // Warn if file tag differs significantly
        if let Some(ref artist) = file_artist {
            if !crate::normalize::authors_match(&folder_author, artist) {
                println!("   ⚠️ File tag author '{}' differs from folder '{}' - using folder (file may be corrupted)",
                    artist, folder_author);
            }
        }
    } else if let Some(ref artist) = file_artist {
        if artist.to_lowercase() != "unknown" && !artist.is_empty() {
            final_author = artist.clone();
        } else {
            final_author = "Unknown".to_string();
        }
    } else {
        final_author = "Unknown".to_string();
    }

    // For title, prefer file tag if clean, else folder name
    if let Some(ref title) = file_title {
        // Apply full title cleaning to file tags too
        let clean_title = normalize::normalize_title(title);
        if tags_are_clean(Some(&clean_title), Some(&final_author)) && !clean_title.is_empty() {
            final_title = clean_title;
        } else {
            final_title = folder_title;
        }
    } else {
        final_title = folder_title;
    }

    // STEP 4: Always normalize title and author
    // (GPT validation was previously done here but is now optional)
    let normalized_title = normalize::normalize_title(&final_title);
    let normalized_author = normalize::clean_author_name(&final_author);

    (normalized_title, normalized_author)
}

/// Check if a string looks like a valid author name
/// Returns true for patterns like "John Smith", "J.K. Rowling", "Stephen King"
fn looks_like_author_name(name: &str) -> bool {
    let name = name.trim();

    // Too short to be a real name
    if name.len() < 5 {
        return false;
    }

    // Starts with a number - probably a track/chapter number
    if name.chars().next().map(|c| c.is_numeric()).unwrap_or(false) {
        return false;
    }

    // Contains brackets (often ASIN or year) - not an author name
    if name.contains('[') || name.contains(']') || name.contains('(') || name.contains(')') {
        return false;
    }

    // Contains comma - likely "Series Name, Book X" format
    if name.contains(',') {
        return false;
    }

    // Contains "Book" followed by a number or # - series info, not author
    lazy_static::lazy_static! {
        static ref BOOK_NUM_REGEX: regex::Regex = regex::Regex::new(r"(?i)book\s*[#]?\d").unwrap();
    }
    if BOOK_NUM_REGEX.is_match(name) {
        return false;
    }

    // Common false positives - series names, descriptors, etc.
    // NOTE: Removed words that could be legitimate names (Magic, Dark, Light, etc.)
    // as they could match authors like "Magic Johnson" or "Light Yagami"
    let false_positives = [
        "the ", "a ", "an ", "book ", "volume ", "vol ", "part ", "chapter ",
        "audiobook", "audio ", "unabridged", "abridged", "complete ",
        "series", "trilogy", "saga ", "collection", "tales ", "stories ",
    ];
    let name_lower = name.to_lowercase();
    for fp in &false_positives {
        if name_lower.starts_with(fp) {
            return false;
        }
    }

    // Check for false positives ANYWHERE in the name (not just start)
    let anywhere_false_positives = [
        " series", " book ", " volume ", " trilogy", " saga",
        " collection", "'s money", "'s guide", "'s handbook",
        "translator", "translated by", "narrated by", "read by",
        "performed by", "foreword by", "introduction by", "edited by",
    ];
    for fp in &anywhere_false_positives {
        if name_lower.contains(fp) {
            return false;
        }
    }

    // Should contain at least one space (first and last name) or period (initials)
    if !name.contains(' ') && !name.contains('.') {
        return false;
    }

    // Should start with an uppercase letter
    if !name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
        return false;
    }

    // Count words - a name should have 2-4 words typically
    let words: Vec<&str> = name.split_whitespace().collect();
    if words.len() < 2 || words.len() > 5 {
        return false;
    }

    // Each word should start with uppercase (or be an initial like "J.")
    for word in &words {
        let first_char = word.chars().next();
        if let Some(c) = first_char {
            // Allow lowercase for small words like "de", "van", "von", etc.
            if !c.is_uppercase() && word.len() > 3 {
                return false;
            }
        }
    }

    true
}

/// Parse folder name for book info (Author - Title patterns)
/// Only extracts author if it clearly looks like a person's name
fn parse_folder_for_book_info(folder_name: &str) -> (String, String) {
    // Pattern: "Author Name - Book Title" (with clear author name)
    lazy_static::lazy_static! {
        static ref AUTHOR_TITLE_PATTERN: regex::Regex = regex::Regex::new(r"^([^-]+?)\s*[-–]\s*(.+)$").unwrap();
    }
    if let Some(caps) = AUTHOR_TITLE_PATTERN.captures(folder_name) {
        if let (Some(potential_author), Some(title)) = (caps.get(1), caps.get(2)) {
            let author_str = potential_author.as_str().trim().to_string();
            let title_str = title.as_str().trim().to_string();

            // Only use if it really looks like an author name
            if looks_like_author_name(&author_str) {
                println!("   📁 Parsed folder: author='{}', title='{}'", author_str, title_str);
                return (title_str, author_str);
            }
        }
    }

    // No author found in folder - just return the title
    (folder_name.to_string(), String::new())
}

// ============================================================================
// IMPROVED SERIES HANDLING
// ============================================================================

/// Represents a series candidate from various sources
#[derive(Debug, Clone)]
struct SeriesCandidate {
    name: String,
    position: Option<String>,
    source: String,  // "audible", "google", "folder", "gpt"
}

/// Collect series candidates from available sources
/// Priority: Audible > Custom Providers (Goodreads) > Folder extraction
/// Folder extraction is ONLY used if no API sources have series info
fn collect_series_candidates(
    folder_name: &str,
    extracted_title: &str,
    audible_data: &Option<AudibleMetadata>,
) -> Vec<SeriesCandidate> {
    let mut candidates: Vec<SeriesCandidate> = Vec::new();
    let title_lower = extracted_title.to_lowercase();

    // 1. Audible series (highest confidence) - ONLY use API sources
    if let Some(ref aud) = audible_data {
        for series in &aud.series {
            let series_lower = series.name.to_lowercase();

            // Validate: reject if series name matches or contains full title
            if series_lower == title_lower {
                println!("   ⚠️ Rejecting Audible series '{}' (exact match with title)", series.name);
                continue;
            }

            // Reject if series looks like "Title - Something" (wrong format)
            if series.name.contains(" - ") && series.name.len() > 40 {
                println!("   ⚠️ Rejecting Audible series '{}' (looks like title with subtitle)", series.name);
                continue;
            }

            candidates.push(SeriesCandidate {
                name: series.name.clone(),
                position: series.position.clone(),
                source: "audible".to_string(),
            });
        }
    }

    // 2. ONLY use folder extraction if we have NO series from Audible
    // This prevents folder-parsed garbage from polluting good API data
    if candidates.is_empty() {
        if let (Some(series_name), position) = extract_series_from_folder(folder_name) {
            let series_lower = series_name.to_lowercase();

            // Stricter validation for folder-extracted series
            if series_lower != title_lower
               && !title_lower.starts_with(&series_lower)
               && series_name.len() >= 3
               && series_name.len() <= 50  // Not too long
               && !series_name.contains(" - ")  // No title separators
            {
                println!("   📁 Using folder-extracted series: '{}' #{:?}", series_name, position);
                candidates.push(SeriesCandidate {
                    name: series_name,
                    position,
                    source: "folder".to_string(),
                });
            }
        }
    }

    candidates
}

/// Validate a series name against the title - STRICT validation
fn is_valid_series(series: &str, title: &str) -> bool {
    is_valid_series_with_sequence(series, title, None)
}

fn is_valid_series_with_sequence(series: &str, title: &str, sequence: Option<&str>) -> bool {
    // First check basic validity (filters GPT artifacts like "or null", "Standalone", etc.)
    if !normalize::is_valid_series(series) {
        println!("   ⚠️ Rejecting series '{}' - invalid/placeholder value", series);
        return false;
    }

    let series_lower = series.to_lowercase().trim().to_string();
    let title_lower = title.to_lowercase().trim().to_string();

    // Reject series that are too short (likely extraction errors)
    if series_lower.len() < 3 {
        println!("   ⚠️ Rejecting series '{}' - too short", series);
        return false;
    }

    // Reject series that are just numbers or have too many numbers
    let digit_count = series.chars().filter(|c| c.is_ascii_digit()).count();
    let total_chars = series.len();
    if digit_count > 0 && (digit_count as f32 / total_chars as f32) > 0.3 {
        println!("   ⚠️ Rejecting series '{}' - too many numbers", series);
        return false;
    }

    // Normalize "and" vs "&" for comparison
    let series_normalized = series_lower.replace(" & ", " and ").replace("&", " and ");
    let title_normalized = title_lower.replace(" & ", " and ").replace("&", " and ");

    // Also strip "The " prefix for comparison (e.g., "Tempest" vs "The Tempest")
    let series_no_the = series_normalized.strip_prefix("the ").unwrap_or(&series_normalized);
    let title_no_the = title_normalized.strip_prefix("the ").unwrap_or(&title_normalized);

    // Check if series matches the title
    let title_matches = series_normalized == title_normalized
       || series_no_the == title_no_the
       || series_normalized == title_no_the
       || series_no_the == title_normalized;

    // Reject if series matches the title, UNLESS we have a valid sequence number
    // (e.g., "Dungeon Crawler Carl #1" in series "Dungeon Crawler Carl" is valid)
    // Also skip the overlap checks below if we allow due to sequence
    let has_valid_sequence = sequence.is_some();

    if title_matches {
        if has_valid_sequence {
            // Has sequence - allow it and skip remaining title checks
            println!("   ✓ Allowing series '{}' matching title - has sequence #{}", series, sequence.unwrap());
            // Don't return yet - still need to check other validations like sub-series
        } else {
            // No sequence - reject (likely wrong series assignment)
            println!("   ⚠️ Rejecting series '{}' - matches title '{}' (no sequence)", series, title);
            return false;
        }
    }

    // Reject if series is most of the title (> 80% overlap) - but skip if we have sequence
    if !has_valid_sequence && title_normalized.starts_with(&series_normalized) {
        let overlap = series_normalized.len() as f32 / title_normalized.len() as f32;
        if overlap > 0.8 {
            println!("   ⚠️ Rejecting series '{}' - too similar to full title ({:.0}% overlap)", series, overlap * 100.0);
            return false;
        }
    }

    // Also check with "The" stripped - but skip if we have sequence
    if !has_valid_sequence && title_no_the.starts_with(series_no_the) && !series_no_the.is_empty() {
        let overlap = series_no_the.len() as f32 / title_no_the.len() as f32;
        if overlap > 0.8 {
            println!("   ⚠️ Rejecting series '{}' - too similar to title ({:.0}% overlap)", series, overlap * 100.0);
            return false;
        }
    }

    // Reject common false positives
    let false_positives = [
        "book", "audiobook", "audio", "unabridged", "novel", "story",
        "fiction", "non-fiction", "chapter", "part", "volume", "edition",
        "complete", "collection", "anthology", "omnibus", "box set"
    ];
    if false_positives.iter().any(|fp| series_lower == *fp) {
        println!("   ⚠️ Rejecting series '{}' - common false positive", series);
        return false;
    }

    // Reject generic/useless series names that don't add value
    let generic_series = [
        "timeless classic", "timeless classics", "classic literature",
        "great books", "must read", "bestseller", "bestsellers",
        "award winner", "award winners", "pulitzer prize",
        "new york times bestseller", "audible originals",
        "kindle unlimited", "prime reading"
    ];
    if generic_series.iter().any(|gs| series_lower == *gs) {
        println!("   ⚠️ Rejecting series '{}' - generic/marketing series", series);
        return false;
    }

    // Reject format-specific series that don't apply to audiobooks
    let format_series = [
        "manga shakespeare", "graphic novel", "comic adaptation",
        "illustrated edition", "pop-up book", "board book"
    ];
    if format_series.iter().any(|fs| series_lower == *fs) {
        println!("   ⚠️ Rejecting series '{}' - format-specific series (not audiobook)", series);
        return false;
    }

    // Reject single-word sub-series indicators that shouldn't stand alone
    // These are often extracted from combined series like "Discworld - Death"
    let subseries_indicators = [
        "death", "witches", "wizards", "watch", "rincewind", "tiffany aching",
        "moist von lipwig", "industrial revolution", "ancient civilizations",
        "gods", "legends", "tales", "adventures", "mysteries", "cases"
    ];
    if subseries_indicators.iter().any(|si| series_lower == *si) {
        println!("   ⚠️ Rejecting series '{}' - sub-series indicator (not standalone)", series);
        return false;
    }

    // Reject if series is just the word "the" + something short (but skip if has sequence)
    if !has_valid_sequence && series_lower.starts_with("the ") && series_lower.len() < 10 {
        println!("   ⚠️ Rejecting series '{}' - too short with 'the' prefix", series);
        return false;
    }

    // Reject if series looks like a full book title (contains subtitle markers AND is long)
    if (series_lower.contains(": ") || series_lower.contains(" - ")) && series_lower.len() > 40 {
        // But allow if it's clearly a series name with subtitle
        if !series_lower.contains("series") && !series_lower.contains("saga")
           && !series_lower.contains("chronicles") {
            println!("   ⚠️ Rejecting series '{}' - looks like full title with subtitle", series);
            return false;
        }
    }

    // Reject companion/fact tracker series if the title doesn't indicate it's a companion book
    // E.g., "Magic Tree House Fact Tracker" should not be added to "Vikings at Sunrise"
    let companion_indicators = ["fact tracker", "research guide", "companion to", "nonfiction companion"];
    let is_companion_series = companion_indicators.iter().any(|ci| series_lower.contains(ci));
    if is_companion_series {
        let title_has_companion = companion_indicators.iter().any(|ci| title_lower.contains(ci))
            || title_lower.contains("fact")
            || title_lower.contains("guide")
            || title_lower.contains("nonfiction");
        if !title_has_companion {
            println!("   ⚠️ Rejecting series '{}' - companion series but title '{}' is not a companion book", series, title);
            return false;
        }
    }

    true
}

/// Public wrapper for series validation - used by other modules (e.g., abs.rs)
pub fn is_valid_series_public(series: &str, title: &str) -> bool {
    is_valid_series(series, title)
}

/// Public wrapper with sequence - allows title-matching series if they have a sequence number
pub fn is_valid_series_with_seq(series: &str, title: &str, sequence: Option<&str>) -> bool {
    is_valid_series_with_sequence(series, title, sequence)
}

/// IMPROVED merge function that handles series intelligently
async fn merge_all_with_gpt_improved(
    folder_name: &str,
    extracted_title: &str,
    extracted_author: &str,
    file_tags: &FileTags,
    audible_data: Option<AudibleMetadata>,
    api_key: Option<&str>
) -> BookMetadata {
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            return fallback_metadata(extracted_title, extracted_author, audible_data, None);
        }
    };

    // Step 1: Collect series candidates from all sources
    let series_candidates = collect_series_candidates(
        folder_name,
        extracted_title,
        &audible_data
    );
    
    println!("   📚 Series candidates: {:?}", series_candidates.iter().map(|c| &c.name).collect::<Vec<_>>());
    
    // Step 2: Determine authoritative series (Audible first, then folder)
    let authoritative_series: Option<(String, Option<String>)> = series_candidates
        .iter()
        .filter(|c| c.source == "audible")
        .next()
        .map(|c| (c.name.clone(), c.position.clone()))
        .or_else(|| {
            series_candidates.iter()
                .filter(|c| c.source == "folder")
                .next()
                .map(|c| (c.name.clone(), c.position.clone()))
        });
    
    // Step 3: Build series instruction for GPT
    let series_instruction = if let Some((ref series_name, ref position)) = authoritative_series {
        format!(
            "SERIES INFO (from {}): This book is part of the '{}' series{}. \
             Use this series name. If you believe this is incorrect, return null for series instead.",
            if series_candidates.iter().any(|c| c.source == "audible") { "Audible" } else { "folder" },
            series_name,
            position.as_ref().map(|p| format!(", position {}", p)).unwrap_or_default()
        )
    } else if !series_candidates.is_empty() {
        let names: Vec<_> = series_candidates.iter().map(|c| c.name.as_str()).collect();
        format!(
            "POSSIBLE SERIES: {}. Verify if any of these are correct, or return null if this is a standalone book.",
            names.join(", ")
        )
    } else {
        "NO SERIES DETECTED from Audible/Google. Use your knowledge! If you KNOW this book is part of a well-known series (like 'Mr. Putter & Tabby', 'Harry Potter', 'Magic Tree House', etc.), provide the SHORT series name. Return null only if truly standalone.".to_string()
    };
    
    // Extract year from Audible
    let reliable_year = audible_data.as_ref()
        .and_then(|d| d.release_date.clone())
        .and_then(|date| date.split('-').next().map(|s| s.to_string()));

    // Build summary for GPT
    let audible_summary = if let Some(ref data) = audible_data {
        format!(
            "Title: {:?}, Authors: {:?}, Narrators: {:?}, Publisher: {:?}, Release Date: {:?}",
            data.title, data.authors, data.narrators, data.publisher, data.release_date
        )
    } else {
        "No data".to_string()
    };
    
    let year_instruction = if let Some(ref year) = reliable_year {
        format!("CRITICAL: Use EXACTLY this year: {} (from Audible - DO NOT CHANGE)", year)
    } else {
        "year: If not found in sources, return null".to_string()
    };

    // Build the SLIMMED DOWN prompt - optimized for speed while keeping genre normalization
    let prompt = format!(
r#"Audiobook metadata specialist. Combine sources for accurate metadata.

SOURCES: Folder: {} | Tags: title='{}', author='{}' | Audible: {} | Comment: {:?}
{}

GENRES (max 3): {}

AUTHOR RULE: Prefer '{}' unless "Unknown". Don't replace valid authors with different ones.

OUTPUT:
- title: Book title only, no junk
- subtitle: From Audible if any
- author: Use '{}'
- narrator: From Audible/comments
- series: SHORT umbrella name only (e.g. "Harry Potter" not "Harry Potter and the...")
- sequence: Book number
- genres: 1-3 from list. For kids: "Children's 0-2/3-5/6-8/9-12" or "Teen 13-17" (age-specific!)
- publisher, {}, description (200+ chars)

JSON only:
{{"title":"","subtitle":null,"author":"","narrator":null,"series":null,"sequence":null,"genres":[],"publisher":null,"year":null,"description":null}}"#,
        folder_name,
        extracted_title,
        extracted_author,
        audible_summary,
        file_tags.comment,
        series_instruction,
        crate::genres::APPROVED_GENRES.join(", "),
        extracted_author,
        extracted_author,
        year_instruction
    );
    
    match call_gpt_api(&prompt, api_key, "gpt-5-nano", 4000).await {
        Ok(json_str) => {
            // Detect truncated JSON responses
            let trimmed = json_str.trim();
            if !trimmed.ends_with('}') {
                println!("   ⚠️ GPT response appears truncated (doesn't end with '}}')");
                println!("   ⚠️ Response length: {} chars, last 50 chars: {:?}",
                    trimmed.len(),
                    &trimmed[trimmed.len().saturating_sub(50)..]);
                return normalize_metadata(fallback_metadata(extracted_title, extracted_author, audible_data, reliable_year));
            }

            match serde_json::from_str::<BookMetadata>(&json_str) {
                Ok(mut metadata) => {
                    // Initialize sources tracking
                    let mut sources = MetadataSources::default();

                    // GPT cleaned/enhanced the basic fields
                    sources.title = Some(MetadataSource::Gpt);
                    sources.author = Some(MetadataSource::Gpt);
                    if metadata.subtitle.is_some() {
                        sources.subtitle = Some(MetadataSource::Gpt);
                    }
                    if metadata.narrator.is_some() {
                        sources.narrator = Some(MetadataSource::Gpt);
                    }
                    if !metadata.genres.is_empty() {
                        // Split any combined genres first
                        metadata.genres = crate::genres::split_combined_genres(&metadata.genres);
                        // Enforce age-specific children's genres
                        crate::genres::enforce_children_age_genres(
                            &mut metadata.genres,
                            &metadata.title,
                            metadata.series.as_deref(),
                            Some(&metadata.author),
                        );
                        sources.genres = Some(MetadataSource::Gpt);
                    }
                    if metadata.publisher.is_some() {
                        sources.publisher = if audible_data.is_some() { Some(MetadataSource::Audible) } else { Some(MetadataSource::Gpt) };
                    }
                    if metadata.description.is_some() {
                        sources.description = Some(MetadataSource::Gpt);
                    }

                    // Override with reliable year from Audible
                    if let Some(year) = reliable_year.clone() {
                        metadata.year = Some(year);
                        sources.year = Some(MetadataSource::Audible);
                    }

                    // VALIDATE author - reject if GPT returned a completely different author
                    if !crate::normalize::author_is_acceptable(extracted_author, &metadata.author) {
                        println!("   ⚠️ Rejecting GPT author '{}' (expected '{}' - keeping original)",
                            metadata.author, extracted_author);
                        metadata.author = extracted_author.to_string();
                        sources.author = Some(MetadataSource::Folder);
                    }

                    // VALIDATE series - reject if it matches title or looks wrong
                    if let Some(ref series) = metadata.series {
                        if !is_valid_series(series, &metadata.title) {
                            println!("   ⚠️ Rejecting GPT series '{}' (failed validation)", series);
                            metadata.series = None;
                            metadata.sequence = None;
                        } else {
                            metadata.series = Some(normalize_series_name(series));
                            sources.series = Some(MetadataSource::Gpt);
                            if metadata.sequence.is_some() {
                                sources.sequence = Some(MetadataSource::Gpt);
                            }
                        }
                    }

                    // ALWAYS prefer Audible's series and sequence if available
                    if let Some((ref series_name, ref position)) = authoritative_series {
                        if is_valid_series(series_name, &metadata.title) {
                            // Use Audible series name (might be more accurate)
                            metadata.series = Some(normalize_series_name(series_name));
                            sources.series = Some(MetadataSource::Audible);
                            // ALWAYS use Audible's sequence if provided - it's authoritative!
                            if let Some(ref pos) = position {
                                println!("   ✅ Using Audible sequence: {} #{}", series_name, pos);
                                metadata.sequence = Some(pos.clone());
                                sources.sequence = Some(MetadataSource::Audible);
                            }
                        }
                    }

                    // Set ASIN from Audible
                    metadata.asin = audible_data.as_ref().and_then(|d| d.asin.clone());
                    if metadata.asin.is_some() {
                        sources.asin = Some(MetadataSource::Audible);
                    }

                    // SET NEW FIELDS from Audible data (authoritative source)
                    if let Some(ref aud) = audible_data {
                        // Multiple authors (prefer Audible, fallback to splitting extracted)
                        if !aud.authors.is_empty() {
                            metadata.authors = aud.authors.clone();
                            sources.author = Some(MetadataSource::Audible);
                        } else {
                            metadata.authors = split_authors(extracted_author);
                        }

                        // Multiple narrators (Audible is authoritative) - clean prefixes
                        if !aud.narrators.is_empty() {
                            metadata.narrators = aud.narrators.iter()
                                .map(|n| normalize::clean_narrator_name(n))
                                .collect();
                            sources.narrator = Some(MetadataSource::Audible);
                            // Also set legacy narrator field
                            if metadata.narrator.is_none() {
                                metadata.narrator = metadata.narrators.first().cloned();
                            }
                        }

                        // Language
                        metadata.language = aud.language.clone();
                        if metadata.language.is_some() {
                            sources.language = Some(MetadataSource::Audible);
                        }

                        // Runtime
                        metadata.runtime_minutes = aud.runtime_minutes;
                        if metadata.runtime_minutes.is_some() {
                            sources.runtime = Some(MetadataSource::Audible);
                        }

                        // Abridged status
                        metadata.abridged = aud.abridged;

                        // Full publish date
                        metadata.publish_date = aud.release_date.clone();

                        // Prefer Audible description if GPT didn't provide one
                        if metadata.description.is_none() || metadata.description.as_ref().map(|d| d.len() < 100).unwrap_or(true) {
                            if let Some(ref desc) = aud.description {
                                if desc.len() >= 50 {
                                    metadata.description = Some(desc.clone());
                                    sources.description = Some(MetadataSource::Audible);
                                }
                            }
                        }
                    } else {
                        // No Audible data - use defaults
                        metadata.authors = split_authors(extracted_author);
                    }

                    // Set sources
                    metadata.sources = Some(sources);

                    // Apply normalization before returning
                    normalize_metadata(metadata)
                }
                Err(e) => {
                    // Check if this looks like a truncation error
                    let error_msg = e.to_string();
                    if error_msg.contains("EOF") || error_msg.contains("unexpected end") {
                        println!("   ❌ GPT response truncated: {}", e);
                        println!("   ⚠️ Response length: {} chars", json_str.len());
                    } else {
                        println!("   ❌ GPT parse error: {}", e);
                    }
                    normalize_metadata(fallback_metadata(extracted_title, extracted_author, audible_data, reliable_year))
                }
            }
        }
        Err(e) => {
            println!("   ❌ GPT API error: {}", e);
            normalize_metadata(fallback_metadata(extracted_title, extracted_author, audible_data, reliable_year))
        }
    }
}

// ============================================================================
// SUPPORTING FUNCTIONS (mostly unchanged)
// ============================================================================

// AudibleMetadata and AudibleSeries are now imported from crate::audible

fn fallback_metadata(
    extracted_title: &str,
    extracted_author: &str,
    audible_data: Option<AudibleMetadata>,
    reliable_year: Option<String>
) -> BookMetadata {
    // Track sources for each field
    let mut sources = MetadataSources::default();

    // Get series from Audible but validate it
    let (series, sequence) = audible_data.as_ref()
        .and_then(|d| d.series.first())
        .map(|s| {
            if is_valid_series(&s.name, extracted_title) {
                sources.series = Some(MetadataSource::Audible);
                sources.sequence = Some(MetadataSource::Audible);
                (Some(normalize_series_name(&s.name)), s.position.clone())
            } else {
                (None, None)
            }
        })
        .unwrap_or((None, None));

    // Get all narrators, use first for legacy narrator field
    let narrators = audible_data.as_ref()
        .map(|d| {
            if !d.narrators.is_empty() {
                sources.narrator = Some(MetadataSource::Audible);
            }
            d.narrators.clone()
        })
        .unwrap_or_default();
    let narrator = narrators.first().cloned();

    // Get all authors: Audible -> Google Books -> folder name
    let authors = audible_data.as_ref()
        .filter(|d| !d.authors.is_empty())
        .map(|d| {
            sources.author = Some(MetadataSource::Audible);
            d.authors.clone()
        })
        .unwrap_or_else(|| {
            // Only use folder name if it doesn't look like "Unknown"
            if extracted_author.to_lowercase() != "unknown" && !extracted_author.is_empty() {
                sources.author = Some(MetadataSource::Folder);
                split_authors(extracted_author)
            } else {
                vec![]
            }
        });

    // Track title source
    sources.title = Some(MetadataSource::Folder);

    // No subtitle without external API
    let subtitle: Option<String> = None;

    // Use genres from ABS search if available
    let genres = audible_data.as_ref()
        .filter(|d| !d.genres.is_empty())
        .map(|d| {
            sources.genres = Some(MetadataSource::Audible);
            let split = crate::genres::split_combined_genres(&d.genres);
            let mapped: Vec<String> = split.iter()
                .filter_map(|g| crate::genres::map_genre_basic(g))
                .collect();
            crate::genres::enforce_genre_policy_basic(&mapped)
        })
        .unwrap_or_default();

    let publisher = audible_data.as_ref().and_then(|d| d.publisher.clone()).map(|p| {
        sources.publisher = Some(MetadataSource::Audible);
        p
    });

    let description = audible_data.as_ref().and_then(|d| d.description.clone()).map(|d| {
        sources.description = Some(MetadataSource::Audible);
        d
    });

    let asin = audible_data.as_ref().and_then(|d| {
        if d.asin.is_some() {
            sources.asin = Some(MetadataSource::Audible);
        }
        d.asin.clone()
    });

    // Track year source
    if reliable_year.is_some() {
        sources.year = Some(MetadataSource::Audible);
    }

    // Track language/runtime sources
    if audible_data.as_ref().and_then(|d| d.language.clone()).is_some() {
        sources.language = Some(MetadataSource::Audible);
    }
    if audible_data.as_ref().and_then(|d| d.runtime_minutes).is_some() {
        sources.runtime = Some(MetadataSource::Audible);
    }

    // Derive author from authors array (or use extracted_author as fallback)
    let author = authors.first().cloned().unwrap_or_else(|| {
        if extracted_author.to_lowercase() != "unknown" {
            extracted_author.to_string()
        } else {
            "Unknown".to_string()
        }
    });

    // Note: normalize_metadata is called by the callers of fallback_metadata
    // Build all_series from series/sequence if present
    let all_series = if let Some(ref s) = series {
        vec![SeriesInfo::new(s.clone(), sequence.clone(), sources.series)]
    } else {
        vec![]
    };

    BookMetadata {
        title: extracted_title.to_string(),
        subtitle,
        author,
        narrator,
        series,
        sequence,
        all_series,
        genres,
        publisher,
        year: reliable_year.clone(),
        description,
        isbn: None,
        asin,
        cover_mime: None,
        cover_url: None,
        // NEW FIELDS
        authors,
        narrators,
        language: audible_data.as_ref().and_then(|d| d.language.clone()),
        abridged: audible_data.as_ref().and_then(|d| d.abridged),
        runtime_minutes: audible_data.as_ref().and_then(|d| d.runtime_minutes),
        explicit: None,
        publish_date: audible_data.as_ref().and_then(|d| d.release_date.clone()),
        sources: Some(sources),
        // Collection fields - detection happens in normalize_metadata
        is_collection: false,
        collection_books: vec![],
        confidence: None,
        // Themes/tropes - extracted later
        themes: vec![],
        tropes: vec![],
        themes_source: None,
        tropes_source: None,
    }
}

/// PERFORMANCE: Create metadata directly from Audible without GPT
/// Used when Audible data is complete enough to skip GPT entirely
fn create_metadata_from_audible(
    extracted_title: &str,
    extracted_author: &str,
    audible_data: AudibleMetadata,
) -> BookMetadata {
    let mut sources = MetadataSources::default();

    // Title from Audible FIRST, then extracted (cleaned of chapter prefixes)
    let title = audible_data.title.clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| clean_chapter_prefix(extracted_title));
    sources.title = if audible_data.title.is_some() {
        Some(MetadataSource::Audible)
    } else {
        Some(MetadataSource::Folder)
    };

    // Subtitle from Audible (was previously always None!)
    let subtitle = audible_data.subtitle.clone();
    if subtitle.is_some() {
        sources.subtitle = Some(MetadataSource::Audible);
    }

    // Author from Audible -> folder
    let authors = if !audible_data.authors.is_empty() {
        sources.author = Some(MetadataSource::Audible);
        audible_data.authors.clone()
    } else if extracted_author.to_lowercase() != "unknown" {
        sources.author = Some(MetadataSource::Folder);
        split_authors(extracted_author)
    } else {
        vec![]
    };
    let author = authors.first().cloned().unwrap_or_else(|| "Unknown".to_string());

    // Narrators from Audible
    let narrators = audible_data.narrators.clone();
    let narrator = narrators.first().cloned();
    if !narrators.is_empty() {
        sources.narrator = Some(MetadataSource::Audible);
    }

    // Series from Audible - now with multi-series support
    let mut all_series: Vec<SeriesInfo> = Vec::new();

    // Process ALL series from Audible, not just the first
    for audible_series in &audible_data.series {
        if is_valid_series(&audible_series.name, &title) {
            // Extract potentially multiple series from compound names
            let extracted = extract_all_series_from_name(
                &audible_series.name,
                audible_series.position.as_deref()
            );

            for (series_name, position) in extracted {
                // Avoid duplicates
                if !all_series.iter().any(|s| s.name.to_lowercase() == series_name.to_lowercase()) {
                    all_series.push(SeriesInfo::new(
                        series_name,
                        position,
                        Some(MetadataSource::Audible),
                    ));
                }
            }
        }
    }

    // Primary series and sequence (for backwards compatibility)
    // Use the most specific series (last one, which is usually the sub-series)
    let (series, sequence) = if let Some(primary) = all_series.last() {
        sources.series = Some(MetadataSource::Audible);
        sources.sequence = Some(MetadataSource::Audible);
        (Some(primary.name.clone()), primary.sequence.clone())
    } else {
        (None, None)
    };

    // Year from Audible release date
    let year = audible_data.release_date.as_ref()
        .and_then(|date| date.split('-').next().map(|s| s.to_string()));
    if year.is_some() {
        sources.year = Some(MetadataSource::Audible);
    }

    // Description from Audible
    let description = audible_data.description.clone();
    if description.is_some() {
        sources.description = Some(MetadataSource::Audible);
    }

    // Publisher from Audible
    let publisher = audible_data.publisher.clone();
    if publisher.is_some() {
        sources.publisher = Some(MetadataSource::Audible);
    }

    // Use genres from ABS search if available
    let genres = if !audible_data.genres.is_empty() {
        sources.genres = Some(MetadataSource::Audible);
        // Process genres through our genre system
        let split = crate::genres::split_combined_genres(&audible_data.genres);
        let mapped: Vec<String> = split.iter()
            .filter_map(|g| crate::genres::map_genre_basic(g))
            .collect();
        crate::genres::enforce_genre_policy_basic(&mapped)
    } else {
        vec![]
    };

    // ASIN from Audible
    let asin = audible_data.asin.clone();
    if asin.is_some() {
        sources.asin = Some(MetadataSource::Audible);
    }

    // Language and runtime from Audible
    if audible_data.language.is_some() {
        sources.language = Some(MetadataSource::Audible);
    }
    if audible_data.runtime_minutes.is_some() {
        sources.runtime = Some(MetadataSource::Audible);
    }

    normalize_metadata(BookMetadata {
        title,
        subtitle,  // Now using Audible's subtitle!
        author,
        narrator,
        series,
        sequence,
        all_series,  // NEW: All series this book belongs to
        genres,
        publisher,
        year,
        description,
        isbn: None,
        asin,
        cover_mime: None,
        cover_url: None,
        authors,
        narrators,
        language: audible_data.language,
        abridged: audible_data.abridged,
        runtime_minutes: audible_data.runtime_minutes,
        explicit: None,
        publish_date: audible_data.release_date,
        sources: Some(sources),
        // Collection fields - detection happens in normalize_metadata
        is_collection: false,
        collection_books: vec![],
        confidence: None,
        // Themes/tropes - extracted later
        themes: vec![],
        tropes: vec![],
        themes_source: None,
        tropes_source: None,
    })
}

/// Clean chapter/part prefixes from folder names
/// Examples: "1_ Part I" -> "Part I", "01 - Chapter One" -> "Chapter One"
fn clean_chapter_prefix(title: &str) -> String {
    use regex::Regex;

    let mut result = title.to_string();

    // Pattern 1: "1_" or "01_" at start (common audiobook chapter naming)
    if let Ok(re) = Regex::new(r"^\d+[_\-]\s*") {
        result = re.replace(&result, "").to_string();
    }

    // Pattern 2: "01 - " at start
    if let Ok(re) = Regex::new(r"^\d+\s*[-–]\s*") {
        result = re.replace(&result, "").to_string();
    }

    // Pattern 3: "Part I", "Part 1", "Part One" at start (if that's ALL there is, keep it)
    // But if there's more after, strip it
    if let Ok(re) = Regex::new(r"^(Part\s+[IVX\d]+|Part\s+\w+)\s*[-–:]\s*") {
        result = re.replace(&result, "").to_string();
    }

    // Pattern 4: "Chapter X" at start followed by separator
    if let Ok(re) = Regex::new(r"^Chapter\s+\d+\s*[-–:]\s*") {
        result = re.replace(&result, "").to_string();
    }

    // Pattern 5: "Disc X" or "Disk X" at start
    if let Ok(re) = Regex::new(r"^Dis[ck]\s+\d+\s*[-–:]\s*") {
        result = re.replace(&result, "").to_string();
    }

    // If result is empty or just whitespace, return original
    let trimmed = result.trim();
    if trimmed.is_empty() {
        title.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Split author string into multiple authors
fn split_authors(author: &str) -> Vec<String> {
    // Common separators for multiple authors
    let separators = [" & ", " and ", ", ", "; "];

    for sep in &separators {
        if author.contains(sep) {
            return author.split(sep)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    vec![author.to_string()]
}

/// Normalize all fields in a BookMetadata struct
/// Applies title case, removes junk suffixes, cleans author/narrator names, etc.
fn normalize_metadata(mut metadata: BookMetadata) -> BookMetadata {
    // Normalize title
    metadata.title = normalize::normalize_title(&metadata.title);

    // Extract subtitle if not already set
    if metadata.subtitle.is_none() {
        let (clean_title, subtitle) = normalize::extract_subtitle(&metadata.title);
        if subtitle.is_some() {
            metadata.title = clean_title;
            metadata.subtitle = subtitle;
        }
    } else {
        // Also normalize the subtitle
        metadata.subtitle = metadata.subtitle.map(|s| normalize::to_title_case(&s));
    }

    // Clean author name
    if normalize::is_valid_author(&metadata.author) {
        metadata.author = normalize::clean_author_name(&metadata.author);
    }

    // Clean all authors in the array
    metadata.authors = metadata.authors
        .into_iter()
        .filter(|a| normalize::is_valid_author(a))
        .map(|a| normalize::clean_author_name(&a))
        .collect();

    // If authors array is empty, populate from author field
    if metadata.authors.is_empty() && normalize::is_valid_author(&metadata.author) {
        metadata.authors = split_authors(&metadata.author)
            .into_iter()
            .map(|a| normalize::clean_author_name(&a))
            .collect();
    }

    // SYNC: Always ensure author matches authors[0] for consistency
    if !metadata.authors.is_empty() {
        metadata.author = metadata.authors[0].clone();
    } else if normalize::is_valid_author(&metadata.author) {
        metadata.authors = vec![metadata.author.clone()];
    }

    // Clean narrator name
    if let Some(ref narrator) = metadata.narrator {
        if normalize::is_valid_narrator(narrator) {
            metadata.narrator = Some(normalize::clean_narrator_name(narrator));
        } else {
            metadata.narrator = None;
        }
    }

    // Clean all narrators in the array
    metadata.narrators = metadata.narrators
        .into_iter()
        .filter(|n| normalize::is_valid_narrator(n))
        .map(|n| normalize::clean_narrator_name(&n))
        .collect();

    // If narrators array is empty, populate from narrator field
    if metadata.narrators.is_empty() {
        if let Some(ref narrator) = metadata.narrator {
            if normalize::is_valid_narrator(narrator) {
                metadata.narrators = vec![narrator.clone()];
            }
        }
    }

    // SYNC: Always ensure narrator matches narrators[0] for consistency
    if !metadata.narrators.is_empty() {
        metadata.narrator = Some(metadata.narrators[0].clone());
    } else if metadata.narrator.as_ref().map(|n| normalize::is_valid_narrator(n)).unwrap_or(false) {
        metadata.narrators = vec![metadata.narrator.clone().unwrap()];
    }

    // Validate and normalize year
    if let Some(ref year) = metadata.year {
        metadata.year = normalize::validate_year(year);
    }

    // Normalize description
    if let Some(ref desc) = metadata.description {
        metadata.description = Some(normalize::normalize_description(desc, Some(2000)));
    }

    // Normalize series name (already done by normalize_series_name, but double-check)
    if let Some(ref series) = metadata.series {
        let normalized = normalize_series_name(series);
        // Apply title case
        metadata.series = Some(normalize::to_title_case(&normalized));
    }

    // Normalize publisher
    if let Some(ref publisher) = metadata.publisher {
        let clean = publisher.trim();
        if !clean.is_empty() && clean.to_lowercase() != "unknown" {
            metadata.publisher = Some(normalize::to_title_case(clean));
        } else {
            metadata.publisher = None;
        }
    }

    // COLLECTION DETECTION
    // Only run if not already marked as collection
    if !metadata.is_collection {
        let (is_collection, mut collection_books) = detect_collection(
            &metadata.title,
            &metadata.title, // Use title as folder fallback
            metadata.runtime_minutes
        );

        if is_collection {
            metadata.is_collection = true;
            println!("   📚 Detected collection: '{}'", metadata.title);

            // Try to extract book titles from description
            if collection_books.is_empty() {
                if let Some(ref desc) = metadata.description {
                    collection_books = extract_collection_books_from_description(
                        desc,
                        metadata.series.as_deref()
                    );
                }
            }

            if !collection_books.is_empty() {
                println!("   📖 Found {} books in collection: {:?}", collection_books.len(), collection_books);
                metadata.collection_books = collection_books;
            }
        }
    }

    metadata
}

pub async fn enrich_with_gpt(
    folder_name: &str,
    extracted_title: &str,
    extracted_author: &str,
    file_tags: &FileTags,
    api_key: Option<&str>,
    file_path: Option<&str>,
) -> BookMetadata {
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            // No GPT available - use folder info only
            let (series, sequence) = extract_series_from_folder(folder_name);
            let mut sources = MetadataSources::default();
            sources.title = Some(MetadataSource::Folder);
            sources.author = Some(MetadataSource::Folder);
            if series.is_some() {
                sources.series = Some(MetadataSource::Folder);
            }
            if sequence.is_some() {
                sources.sequence = Some(MetadataSource::Folder);
            }

            let normalized_series = series.map(|s| normalize_series_name(&s));
            let all_series = if let Some(ref s) = normalized_series {
                vec![SeriesInfo::new(s.clone(), sequence.clone(), Some(MetadataSource::Folder))]
            } else {
                vec![]
            };

            return BookMetadata {
                title: extracted_title.to_string(),
                author: extracted_author.to_string(),
                subtitle: None,
                narrator: None,
                series: normalized_series,
                sequence,
                all_series,
                genres: vec![],
                publisher: None,
                year: None,
                description: None,
                isbn: None,
                asin: None,
                cover_mime: None,
                cover_url: None,
                // NEW FIELDS
                authors: split_authors(extracted_author),
                narrators: vec![],
                language: None,
                abridged: None,
                runtime_minutes: None,
                explicit: None,
                publish_date: None,
                sources: Some(sources),
                // Collection fields
                is_collection: false,
                collection_books: vec![],
                confidence: None,
                // Themes/tropes - empty for fallback case
                themes: vec![],
                tropes: vec![],
                themes_source: None,
                tropes_source: None,
            };
        }
    };

    // IMPROVED prompt - encourage GPT to use knowledge for well-known series
    // ENHANCED: Now asks for ISBN, subtitle, and more metadata when Audible fails
    // Also includes file path to help extract correct title from directory structure
    let path_context = file_path
        .map(|p| format!("\nFILE PATH: {}\n(Use path to extract real book title if folder name looks like a chapter marker like '1_ Part I')", p))
        .unwrap_or_default();

    let prompt = format!(
r#"You are enriching audiobook metadata using your knowledge. This book was NOT found on Audible, so please provide as much metadata as you know.

FOLDER NAME: {}
TITLE: {}
AUTHOR: {}
COMMENT TAG: {:?}{}

IMPORTANT: If the folder name looks like a chapter/part marker (e.g., "1_ Part I", "Chapter 1", "Disc 1"),
look at the FILE PATH to extract the real book title from parent directories.
Example: Path ".../Stephen King/Black House/1_ Part I/file.mp3" → real title is "Black House", author is "Stephen King"

Based on your knowledge, provide COMPLETE metadata for this audiobook:

1. Corrected Title: If the extracted title looks wrong (like a chapter marker), provide the correct title from the path
2. Narrator: Check comment field or use your knowledge of common audiobook narrators
3. Series: If this book is part of a known series, provide the series name. Examples:
   - "Mr. Putter and Tabby Pour the Tea" → series: "Mr. Putter & Tabby"
   - "Harry Potter and the Sorcerer's Stone" → series: "Harry Potter"
   - "The Name of the Wind" → series: "The Kingkiller Chronicle"
   - "1984" → series: null (standalone book)
   The series name should be SHORT (just the series name, not the full book title).

4. Sequence: Find the book's position in the series publication order using your knowledge.

5. Genres: Provide 1-3 appropriate genres from this list: {}
   For children's books, use age-specific genres:
   - "Children's 0-2", "Children's 3-5", "Children's 6-8", "Children's 9-12", "Teen 13-17"

6. Publisher: The book's publisher (not audiobook publisher)
7. Year: Publication year AS A STRING (YYYY format)
8. Description: A brief 2-3 sentence description
9. Subtitle: If the book has a subtitle, provide it
10. ISBN: If you know the ISBN-13, provide it (format: 978-X-XXXX-XXXX-X)

Return ONLY valid JSON:
{{
  "corrected_title": "correct title or null if current is correct",
  "corrected_author": "correct author or null if current is correct",
  "narrator": "narrator or null",
  "series": "SHORT series name or null",
  "sequence": "correct position number or null",
  "genres": ["Genre1", "Genre2"],
  "publisher": "publisher or null",
  "year": "YYYY or null",
  "description": "description or null",
  "subtitle": "subtitle or null",
  "isbn": "ISBN-13 or null"
}}

JSON:"#,
        folder_name,
        extracted_title,
        extracted_author,
        file_tags.comment,
        path_context,
        crate::genres::APPROVED_GENRES.join(", ")
    );

    match call_gpt_api(&prompt, api_key, "gpt-5-nano", 4000).await {
        Ok(json_str) => {
            match serde_json::from_str::<serde_json::Value>(&json_str) {
                Ok(json) => {
                    let get_string = |v: &serde_json::Value| -> Option<String> {
                        match v {
                            serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
                            serde_json::Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        }
                    };
                    
                    let get_string_array = |v: &serde_json::Value| -> Vec<String> {
                        match v {
                            serde_json::Value::Array(arr) => {
                                arr.iter()
                                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                                    .collect()
                            }
                            _ => vec![],
                        }
                    };
                    
                    // Check for corrected title/author from GPT
                    let corrected_title = json.get("corrected_title").and_then(get_string);
                    let corrected_author = json.get("corrected_author").and_then(get_string);

                    // Use corrected values if provided, otherwise use extracted values
                    let final_title = corrected_title.clone()
                        .filter(|t| !t.is_empty() && t.to_lowercase() != "null")
                        .unwrap_or_else(|| extracted_title.to_string());
                    let final_author = corrected_author.clone()
                        .filter(|a| !a.is_empty() && a.to_lowercase() != "null")
                        .unwrap_or_else(|| extracted_author.to_string());

                    if corrected_title.is_some() {
                        println!("   🔄 GPT corrected title: '{}' → '{}'", extracted_title, final_title);
                    }
                    if corrected_author.is_some() {
                        println!("   🔄 GPT corrected author: '{}' → '{}'", extracted_author, final_author);
                    }

                    // Get and VALIDATE series (validate against corrected title)
                    let raw_series = json.get("series").and_then(get_string);
                    let sequence = json.get("sequence").and_then(get_string);

                    let (series, sequence) = if let Some(ref s) = raw_series {
                        if is_valid_series(s, &final_title) {
                            (Some(normalize_series_name(s)), sequence)
                        } else {
                            println!("   ⚠️ Rejecting GPT series '{}' (failed validation)", s);
                            (None, None)
                        }
                    } else {
                        (None, None)
                    };

                    // Get genres
                    // Split any combined genres from GPT response
                    let genres = crate::genres::split_combined_genres(
                        &json.get("genres").map(get_string_array).unwrap_or_default()
                    );

                    let narrator = json.get("narrator").and_then(get_string);
                    let publisher = json.get("publisher").and_then(get_string);
                    let year = json.get("year").and_then(get_string);
                    let description = json.get("description").and_then(get_string);
                    // NEW: Extract subtitle and ISBN from GPT response
                    let subtitle = json.get("subtitle").and_then(get_string);
                    let isbn = json.get("isbn").and_then(get_string);

                    // Build sources tracking
                    let mut sources = MetadataSources::default();
                    sources.title = if corrected_title.is_some() { Some(MetadataSource::Gpt) } else { Some(MetadataSource::Folder) };
                    sources.author = if corrected_author.is_some() { Some(MetadataSource::Gpt) } else { Some(MetadataSource::Folder) };
                    if narrator.is_some() {
                        sources.narrator = Some(MetadataSource::Gpt);
                    }
                    if series.is_some() {
                        sources.series = Some(MetadataSource::Gpt);
                    }
                    if sequence.is_some() {
                        sources.sequence = Some(MetadataSource::Gpt);
                    }
                    if !genres.is_empty() {
                        sources.genres = Some(MetadataSource::Gpt);
                    }
                    if publisher.is_some() {
                        sources.publisher = Some(MetadataSource::Gpt);
                    }
                    if year.is_some() {
                        sources.year = Some(MetadataSource::Gpt);
                    }
                    if description.is_some() {
                        sources.description = Some(MetadataSource::Gpt);
                    }
                    if subtitle.is_some() {
                        sources.subtitle = Some(MetadataSource::Gpt);
                    }

                    let all_series = if let Some(ref s) = series {
                        vec![SeriesInfo::new(s.clone(), sequence.clone(), Some(MetadataSource::Gpt))]
                    } else {
                        vec![]
                    };

                    // Build base metadata
                    let mut metadata = normalize_metadata(BookMetadata {
                        title: final_title.clone(),
                        author: final_author.clone(),
                        subtitle,  // Now from GPT!
                        narrator: narrator.clone(),
                        series,
                        sequence,
                        all_series,
                        genres,
                        publisher,
                        year,
                        description,
                        isbn,  // Now from GPT!
                        asin: None,
                        cover_mime: None,
                        cover_url: None,
                        // NEW FIELDS
                        authors: split_authors(&final_author),
                        narrators: narrator.map(|n| vec![n]).unwrap_or_default(),
                        language: None,
                        abridged: None,
                        runtime_minutes: None,
                        explicit: None,
                        publish_date: None,
                        sources: Some(sources),
                        // Collection fields
                        is_collection: false,
                        collection_books: vec![],
                        confidence: None,
                        // Themes/tropes will be extracted separately
                        themes: vec![],
                        tropes: vec![],
                        themes_source: None,
                        tropes_source: None,
                    });

                    // Extract themes/tropes if we have a description
                    if let Some(ref desc) = metadata.description {
                        if desc.len() >= 50 {
                            if let Some(themes_tropes) = extract_themes_and_tropes(
                                &metadata.title,
                                &metadata.author,
                                &metadata.genres,
                                Some(desc),
                                api_key,
                            ).await {
                                metadata.themes = themes_tropes.themes;
                                metadata.tropes = themes_tropes.tropes;
                                metadata.themes_source = Some("gpt".to_string());
                                metadata.tropes_source = Some("gpt".to_string());
                            }
                        }
                    }

                    metadata
                }
                Err(e) => {
                    println!("   ❌ GPT parse error: {}", e);
                    let (series, sequence) = extract_series_from_folder(folder_name);
                    let mut sources = MetadataSources::default();
                    sources.title = Some(MetadataSource::Folder);
                    sources.author = Some(MetadataSource::Folder);
                    if series.is_some() {
                        sources.series = Some(MetadataSource::Folder);
                    }
                    if sequence.is_some() {
                        sources.sequence = Some(MetadataSource::Folder);
                    }
                    let normalized_series = series.map(|s| normalize_series_name(&s));
                    let all_series = if let Some(ref s) = normalized_series {
                        vec![SeriesInfo::new(s.clone(), sequence.clone(), Some(MetadataSource::Folder))]
                    } else {
                        vec![]
                    };
                    normalize_metadata(BookMetadata {
                        title: extracted_title.to_string(),
                        author: extracted_author.to_string(),
                        subtitle: None,
                        narrator: None,
                        series: normalized_series,
                        sequence,
                        all_series,
                        genres: vec![],
                        publisher: None,
                        year: None,
                        description: None,
                        isbn: None,
                        asin: None,
                        cover_mime: None,
                        cover_url: None,
                        // NEW FIELDS
                        authors: split_authors(extracted_author),
                        narrators: vec![],
                        language: None,
                        abridged: None,
                        runtime_minutes: None,
                        explicit: None,
                        publish_date: None,
                        sources: Some(sources),
                        // Collection fields
                        is_collection: false,
                        collection_books: vec![],
                        confidence: None,
                        // Themes/tropes - empty for fallback case
                        themes: vec![],
                        tropes: vec![],
                        themes_source: None,
                        tropes_source: None,
                    })
                }
            }
        }
        Err(_) => {
            let (series, sequence) = extract_series_from_folder(folder_name);
            let mut sources = MetadataSources::default();
            sources.title = Some(MetadataSource::Folder);
            sources.author = Some(MetadataSource::Folder);
            if series.is_some() {
                sources.series = Some(MetadataSource::Folder);
            }
            if sequence.is_some() {
                sources.sequence = Some(MetadataSource::Folder);
            }
            let normalized_series = series.map(|s| normalize_series_name(&s));
            let all_series = if let Some(ref s) = normalized_series {
                vec![SeriesInfo::new(s.clone(), sequence.clone(), Some(MetadataSource::Folder))]
            } else {
                vec![]
            };
            normalize_metadata(BookMetadata {
                title: extracted_title.to_string(),
                author: extracted_author.to_string(),
                subtitle: None,
                narrator: None,
                series: normalized_series,
                sequence,
                all_series,
                genres: vec![],
                publisher: None,
                year: None,
                description: None,
                isbn: None,
                asin: None,
                cover_mime: None,
                cover_url: None,
                // NEW FIELDS
                authors: split_authors(extracted_author),
                narrators: vec![],
                language: None,
                abridged: None,
                runtime_minutes: None,
                explicit: None,
                publish_date: None,
                sources: Some(sources),
                // Collection fields
                is_collection: false,
                collection_books: vec![],
                confidence: None,
                // Themes/tropes - empty for fallback case
                themes: vec![],
                tropes: vec![],
                themes_source: None,
                tropes_source: None,
            })
        }
    }
}

/// Transcribe first audio file to extract book info from narrator's spoken intro
/// Returns TranscriptionResult if successful, None otherwise
async fn transcribe_for_search(
    group: &BookGroup,
    config: &Config,
) -> Option<crate::whisper::TranscriptionResult> {
    // Get first audio file
    let first_file = group.files.first()?;
    let audio_path = &first_file.path;

    // Check cache first
    let cache_key = format!("transcription_{}", group.id);
    if let Some(cached) = cache::get::<crate::whisper::TranscriptionResult>(&cache_key) {
        println!("   ⚡ Transcription cache hit for '{}'", group.group_name);
        return Some(cached);
    }

    // Check FFmpeg is available
    if !crate::whisper::check_ffmpeg_available() {
        println!("   ⚠️ FFmpeg not available, skipping transcription");
        return None;
    }

    // Get OpenAI API key
    let api_key = config.openai_api_key.as_ref()?;

    println!("   🎤 Transcribing first 90s of '{}'...", group.group_name);

    match crate::whisper::transcribe_audio_intro(audio_path, 90, api_key).await {
        Ok(result) => {
            // Cache the result
            let _ = cache::set(&cache_key, &result);
            Some(result)
        }
        Err(e) => {
            println!("   ⚠️ Transcription failed: {}", e);
            None
        }
    }
}

/// Pre-search title/author cleaning using GPT
/// This is a fast, cheap call to clean messy folder names BEFORE searching ABS
/// Example: "Stephen King - The Shining [Retail] (320kbps)" -> ("The Shining", "Stephen King")
/// Example: "01 - Harry Potter and the Sorcerer's Stone" -> ("Harry Potter and the Sorcerer's Stone", "")
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CleanedSearchQuery {
    pub title: String,
    pub author: Option<String>,
    #[serde(default)]
    pub series_hint: Option<String>,
}

/// Clean a messy folder/file name into a proper search query using GPT
/// Returns (clean_title, clean_author) for ABS search
pub async fn clean_title_for_search(
    raw_title: &str,
    raw_author: &str,
    folder_name: &str,
    api_key: Option<&str>,
) -> (String, String) {
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            // No API key - just do basic cleaning
            return (
                crate::normalize::normalize_title(raw_title),
                crate::normalize::clean_author_name(raw_author),
            );
        }
    };

    // Check cache first
    let cache_key = format!("search_clean_{}_{}",
        folder_name.to_lowercase().replace(' ', "_"),
        raw_author.to_lowercase().replace(' ', "_")
    );

    if let Some(cached) = crate::cache::get::<(String, String)>(&cache_key) {
        println!("   ⚡ Pre-search clean cache hit");
        return cached;
    }

    let prompt = format!(
r#"Extract the CLEAN book title and author for searching an audiobook database.

INPUT:
- Folder name: "{}"
- Extracted title: "{}"
- Extracted author: "{}"

TASK: Clean the title and author for searching. Remove:
- Track/chapter numbers (01, 1_, Part I, Chapter 1, etc.)
- Quality markers ([Retail], 320kbps, [M4B], etc.)
- File format info (.m4b, .mp3, etc.)
- Series markers in title (Book 1, #1, etc.) - keep for series_hint
- "Unabridged", "Audiobook", etc.
- "by Author Name" from title
- "Read by Narrator" from title

EXAMPLES:
- "01 - The Shining" → title: "The Shining"
- "Stephen King - The Shining [Retail]" → title: "The Shining", author: "Stephen King"
- "Harry Potter and the Chamber of Secrets (Book 2)" → title: "Harry Potter and the Chamber of Secrets", series_hint: "Harry Potter"
- "1_ Part I - Welcome to Coulee Country" → title: "" (this is a chapter, not a book title)

Return JSON only:
{{"title": "clean title or empty if chapter", "author": "author or null", "series_hint": "series name or null"}}"#,
        folder_name, raw_title, raw_author
    );

    match call_gpt_api(&prompt, api_key, "gpt-5-nano", 4000).await {
        Ok(json_str) => {
            match serde_json::from_str::<CleanedSearchQuery>(&json_str) {
                Ok(cleaned) => {
                    let clean_title = if cleaned.title.is_empty() {
                        // GPT thinks this is a chapter - use folder name extraction
                        crate::normalize::normalize_title(raw_title)
                    } else {
                        cleaned.title
                    };
                    let clean_author = cleaned.author
                        .filter(|a| !a.is_empty() && a.to_lowercase() != "null")
                        .unwrap_or_else(|| raw_author.to_string());

                    println!("   🧹 Pre-search cleaned: '{}' → '{}' by '{}'",
                        folder_name, clean_title, clean_author);

                    let result = (clean_title, clean_author);
                    let _ = crate::cache::set(&cache_key, &result);
                    result
                }
                Err(e) => {
                    println!("   ⚠️ Pre-search clean parse error: {}", e);
                    (
                        crate::normalize::normalize_title(raw_title),
                        crate::normalize::clean_author_name(raw_author),
                    )
                }
            }
        }
        Err(e) => {
            println!("   ⚠️ Pre-search clean GPT error: {}", e);
            (
                crate::normalize::normalize_title(raw_title),
                crate::normalize::clean_author_name(raw_author),
            )
        }
    }
}

pub async fn call_gpt_api(
    prompt: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();

    // All GPT-5 models (including nano) use the Responses API
    let use_responses_api = model.starts_with("gpt-5");

    let (endpoint, body) = if use_responses_api {
        // All GPT-5 models use the /v1/responses endpoint with message array format
        // Use "developer" role instead of "system" for Responses API
        (
            "https://api.openai.com/v1/responses",
            serde_json::json!({
                "model": model,
                "input": [
                    {
                        "role": "developer",
                        "content": "You extract audiobook metadata. Return ONLY valid JSON, no markdown. Be concise."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "max_output_tokens": max_tokens,
                "reasoning": {
                    "effort": "low"
                },
                "text": {
                    "format": {
                        "type": "json_object"
                    }
                }
            })
        )
    } else {
        // Chat Completions API for GPT-4 models (legacy)
        let is_gpt5_model = model.starts_with("gpt-5");
        let mut body = serde_json::json!({
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You extract audiobook metadata. Return ONLY valid JSON, no markdown."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        });

        // GPT-5 models don't support temperature, GPT-4 does
        if !is_gpt5_model {
            body["temperature"] = serde_json::json!(0.3);
        }

        // Use the correct token parameter based on model
        if is_gpt5_model {
            body["max_completion_tokens"] = serde_json::json!(max_tokens);
        } else {
            body["max_tokens"] = serde_json::json!(max_tokens);
        }

        ("https://api.openai.com/v1/chat/completions", body)
    };

    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("GPT API error: {}", error_text).into());
    }

    let response_text = response.text().await?;

    // Parse response based on API type
    let content = if use_responses_api {
        // Responses API format - try multiple approaches
        #[derive(serde::Deserialize, Debug)]
        struct ResponsesApiResponse {
            #[serde(default)]
            output: Vec<OutputItem>,
            // Top-level output_text field (simpler format)
            output_text: Option<String>,
        }

        #[derive(serde::Deserialize, Debug)]
        struct OutputItem {
            content: Option<Vec<ContentItem>>,
            #[serde(rename = "type")]
            item_type: String,
        }

        #[derive(serde::Deserialize, Debug)]
        struct ContentItem {
            text: Option<String>,
            #[serde(rename = "type")]
            content_type: String,
        }

        let result: ResponsesApiResponse = serde_json::from_str(&response_text)
            .map_err(|e| format!("Failed to parse Responses API response: {}. Raw: {}", e, response_text))?;

        // First try top-level output_text (simpler responses)
        if let Some(ref text) = result.output_text {
            text.trim().to_string()
        } else {
            // Fall back to nested output array format
            result.output.iter()
                .filter(|item| item.item_type == "message")
                .filter_map(|item| item.content.as_ref())
                .flatten()
                .filter(|c| c.content_type == "output_text" || c.content_type == "text")
                .filter_map(|c| c.text.as_ref())
                .next()
                .ok_or_else(|| format!("No text content in Responses API response. Raw: {}", &response_text[..response_text.len().min(500)]))?
                .trim()
                .to_string()
        }
    } else {
        // Chat Completions API format
        #[derive(serde::Deserialize, Debug)]
        struct ChatResponse { choices: Vec<Choice> }

        #[derive(serde::Deserialize, Debug)]
        struct Choice { message: Message }

        #[derive(serde::Deserialize, Debug)]
        struct Message { content: Option<String> }

        let result: ChatResponse = serde_json::from_str(&response_text)
            .map_err(|e| format!("Failed to parse Chat Completions response: {}. Raw: {}", e, &response_text[..response_text.len().min(500)]))?;

        let content = result.choices.first()
            .ok_or_else(|| format!("No choices in GPT response. Raw: {}", &response_text[..response_text.len().min(500)]))?
            .message.content.clone()
            .unwrap_or_default();

        if content.is_empty() {
            return Err(format!("Empty content in GPT response. Raw: {}", &response_text[..response_text.len().min(500)]).into());
        }

        content.trim().to_string()
    };

    let content = content.as_str();

    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    Ok(json_str.to_string())
}

/// Clean series list with GPT to filter out irrelevant series for this specific edition
/// GPT considers title, author, subtitle (edition info), and validates each series
pub async fn clean_series_with_gpt(
    series_list: &[AudibleSeries],
    title: &str,
    author: &str,
    subtitle: Option<&str>,
    api_key: &str,
) -> Vec<AudibleSeries> {
    if series_list.is_empty() {
        return vec![];
    }

    // Format series for GPT
    let series_str = series_list.iter()
        .map(|s| format!("\"{}\"", s.name))
        .collect::<Vec<_>>()
        .join(", ");

    let subtitle_info = subtitle.unwrap_or("none");

    let prompt = format!(
r#"Filter this series list for an AUDIOBOOK. Return ONLY series that THIS BOOK actually belongs to.

Title: {}
Author: {}
Subtitle/Edition: {}
Series candidates: [{}]

CRITICAL RULES:
1. REJECT series that are COMPLETELY UNRELATED to this book (e.g., "1920s Lady Traveler" for a fantasy book by Terry Pratchett)
2. REJECT standalone sub-series names like "Death", "Wizards", "Watch" - these are meaningless without parent series
3. REJECT format-specific series (e.g., "Manga Shakespeare" for an audiobook)
4. REJECT generic/marketing series ("Timeless Classics", "Bestseller", etc.)
5. REJECT children's adaptations for adult editions
6. KEEP the main series (e.g., "Discworld" for Pratchett)
7. KEEP combined sub-series (e.g., "Discworld - Death" is valid, but "Death" alone is NOT)
8. If subtitle indicates a production (like "Arkangel Shakespeare"), only keep matching series

BE STRICT: When in doubt, REJECT. It's better to have fewer correct series than many wrong ones.

Return JSON: {{"valid_series": ["series1", "series2"]}}"#,
        title, author, subtitle_info, series_str
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        call_gpt_api(&prompt, api_key, "gpt-5-nano", 500)
    ).await;

    match result {
        Ok(Ok(response)) => {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&response) {
                if let Some(valid) = json.get("valid_series").and_then(|v| v.as_array()) {
                    let valid_names: Vec<String> = valid.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_lowercase()))
                        .collect();

                    let filtered: Vec<AudibleSeries> = series_list.iter()
                        .filter(|s| valid_names.contains(&s.name.to_lowercase()))
                        .cloned()
                        .collect();

                    if filtered.len() < series_list.len() {
                        let removed: Vec<_> = series_list.iter()
                            .filter(|s| !valid_names.contains(&s.name.to_lowercase()))
                            .map(|s| &s.name)
                            .collect();
                        println!("   🧹 GPT filtered series: removed {:?}", removed);
                    }

                    return filtered;
                }
            }
            println!("   ⚠️ GPT series filter: couldn't parse response, keeping all");
            series_list.to_vec()
        }
        Ok(Err(e)) => {
            println!("   ⚠️ GPT series filter failed: {}", e);
            series_list.to_vec()
        }
        Err(_) => {
            println!("   ⚠️ GPT series filter timed out");
            series_list.to_vec()
        }
    }
}

/// Clean a title for Audible search by removing chapter indicators (basic sync version)
fn clean_title_basic(title: &str) -> String {
    let mut clean = title.to_string();

    // Remove leading track/chapter numbers like "1 - ", "01 - ", "Track 1 - "
    if let Ok(track_regex) = regex::Regex::new(r"^(?:Track\s*)?\d+\s*[-–:]\s*") {
        clean = track_regex.replace(&clean, "").to_string();
    }

    // Remove common chapter suffixes like ": Opening Credits", ": Chapter 1", etc.
    let suffixes_to_remove = [
        ": Opening Credits",
        ": Closing Credits",
        ": Credits",
        ": Chapter 1",
        ": Chapitre 1",
        ": Unit 1",
        ": Part 1",
        ": Introduction",
        ": Prologue",
        " - Part 1",
        " - Part 2",
        " (Unabridged)",
        " [Unabridged]",
    ];
    for suffix in &suffixes_to_remove {
        if let Some(idx) = clean.to_lowercase().find(&suffix.to_lowercase()) {
            clean = clean[..idx].to_string();
        }
    }

    // Remove ASIN patterns like [B002V0QDN0]
    if let Ok(asin_regex) = regex::Regex::new(r"\s*\[[A-Z0-9]{10}\]\s*$") {
        clean = asin_regex.replace(&clean, "").to_string();
    }

    // Remove year patterns like [1998] or (1998)
    if let Ok(year_regex) = regex::Regex::new(r"\s*[\[\(]\d{4}[\]\)]\s*$") {
        clean = year_regex.replace(&clean, "").to_string();
    }

    clean.trim().to_string()
}

/// Clean and improve a book description using GPT
/// Takes a raw description (often from Audible with HTML) and returns a clean, well-formatted version
pub async fn clean_description_with_gpt(
    raw_description: &str,
    title: &str,
    author: &str,
    api_key: &str,
) -> Option<String> {
    if raw_description.is_empty() {
        return None;
    }

    // Strip HTML tags first
    let html_regex = regex::Regex::new(r"<[^>]+>").ok()?;
    let text_only = html_regex.replace_all(raw_description, " ");
    let text_only = text_only.trim();

    // If already clean and reasonable length, might not need GPT
    if text_only.len() < 100 {
        return Some(text_only.to_string());
    }

    let prompt = format!(
        r#"Clean and improve this audiobook description for "{}" by {}.

RAW DESCRIPTION:
{}

RULES:
1. Remove all HTML artifacts, encoding errors, and promotional text
2. Remove phrases like "Read by...", "Narrated by...", "A [Publisher] audiobook"
3. Remove review quotes and ratings ("New York Times bestseller", "5 stars")
4. Remove calls to action ("Buy now", "Listen today", "Download")
5. Keep the core plot/content summary
6. Fix any obvious grammar or formatting issues
7. Keep it between 150-400 characters if possible
8. Write in third person, present tense
9. Do NOT add information not in the original
10. If the description is mostly promotional/unusable, write a brief factual summary

Return ONLY the cleaned description text, nothing else. No quotes, no JSON, just the text."#,
        title, author, text_only
    );

    match call_gpt_api(&prompt, api_key, "gpt-5-nano", 4000).await {
        Ok(response) => {
            let cleaned = response.trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim();
            if cleaned.len() >= 50 {
                println!("   ✅ GPT cleaned description: {} -> {} chars", text_only.len(), cleaned.len());
                Some(cleaned.to_string())
            } else {
                println!("   ⚠️ GPT description too short, using original");
                Some(text_only.to_string())
            }
        }
        Err(e) => {
            println!("   ⚠️ GPT description cleaning failed: {}", e);
            Some(text_only.to_string())
        }
    }
}

/// Result of themes and tropes extraction
#[derive(Debug, Clone, Default)]
pub struct ThemesAndTropes {
    pub themes: Vec<String>,
    pub tropes: Vec<String>,
}

/// Extract themes and tropes from book metadata using GPT
/// Themes: philosophical/conceptual ideas (e.g., "Mortality", "Identity")
/// Tropes: plot-based story patterns (e.g., "Revenge", "Heist")
pub async fn extract_themes_and_tropes(
    title: &str,
    author: &str,
    genres: &[String],
    description: Option<&str>,
    api_key: &str,
) -> Option<ThemesAndTropes> {
    // Skip if no description or too short
    let desc = match description {
        Some(d) if d.len() >= 50 => d,
        _ => {
            println!("   ⚠️ Skipping themes/tropes: no description or too short");
            return None;
        }
    };

    // Truncate description for GPT prompt
    let desc_for_prompt = if desc.len() > 500 {
        format!("{}...", &desc.chars().take(500).collect::<String>())
    } else {
        desc.to_string()
    };

    let genres_str = if genres.is_empty() {
        "none".to_string()
    } else {
        genres.join(", ")
    };

    let prompt = format!(
r#"Given this audiobook's metadata, extract two types of information:

1. THEMES (exactly 3): Philosophical or conceptual ideas the book explores. Focus on abstract ideas, emotions, existential questions, and human experiences.
   Examples: "Mortality", "The Nature of Evil", "Found Family", "What We Owe Each Other", "Identity", "Generational Trauma", "Belonging", "The Cost of Ambition", "Grief", "Memory and Truth"

2. TROPES (exactly 3): Plot-based elements, story patterns, and genre conventions used in the book.

   CRITICAL: Only include tropes apparent from the premise/setup. NEVER include spoiler tropes that reveal twists, hidden identities, or surprise endings.

   Safe examples: "Revenge", "Love Triangle", "Chosen One", "Heist", "Enemies to Lovers", "Unreliable Narrator", "Quest", "Slow Burn Romance", "Dual Timeline", "Reluctant Hero", "Fish Out of Water", "Locked Room Mystery"

   NEVER use these spoiler tropes: "Twist Villain", "Secret Royal", "Dead All Along", "Secretly Evil", "Double Agent", "Faked Death", "Hidden Antagonist", "Redemption Arc", "Heel Turn", "The Killer Is..."

Title: {}
Author: {}
Genres: {}
Description: {}

Return in this exact format (no extra text):
Themes: [theme1], [theme2], [theme3]
Tropes: [trope1], [trope2], [trope3]"#,
        title, author, genres_str, desc_for_prompt
    );

    println!("   🎭 Extracting themes/tropes for '{}'...", title);

    // Retry logic for 502/503 errors with exponential backoff
    let max_retries = 3;
    for attempt in 0..max_retries {
        if attempt > 0 {
            let delay = std::time::Duration::from_millis(500 * (1 << attempt)); // 1s, 2s, 4s
            println!("   🔄 Retry {} for themes/tropes (waiting {:?})...", attempt, delay);
            tokio::time::sleep(delay).await;
        }

        let gpt_result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            call_gpt_api(&prompt, api_key, "gpt-5-nano", 2000)
        ).await;

        match gpt_result {
            Ok(Ok(response)) => {
                return parse_themes_and_tropes(&response);
            }
            Ok(Err(e)) => {
                let err_str = e.to_string();
                // Retry on 502/503/429 errors
                if err_str.contains("502") || err_str.contains("503") || err_str.contains("429") || err_str.contains("Bad Gateway") {
                    if attempt < max_retries - 1 {
                        println!("   ⚠️ Server error ({}), will retry...", err_str.chars().take(50).collect::<String>());
                        continue;
                    }
                }
                println!("   ⚠️ GPT themes/tropes extraction failed: {}", e);
                return None;
            }
            Err(_) => {
                if attempt < max_retries - 1 {
                    println!("   ⚠️ Timeout, will retry...");
                    continue;
                }
                println!("   ⚠️ GPT themes/tropes extraction timed out");
                return None;
            }
        }
    }
    None
}

/// Parse GPT response for themes and tropes
/// Handles both plain text format (Themes: X, Y, Z) and JSON format ({"Themes": [...]})
fn parse_themes_and_tropes(response: &str) -> Option<ThemesAndTropes> {
    let mut themes = Vec::new();
    let mut tropes = Vec::new();

    // Try JSON format first (GPT sometimes returns {"Themes": [...], "Tropes": [...]})
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(response) {
        if let Some(t) = json.get("Themes").or(json.get("themes")) {
            if let Some(arr) = t.as_array() {
                themes = arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|s| !s.is_empty() && s.len() <= 40)
                    .take(3)
                    .collect();
            }
        }
        if let Some(t) = json.get("Tropes").or(json.get("tropes")) {
            if let Some(arr) = t.as_array() {
                tropes = arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|s| !s.is_empty() && s.len() <= 40)
                    .take(3)
                    .collect();
            }
        }
    }

    // If JSON parsing didn't work, try plain text format
    if themes.is_empty() && tropes.is_empty() {
        for line in response.lines() {
            let line = line.trim();

            if line.to_lowercase().starts_with("themes:") {
                let content = line.split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
                themes = content
                    .split(',')
                    .map(|s| s.trim().trim_matches(|c| c == '[' || c == ']' || c == '"').trim().to_string())
                    .filter(|s| !s.is_empty() && s.len() <= 40)
                    .take(3)
                    .collect();
            } else if line.to_lowercase().starts_with("tropes:") {
                let content = line.split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
                tropes = content
                    .split(',')
                    .map(|s| s.trim().trim_matches(|c| c == '[' || c == ']' || c == '"').trim().to_string())
                    .filter(|s| !s.is_empty() && s.len() <= 40)
                    .take(3)
                    .collect();
            }
        }
    }

    if themes.is_empty() && tropes.is_empty() {
        println!("   ⚠️ Could not parse themes/tropes from GPT response");
        println!("      Response: {:?}", response);
        return None;
    }

    println!("   ✅ Extracted {} themes, {} tropes", themes.len(), tropes.len());
    if !themes.is_empty() {
        println!("      Themes: {}", themes.join(" · "));
    }
    if !tropes.is_empty() {
        println!("      Tropes: {}", tropes.join(" · "));
    }

    Some(ThemesAndTropes { themes, tropes })
}

/// Strip existing themes/tropes header from description (for rescan)
/// Returns the clean description without the header
pub fn strip_themes_tropes_header(description: &str) -> String {
    let lines: Vec<&str> = description.lines().collect();

    if lines.is_empty() {
        return description.to_string();
    }

    // Check if first line(s) are themes/tropes header
    let mut header_end = 0;
    for (i, line) in lines.iter().enumerate() {
        let line_lower = line.to_lowercase();
        if line_lower.starts_with("themes:") || line_lower.starts_with("tropes:") {
            header_end = i + 1;
        } else if line.trim().is_empty() && header_end > 0 {
            // Found blank line after header - skip it too
            header_end = i + 1;
            break;
        } else if header_end > 0 {
            // Found non-empty, non-header line - stop
            break;
        } else {
            // First line isn't header - no stripping needed
            break;
        }
    }

    if header_end == 0 {
        return description.to_string();
    }

    // Return everything after the header
    lines[header_end..].join("\n").trim().to_string()
}

/// Build description with themes/tropes header prepended
/// Used when writing metadata.json or pushing to ABS
pub fn build_description_with_header(
    description: Option<&str>,
    themes: &[String],
    tropes: &[String],
) -> Option<String> {
    let clean_desc = description.map(|d| strip_themes_tropes_header(d));

    let mut lines = Vec::new();

    if !themes.is_empty() {
        lines.push(format!("Themes: {}", themes.join(" · ")));
    }
    if !tropes.is_empty() {
        lines.push(format!("Tropes: {}", tropes.join(" · ")));
    }

    if lines.is_empty() {
        return clean_desc;
    }

    match clean_desc {
        Some(desc) if !desc.is_empty() => {
            Some(format!("{}\n\n{}", lines.join("\n"), desc))
        }
        _ => Some(lines.join("\n"))
    }
}

/// Input data for ABS import GPT processing
#[derive(Debug, Clone, Default)]
pub struct AbsImportData {
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub genres: Vec<String>,
    pub subtitle: Option<String>,
    pub narrator: Option<String>,
    pub description: Option<String>,
    pub year: Option<String>,
    pub publisher: Option<String>,
}

/// Process ABS import metadata with GPT cleaning
/// Uses existing ABS data - NO external API calls, just GPT to clean genres
/// Preserves all existing metadata fields
pub async fn process_abs_import_with_gpt(
    input: &AbsImportData,
    config: &crate::config::Config,
) -> BookMetadata {
    println!("   📖 Processing '{}'", input.title);

    // Start with all existing data preserved
    let mut metadata = BookMetadata::default();
    metadata.title = input.title.clone();
    metadata.author = input.author.clone();
    metadata.series = input.series.clone();
    metadata.sequence = input.sequence.clone();
    metadata.subtitle = input.subtitle.clone();

    // Debug: log input series/sequence
    println!("   📚 Input series='{}' sequence={:?}",
        input.series.as_deref().unwrap_or("none"),
        input.sequence
    );
    metadata.narrator = input.narrator.clone();
    metadata.description = input.description.clone();
    metadata.year = input.year.clone();
    metadata.publisher = input.publisher.clone();
    metadata.genres = input.genres.clone();

    // Check if we have OpenAI API key
    let api_key = match &config.openai_api_key {
        Some(key) if !key.is_empty() => key.as_str(),
        _ => {
            println!("   ⚠️ No OpenAI API key, returning cleaned data");
            metadata.genres = crate::genres::enforce_genre_policy_with_split(&metadata.genres);
            return metadata;
        }
    };

    let genres_str = if input.genres.is_empty() {
        "none".to_string()
    } else {
        input.genres.join(", ")
    };

    // Strip HTML from description for GPT
    let raw_desc = input.description.as_deref().unwrap_or("");
    let desc_for_prompt = if raw_desc.len() > 500 {
        format!("{}...", &raw_desc.chars().take(500).collect::<String>())
    } else {
        raw_desc.to_string()
    };

    // GPT cleans series, genres, and description
    let sequence_str = input.sequence.as_deref().unwrap_or("none");
    let prompt = format!(
r#"Clean this audiobook metadata. Return ONLY valid JSON.

Title: {}
Author: {}
Series: {}
Sequence: {}
Current genres: {}
Raw description: {}

RULES:
1. Series: short umbrella name (e.g. "Harry Potter" not full title)
2. Sequence: keep the book number if provided (e.g. "1", "2", "3")
3. Genres: pick 1-3 from approved list
4. For children's books: "Children's 0-2", "Children's 3-5", "Children's 6-8", "Children's 9-12", "Teen 13-17"
5. Description: Remove HTML tags, keep plot summary only, 150-400 chars, no promotional text

APPROVED GENRES: {}

{{"series":null,"sequence":null,"genres":[],"description":"cleaned text"}}"#,
        input.title,
        input.author,
        input.series.as_deref().unwrap_or("none"),
        sequence_str,
        genres_str,
        desc_for_prompt,
        crate::genres::APPROVED_GENRES.join(", ")
    );

    println!("   🤖 GPT cleaning metadata...");

    // Call GPT-5-nano
    let gpt_result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        call_gpt_api(&prompt, api_key, "gpt-5-nano", 2000)
    ).await;

    match gpt_result {
        Ok(Ok(response)) => {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&response) {
                // Update series/sequence/genres/description from GPT
                // Only override if GPT returns a non-null, non-empty value
                if let Some(s) = json.get("series").and_then(|v| v.as_str()) {
                    if !s.is_empty() && s.to_lowercase() != "null" {
                        // Use author-aware validation to reject author names as series
                        let cleaned = normalize::clean_series_with_author(Some(s), Some(&metadata.author));
                        if cleaned.is_some() {
                            metadata.series = cleaned;
                        }
                    }
                }
                // Only override sequence if GPT returns a valid value
                if let Some(seq) = json.get("sequence").and_then(|v| v.as_str()) {
                    if !seq.is_empty() && seq.to_lowercase() != "null" {
                        if let Some(cleaned_seq) = normalize::clean_sequence(Some(seq)) {
                            metadata.sequence = Some(cleaned_seq);
                        }
                    }
                }
                // Also handle sequence as a number
                if metadata.sequence.is_none() {
                    if let Some(seq_num) = json.get("sequence").and_then(|v| v.as_i64()) {
                        metadata.sequence = Some(seq_num.to_string());
                    } else if let Some(seq_num) = json.get("sequence").and_then(|v| v.as_f64()) {
                        if seq_num.fract() == 0.0 {
                            metadata.sequence = Some((seq_num as i64).to_string());
                        } else {
                            metadata.sequence = Some(format!("{:.1}", seq_num));
                        }
                    }
                }
                if let Some(genres) = json.get("genres").and_then(|g| g.as_array()) {
                    let parsed: Vec<String> = genres.iter()
                        .filter_map(|g| g.as_str().map(|s| s.to_string()))
                        .collect();
                    if !parsed.is_empty() { metadata.genres = parsed; }
                }
                if let Some(desc) = json.get("description").and_then(|v| v.as_str()) {
                    if !desc.is_empty() && desc != "null" && desc.len() > 50 {
                        metadata.description = Some(desc.to_string());
                    }
                }
                println!("   ✅ GPT done: {} - genres: {:?}", metadata.title, metadata.genres);
            }
        }
        Ok(Err(e)) => {
            println!("   ⚠️ GPT error: {}", e);
        }
        Err(_) => {
            println!("   ⚠️ GPT timeout");
        }
    }

    // Normalize genres
    metadata.genres = crate::genres::enforce_genre_policy_with_split(&metadata.genres);
    crate::genres::enforce_children_age_genres(
        &mut metadata.genres,
        &metadata.title,
        metadata.series.as_deref(),
        Some(&metadata.author),
    );

    // Extract themes/tropes if we have a description
    if let Some(ref desc) = metadata.description {
        if desc.len() >= 50 {
            if let Some(themes_tropes) = extract_themes_and_tropes(
                &metadata.title,
                &metadata.author,
                &metadata.genres,
                Some(desc),
                api_key,
            ).await {
                metadata.themes = themes_tropes.themes;
                metadata.tropes = themes_tropes.tropes;
                metadata.themes_source = Some("gpt".to_string());
                metadata.tropes_source = Some("gpt".to_string());
            }
        }
    }

    metadata.sources = Some(MetadataSources {
        series: if metadata.series.is_some() { Some(MetadataSource::Gpt) } else { None },
        genres: Some(MetadataSource::Gpt),
        description: if metadata.description.is_some() { Some(MetadataSource::Gpt) } else { None },
        ..Default::default()
    });

    metadata
}

/// Find the best matching ASIN from Audible search results
/// Extracts multiple candidates and scores them by title/author match
fn find_best_matching_asin(html: &str, expected_title: &str, expected_author: &str) -> Option<String> {
    // Extract ASINs from product links in the search results
    // Look specifically for the productListItem container to avoid sidebar/promoted content
    let asin_regex = regex::Regex::new(r#"/pd/([^/]+)/([A-Z0-9]{10})"#).ok()?;

    // Collect all unique ASINs with their associated titles
    let mut candidates: Vec<(String, String, i32)> = Vec::new(); // (asin, title_slug, score)

    for caps in asin_regex.captures_iter(html) {
        if let (Some(title_slug), Some(asin)) = (caps.get(1), caps.get(2)) {
            let asin_str = asin.as_str().to_string();
            let title_slug_str = title_slug.as_str().to_string();

            // Skip if we already have this ASIN
            if candidates.iter().any(|(a, _, _)| a == &asin_str) {
                continue;
            }

            // Calculate match score based on title similarity
            let score = calculate_title_match_score(&title_slug_str, expected_title);
            candidates.push((asin_str, title_slug_str, score));
        }
    }

    if candidates.is_empty() {
        println!("   ⚠️ No Audible search results found");
        return None;
    }

    // Sort by score (highest first)
    candidates.sort_by(|a, b| b.2.cmp(&a.2));

    // Log candidates for debugging
    if candidates.len() > 1 {
        println!("   🔍 Audible candidates:");
        for (i, (asin, slug, score)) in candidates.iter().take(3).enumerate() {
            println!("      {}: {} (score: {}) [{}]", i + 1, slug.replace('-', " "), score, asin);
        }
    }

    // Return the best match if score is reasonable
    let (best_asin, best_slug, best_score) = &candidates[0];

    // If score is too low, the search probably didn't find the right book
    if *best_score < 20 {
        println!("   ⚠️ Best Audible match '{}' has low score ({}), may be wrong book",
            best_slug.replace('-', " "), best_score);
    }

    Some(best_asin.clone())
}

/// Calculate how well a URL slug matches an expected title
/// Returns a score from 0-100
fn calculate_title_match_score(slug: &str, expected_title: &str) -> i32 {
    // Convert slug to readable format (replace hyphens with spaces)
    let slug_words: Vec<&str> = slug.split('-')
        .filter(|s| !s.is_empty())
        .collect();

    let expected_lower = expected_title.to_lowercase();
    let expected_words: Vec<&str> = expected_lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty() && s.len() > 2)
        .collect();

    if expected_words.is_empty() {
        return 0;
    }

    // Count how many expected words appear in the slug
    let mut matches = 0;
    for expected_word in &expected_words {
        if slug_words.iter().any(|sw| sw.to_lowercase() == *expected_word) {
            matches += 1;
        }
    }

    // Calculate score as percentage of matching words
    let score = (matches * 100) / expected_words.len().max(1);

    // Bonus for exact prefix match
    let slug_joined = slug_words.join(" ").to_lowercase();
    if slug_joined.starts_with(&expected_lower) || expected_lower.starts_with(&slug_joined) {
        return (score + 20).min(100) as i32;
    }

    score as i32
}

async fn fetch_audible_metadata(title: &str, author: &str) -> Option<AudibleMetadata> {
    // PERFORMANCE: Cache Audible lookups by title+author
    let cache_key = format!("audible_{}_{}", title.to_lowercase().replace(' ', "_"), author.to_lowercase().replace(' ', "_"));
    if let Some(cached) = cache::get::<Option<AudibleMetadata>>(&cache_key) {
        println!("   ⚡ Audible cache hit for '{}'", title);
        return cached;
    }

    // Clean the title for better search results
    // Remove chapter indicators like "1 - ", "Opening Credits", etc.
    let clean_title = clean_title_basic(title);

    // Don't include "Unknown" in the search - it hurts results
    let search_query = if author.to_lowercase() == "unknown" || author.is_empty() {
        clean_title.clone()
    } else {
        format!("{} {}", clean_title, author)
    };
    let encoded_query = search_query
        .replace(' ', "+")
        .replace('&', "%26")
        .replace('\'', "%27");

    let search_url = format!("https://www.audible.com/search?keywords={}", encoded_query);

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .ok()?;

    let response = client.get(&search_url).send().await.ok()?;
    let html = response.text().await.ok()?;

    // IMPROVED: Extract multiple ASINs from search results and find the best match
    // Look for ASINs specifically in the product result area, not sidebars
    let asin = find_best_matching_asin(&html, &clean_title, author)?;

    // Fetch product page
    let product_url = format!("https://www.audible.com/pd/{}", asin);
    let product_response = client.get(&product_url).send().await.ok()?;
    let product_html = product_response.text().await.ok()?;

    // Extract title
    let title_regex = regex::Regex::new(r#"<meta[^>]*property="og:title"[^>]*content="([^"]+)""#).ok()?;
    let extracted_title = title_regex.captures(&product_html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().replace(" (Audiobook)", "").replace(" Audiobook", ""));

    // Extract ALL authors - try multiple methods
    let mut extracted_authors: Vec<String> = Vec::new();

    // Method 1: JSON-LD author extraction (most reliable)
    if let Ok(jsonld_author_regex) = regex::Regex::new(r#""author"\s*:\s*\[\s*\{[^}]*"name"\s*:\s*"([^"]+)""#) {
        for caps in jsonld_author_regex.captures_iter(&product_html) {
            if let Some(name) = caps.get(1) {
                let author_name = name.as_str().trim().to_string();
                if !extracted_authors.contains(&author_name) {
                    extracted_authors.push(author_name);
                }
            }
        }
    }

    // Method 2: Single author JSON-LD format
    if extracted_authors.is_empty() {
        if let Ok(single_author_regex) = regex::Regex::new(r#""author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)""#) {
            if let Some(caps) = single_author_regex.captures(&product_html) {
                if let Some(name) = caps.get(1) {
                    extracted_authors.push(name.as_str().trim().to_string());
                }
            }
        }
    }

    // Method 3: HTML link extraction (fallback)
    // Use IndexSet to preserve order while deduplicating
    if extracted_authors.is_empty() {
        if let Ok(author_regex) = regex::Regex::new(r#"/author/[^"]*"[^>]*>([^<]+)</a>"#) {
            let unique: IndexSet<String> = author_regex
                .captures_iter(&product_html)
                .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
                .collect();
            extracted_authors = unique.into_iter().collect();
        }
    }

    // Method 4: "By:" pattern in HTML
    if extracted_authors.is_empty() {
        if let Ok(by_regex) = regex::Regex::new(r#"(?i)>\s*By:?\s*</[^>]+>\s*<[^>]+>([^<]+)</a>"#) {
            if let Some(caps) = by_regex.captures(&product_html) {
                if let Some(name) = caps.get(1) {
                    extracted_authors.push(name.as_str().trim().to_string());
                }
            }
        }
    }

    // Extract ALL narrators (not just first)
    // Use IndexSet to preserve order while deduplicating
    let narrator_regex = regex::Regex::new(r#"/narrator/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
    let unique_narrators: IndexSet<String> = narrator_regex
        .captures_iter(&product_html)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .collect();
    let extracted_narrators: Vec<String> = unique_narrators.into_iter().collect();

    // Extract series - look for series link with book number
    let series_regex = regex::Regex::new(r#"/series/[^"]*"[^>]*>([^<]+)</a>[^<]*,?\s*Book\s*(\d+)"#).ok()?;
    let (series_name, series_position) = if let Some(caps) = series_regex.captures(&product_html) {
        (
            caps.get(1).map(|m| m.as_str().trim().to_string()),
            caps.get(2).map(|m| m.as_str().to_string())
        )
    } else {
        // Try just series name without position
        let series_only_regex = regex::Regex::new(r#"/series/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
        let name = series_only_regex.captures(&product_html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());
        (name, None)
    };

    // Extract publisher
    let publisher_regex = regex::Regex::new(r#"/publisher/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
    let publisher = publisher_regex.captures(&product_html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    // Extract release date from JSON-LD schema
    let date_regex = regex::Regex::new(r#""datePublished"\s*:\s*"([^"]+)""#).ok()?;
    let release_date = date_regex.captures(&product_html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    // NEW: Extract description from JSON-LD schema
    let description = extract_audible_description(&product_html);

    // NEW: Extract language from page (look for language meta or JSON-LD)
    let language = extract_audible_language(&product_html);

    // NEW: Extract runtime in minutes
    let runtime_minutes = extract_audible_runtime(&product_html);

    // NEW: Check if abridged
    let abridged = detect_abridged(&product_html);

    // VALIDATE: Check if the Audible result matches our expected author
    // This prevents returning wrong books when search returns irrelevant results
    let author_validated = if author.to_lowercase() == "unknown" || author.is_empty() {
        // No author to validate against - accept result
        true
    } else if extracted_authors.is_empty() {
        // No authors extracted - can't validate, accept cautiously
        true
    } else {
        // Check if any extracted author matches expected author
        extracted_authors.iter().any(|a| {
            crate::normalize::authors_match(author, a)
        })
    };

    if !author_validated {
        println!("   ⚠️ Audible result rejected: expected author '{}', got {:?}",
            author, extracted_authors);
        // Cache this as None to avoid re-fetching
        let _ = cache::set(&cache_key, &None::<AudibleMetadata>);
        return None;
    }

    // Validate series before adding
    let series_vec = if let Some(ref name) = series_name {
        let title_for_validation = extracted_title.as_deref().unwrap_or(title);
        if is_valid_series(name, title_for_validation) {
            vec![AudibleSeries {
                name: name.clone(),
                position: series_position,
            }]
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    let result = AudibleMetadata {
        asin: Some(asin),
        title: extracted_title,
        subtitle: None,  // Audible scraping doesn't extract subtitles
        authors: extracted_authors,
        narrators: extracted_narrators,
        series: series_vec,
        publisher,
        release_date,
        description,
        language,
        runtime_minutes,
        abridged,
        genres: vec![], // Direct Audible scraping doesn't extract genres
        cover_url: None, // Direct Audible scraping doesn't extract cover URL
    };

    // Cache the result for future lookups
    let _ = cache::set(&cache_key, &Some(result.clone()));
    Some(result)
}

/// Fetch metadata via AudiobookShelf search API (preferred when ABS is configured)
/// Uses waterfall strategy: Audible -> Google -> iTunes
/// Also searches custom providers (Goodreads, Hardcover, etc.) for additional data
/// Falls back to direct Audible scraping if ABS is not configured or fails
async fn fetch_metadata_via_abs(title: &str, author: &str, config: &Config) -> Option<AudibleMetadata> {
    // Check if ABS is configured
    if !crate::abs_search::is_abs_configured(config) {
        println!("   ⚠️ ABS not configured, falling back to direct Audible scraping");
        return fetch_audible_metadata(title, author).await;
    }

    // Check cache first (separate cache key for ABS)
    let cache_key = format!(
        "abs_meta_{}_{}",
        title.to_lowercase().replace(' ', "_"),
        author.to_lowercase().replace(' ', "_")
    );

    if let Some(cached) = cache::get::<Option<AudibleMetadata>>(&cache_key) {
        println!("   ⚡ ABS cache hit for '{}'", title);
        return cached;
    }

    // Search ABS and custom providers in parallel
    println!("   🔍 Fetching metadata via ABS + custom providers for '{}'...", title);

    let abs_future = crate::abs_search::search_metadata_waterfall(config, title, author);
    let custom_future = crate::custom_providers::search_custom_providers(config, title, author);

    let (abs_result, custom_results) = tokio::join!(abs_future, custom_future);

    // Convert ABS result to AudibleMetadata
    let mut metadata = match abs_result {
        Some(abs) => {
            let mut meta = crate::abs_search::convert_to_audible_metadata(abs);
            println!("   ✅ ABS metadata found: {:?}", meta.title);

            // Validate ABS series through our blocklist
            let title_for_validation = meta.title.as_deref().unwrap_or(title);
            let original_count = meta.series.len();
            meta.series.retain(|s| is_valid_series(&s.name, title_for_validation));
            if meta.series.len() < original_count {
                println!("   🧹 Filtered {} invalid ABS series", original_count - meta.series.len());
            }

            Some(meta)
        }
        None => {
            // ABS returned nothing, try direct Audible scraping as fallback
            println!("   ⚠️ ABS returned no results, trying direct Audible scraping");
            fetch_audible_metadata(title, author).await
        }
    };

    // Merge data from custom providers (Goodreads, Hardcover, etc.)
    if !custom_results.is_empty() {
        println!("   🔌 Found {} custom provider results", custom_results.len());

        if let Some(ref mut meta) = metadata {
            // Enhance existing metadata with custom provider data
            for custom in &custom_results {
                // Fill in missing or bad author (critical for "Unknown Author" cases)
                let authors_bad = meta.authors.is_empty()
                    || meta.authors.iter().all(|a| a.is_empty() || a.to_lowercase() == "unknown" || a.to_lowercase() == "unknown author");
                if authors_bad {
                    if let Some(ref custom_author) = custom.author {
                        if !custom_author.is_empty() && custom_author.to_lowercase() != "unknown" {
                            let old_authors = meta.authors.join(", ");
                            println!("   ✍️  Added author from {}: '{}' (was: '{}')",
                                custom.provider_name, custom_author, old_authors);
                            meta.authors = vec![custom_author.clone()];
                        }
                    }
                }

                // Merge series from custom providers (Goodreads is excellent for series)
                // Add ALL series from custom providers, avoiding duplicates
                for custom_series in &custom.series {
                    if let Some(ref series_name) = custom_series.series {
                        // Check if this series already exists (case-insensitive)
                        let series_lower = series_name.to_lowercase();
                        let already_exists = meta.series.iter()
                            .any(|s| s.name.to_lowercase() == series_lower);

                        // Validate series before adding
                        let title = meta.title.as_deref().unwrap_or("");
                        if !already_exists && !series_name.is_empty() && is_valid_series(series_name, title) {
                            meta.series.push(AudibleSeries {
                                name: series_name.clone(),
                                position: custom_series.sequence.clone(),
                            });
                            println!("   📚 Added series from {}: '{}' #{:?}",
                                custom.provider_name, series_name, custom_series.sequence);
                        }
                    }
                }

                // Fill in missing description (Goodreads has great descriptions)
                if meta.description.is_none() && custom.description.is_some() {
                    meta.description = custom.description.clone();
                    println!("   📝 Added description from {}", custom.provider_name);
                }

                // Fill in missing genres
                if meta.genres.is_empty() && !custom.genres.is_empty() {
                    meta.genres = custom.genres.clone();
                    println!("   🏷️  Added {} genres from {}", custom.genres.len(), custom.provider_name);
                }

                // Fill in missing narrator
                if meta.narrators.is_empty() && custom.narrator.is_some() {
                    if let Some(ref narrator) = custom.narrator {
                        meta.narrators = vec![narrator.clone()];
                        println!("   🎙️  Added narrator from {}: {}", custom.provider_name, narrator);
                    }
                }

                // Fill in missing publisher
                if meta.publisher.is_none() && custom.publisher.is_some() {
                    meta.publisher = custom.publisher.clone();
                }

                // Fill in missing year
                if meta.release_date.is_none() && custom.published_year.is_some() {
                    meta.release_date = custom.published_year.clone();
                }
            }
        } else {
            // No ABS result - create metadata from custom providers
            if let Some(best) = custom_results.first() {
                println!("   ✅ Using {} as primary source", best.provider_name);
                let mut meta = AudibleMetadata {
                    title: best.title.clone(),
                    subtitle: best.subtitle.clone(),
                    authors: best.author.as_ref().map(|a| vec![a.clone()]).unwrap_or_default(),
                    narrators: best.narrator.as_ref().map(|n| vec![n.clone()]).unwrap_or_default(),
                    series: best.series.iter().filter_map(|s| {
                        s.series.as_ref().and_then(|name| {
                            let title = best.title.as_deref().unwrap_or("");
                            if is_valid_series(name, title) {
                                Some(AudibleSeries {
                                    name: name.clone(),
                                    position: s.sequence.clone(),
                                })
                            } else {
                                None
                            }
                        })
                    }).collect(),
                    publisher: best.publisher.clone(),
                    release_date: best.published_year.clone(),
                    description: best.description.clone(),
                    language: best.language.clone(),
                    runtime_minutes: best.duration.map(|d| d as u32),
                    abridged: None,
                    genres: best.genres.clone(),
                    asin: best.asin.clone(),
                    cover_url: best.cover.clone(),
                };

                // Merge from other custom providers
                for custom in custom_results.iter().skip(1) {
                    // Add ALL series from custom providers, avoiding duplicates
                    for custom_series in &custom.series {
                        if let Some(ref series_name) = custom_series.series {
                            let series_lower = series_name.to_lowercase();
                            let already_exists = meta.series.iter()
                                .any(|s| s.name.to_lowercase() == series_lower);

                            // Validate series before adding
                            let title = meta.title.as_deref().unwrap_or("");
                            if !already_exists && !series_name.is_empty() && is_valid_series(series_name, title) {
                                meta.series.push(AudibleSeries {
                                    name: series_name.clone(),
                                    position: custom_series.sequence.clone(),
                                });
                            }
                        }
                    }
                    if meta.description.is_none() {
                        meta.description = custom.description.clone();
                    }
                    if meta.genres.is_empty() {
                        meta.genres = custom.genres.clone();
                    }
                }

                metadata = Some(meta);
            }
        }
    }

    // GPT series cleaning: filter out irrelevant series based on book context
    if let Some(ref mut meta) = metadata {
        if !meta.series.is_empty() {
            if let Some(api_key) = &config.openai_api_key {
                if !api_key.is_empty() {
                    let title = meta.title.as_deref().unwrap_or("");
                    let author = meta.authors.first().map(|s| s.as_str()).unwrap_or("");
                    let subtitle = meta.subtitle.as_deref();

                    println!("   🧹 Running GPT series validation for {} series...", meta.series.len());
                    meta.series = clean_series_with_gpt(
                        &meta.series,
                        title,
                        author,
                        subtitle,
                        api_key
                    ).await;
                }
            }
        }
    }

    // Cache the result
    let _ = cache::set(&cache_key, &metadata);
    metadata
}

/// Extract description from Audible page JSON-LD or HTML
fn extract_audible_description(html: &str) -> Option<String> {
    // Try JSON-LD first (most reliable)
    if let Ok(desc_regex) = regex::Regex::new(r#""description"\s*:\s*"([^"]+)""#) {
        if let Some(caps) = desc_regex.captures(html) {
            if let Some(desc) = caps.get(1) {
                let description = desc.as_str()
                    .replace("\\n", " ")
                    .replace("\\r", "")
                    .replace("\\\"", "\"")
                    .replace("&amp;", "&")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&#39;", "'")
                    .trim()
                    .to_string();

                // Skip if it's too short or looks like metadata
                if description.len() > 50 && !description.starts_with("http") {
                    return Some(description);
                }
            }
        }
    }

    // Fallback: Try to get from publisher's summary section
    if let Ok(summary_regex) = regex::Regex::new(r#"(?s)<div[^>]*class="[^"]*productPublisherSummary[^"]*"[^>]*>.*?<p[^>]*>(.*?)</p>"#) {
        if let Some(caps) = summary_regex.captures(html) {
            if let Some(desc) = caps.get(1) {
                let clean_desc = desc.as_str()
                    .replace("<br>", " ")
                    .replace("<br/>", " ")
                    .replace("<br />", " ");
                // Strip remaining HTML tags
                if let Ok(tag_regex) = regex::Regex::new(r"<[^>]+>") {
                    let stripped = tag_regex.replace_all(&clean_desc, "").trim().to_string();
                    if stripped.len() > 50 {
                        return Some(stripped);
                    }
                }
            }
        }
    }

    None
}

/// Extract language from Audible page
fn extract_audible_language(html: &str) -> Option<String> {
    // Look for language in JSON-LD
    if let Ok(lang_regex) = regex::Regex::new(r#""inLanguage"\s*:\s*"([a-z]{2})""#) {
        if let Some(caps) = lang_regex.captures(html) {
            return caps.get(1).map(|m| m.as_str().to_string());
        }
    }

    // Look for language in page content
    if let Ok(lang_regex) = regex::Regex::new(r#"(?i)Language:\s*([A-Za-z]+)"#) {
        if let Some(caps) = lang_regex.captures(html) {
            let lang = caps.get(1)?.as_str().to_lowercase();
            // Map common language names to ISO codes
            return Some(match lang.as_str() {
                "english" => "en",
                "spanish" | "español" => "es",
                "french" | "français" => "fr",
                "german" | "deutsch" => "de",
                "italian" | "italiano" => "it",
                "portuguese" | "português" => "pt",
                "japanese" | "日本語" => "ja",
                "chinese" | "中文" => "zh",
                _ => &lang,
            }.to_string());
        }
    }

    // Default to English for Audible.com
    Some("en".to_string())
}

/// Extract runtime in minutes from Audible page
fn extract_audible_runtime(html: &str) -> Option<u32> {
    // Look for duration in various formats
    // Format: "X hrs and Y mins" or "X hr Y min"
    if let Ok(runtime_regex) = regex::Regex::new(r#"(?i)(\d+)\s*(?:hrs?|hours?)\s*(?:and\s*)?(\d+)?\s*(?:mins?|minutes?)?"#) {
        if let Some(caps) = runtime_regex.captures(html) {
            let hours: u32 = caps.get(1)?.as_str().parse().ok()?;
            let minutes: u32 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            return Some(hours * 60 + minutes);
        }
    }

    // Format: "X minutes" (for short audiobooks)
    if let Ok(mins_regex) = regex::Regex::new(r#"(?i)(\d+)\s*(?:mins?|minutes?)"#) {
        if let Some(caps) = mins_regex.captures(html) {
            return caps.get(1)?.as_str().parse().ok();
        }
    }

    None
}

/// Detect if audiobook is abridged
fn detect_abridged(html: &str) -> Option<bool> {
    let html_lower = html.to_lowercase();

    // Check for explicit abridged/unabridged markers
    if html_lower.contains("unabridged") {
        return Some(false);
    }
    if html_lower.contains("abridged") && !html_lower.contains("unabridged") {
        return Some(true);
    }

    // Default to unabridged if not specified (most audiobooks are unabridged)
    Some(false)
}

// ============================================================================
// COLLECTION DETECTION
// ============================================================================

/// Collection detection patterns
const COLLECTION_PATTERNS: &[&str] = &[
    "collection",
    "complete",
    "omnibus",
    "box set",
    "boxed set",
    "anthology",
    "compendium",
    "books 1",
    "books 2",
    "books 3",
    "books 1-",
    "books 2-",
    "books one",
    "books two",
    "volumes 1",
    "volumes 2",
    "vol 1-",
    "vol. 1-",
    "trilogy",
    "duology",
    "complete series",
    "complete saga",
    "3-in-1",
    "3 in 1",
    "2-in-1",
    "2 in 1",
    "4-in-1",
    "4 in 1",
];

/// Detect if title or folder name indicates a collection
fn detect_collection(title: &str, folder_name: &str, runtime_minutes: Option<u32>) -> (bool, Vec<String>) {
    let title_lower = title.to_lowercase();
    let folder_lower = folder_name.to_lowercase();
    let mut collection_books = Vec::new();

    // Check for collection keywords in title or folder name
    let mut is_collection = COLLECTION_PATTERNS.iter().any(|pattern| {
        title_lower.contains(pattern) || folder_lower.contains(pattern)
    });

    // Check for "Books X-Y" pattern in title
    if let Ok(books_range_regex) = regex::Regex::new(r"(?i)books?\s*(\d+)\s*[-–to]+\s*(\d+)") {
        if let Some(caps) = books_range_regex.captures(&title_lower) {
            is_collection = true;
            if let (Some(start), Some(end)) = (caps.get(1), caps.get(2)) {
                if let (Ok(s), Ok(e)) = (start.as_str().parse::<u32>(), end.as_str().parse::<u32>()) {
                    // Generate book numbers
                    for i in s..=e {
                        collection_books.push(format!("Book {}", i));
                    }
                }
            }
        }
    }

    // Check runtime - unusually long runtimes suggest collection
    // Average audiobook is ~10 hours (600 minutes), collection threshold > 30 hours (1800 minutes)
    if let Some(runtime) = runtime_minutes {
        if runtime > 1800 && !is_collection {
            // Long runtime without collection keywords - flag as potential collection
            println!("   ⚠️ Long runtime detected ({} hours) - potential collection", runtime / 60);
        }
        // Very long runtime (>50 hours) almost certainly a collection
        if runtime > 3000 {
            is_collection = true;
            println!("   📚 Very long runtime ({} hours) - marking as collection", runtime / 60);
        }
    }

    (is_collection, collection_books)
}

/// Extract individual book titles from collection description
fn extract_collection_books_from_description(description: &str, series_name: Option<&str>) -> Vec<String> {
    let mut books = Vec::new();

    // Pattern 1: "Book 1: Title, Book 2: Title, ..."
    if let Ok(book_title_regex) = regex::Regex::new(r"(?i)book\s*(\d+)[:\s]+([^,\n.]+)") {
        for caps in book_title_regex.captures_iter(description) {
            if let Some(title) = caps.get(2) {
                let book_title = title.as_str().trim().to_string();
                if book_title.len() > 3 && !books.contains(&book_title) {
                    books.push(book_title);
                }
            }
        }
    }

    // Pattern 2: Numbered list "1. Title\n2. Title\n..."
    if books.is_empty() {
        if let Ok(numbered_regex) = regex::Regex::new(r"(?m)^\s*(\d+)[.)\s]+([^\n]+)") {
            for caps in numbered_regex.captures_iter(description) {
                if let Some(title) = caps.get(2) {
                    let book_title = title.as_str().trim().to_string();
                    // Filter out common false positives
                    if book_title.len() > 3
                       && !book_title.to_lowercase().contains("chapter")
                       && !book_title.to_lowercase().contains("narrator")
                       && !books.contains(&book_title) {
                        books.push(book_title);
                    }
                }
            }
        }
    }

    // Pattern 3: "Contains: Title, Title, and Title"
    if books.is_empty() {
        if let Ok(contains_regex) = regex::Regex::new(r"(?i)contains:?\s*([^.]+)") {
            if let Some(caps) = contains_regex.captures(description) {
                if let Some(content) = caps.get(1) {
                    // Split by comma or "and"
                    let items: Vec<&str> = content.as_str()
                        .split(&[',', '&'][..])
                        .flat_map(|s| s.split(" and "))
                        .collect();
                    for item in items {
                        let book_title = item.trim().to_string();
                        if book_title.len() > 3 && !books.contains(&book_title) {
                            books.push(book_title);
                        }
                    }
                }
            }
        }
    }

    // Pattern 4: Known series - look for book titles from that series
    if let Some(series) = series_name {
        if books.is_empty() {
            // Try to find titles that match "Series Name: Book Title" or "Book Title (Series Name)"
            let series_lower = series.to_lowercase();
            if let Ok(series_book_regex) = regex::Regex::new(&format!(
                r"(?i){}[:\s]+([^,\n.]+)|([^,\n.]+)\s*\({}\)",
                regex::escape(&series_lower),
                regex::escape(&series_lower)
            )) {
                for caps in series_book_regex.captures_iter(description) {
                    if let Some(title) = caps.get(1).or_else(|| caps.get(2)) {
                        let book_title = title.as_str().trim().to_string();
                        if book_title.len() > 3 && !books.contains(&book_title) {
                            books.push(book_title);
                        }
                    }
                }
            }
        }
    }

    books
}

/// Extract series name and book number from folder name
/// Handles patterns like:
/// - "Discworld 01 - The Colour of Magic" -> ("Discworld", "1")
/// - "Harry Potter Book 3" -> ("Harry Potter", "3")
/// - "[Series Name #5] Title" -> ("Series Name", "5")
/// - "The Witcher 01" -> ("The Witcher", "1")
fn extract_series_from_folder(folder_name: &str) -> (Option<String>, Option<String>) {
    // Pattern 1: "[Series Name #N]" or "[Series Name N]" at start (most specific)
    // e.g., "[Discworld 7] Pyramids"
    if let Some(re) = regex::Regex::new(r"^\[(.+?)\s*[#]?(\d+)\]").ok() {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let series_name = series.as_str().trim();
                let book_num = num.as_str().trim_start_matches('0');
                if series_name.len() >= 3 && !book_num.is_empty() {
                    return (Some(normalize_series_name(series_name)), Some(book_num.to_string()));
                }
            }
        }
    }

    // Pattern 2: "Series Name Book N" or "Series Name Book #N" (explicit Book keyword)
    // e.g., "Wheel of Time Book 5" or "Harry Potter Book #3"
    if let Some(re) = regex::Regex::new(r"(?i)^(.+?)\s+Book\s*[#]?(\d+)").ok() {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let series_name = series.as_str().trim();
                let book_num = num.as_str().trim_start_matches('0');
                if series_name.len() >= 3 && !book_num.is_empty() {
                    return (Some(normalize_series_name(series_name)), Some(book_num.to_string()));
                }
            }
        }
    }

    // Pattern 3: "Series Name #N" (hashtag format)
    // e.g., "Discworld #5"
    if let Some(re) = regex::Regex::new(r"^(.+?)\s*#(\d+)").ok() {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let series_name = series.as_str().trim();
                let book_num = num.as_str().trim_start_matches('0');
                if series_name.len() >= 3 && !book_num.is_empty() {
                    return (Some(normalize_series_name(series_name)), Some(book_num.to_string()));
                }
            }
        }
    }

    // Pattern 4: "Series Name ## - Title" (number before dash separator)
    // e.g., "Discworld 01 - The Colour of Magic" -> "Discworld", "1"
    if let Some(re) = regex::Regex::new(r"^(.+?)\s+(\d{1,2})\s*[-–—]\s*.+$").ok() {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let series_name = series.as_str().trim();
                let book_num = num.as_str().trim_start_matches('0');
                // Validate series name isn't too short, just numbers, or ends with "Book"
                if series_name.len() >= 3
                   && !series_name.chars().all(|c| c.is_ascii_digit())
                   && !series_name.to_lowercase().ends_with(" book")
                   && !book_num.is_empty() {
                    return (Some(normalize_series_name(series_name)), Some(book_num.to_string()));
                }
            }
        }
    }

    // Pattern 5: "Series Name ##" at end (just number, no separator after)
    // e.g., "Harry Potter 3" -> "Harry Potter", "3"
    if let Some(re) = regex::Regex::new(r"^(.+?)\s+(\d{1,2})$").ok() {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let series_name = series.as_str().trim();
                let book_num = num.as_str().trim_start_matches('0');
                if series_name.len() >= 3
                   && !series_name.chars().all(|c| c.is_ascii_digit())
                   && !series_name.to_lowercase().ends_with(" book")
                   && !book_num.is_empty() {
                    return (Some(normalize_series_name(series_name)), Some(book_num.to_string()));
                }
            }
        }
    }

    (None, None)
}

fn extract_book_number_from_folder(folder: &str) -> Option<String> {
    // Look for common book number patterns
    let patterns = [
        r"(?i)book\s*[#]?(\d+)",     // "Book 3", "Book #3"
        r"[#](\d+)",                  // "#5"
        r"\s(\d{2})\s*[-–—]\s",       // " 01 - " (padded number before dash)
    ];

    for pattern in &patterns {
        if let Some(re) = regex::Regex::new(pattern).ok() {
            if let Some(caps) = re.captures(folder) {
                if let Some(m) = caps.get(1) {
                    let num = m.as_str().trim_start_matches('0');
                    if !num.is_empty() {
                        return Some(num.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Check if file tags are already clean (no GPT extraction needed)
fn tags_are_clean(title: Option<&str>, artist: Option<&str>) -> bool {
    let title = match title {
        Some(t) if !t.is_empty() => t.to_lowercase(),
        _ => return false,
    };

    let artist = match artist {
        Some(a) if !a.is_empty() => a.to_lowercase(),
        _ => return false,
    };

    // Reject generic/track-like titles
    let bad_patterns = [
        "track", "chapter", "part 0", "part 1", "part 2", "part 3",
        "disc ", "cd ", "untitled", "unknown", "audio", ".mp3", ".m4b"
    ];

    for pattern in bad_patterns {
        if title.contains(pattern) {
            return false;
        }
    }

    // Reject if title is just numbers
    if title.chars().all(|c| c.is_numeric() || c.is_whitespace() || c == '-') {
        return false;
    }

    // Reject if artist looks like a placeholder
    if artist == "unknown" || artist == "various" || artist == "artist" {
        return false;
    }

    // Must have at least 3 chars and look like real names
    title.len() >= 3 && artist.len() >= 3
}

async fn extract_book_info_with_gpt(
    sample_file: &RawFileData,
    folder_name: &str,
    api_key: Option<&str>
) -> (String, String) {
    // PERFORMANCE: Skip GPT if tags are already clean
    if let (Some(title), Some(artist)) = (&sample_file.tags.title, &sample_file.tags.artist) {
        let clean_title = title.replace(" - Part 1", "").replace(" - Part 2", "").trim().to_string();
        if tags_are_clean(Some(&clean_title), Some(artist)) {
            println!("   ⚡ Fast path: clean tags for '{}'", clean_title);
            return (clean_title, artist.clone());
        }
    }

    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            return (
                sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
                sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
            );
        }
    };

    let clean_title = sample_file.tags.title.as_ref()
        .map(|t| t.replace(" - Part 1", "").replace(" - Part 2", "").trim().to_string());
    let clean_artist = sample_file.tags.artist.as_ref().map(|a| a.to_string());

    let book_number = extract_book_number_from_folder(folder_name);
    let book_hint = if let Some(num) = &book_number {
        format!("\nBOOK NUMBER DETECTED: This is Book #{} in a series", num)
    } else {
        String::new()
    };
    
    let prompt = format!(
r#"You are extracting the actual book title and author from audiobook tags.

FOLDER NAME: {}
FILENAME: {}
FILE TAGS:
* Title: {:?}
* Artist: {:?}
* Album: {:?}{}

PRIMARY RULES:
1. Ignore generic titles like Track 01, Chapter 1, Part 1.
2. Prefer folder name or album when title tag is generic.
3. Always output the specific book title, not just series name.
4. Remove track numbers, chapter numbers, and formatting noise.

Return only valid JSON:
{{"book_title":"specific book title","author":"author name"}}

JSON:"#,
        folder_name,
        sample_file.filename,
        clean_title,
        clean_artist,
        sample_file.tags.album,
        book_hint
    );
    
    for attempt in 1..=2 {
        match call_gpt_api(&prompt, api_key, "gpt-5-nano", 4000).await {
            Ok(json_str) => {
                match serde_json::from_str::<serde_json::Value>(&json_str) {
                    Ok(json) => {
                        let title = json["book_title"].as_str()
                            .unwrap_or(sample_file.tags.title.as_deref().unwrap_or(folder_name))
                            .to_string();
                        let author = json["author"].as_str()
                            .unwrap_or(sample_file.tags.artist.as_deref().unwrap_or("Unknown"))
                            .to_string();
                        
                        if title.to_lowercase().contains("track") || 
                           title.to_lowercase().contains("chapter") ||
                           title.to_lowercase().contains("part") {
                            if attempt == 2 {
                                return (folder_name.to_string(), author);
                            }
                            continue;
                        }
                        
                        return (title, author);
                    }
                    Err(_) => {
                        if attempt == 2 {
                            return (
                                sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
                                sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
                            );
                        }
                    }
                }
            }
            Err(_) => {
                if attempt == 2 {
                    return (
                        sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
                        sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
                    );
                }
            }
        }
    }
    
    (
        sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
        sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
    )
}

fn calculate_changes(group: &mut BookGroup) -> usize {
    // Synchronous version - use calculate_changes_async for better performance
    let mut total_changes = 0;

    for file in &mut group.files {
        file.changes.clear();

        // Read current tags from file to compare
        let current = read_file_tags(&file.path);
        total_changes += apply_changes_for_file(file, &current, &group.metadata);
    }

    total_changes
}

/// Async version of calculate_changes that reads file tags in parallel
/// This provides significant speedup for books with many files
async fn calculate_changes_async(group: &mut BookGroup, file_concurrency: usize) -> usize {
    // Collect paths for parallel reading
    let paths: Vec<String> = group.files.iter().map(|f| f.path.clone()).collect();

    // Read all file tags in parallel
    let tags_map: std::collections::HashMap<String, FileTags> =
        read_all_file_tags_parallel(paths, file_concurrency)
            .await
            .into_iter()
            .collect();

    let mut total_changes = 0;

    for file in &mut group.files {
        file.changes.clear();

        // Get pre-read tags from map
        let current = tags_map.get(&file.path).cloned().unwrap_or_else(|| FileTags {
            title: None, artist: None, album: None,
            genre: None, comment: None, year: None,
        });

        total_changes += apply_changes_for_file(file, &current, &group.metadata);
    }

    total_changes
}

/// Apply metadata changes to a single file based on current tags
fn apply_changes_for_file(file: &mut AudioFile, current: &FileTags, metadata: &BookMetadata) -> usize {
    let mut total_changes = 0;

    // CRITICAL FIX: ALWAYS include all metadata fields for metadata.json writing
    // Previously only changed fields were included, causing empty values when writing

    // Title - ALWAYS include
    let title_changed = current.title.as_ref() != Some(&metadata.title);
    file.changes.insert("title".to_string(), MetadataChange {
        old: current.title.clone().unwrap_or_default(),
        new: metadata.title.clone(),
    });
    if title_changed { total_changes += 1; }

    // Author (primary) - ALWAYS include
    let author_changed = current.artist.as_ref() != Some(&metadata.author);
    file.changes.insert("author".to_string(), MetadataChange {
        old: current.artist.clone().unwrap_or_default(),
        new: metadata.author.clone(),
    });
    if author_changed { total_changes += 1; }

    // Authors array - ALWAYS include (JSON array for metadata.json)
    let authors_json = serde_json::to_string(&metadata.authors).unwrap_or_else(|_| "[]".to_string());
    file.changes.insert("authors_json".to_string(), MetadataChange {
        old: String::new(),
        new: authors_json,
    });

    // Album = Title - ALWAYS include
    let album_changed = current.album.as_ref() != Some(&metadata.title);
    file.changes.insert("album".to_string(), MetadataChange {
        old: current.album.clone().unwrap_or_default(),
        new: metadata.title.clone(),
    });
    if album_changed { total_changes += 1; }

    // Subtitle - ALWAYS include if present
    if let Some(ref subtitle) = metadata.subtitle {
        file.changes.insert("subtitle".to_string(), MetadataChange {
            old: String::new(),
            new: subtitle.clone(),
        });
    }

    // Narrators array - ALWAYS include (JSON array for metadata.json)
    let narrators_json = serde_json::to_string(&metadata.narrators).unwrap_or_else(|_| "[]".to_string());
    file.changes.insert("narrators_json".to_string(), MetadataChange {
        old: String::new(),
        new: narrators_json,
    });

    // Narrator (single string for audio file tags) - ALWAYS include if present
    if !metadata.narrators.is_empty() {
        let narrators_str = metadata.narrators.join("; ");
        file.changes.insert("narrator".to_string(), MetadataChange {
            old: String::new(),
            new: narrators_str,
        });
        total_changes += 1;
    } else if let Some(ref narrator) = metadata.narrator {
        file.changes.insert("narrator".to_string(), MetadataChange {
            old: String::new(),
            new: narrator.clone(),
        });
        total_changes += 1;
    }

    // Genres - ALWAYS include (even empty)
    let genres_str = metadata.genres.join(", ");
    let genre_changed = current.genre.as_ref().map(|g| g.as_str()) != Some(&genres_str);
    file.changes.insert("genre".to_string(), MetadataChange {
        old: current.genre.clone().unwrap_or_default(),
        new: genres_str,
    });
    if genre_changed && !metadata.genres.is_empty() { total_changes += 1; }

    // Genres array - ALWAYS include (JSON array for metadata.json)
    let genres_json = serde_json::to_string(&metadata.genres).unwrap_or_else(|_| "[]".to_string());
    file.changes.insert("genres_json".to_string(), MetadataChange {
        old: String::new(),
        new: genres_json,
    });

    // Series - include if present
    if let Some(ref series) = metadata.series {
        file.changes.insert("series".to_string(), MetadataChange {
            old: String::new(),
            new: series.clone(),
        });
        total_changes += 1;
    }

    // Sequence - include if present
    if let Some(ref sequence) = metadata.sequence {
        file.changes.insert("sequence".to_string(), MetadataChange {
            old: String::new(),
            new: sequence.clone(),
        });
        total_changes += 1;
    }

    // Description - include if present
    if let Some(ref description) = metadata.description {
        file.changes.insert("description".to_string(), MetadataChange {
            old: current.comment.clone().unwrap_or_default(),
            new: description.clone(),
        });
        total_changes += 1;
    }

    // Year - ALWAYS include if present
    if let Some(ref year) = metadata.year {
        let year_changed = current.year.as_ref() != Some(year);
        file.changes.insert("year".to_string(), MetadataChange {
            old: current.year.clone().unwrap_or_default(),
            new: year.clone(),
        });
        if year_changed { total_changes += 1; }
    }

    // ASIN - include if present
    if let Some(ref asin) = metadata.asin {
        file.changes.insert("asin".to_string(), MetadataChange {
            old: String::new(),
            new: asin.clone(),
        });
        total_changes += 1;
    }

    // ISBN - include if present
    if let Some(ref isbn) = metadata.isbn {
        file.changes.insert("isbn".to_string(), MetadataChange {
            old: String::new(),
            new: isbn.clone(),
        });
        total_changes += 1;
    }

    // Language - include if present
    if let Some(ref language) = metadata.language {
        file.changes.insert("language".to_string(), MetadataChange {
            old: String::new(),
            new: language.clone(),
        });
        total_changes += 1;
    }

    // Publisher - include if present
    if let Some(ref publisher) = metadata.publisher {
        file.changes.insert("publisher".to_string(), MetadataChange {
            old: String::new(),
            new: publisher.clone(),
        });
        total_changes += 1;
    }

    // Cover URL - include if present (for cover downloading)
    if let Some(ref cover_url) = metadata.cover_url {
        file.changes.insert("cover_url".to_string(), MetadataChange {
            old: String::new(),
            new: cover_url.clone(),
        });
    }

    total_changes
}

// ============================================================================
// SUPER SCANNER MODE - Maximum accuracy with retries and multi-source validation
// ============================================================================

/// Process all book groups using SuperScanner mode
/// This mode prioritizes accuracy over speed with:
/// - Retry logic for all API calls (3 retries with exponential backoff)
/// - Cross-validation between multiple sources
/// - GPT verification on all books (not just incomplete ones)
/// - Confidence scoring for metadata fields
/// - Optional audio transcription for book verification
pub async fn process_all_groups_super_scanner(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    enable_transcription: bool,
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    let total = groups.len();
    let start_time = std::time::Instant::now();

    println!("🔬 Super Scanner: Processing {} book groups (max accuracy mode)", total);
    println!("   ⚙️ Retries: 3 per API, GPT validation: all books, Multi-source: enabled");

    // Start progress tracking with timer for ETA calculation
    crate::progress::start_scan(total);

    let processed = Arc::new(AtomicUsize::new(0));
    let covers_found = Arc::new(AtomicUsize::new(0));
    let concurrency = config.get_concurrency(crate::config::ConcurrencyOp::SuperScanner);
    let config = Arc::new(config.clone());

    // Process with lower concurrency for Super Scanner (more API-intensive)
    let results: Vec<BookGroup> = stream::iter(groups)
        .map(|group| {
            let config = config.clone();
            let cancel_flag = cancel_flag.clone();
            let processed = processed.clone();
            let covers_found = covers_found.clone();
            let total = total;
            let enable_transcription = enable_transcription;

            async move {
                let result = process_group_super_scanner(
                    group,
                    &config,
                    cancel_flag,
                    covers_found.clone(),
                    enable_transcription,
                ).await;

                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                let covers = covers_found.load(Ordering::Relaxed);

                // Update progress every book for responsive parallel updates
                // ETA is calculated automatically in progress module
                crate::progress::update_progress_with_covers(done, total,
                    &format!("🔬 {}/{} books ({} covers)", done, total, covers),
                    covers
                );

                result
            }
        })
        .buffer_unordered(concurrency)
        .filter_map(|r| async { r.ok() })
        .collect()
        .await;

    let elapsed = start_time.elapsed();
    let final_covers = covers_found.load(Ordering::Relaxed);
    let books_per_sec = results.len() as f64 / elapsed.as_secs_f64();

    println!("✅ Super Scanner complete: {} books, {} covers in {:.1}s ({:.2}/sec)",
        results.len(), final_covers, elapsed.as_secs_f64(), books_per_sec);

    Ok(results)
}

/// Process a single book group with SuperScanner mode
/// Maximum accuracy: retries, cross-validation, GPT on all
async fn process_group_super_scanner(
    mut group: BookGroup,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    covers_found: Arc<AtomicUsize>,
    enable_transcription: bool,
) -> Result<BookGroup, Box<dyn std::error::Error + Send + Sync>> {
    println!("🔬 Super Scanner: '{}'", group.group_name);

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // Read first file's tags
    let sample_file = &group.files[0];
    let file_tags = read_file_tags(&sample_file.path);

    let raw_file = RawFileData {
        path: sample_file.path.clone(),
        filename: sample_file.filename.clone(),
        parent_dir: std::path::Path::new(&sample_file.path)
            .parent()
            .unwrap_or(std::path::Path::new(""))
            .to_string_lossy()
            .to_string(),
        tags: file_tags.clone(),
    };

    // Extract title/author from folder (most reliable base)
    let (extracted_title, extracted_author) = extract_book_info_with_priority(
        &raw_file,
        &group.group_name,
        config.openai_api_key.as_deref()
    ).await;

    println!("   📂 Extracted: '{}' by '{}'", extracted_title, extracted_author);

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // SUPER SCANNER: Audio transcription for book verification
    let transcription = if enable_transcription && config.openai_api_key.is_some() {
        transcribe_for_search(&group, config).await
    } else {
        None
    };

    // Use transcription results if available and confident
    let (trans_title, trans_author) = if let Some(ref t) = transcription {
        let title = t.extracted_title.clone().filter(|s| !s.is_empty());
        let author = t.extracted_author.clone().filter(|s| !s.is_empty());
        if title.is_some() || author.is_some() {
            println!("   🎤 Transcription: title={:?}, author={:?}, confidence={}",
                title, author, t.confidence);
        }
        (title, author)
    } else {
        (None, None)
    };

    // SUPER SCANNER: Pre-search cleaning for better ABS search results
    // Use transcription if high-confidence, otherwise GPT cleaning
    let (search_title, search_author) = if trans_title.is_some() && transcription.as_ref().map(|t| t.confidence >= 60).unwrap_or(false) {
        // High-confidence transcription (has title + author) - use it directly
        println!("   🎤 Using transcription for search (confidence >= 60)");
        (
            trans_title.unwrap_or_else(|| extracted_title.clone()),
            trans_author.unwrap_or_else(|| extracted_author.clone()),
        )
    } else if trans_title.is_some() && transcription.as_ref().map(|t| t.confidence >= 40).unwrap_or(false) {
        // Moderate confidence transcription (has title but maybe no author) - use title from transcription
        let trans_t = trans_title.unwrap();
        println!("   🎤 Using transcription title for search: '{}' (confidence >= 40)", trans_t);
        (
            trans_t,
            trans_author.unwrap_or_else(|| extracted_author.clone()),
        )
    } else {
        clean_title_for_search(
            &extracted_title,
            &extracted_author,
            &group.group_name,
            config.openai_api_key.as_deref(),
        ).await
    };

    // SUPER SCANNER: Fetch metadata via ABS (preferred) or direct Audible (fallback) with retries
    let title_for_audible = search_title.clone();
    let author_for_audible = search_author.clone();
    let config_for_abs = config.clone();
    let audible_data = with_retry("ABS/Audible", 3, 2000, || {
        let t = title_for_audible.clone();
        let a = author_for_audible.clone();
        let cfg = config_for_abs.clone();
        async move {
            fetch_metadata_via_abs(&t, &a, &cfg).await
        }
    }).await;

    // Log source results
    println!("   📊 Sources for '{}' (searched as: '{}'):", extracted_title, search_title);
    println!("      Audible: {}", if audible_data.is_some() { "✅ Found" } else { "❌ None" });

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // SUPER SCANNER: Cross-validate sources
    let validation = cross_validate_sources(
        &group.metadata,
        audible_data.as_ref(),
    );

    if !validation.conflicts.is_empty() {
        println!("   ⚠️ Conflicts detected:");
        for conflict in &validation.conflicts {
            println!("      - {}", conflict);
        }
    }

    // SUPER SCANNER: ALWAYS use GPT for validation (with retries)
    let final_metadata = if config.openai_api_key.is_some() {
        let api_key = config.openai_api_key.clone();
        let title = extracted_title.clone();
        let author = extracted_author.clone();
        let aud = audible_data.clone();
        let val = validation.clone();
        let file_tags_clone = file_tags.clone();
        let folder_name = group.group_name.clone();

        let gpt_result = with_retry("GPT validation", 3, 3000, || {
            let api_key = api_key.clone();
            let title = title.clone();
            let author = author.clone();
            let aud = aud.clone();
            let val = val.clone();
            let file_tags = file_tags_clone.clone();
            let folder = folder_name.clone();

            async move {
                merge_with_gpt_super_scanner(
                    &title,
                    &author,
                    &folder,
                    &file_tags,
                    aud.as_ref(),
                    &val,
                    api_key.as_deref(),
                ).await
            }
        }).await;

        match gpt_result {
            Some(meta) => {
                println!("   ✅ GPT validation complete");
                meta
            }
            None => {
                println!("   ⚠️ GPT failed, using fallback merge");
                create_fallback_metadata_super(
                    &extracted_title,
                    &extracted_author,
                    audible_data.as_ref(),
                    &validation,
                )
            }
        }
    } else {
        println!("   ⚠️ No OpenAI API key, using rule-based merge");
        create_fallback_metadata_super(
            &extracted_title,
            &extracted_author,
            audible_data.as_ref(),
            &validation,
        )
    };

    group.metadata = final_metadata;
    group.scan_status = ScanStatus::NewScan;

    // SUPER SCANNER: Calculate confidence with cross-validation results
    group.metadata.confidence = Some(calculate_confidence_scores(&group.metadata, Some(&validation)));

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // SUPER SCANNER: Fetch cover with retries from multiple sources
    let asin = group.metadata.asin.clone();
    let cover_title = group.metadata.title.clone();
    let cover_author = group.metadata.author.clone();

    let cover = with_retry("Cover art", 3, 1500, || {
        let asin = asin.clone();
        let title = cover_title.clone();
        let author = cover_author.clone();

        async move {
            match crate::cover_art::fetch_and_download_cover(
                &title,
                &author,
                asin.as_deref(),
                None, // No longer using Google Books API key
            ).await {
                Ok(cover) if cover.data.is_some() => Some(cover),
                _ => None
            }
        }
    }).await;

    if let Some(cover) = cover {
        if let Some(ref data) = cover.data {
            let cover_cache_key = format!("cover_{}", group.id);
            let mime_type = cover.mime_type.clone().unwrap_or_else(|| "image/jpeg".to_string());
            let _ = cache::set(&cover_cache_key, &(data.clone(), mime_type.clone()));
            group.metadata.cover_url = cover.url;
            group.metadata.cover_mime = Some(mime_type);
            covers_found.fetch_add(1, Ordering::Relaxed);
            println!("   🖼️ Cover found");
        }
    } else {
        println!("   ⚠️ No cover found");
    }

    // Cache the result
    let parent_path = std::path::Path::new(&group.files[0].path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| group.group_name.clone());
    let cache_key = format!("book_{}", parent_path);
    let _ = cache::set(&cache_key, &group.metadata);

    // Calculate changes with parallel file reading
    let file_concurrency = config.get_concurrency(crate::config::ConcurrencyOp::FileScan);
    group.total_changes = calculate_changes_async(&mut group, file_concurrency).await;

    Ok(group)
}

/// GPT merge specifically for SuperScanner mode
/// Includes conflict resolution, confidence scoring, and ENHANCED validation
async fn merge_with_gpt_super_scanner(
    extracted_title: &str,
    extracted_author: &str,
    folder_name: &str,
    file_tags: &FileTags,
    audible: Option<&AudibleMetadata>,
    validation: &SourceValidation,
    api_key: Option<&str>,
) -> Option<BookMetadata> {
    let api_key = api_key?;

    // Step 1: Collect series candidates from all sources (like normal scanner)
    let series_candidates = collect_series_candidates(
        folder_name,
        extracted_title,
        &audible.cloned()
    );

    println!("   📚 SuperScanner series candidates: {:?}", series_candidates.iter().map(|c| &c.name).collect::<Vec<_>>());

    // Step 2: Determine authoritative series (Audible first, then folder)
    let authoritative_series: Option<(String, Option<String>)> = series_candidates
        .iter()
        .filter(|c| c.source == "audible")
        .next()
        .map(|c| (c.name.clone(), c.position.clone()))
        .or_else(|| {
            series_candidates.iter()
                .filter(|c| c.source == "folder")
                .next()
                .map(|c| (c.name.clone(), c.position.clone()))
        });

    // Step 3: Build series instruction for GPT
    let series_instruction = if let Some((ref series_name, ref position)) = authoritative_series {
        format!(
            "SERIES INFO (from {}): This book is part of the '{}' series{}. \
             Use this series name. If you believe this is incorrect, return null for series instead.",
            if series_candidates.iter().any(|c| c.source == "audible") { "Audible" } else { "folder" },
            series_name,
            position.as_ref().map(|p| format!(", position {}", p)).unwrap_or_default()
        )
    } else if !series_candidates.is_empty() {
        let names: Vec<_> = series_candidates.iter().map(|c| c.name.as_str()).collect();
        format!(
            "POSSIBLE SERIES: {}. Verify if any of these are correct, or return null if this is a standalone book.",
            names.join(", ")
        )
    } else {
        "NO SERIES DETECTED from Audible/Google. Use your knowledge! If you KNOW this book is part of a well-known series (like 'Mr. Putter & Tabby', 'Harry Potter', 'Magic Tree House', etc.), provide the SHORT series name. Return null only if truly standalone.".to_string()
    };

    // Extract year from Audible (authoritative)
    let reliable_year = audible
        .and_then(|d| d.release_date.clone())
        .and_then(|date| date.split('-').next().map(|s| s.to_string()));

    let year_instruction = if let Some(ref year) = reliable_year {
        format!("CRITICAL: Use EXACTLY this year: {} (from Audible - DO NOT CHANGE)", year)
    } else {
        "year: If not found in sources, return null".to_string()
    };

    // Build comprehensive prompt with all sources and conflicts
    let audible_summary = if let Some(aud) = audible {
        format!(
            "Title: {:?}\nAuthors: {:?}\nNarrators: {:?}\nSeries: {:?}\nDescription: {:?}\nPublisher: {:?}\nASIN: {:?}\nRelease Date: {:?}",
            aud.title, aud.authors, aud.narrators, aud.series,
            aud.description.as_ref().map(|d| if d.len() > 300 { format!("{}...", &d[..300]) } else { d.clone() }),
            aud.publisher, aud.asin, aud.release_date
        )
    } else {
        "Not found".to_string()
    };

    let conflicts_summary = if validation.conflicts.is_empty() {
        "None - sources agree".to_string()
    } else {
        validation.conflicts.join("\n")
    };

    let prompt = format!(r#"You are an audiobook metadata specialist. This is SUPER SCANNER mode - maximum accuracy required.
Combine information from all sources to produce the most accurate metadata.

SOURCES:
1. Folder: {}
2. Extracted from tags: title='{}', author='{}'
3. Sample comment: {:?}

AUDIBLE DATA (authoritative for audiobooks):
{}

CONFLICTS DETECTED:
{}

{}

APPROVED GENRES (select maximum 3):
{}

CRITICAL AUTHOR RULE:
The author '{}' was extracted from file tags/folder name. This is likely the CORRECT author.
If Audible returned a DIFFERENT author, they may have returned the WRONG book.
ALWAYS prefer the extracted author '{}' unless the folder name was clearly wrong or "Unknown".
NEVER replace a valid author like "Will Wight" with a completely different author like "J.K. Rowling".

OUTPUT FIELDS:
* title: Book title only. Remove junk, series markers, "Unabridged", author/narrator names.
* subtitle: Use only if genuinely a subtitle (not series info).
* author: CRITICAL - Use '{}' unless it was "Unknown" or clearly wrong.
* authors: Array of all authors.
* narrator: Primary narrator. MUST be a person's name, NOT "Recorded Books" or company names.
* narrators: Array of all narrators from Audible.
* series: SHORT series name only! Examples:
  - "Harry Potter" (NOT "Harry Potter and the Chamber of Secrets")
  - "The Stormlight Archive" (NOT "Words of Radiance - The Stormlight Archive")
  - "A Court of Thorns and Roses" (NOT the full book title)
  - "Dungeon Crawler Carl" for all books in that series
  The series name should be the UMBRELLA name for all books, not this specific book's title.
* sequence: Book number in series. Use Audible's position if provided.
* genres: Select 1-3 from the approved list. CRITICAL AGE CLASSIFICATION:
  For children's/youth books, you MUST use age-specific genres:
  - "Children's 0-2": Baby/toddler books (Goodnight Moon, board books)
  - "Children's 3-5": Preschool/kindergarten (Dr. Seuss, Peppa Pig, Curious George)
  - "Children's 6-8": Early chapter books (Magic Tree House, Junie B. Jones, Dog Man, Diary of a Wimpy Kid)
  - "Children's 9-12": Middle grade (Harry Potter, Percy Jackson, Narnia, Goosebumps, Roald Dahl)
  - "Teen 13-17": Young adult (Hunger Games, Divergent, Twilight, Throne of Glass, Sarah J. Maas)
  NEVER use generic "Children's", "Young Adult", "Middle Grade" - ALWAYS use the age range version!
  NEVER use "Children's" for teen/YA books like Hunger Games or Throne of Glass.
* publisher: Use Audible publisher if available.
* {}
* description: From Audible or create a brief summary, minimum 200 characters.

SERIES RULES (STRICT):
1. Series name must be SHORT - just the series umbrella name
2. NEVER use the full book title as the series name
3. Series name must be SIGNIFICANTLY shorter than the book title
4. If Audible provides series, clean it up (remove "(Book", trailing commas, etc.)

CONFIDENCE SCORING (SuperScanner mode - be accurate):
- 95+: Audible data matches folder name exactly
- 85-94: Audible data available, minor discrepancies
- 70-84: Single reliable source only
- Below 70: Uncertain, multiple conflicts

Return ONLY valid JSON (no markdown, no explanation):
{{
  "title": "cleaned book title",
  "subtitle": "subtitle or null",
  "author": "primary author name",
  "authors": ["all", "author", "names"],
  "narrator": "primary narrator",
  "narrators": ["all", "narrator", "names"],
  "series": "SHORT series name or null",
  "sequence": "number or null",
  "genres": ["Genre1", "Genre2"],
  "publisher": "publisher or null",
  "year": "YYYY or null",
  "description": "description",
  "isbn": "ISBN-13 or null",
  "asin": "ASIN or null",
  "language": "en",
  "confidence": {{
    "title": 95,
    "author": 90,
    "narrator": 85,
    "series": 75,
    "overall": 85
  }}
}}

JSON:"#,
        folder_name,
        extracted_title,
        extracted_author,
        file_tags.comment,
        audible_summary,
        conflicts_summary,
        series_instruction,
        crate::genres::APPROVED_GENRES.join(", "),
        extracted_author, // for CRITICAL AUTHOR RULE line 1
        extracted_author, // for CRITICAL AUTHOR RULE line 2
        extracted_author, // for OUTPUT FIELDS author line
        year_instruction
    );

    // Call GPT API with increased token limit
    let response = match call_gpt_api(&prompt, api_key, "gpt-5-nano", 4000).await {
        Ok(r) => r,
        Err(e) => {
            println!("   ⚠️ SuperScanner GPT API error: {}", e);
            return None;
        }
    };

    // Parse response with enhanced validation
    parse_super_scanner_gpt_response_enhanced(
        &response,
        extracted_title,
        extracted_author,
        audible,
        &authoritative_series,
        reliable_year.as_deref()
    )
}

/// Enhanced GPT response parser for SuperScanner mode
/// Includes strict validation, normalization, and source tracking
fn parse_super_scanner_gpt_response_enhanced(
    response: &str,
    fallback_title: &str,
    fallback_author: &str,
    audible: Option<&AudibleMetadata>,
    authoritative_series: &Option<(String, Option<String>)>,
    reliable_year: Option<&str>,
) -> Option<BookMetadata> {
    // Detect truncated JSON responses
    let trimmed = response.trim();
    if !trimmed.ends_with('}') {
        println!("   ⚠️ SuperScanner GPT response appears truncated (doesn't end with '}}')");
        println!("   ⚠️ Response length: {} chars, last 50 chars: {:?}",
            trimmed.len(),
            &trimmed[trimmed.len().saturating_sub(50)..]);
        return None;
    }

    // Try to extract JSON from response
    let json_str = if let Some(start) = response.find('{') {
        if let Some(end) = response.rfind('}') {
            &response[start..=end]
        } else {
            response
        }
    } else {
        response
    };

    let parsed: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(e) => {
            // Check if this looks like a truncation error
            let error_msg = e.to_string();
            if error_msg.contains("EOF") || error_msg.contains("unexpected end") {
                println!("   ❌ SuperScanner GPT response truncated: {}", e);
            } else {
                println!("   ❌ SuperScanner GPT parse error: {}", e);
            }
            return None;
        }
    };

    // Initialize sources tracking
    let mut sources = MetadataSources::default();

    // Extract title with validation
    let mut title = parsed["title"].as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or(fallback_title)
        .to_string();
    sources.title = Some(MetadataSource::Gpt);

    // Extract author with STRICT validation
    let mut author = parsed["author"].as_str()
        .filter(|a| !a.is_empty())
        .unwrap_or(fallback_author)
        .to_string();

    // STRICT AUTHOR VALIDATION (SuperScanner exclusive)
    if !crate::normalize::author_is_acceptable(fallback_author, &author) {
        println!("   ⚠️ SuperScanner: Rejecting GPT author '{}' (expected '{}' - keeping original)",
            author, fallback_author);
        author = fallback_author.to_string();
        sources.author = Some(MetadataSource::Folder);
    } else {
        sources.author = Some(MetadataSource::Gpt);
    }

    let mut authors: Vec<String> = parsed["authors"].as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_else(|| vec![author.clone()]);

    // Sync authors array with validated author
    if !authors.contains(&author) && !author.is_empty() {
        authors.insert(0, author.clone());
    }

    // Extract narrator with validation against Audible
    let mut narrator = parsed["narrator"].as_str().map(|s| s.to_string());
    let mut narrators: Vec<String> = parsed["narrators"].as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    // CROSS-VALIDATE narrator against Audible (SuperScanner exclusive)
    if let Some(aud) = audible {
        if !aud.narrators.is_empty() {
            // Always prefer Audible narrators - they're authoritative
            narrators = aud.narrators.clone();
            narrator = aud.narrators.first().cloned();
            sources.narrator = Some(MetadataSource::Audible);
            println!("   ✅ SuperScanner: Using Audible narrators: {:?}", narrators);
        }
    }
    if narrator.is_some() && sources.narrator.is_none() {
        sources.narrator = Some(MetadataSource::Gpt);
    }

    // Extract and VALIDATE series
    let mut series = parsed["series"].as_str()
        .filter(|s| !s.is_empty() && s.to_lowercase() != title.to_lowercase())
        .map(|s| s.to_string());
    let mut sequence = parsed["sequence"].as_str().map(|s| s.to_string());

    // STRICT SERIES VALIDATION (SuperScanner exclusive)
    if let Some(ref s) = series {
        // Validate using existing function
        if !is_valid_series(s, &title) {
            println!("   ⚠️ SuperScanner: Rejecting GPT series '{}' (failed validation)", s);
            series = None;
            sequence = None;
        } else {
            // Normalize the series name
            series = Some(normalize_series_name(s));
            sources.series = Some(MetadataSource::Gpt);
            if sequence.is_some() {
                sources.sequence = Some(MetadataSource::Gpt);
            }
        }
    }

    // ALWAYS prefer Audible's series and sequence if available
    if let Some((ref series_name, ref position)) = authoritative_series {
        if is_valid_series(series_name, &title) {
            // Use Audible series name (more accurate)
            series = Some(normalize_series_name(series_name));
            sources.series = Some(MetadataSource::Audible);
            // ALWAYS use Audible's sequence if provided - it's authoritative!
            if let Some(ref pos) = position {
                println!("   ✅ SuperScanner: Using Audible sequence: {} #{}", series_name, pos);
                sequence = Some(pos.clone());
                sources.sequence = Some(MetadataSource::Audible);
            }
        }
    }

    // Extract subtitle - prefer Audible, then GPT
    let subtitle = if let Some(aud) = audible {
        aud.subtitle.clone().filter(|s| !s.is_empty()).map(|s| {
            sources.subtitle = Some(MetadataSource::Audible);
            s
        })
    } else {
        None
    }.or_else(|| {
        parsed["subtitle"].as_str()
            .filter(|s| !s.is_empty())
            .map(|s| {
                sources.subtitle = Some(MetadataSource::Gpt);
                s.to_string()
            })
    });

    // Extract description
    let mut description = parsed["description"].as_str().map(|s| s.to_string());
    // Prefer Audible description if GPT's is too short
    if description.as_ref().map(|d| d.len() < 100).unwrap_or(true) {
        if let Some(aud) = audible {
            if let Some(ref desc) = aud.description {
                if desc.len() >= 50 {
                    description = Some(desc.clone());
                    sources.description = Some(MetadataSource::Audible);
                }
            }
        }
    }
    if description.is_some() && sources.description.is_none() {
        sources.description = Some(MetadataSource::Gpt);
    }

    // Extract publisher (prefer Audible)
    let publisher = if let Some(aud) = audible {
        aud.publisher.clone().map(|p| {
            sources.publisher = Some(MetadataSource::Audible);
            p
        })
    } else {
        parsed["publisher"].as_str().map(|s| {
            sources.publisher = Some(MetadataSource::Gpt);
            s.to_string()
        })
    };

    // Use reliable year from Audible
    let year = if let Some(y) = reliable_year {
        sources.year = Some(MetadataSource::Audible);
        Some(y.to_string())
    } else {
        parsed["year"].as_str().map(|s| {
            sources.year = Some(MetadataSource::Gpt);
            s.to_string()
        })
    };

    // Extract and process genres
    let mut genres: Vec<String> = parsed["genres"].as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    // GENRE POST-PROCESSING (like normal scanner)
    if !genres.is_empty() {
        // Split any combined genres
        genres = crate::genres::split_combined_genres(&genres);
        // Enforce age-specific children's genres
        crate::genres::enforce_children_age_genres(
            &mut genres,
            &title,
            series.as_deref(),
            Some(&author),
        );
        // Limit to 3 genres
        genres.truncate(3);
        sources.genres = Some(MetadataSource::Gpt);
    }

    let isbn = parsed["isbn"].as_str().map(|s| s.to_string());

    // Prefer Audible ASIN
    let asin = audible.and_then(|a| a.asin.clone())
        .or_else(|| parsed["asin"].as_str().map(|s| s.to_string()));
    if asin.is_some() {
        sources.asin = Some(if audible.is_some() { MetadataSource::Audible } else { MetadataSource::Gpt });
    }

    // Language - prefer Audible, then GPT
    let language = if let Some(aud) = audible {
        aud.language.clone().map(|l| {
            sources.language = Some(MetadataSource::Audible);
            l
        })
    } else {
        None
    }.or_else(|| {
        parsed["language"].as_str().map(|s| {
            sources.language = Some(MetadataSource::Gpt);
            s.to_string()
        })
    });

    // Parse confidence scores
    let mut confidence = if let Some(conf_obj) = parsed["confidence"].as_object() {
        MetadataConfidence {
            title: conf_obj.get("title").and_then(|v| v.as_u64()).unwrap_or(75) as u8,
            author: conf_obj.get("author").and_then(|v| v.as_u64()).unwrap_or(75) as u8,
            narrator: conf_obj.get("narrator").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            series: conf_obj.get("series").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            overall: conf_obj.get("overall").and_then(|v| v.as_u64()).unwrap_or(70) as u8,
            sources_used: vec!["GPT".to_string()],
        }
    } else {
        MetadataConfidence {
            title: 75,
            author: 75,
            narrator: if narrator.is_some() { 70 } else { 0 },
            series: if series.is_some() { 60 } else { 0 },
            overall: 70,
            sources_used: vec!["GPT".to_string()],
        }
    };

    // Update sources_used based on what we actually used
    confidence.sources_used = vec![];
    if audible.is_some() {
        confidence.sources_used.push("Audible".to_string());
    }
    confidence.sources_used.push("GPT".to_string());
    confidence.sources_used.push("Folder".to_string());

    // Get additional fields from Audible if available
    let (runtime_minutes, abridged, publish_date) = audible
        .map(|a| (a.runtime_minutes, a.abridged, a.release_date.clone()))
        .unwrap_or((None, None, None));
    if runtime_minutes.is_some() {
        sources.runtime = Some(MetadataSource::Audible);
    }

    // TITLE CLEANING VALIDATION (SuperScanner exclusive)
    // Verify title doesn't contain author, narrator, "Unabridged", year, or ASIN
    let title_lower = title.to_lowercase();
    let author_lower = author.to_lowercase();
    if title_lower.contains(&author_lower) && author.len() > 3 {
        println!("   ⚠️ SuperScanner: Title contains author name, cleaning...");
        title = title.replace(&author, "").trim().to_string();
    }
    if title_lower.contains("unabridged") {
        title = title.replace("Unabridged", "").replace("unabridged", "").replace("()", "").trim().to_string();
    }
    // Remove trailing dashes, colons, etc.
    title = title.trim_end_matches(|c: char| c == '-' || c == ':' || c == ' ').to_string();

    // Build all_series from series/sequence if present
    let all_series = if let Some(ref s) = series {
        vec![SeriesInfo::new(s.clone(), sequence.clone(), sources.series)]
    } else {
        vec![]
    };

    // Build the metadata
    let mut metadata = BookMetadata {
        title,
        author,
        authors,
        subtitle,
        narrator,
        narrators,
        series,
        sequence,
        all_series,
        genres,
        description,
        publisher,
        year,
        isbn,
        asin,
        cover_url: None,
        cover_mime: None,
        language,
        abridged,
        runtime_minutes,
        explicit: None,
        publish_date,
        sources: Some(sources),
        is_collection: false,
        collection_books: vec![],
        confidence: Some(confidence),
        // Themes/tropes - extracted later
        themes: vec![],
        tropes: vec![],
        themes_source: None,
        tropes_source: None,
    };

    // Apply FULL normalization pipeline (like normal scanner)
    metadata = normalize_metadata(metadata);

    Some(metadata)
}

/// Parse GPT response for SuperScanner mode (legacy - kept for compatibility)
fn parse_super_scanner_gpt_response(
    response: &str,
    fallback_title: &str,
    fallback_author: &str,
    audible: Option<&AudibleMetadata>,
) -> Option<BookMetadata> {
    // Try to extract JSON from response
    let json_str = if let Some(start) = response.find('{') {
        if let Some(end) = response.rfind('}') {
            &response[start..=end]
        } else {
            response
        }
    } else {
        response
    };

    let parsed: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(e) => {
            println!("   ⚠️ Failed to parse GPT response: {}", e);
            return None;
        }
    };

    // Extract fields with fallbacks
    let title = parsed["title"].as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or(fallback_title)
        .to_string();

    let author = parsed["author"].as_str()
        .filter(|a| !a.is_empty())
        .unwrap_or(fallback_author)
        .to_string();

    let authors: Vec<String> = parsed["authors"].as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_else(|| vec![author.clone()]);

    let narrator = parsed["narrator"].as_str().map(|s| s.to_string());
    let narrators: Vec<String> = parsed["narrators"].as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let series = parsed["series"].as_str()
        .filter(|s| !s.is_empty() && s.to_lowercase() != title.to_lowercase())
        .map(|s| s.to_string());

    let sequence = parsed["sequence"].as_str().map(|s| s.to_string());

    let subtitle = parsed["subtitle"].as_str().map(|s| s.to_string());

    let description = parsed["description"].as_str().map(|s| s.to_string());

    let publisher = parsed["publisher"].as_str().map(|s| s.to_string());

    let year = parsed["year"].as_str().map(|s| s.to_string());

    let genres: Vec<String> = parsed["genres"].as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let isbn = parsed["isbn"].as_str().map(|s| s.to_string());

    let asin = parsed["asin"].as_str().map(|s| s.to_string())
        .or_else(|| audible.and_then(|a| a.asin.clone()));

    let language = parsed["language"].as_str().map(|s| s.to_string());

    // Parse confidence scores
    let confidence = if let Some(conf_obj) = parsed["confidence"].as_object() {
        Some(MetadataConfidence {
            title: conf_obj.get("title").and_then(|v| v.as_u64()).unwrap_or(75) as u8,
            author: conf_obj.get("author").and_then(|v| v.as_u64()).unwrap_or(75) as u8,
            narrator: conf_obj.get("narrator").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            series: conf_obj.get("series").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            overall: conf_obj.get("overall").and_then(|v| v.as_u64()).unwrap_or(70) as u8,
            sources_used: vec!["GPT".to_string(), "Audible".to_string()],
        })
    } else {
        Some(MetadataConfidence {
            title: 75,
            author: 75,
            narrator: if narrator.is_some() { 70 } else { 0 },
            series: if series.is_some() { 60 } else { 0 },
            overall: 70,
            sources_used: vec!["GPT".to_string()],
        })
    };

    // Get additional fields from Audible if available
    let (runtime_minutes, abridged, explicit) = audible
        .map(|a| (a.runtime_minutes, a.abridged, None::<bool>))
        .unwrap_or((None, None, None));

    // Build all_series from series/sequence if present
    let all_series = if let Some(ref s) = series {
        vec![SeriesInfo::new(s.clone(), sequence.clone(), Some(MetadataSource::Gpt))]
    } else {
        vec![]
    };

    Some(BookMetadata {
        title,
        author,
        authors,
        subtitle,
        narrator,
        narrators,
        series,
        sequence,
        all_series,
        genres,
        description,
        publisher,
        year,
        isbn,
        asin,
        cover_url: None,
        cover_mime: None,
        language,
        abridged,
        runtime_minutes,
        explicit,
        publish_date: None,
        sources: None,
        is_collection: false,
        collection_books: vec![],
        confidence,
        // Themes/tropes - extracted later
        themes: vec![],
        tropes: vec![],
        themes_source: None,
        tropes_source: None,
    })
}

/// Create fallback metadata when GPT fails in SuperScanner mode
/// Enhanced with validation, normalization, and source tracking
fn create_fallback_metadata_super(
    title: &str,
    author: &str,
    audible: Option<&AudibleMetadata>,
    validation: &SourceValidation,
) -> BookMetadata {
    // Initialize sources tracking
    let mut sources = MetadataSources::default();
    sources.title = Some(MetadataSource::Folder);
    sources.author = Some(MetadataSource::Folder);

    // Use Audible for narrators
    let narrator = audible.and_then(|a| a.narrators.first().cloned());
    let narrators = audible.map(|a| a.narrators.clone()).unwrap_or_default();
    if !narrators.is_empty() {
        sources.narrator = Some(MetadataSource::Audible);
    }

    // Get series from Audible but VALIDATE it
    let (series, sequence) = audible
        .and_then(|a| a.series.first())
        .map(|s| {
            // Validate series
            if is_valid_series(&s.name, title) {
                sources.series = Some(MetadataSource::Audible);
                sources.sequence = Some(MetadataSource::Audible);
                (Some(normalize_series_name(&s.name)), s.position.clone())
            } else {
                println!("   ⚠️ SuperScanner fallback: Rejecting invalid series '{}'", s.name);
                (None, None)
            }
        })
        .unwrap_or((None, None));

    let asin = audible.and_then(|a| a.asin.clone());
    if asin.is_some() {
        sources.asin = Some(MetadataSource::Audible);
    }

    let runtime_minutes = audible.and_then(|a| a.runtime_minutes);
    if runtime_minutes.is_some() {
        sources.runtime = Some(MetadataSource::Audible);
    }

    let abridged = audible.and_then(|a| a.abridged);

    let description = audible.and_then(|a| a.description.clone());
    if description.is_some() {
        sources.description = Some(MetadataSource::Audible);
    }

    let publisher = audible.and_then(|a| a.publisher.clone());
    if publisher.is_some() {
        sources.publisher = Some(MetadataSource::Audible);
    }

    let year = audible.and_then(|a| a.release_date.as_ref().and_then(|d| d.get(0..4).map(|s| s.to_string())));
    if year.is_some() {
        sources.year = Some(MetadataSource::Audible);
    }

    let language = audible.and_then(|a| a.language.clone());
    if language.is_some() {
        sources.language = Some(MetadataSource::Audible);
    }

    let publish_date = audible.and_then(|a| a.release_date.clone());

    // Authors - prefer Audible
    let authors = audible
        .filter(|a| !a.authors.is_empty())
        .map(|a| {
            sources.author = Some(MetadataSource::Audible);
            a.authors.clone()
        })
        .unwrap_or_else(|| vec![author.to_string()]);

    // Build confidence based on validation
    let confidence = Some(MetadataConfidence {
        title: validation.title_confidence,
        author: validation.author_confidence,
        narrator: validation.narrator_confidence,
        series: validation.series_confidence,
        overall: (validation.title_confidence + validation.author_confidence) / 2,
        sources_used: {
            let mut src = vec!["Folder".to_string()];
            if audible.is_some() { src.push("Audible".to_string()); }
            src
        },
    });

    // Build all_series from series/sequence if present
    let all_series = if let Some(ref s) = series {
        vec![SeriesInfo::new(s.clone(), sequence.clone(), sources.series)]
    } else {
        vec![]
    };

    // Build metadata
    let metadata = BookMetadata {
        title: title.to_string(),
        author: author.to_string(),
        authors,
        subtitle: None,
        narrator,
        narrators,
        series,
        sequence,
        all_series,
        genres: vec![],
        description,
        publisher,
        year,
        isbn: None,
        asin,
        cover_url: None,
        cover_mime: None,
        language,
        abridged,
        runtime_minutes,
        explicit: None,
        publish_date,
        sources: Some(sources),
        is_collection: false,
        collection_books: vec![],
        confidence,
        // Themes/tropes - extracted later
        themes: vec![],
        tropes: vec![],
        themes_source: None,
        tropes_source: None,
    };

    // Apply FULL normalization pipeline
    normalize_metadata(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Series Extraction Tests
    // =========================================================================

    #[test]
    fn test_extract_series_simple() {
        let result = extract_all_series_from_name("Harry Potter", Some("1"));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "Harry Potter");
        assert_eq!(result[0].1, Some("1".to_string()));
    }

    #[test]
    fn test_extract_series_compound_magic_tree_house() {
        // "Magic Tree House: Merlin Missions" - CONSERVATIVE: only return sub-series
        let result = extract_all_series_from_name("Magic Tree House: Merlin Missions", Some("1"));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "Merlin Missions"); // Only the specific sub-series
        assert_eq!(result[0].1, Some("1".to_string()));
    }

    #[test]
    fn test_extract_series_colon_separated_kept_together() {
        // CONSERVATIVE: Colon-separated series are kept together, not split
        let result = extract_all_series_from_name("Discworld: Witches", Some("3"));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "Discworld: Witches"); // Kept as one series
        assert_eq!(result[0].1, Some("3".to_string()));
    }

    #[test]
    fn test_extract_series_no_split_subtitle() {
        // Should NOT split if it looks like a subtitle (contains "book")
        let result = extract_all_series_from_name("Wheel of Time: Book One", Some("1"));
        assert_eq!(result.len(), 1); // Should not split
    }

    #[test]
    fn test_extract_series_star_wars() {
        // Star Wars series with colon should stay together
        let result = extract_all_series_from_name("Star Wars: The High Republic", Some("2"));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "Star Wars: The High Republic");
        assert_eq!(result[0].1, Some("2".to_string()));
    }

    // =========================================================================
    // Folder Series Extraction Tests
    // =========================================================================

    #[test]
    fn test_folder_extraction_discworld() {
        // "Discworld 01 - The Colour of Magic" -> Series: "Discworld", Position: "1"
        let (series, position) = extract_series_from_folder("Discworld 01 - The Colour of Magic");
        assert_eq!(series, Some("Discworld".to_string()));
        assert_eq!(position, Some("1".to_string())); // Leading zero stripped
    }

    #[test]
    fn test_folder_extraction_harry_potter() {
        // "Harry Potter 3" -> Series: "Harry Potter", Position: "3"
        let (series, position) = extract_series_from_folder("Harry Potter 3");
        assert_eq!(series, Some("Harry Potter".to_string()));
        assert_eq!(position, Some("3".to_string()));
    }

    #[test]
    fn test_folder_extraction_bracket_format() {
        // "[Discworld 7] Pyramids" -> Series: "Discworld", Position: "7"
        let (series, position) = extract_series_from_folder("[Discworld 7] Pyramids");
        assert_eq!(series, Some("Discworld".to_string()));
        assert_eq!(position, Some("7".to_string()));
    }

    #[test]
    fn test_folder_extraction_book_keyword() {
        // "Wheel of Time Book 5" -> Series: "Wheel of Time", Position: "5"
        let (series, position) = extract_series_from_folder("Wheel of Time Book 5");
        assert_eq!(series, Some("Wheel of Time".to_string()));
        assert_eq!(position, Some("5".to_string()));
    }

    #[test]
    fn test_folder_extraction_no_series() {
        // "The Great Gatsby" - no series pattern
        let (series, position) = extract_series_from_folder("The Great Gatsby");
        assert_eq!(series, None);
        assert_eq!(position, None);
    }

    #[test]
    fn test_folder_extraction_rejects_title_with_dash() {
        // Should NOT extract "Discworld 01 - The Colour of Magic" as the series name
        let (series, _) = extract_series_from_folder("Discworld 01 - The Colour of Magic");
        assert_ne!(series, Some("Discworld 01 - The Colour of Magic".to_string()));
        assert_eq!(series, Some("Discworld".to_string())); // Just the series part
    }

    // =========================================================================
    // Themes and Tropes Parsing Tests
    // =========================================================================

    #[test]
    fn test_parse_themes_json_format() {
        let response = r#"{"Themes": ["Adventure", "Friendship", "Coming of Age"], "Tropes": ["Chosen One", "Magic School"]}"#;
        let result = parse_themes_and_tropes(response);
        assert!(result.is_some());
        let data = result.unwrap();
        assert_eq!(data.themes.len(), 3);
        assert!(data.themes.contains(&"Adventure".to_string()));
        assert_eq!(data.tropes.len(), 2);
        assert!(data.tropes.contains(&"Chosen One".to_string()));
    }

    #[test]
    fn test_parse_themes_plain_text_format() {
        let response = "Themes: Adventure, Friendship, Coming of Age\nTropes: Chosen One, Magic School";
        let result = parse_themes_and_tropes(response);
        assert!(result.is_some());
        let data = result.unwrap();
        assert!(data.themes.len() >= 2);
        assert!(data.tropes.len() >= 1);
    }

    #[test]
    fn test_parse_themes_lowercase_keys() {
        let response = r#"{"themes": ["Adventure"], "tropes": ["Hero's Journey"]}"#;
        let result = parse_themes_and_tropes(response);
        assert!(result.is_some());
        let data = result.unwrap();
        assert_eq!(data.themes.len(), 1);
        assert_eq!(data.tropes.len(), 1);
    }

    #[test]
    fn test_parse_themes_empty_response() {
        let response = "No themes found";
        let result = parse_themes_and_tropes(response);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_themes_limits_to_3() {
        let response = r#"{"Themes": ["One", "Two", "Three", "Four", "Five"], "Tropes": []}"#;
        let result = parse_themes_and_tropes(response);
        assert!(result.is_some());
        let data = result.unwrap();
        assert_eq!(data.themes.len(), 3); // Should be limited to 3
    }

    // =========================================================================
    // Series Name Normalization Tests
    // =========================================================================

    #[test]
    fn test_normalize_series_name_removes_series_suffix() {
        // Function should remove " Series" suffix
        assert_eq!(normalize_series_name("Harry Potter Series"), "Harry Potter");
    }

    #[test]
    fn test_normalize_series_name_removes_trilogy_suffix() {
        assert_eq!(normalize_series_name("The Hunger Games Trilogy"), "The Hunger Games");
    }

    #[test]
    fn test_normalize_series_name_removes_book_pattern() {
        assert_eq!(normalize_series_name("Wheel of Time (Book"), "Wheel of Time");
        assert_eq!(normalize_series_name("Dark Tower, Book 1"), "Dark Tower");
    }

    #[test]
    fn test_normalize_series_name_preserves_normal() {
        // Normal series names should be preserved
        assert_eq!(normalize_series_name("The Lord of the Rings"), "The Lord of the Rings");
        assert_eq!(normalize_series_name("Discworld"), "Discworld");
    }

    // =========================================================================
    // Folder Parsing Tests
    // =========================================================================

    #[test]
    fn test_parse_folder_basic() {
        let (title, author) = parse_folder_for_book_info("Brandon Sanderson - The Way of Kings");
        assert_eq!(author, "Brandon Sanderson");
        assert_eq!(title, "The Way of Kings");
    }

    #[test]
    fn test_parse_folder_with_year() {
        let (title, author) = parse_folder_for_book_info("Stephen King - It (1986)");
        assert_eq!(author, "Stephen King");
        assert!(title.contains("It"));
    }

    #[test]
    fn test_parse_folder_no_separator() {
        let (title, author) = parse_folder_for_book_info("The Great Gatsby");
        assert_eq!(title, "The Great Gatsby");
        assert!(author.is_empty());
    }

    // =========================================================================
    // Description Header Stripping Tests
    // =========================================================================

    #[test]
    fn test_strip_themes_tropes_header() {
        // Function expects plain text format starting with "Themes:" or "Tropes:"
        let desc_with_header = "Themes: Adventure · Mystery\nTropes: Chosen One\n\nActual description starts here.";
        let clean = strip_themes_tropes_header(desc_with_header);
        assert!(clean.contains("Actual description starts here"));
        assert!(!clean.contains("Themes:"));
    }

    #[test]
    fn test_strip_themes_tropes_no_header() {
        let desc = "This is just a normal description.";
        let clean = strip_themes_tropes_header(desc);
        assert_eq!(clean, desc);
    }

    #[test]
    fn test_strip_themes_tropes_only_themes() {
        let desc = "Themes: Adventure\n\nThe story begins...";
        let clean = strip_themes_tropes_header(desc);
        assert_eq!(clean, "The story begins...");
    }

    // =========================================================================
    // Series Validation Tests
    // =========================================================================

    #[test]
    fn test_is_valid_series_rejects_subseries_indicators() {
        // Discworld sub-series indicators should be rejected as standalone
        assert!(!is_valid_series("Death", "Mort"));
        assert!(!is_valid_series("Witches", "Equal Rites"));
        assert!(!is_valid_series("Wizards", "The Colour of Magic"));
        assert!(!is_valid_series("Watch", "Guards! Guards!"));
        assert!(!is_valid_series("Rincewind", "The Colour of Magic"));
    }

    #[test]
    fn test_is_valid_series_accepts_combined_subseries() {
        // Combined series with sub-series indicator should be valid
        assert!(is_valid_series("Discworld - Death", "Mort"));
        assert!(is_valid_series("Discworld: Witches", "Equal Rites"));
        assert!(is_valid_series("Discworld - Watch", "Guards! Guards!"));
    }

    #[test]
    fn test_is_valid_series_accepts_main_series() {
        // Main series names should be valid
        assert!(is_valid_series("Discworld", "Mort"));
        assert!(is_valid_series("Harry Potter", "The Philosopher's Stone"));
        assert!(is_valid_series("Wheel of Time", "The Eye of the World"));
    }

    #[test]
    fn test_is_valid_series_rejects_common_false_positives() {
        assert!(!is_valid_series("Book", "Some Title"));
        assert!(!is_valid_series("Audiobook", "Some Title"));
        assert!(!is_valid_series("Novel", "Some Title"));
        assert!(!is_valid_series("Collection", "Some Title"));
    }

    #[test]
    fn test_is_valid_series_rejects_title_as_series() {
        // Series should not be the same as the book title
        assert!(!is_valid_series("Tempest", "Tempest"));
        assert!(!is_valid_series("Tempest", "The Tempest"));
        assert!(!is_valid_series("The Tempest", "Tempest"));
        assert!(!is_valid_series("Othello", "Othello"));
        assert!(!is_valid_series("Hamlet", "Hamlet"));
        assert!(!is_valid_series("Macbeth", "Macbeth"));

        // But allow actual series names that don't match title
        assert!(is_valid_series("Arkangel Shakespeare", "Tempest"));
        assert!(is_valid_series("Shakespeare Stories", "Othello"));
    }

    #[test]
    fn test_is_valid_series_rejects_generic_marketing() {
        // Generic/marketing series should be rejected
        assert!(!is_valid_series("Timeless Classic", "Othello"));
        assert!(!is_valid_series("Timeless Classics", "Hamlet"));
        assert!(!is_valid_series("Classic Literature", "Pride and Prejudice"));
        assert!(!is_valid_series("Great Books", "1984"));
        assert!(!is_valid_series("Bestseller", "The Da Vinci Code"));
    }

    #[test]
    fn test_is_valid_series_rejects_format_specific() {
        // Format-specific series should be rejected for audiobooks
        assert!(!is_valid_series("Manga Shakespeare", "Hamlet"));
        assert!(!is_valid_series("Graphic Novel", "Watchmen"));
        assert!(!is_valid_series("Illustrated Edition", "Harry Potter"));
    }
}