// src-tauri/src/scanner/processor.rs
// IMPROVED VERSION - Smart Series Handling + Normalization
// GPT validates/chooses from candidates instead of inventing series names
// API/GPT sources are now prioritized over file metadata to prevent corrupted tags from overriding

use super::types::{AudioFile, BookGroup, BookMetadata, MetadataChange, MetadataSource, MetadataSources, ScanStatus, ScanMode, SelectiveRefreshFields};
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

fn read_file_tags(path: &str) -> FileTags {
    
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
    
    // Magic Tree House variations
    if normalized_lower.contains("magic tree house") {
        return "Magic Tree House".to_string();
    }
    
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
    
    // Remove "The " prefix for consistency (optional - some series start with "The")
    // Keep it for now as some series legitimately start with "The"
    
    normalized.trim().to_string()
}

pub async fn process_all_groups(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    scan_mode: ScanMode,
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    process_all_groups_with_options(groups, config, cancel_flag, scan_mode, None).await
}

/// Process all groups with optional selective refresh fields
pub async fn process_all_groups_with_options(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    scan_mode: ScanMode,
    selective_fields: Option<SelectiveRefreshFields>,
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    let total = groups.len();
    let start_time = std::time::Instant::now();

    println!("🚀 Processing {} book groups (mode={:?})...", total, scan_mode);

    crate::progress::update_progress(0, total, "Starting...");

    let processed = Arc::new(AtomicUsize::new(0));
    let covers_found = Arc::new(AtomicUsize::new(0));
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

            async move {
                let result = process_book_group_with_options(
                    group,
                    &config,
                    cancel_flag,
                    covers_found.clone(),
                    scan_mode,
                    (*selective_fields).clone()
                ).await;

                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                let covers = covers_found.load(Ordering::Relaxed);

                if done % 5 == 0 || done == total {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let rate = done as f64 / elapsed;
                    crate::progress::update_progress(done, total,
                        &format!("{} books ({} covers) - {:.1}/sec", done, covers, rate)
                    );
                }

                result
            }
        })
        .buffer_unordered(50)  // High concurrency for maximum throughput
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
    process_book_group_with_options(group, config, cancel_flag, covers_found, scan_mode, None).await
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
            if group.scan_status == ScanStatus::LoadedFromFile {
                println!("   ⚡ Skipping API calls for '{}' (metadata.json exists)", group.metadata.title);
                group.total_changes = calculate_changes(&mut group);
                return Ok(group);
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
    }

    let cache_key = format!("book_{}", group.group_name);

    // For selective refresh, don't use full cache - we need fresh API data for specific fields
    // For normal modes, check cache first
    if scan_mode != ScanMode::SelectiveRefresh {
        if let Some(cached_metadata) = cache::get::<BookMetadata>(&cache_key) {
            group.metadata = cached_metadata;
            group.scan_status = ScanStatus::NewScan; // Mark as scanned (from cache)
            group.total_changes = calculate_changes(&mut group);
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

    // Fetch Google Books AND Audible in parallel
    let title_clone = extracted_title.clone();
    let author_clone = extracted_author.clone();
    let google_api_key = config.google_books_api_key.clone();

    let google_future = async {
        if let Some(ref api_key) = google_api_key {
            fetch_google_books_data(&title_clone, &author_clone, api_key).await.ok().flatten()
        } else {
            None
        }
    };

    let title_clone2 = extracted_title.clone();
    let author_clone2 = extracted_author.clone();
    let audible_future = fetch_audible_metadata(&title_clone2, &author_clone2);

    let (google_data, audible_data) = tokio::join!(google_future, audible_future);

    // Log what we got from each source
    println!("📊 Data sources for '{}':", extracted_title);
    println!("   Google Books: {}", if google_data.is_some() { "✅ Found" } else { "❌ None" });
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

    // Fetch cover art (only if selective_fields includes cover or we're doing a full scan)
    let should_fetch_cover = selective_fields.as_ref().map(|f| f.cover || f.all).unwrap_or(true);
    let asin = audible_data.as_ref().and_then(|d| d.asin.clone());
    let cover_art = if should_fetch_cover {
        match crate::cover_art::fetch_and_download_cover(
            &extracted_title,
            &extracted_author,
            asin.as_deref(),
            config.google_books_api_key.as_deref(),
        ).await {
            Ok(cover) if cover.data.is_some() => {
                if let Some(ref data) = cover.data {
                    let cover_cache_key = format!("cover_{}", group.id);
                    let mime_type = cover.mime_type.clone().unwrap_or_else(|| "image/jpeg".to_string());
                    let _ = cache::set(&cover_cache_key, &(data.clone(), mime_type));
                    covers_found.fetch_add(1, Ordering::Relaxed);
                }
                Some(cover)
            }
            _ => None
        }
    } else {
        None
    };

    let needs_gpt_enrichment = google_data.is_none() && audible_data.is_none();

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
        create_metadata_from_audible(&extracted_title, &extracted_author, audible_data.unwrap(), google_data)
    } else if needs_gpt_enrichment {
        enrich_with_gpt(
            &group.group_name,
            &extracted_title,
            &extracted_author,
            &file_tags,
            config.openai_api_key.as_deref()
        ).await
    } else {
        merge_all_with_gpt_improved(
            &group.group_name,
            &extracted_title,
            &extracted_author,
            &file_tags,
            google_data,
            audible_data,
            config.openai_api_key.as_deref()
        ).await
    };

    // For selective refresh, merge only the requested fields with existing metadata
    if scan_mode == ScanMode::SelectiveRefresh {
        final_metadata = merge_selective_fields(existing_metadata, final_metadata, selective_fields);
    }

    // Add cover URL to metadata
    if let Some(cover) = cover_art {
        final_metadata.cover_url = cover.url;
        final_metadata.cover_mime = cover.mime_type;
    }

    group.metadata = final_metadata;

    // Cache the result
    let _ = cache::set(&cache_key, &group.metadata);

    // Mark as newly scanned
    group.scan_status = ScanStatus::NewScan;

    // Calculate changes
    group.total_changes = calculate_changes(&mut group);

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
    let (folder_title, folder_author) = parse_folder_for_book_info(folder_name);

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
        let clean_title = title.replace(" - Part 1", "").replace(" - Part 2", "").trim().to_string();
        if tags_are_clean(Some(&clean_title), Some(&final_author)) {
            final_title = clean_title;
        } else {
            final_title = folder_title;
        }
    } else {
        final_title = folder_title;
    }

    // STEP 4: If we have GPT, validate and clean up
    if let Some(key) = api_key {
        if !key.is_empty() {
            // Use GPT to validate/clean but NOT to discover new author
            // The author is already determined from folder/file above
            return (
                normalize::normalize_title(&final_title),
                normalize::clean_author_name(&final_author)
            );
        }
    }

    (final_title, final_author)
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
    if let Ok(book_num_regex) = regex::Regex::new(r"(?i)book\s*[#]?\d") {
        if book_num_regex.is_match(name) {
            return false;
        }
    }

    // Common false positives - series names, descriptors, etc.
    let false_positives = [
        "the ", "a ", "an ", "book", "volume", "vol", "part", "chapter",
        "audiobook", "audio", "unabridged", "abridged", "complete",
        "series", "trilogy", "saga", "collection", "tales", "stories",
        "magic", "dark", "light", "world", "house", "mystery", "spooky",
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
    if let Ok(pattern) = regex::Regex::new(r"^([^-]+?)\s*[-–]\s*(.+)$") {
        if let Some(caps) = pattern.captures(folder_name) {
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
    confidence: u8,  // 0-100
}

/// Collect series candidates from all available sources
fn collect_series_candidates(
    folder_name: &str,
    extracted_title: &str,
    audible_data: &Option<AudibleMetadata>,
    _google_data: &Option<GoogleBookData>,
) -> Vec<SeriesCandidate> {
    let mut candidates: Vec<SeriesCandidate> = Vec::new();
    let title_lower = extracted_title.to_lowercase();
    
    // 1. Audible series (highest confidence)
    if let Some(ref aud) = audible_data {
        for series in &aud.series {
            let series_lower = series.name.to_lowercase();
            
            // Validate: reject if series name matches title
            if series_lower == title_lower || title_lower.starts_with(&series_lower) {
                println!("   ⚠️ Rejecting Audible series '{}' (matches title)", series.name);
                continue;
            }
            
            candidates.push(SeriesCandidate {
                name: series.name.clone(),
                position: series.position.clone(),
                source: "audible".to_string(),
                confidence: 90,
            });
        }
    }
    
    // 2. Folder name extraction (medium confidence)
    if let (Some(series_name), position) = extract_series_from_folder(folder_name) {
        let series_lower = series_name.to_lowercase();
        
        // Validate: reject if series name matches title
        if series_lower != title_lower && !title_lower.starts_with(&series_lower) {
            candidates.push(SeriesCandidate {
                name: series_name,
                position,
                source: "folder".to_string(),
                confidence: 60,
            });
        }
    }
    
    candidates
}

/// Validate a series name against the title
fn is_valid_series(series: &str, title: &str) -> bool {
    let series_lower = series.to_lowercase().trim().to_string();
    let title_lower = title.to_lowercase().trim().to_string();
    
    // Normalize "and" vs "&" for comparison
    let series_normalized = series_lower.replace(" & ", " and ").replace("&", " and ");
    let title_normalized = title_lower.replace(" & ", " and ").replace("&", " and ");
    
    // Reject if series EXACTLY matches the full title (not just a prefix)
    if series_normalized == title_normalized {
        println!("   ⚠️ Rejecting series '{}' - exact match with title", series);
        return false;
    }
    
    // Reject if series is very long and matches most of the title
    // (This catches cases where full title is used as series)
    if series_normalized.len() > 30 && title_normalized.starts_with(&series_normalized) {
        let remaining = title_normalized.len() - series_normalized.len();
        if remaining < 10 {
            println!("   ⚠️ Rejecting series '{}' - too similar to full title", series);
            return false;
        }
    }
    
    // Reject common false positives
    let false_positives = [
        "book", "audiobook", "audio", "unabridged", "novel", "story",
        "fiction", "non-fiction", "chapter", "part", "volume"
    ];
    if false_positives.iter().any(|fp| series_lower == *fp) {
        println!("   ⚠️ Rejecting series '{}' - common false positive", series);
        return false;
    }
    
    // Reject if series looks like a full book title (contains subtitle markers)
    if series_lower.contains(": ") || series_lower.contains(" - ") {
        // But allow if it's clearly a series name with subtitle
        if !series_lower.contains("series") && series_lower.len() > 50 {
            println!("   ⚠️ Rejecting series '{}' - looks like full title with subtitle", series);
            return false;
        }
    }
    
    true
}

/// IMPROVED merge function that handles series intelligently
async fn merge_all_with_gpt_improved(
    folder_name: &str,
    extracted_title: &str,
    extracted_author: &str,
    file_tags: &FileTags,
    google_data: Option<GoogleBookData>,
    audible_data: Option<AudibleMetadata>,
    api_key: Option<&str>
) -> BookMetadata {
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            return fallback_metadata(extracted_title, extracted_author, google_data, audible_data, None);
        }
    };
    
    // Step 1: Collect series candidates from all sources
    let series_candidates = collect_series_candidates(
        folder_name, 
        extracted_title, 
        &audible_data, 
        &google_data
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
    
    // Extract year
    let reliable_year = audible_data.as_ref()
        .and_then(|d| d.release_date.clone())
        .and_then(|date| date.split('-').next().map(|s| s.to_string()))
        .or_else(|| google_data.as_ref().and_then(|d| d.year.clone()));
    
    // Build summaries for GPT
    let google_summary = if let Some(ref data) = google_data {
        format!(
            "Title: {:?}, Subtitle: {:?}, Publisher: {:?}, Year: {:?}, Genres: {:?}",
            data.subtitle, data.subtitle, data.publisher, data.year, data.genres
        )
    } else {
        "No data".to_string()
    };
    
    let audible_summary = if let Some(ref data) = audible_data {
        format!(
            "Title: {:?}, Authors: {:?}, Narrators: {:?}, Publisher: {:?}, Release Date: {:?}",
            data.title, data.authors, data.narrators, data.publisher, data.release_date
        )
    } else {
        "No data".to_string()
    };
    
    let year_instruction = if let Some(ref year) = reliable_year {
        format!("CRITICAL: Use EXACTLY this year: {} (from Audible/Google Books - DO NOT CHANGE)", year)
    } else {
        "year: If not found in sources, return null".to_string()
    };
    
    // Build the IMPROVED prompt
    let prompt = format!(
r#"You are an audiobook metadata specialist. Combine information from all sources to produce the most accurate metadata.

SOURCES:
1. Folder: {}
2. Extracted from tags: title='{}', author='{}'
3. Google Books: {}
4. Audible: {}
5. Sample comment: {:?}

{}

APPROVED GENRES (maximum 3):
{}

CRITICAL AUTHOR RULE:
The author '{}' was extracted from file tags/folder name. This is likely the CORRECT author.
If Google Books or Audible returned a DIFFERENT author, they may have returned the WRONG book.
ALWAYS prefer the extracted author '{}' unless the folder name was clearly wrong or "Unknown".
NEVER replace a valid author like "Will Wight" with a completely different author like "J.K. Rowling".

OUTPUT FIELDS:
* title: Book title only. Remove junk and series markers.
* subtitle: Use only if provided by Google Books or Audible.
* author: CRITICAL - Use '{}' unless it was "Unknown" or clearly wrong.
* narrator: Use Audible narrators or find in comments.
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
* publisher: Prefer Google Books or Audible.
* {}
* description: Short description from sources, minimum 200 characters.
* isbn: From Google Books.

SERIES RULES:
1. Series name must be SHORT - just the series umbrella name
2. NEVER use the full book title as the series name
3. If Audible provides series, clean it up (remove "(Book", trailing commas, etc.)

Return ONLY valid JSON:
{{
  "title": "specific book title",
  "subtitle": null,
  "author": "author name",
  "narrator": "narrator name or null",
  "series": "SHORT series name or null",
  "sequence": "number or null",
  "genres": ["Genre1", "Genre2"],
  "publisher": "publisher or null",
  "year": "YYYY or null",
  "description": "description or null",
  "isbn": "isbn or null"
}}

JSON:"#,
        folder_name,
        extracted_title,
        extracted_author,
        google_summary,
        audible_summary,
        file_tags.comment,
        series_instruction,
        crate::genres::APPROVED_GENRES.join(", "),
        extracted_author, // for CRITICAL AUTHOR RULE line 1
        extracted_author, // for CRITICAL AUTHOR RULE line 2
        extracted_author, // for OUTPUT FIELDS author line
        year_instruction
    );
    
    match call_gpt_api(&prompt, api_key, "gpt-4o-mini", 1000).await {
        Ok(json_str) => {
            match serde_json::from_str::<BookMetadata>(&json_str) {
                Ok(mut metadata) => {
                    // Initialize sources tracking
                    let mut sources = MetadataSources::default();

                    // GPT cleaned/enhanced the basic fields
                    sources.title = Some(MetadataSource::Gpt);
                    sources.author = Some(MetadataSource::Gpt);
                    if metadata.subtitle.is_some() {
                        sources.subtitle = if google_data.is_some() { Some(MetadataSource::GoogleBooks) } else { Some(MetadataSource::Gpt) };
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
                        sources.publisher = if google_data.is_some() { Some(MetadataSource::GoogleBooks) } else if audible_data.is_some() { Some(MetadataSource::Audible) } else { Some(MetadataSource::Gpt) };
                    }
                    if metadata.description.is_some() {
                        sources.description = Some(MetadataSource::Gpt);
                    }

                    // Override with reliable year
                    if let Some(year) = reliable_year.clone() {
                        metadata.year = Some(year);
                        sources.year = if audible_data.as_ref().and_then(|d| d.release_date.clone()).is_some() {
                            Some(MetadataSource::Audible)
                        } else {
                            Some(MetadataSource::GoogleBooks)
                        };
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

                        // Multiple narrators (Audible is authoritative)
                        if !aud.narrators.is_empty() {
                            metadata.narrators = aud.narrators.clone();
                            sources.narrator = Some(MetadataSource::Audible);
                            // Also set legacy narrator field
                            if metadata.narrator.is_none() {
                                metadata.narrator = aud.narrators.first().cloned();
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

                    // ISBN from Google Books (more reliable for ISBN)
                    if metadata.isbn.is_none() {
                        metadata.isbn = google_data.as_ref().and_then(|d| d.isbn.clone());
                    }
                    if metadata.isbn.is_some() {
                        sources.isbn = Some(MetadataSource::GoogleBooks);
                    }

                    // Set sources
                    metadata.sources = Some(sources);

                    // Apply normalization before returning
                    normalize_metadata(metadata)
                }
                Err(e) => {
                    println!("   ❌ GPT parse error: {}", e);
                    normalize_metadata(fallback_metadata(extracted_title, extracted_author, google_data, audible_data, reliable_year))
                }
            }
        }
        Err(e) => {
            println!("   ❌ GPT API error: {}", e);
            normalize_metadata(fallback_metadata(extracted_title, extracted_author, google_data, audible_data, reliable_year))
        }
    }
}

// ============================================================================
// SUPPORTING FUNCTIONS (mostly unchanged)
// ============================================================================

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
struct AudibleMetadata {
    asin: Option<String>,
    title: Option<String>,
    authors: Vec<String>,
    narrators: Vec<String>,
    series: Vec<AudibleSeries>,
    publisher: Option<String>,
    release_date: Option<String>,
    description: Option<String>,
    /// ISO language code (e.g., "en", "es")
    language: Option<String>,
    /// Runtime in minutes
    runtime_minutes: Option<u32>,
    /// Whether the audiobook is abridged
    abridged: Option<bool>,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
struct AudibleSeries {
    name: String,
    position: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
struct GoogleBookData {
    subtitle: Option<String>,
    description: Option<String>,
    publisher: Option<String>,
    year: Option<String>,
    genres: Vec<String>,
    isbn: Option<String>,
    authors: Vec<String>,
}

fn fallback_metadata(
    extracted_title: &str,
    extracted_author: &str,
    google_data: Option<GoogleBookData>,
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
        .or_else(|| {
            google_data.as_ref()
                .filter(|d| !d.authors.is_empty())
                .map(|d| {
                    sources.author = Some(MetadataSource::GoogleBooks);
                    d.authors.clone()
                })
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

    // Track other sources based on availability
    let subtitle = google_data.as_ref().and_then(|d| {
        if d.subtitle.is_some() {
            sources.subtitle = Some(MetadataSource::GoogleBooks);
        }
        d.subtitle.clone()
    });

    // Split combined genres (Google Books uses hierarchical format like "Fiction / Thrillers / Suspense")
    let mut genres = google_data.as_ref().map(|d| {
        if !d.genres.is_empty() {
            sources.genres = Some(MetadataSource::GoogleBooks);
        }
        crate::genres::split_combined_genres(&d.genres)
    }).unwrap_or_default();

    // Enforce age-specific children's genres
    if !genres.is_empty() {
        crate::genres::enforce_children_age_genres(
            &mut genres,
            extracted_title,
            series.as_deref(),
            authors.first().map(|s| s.as_str()),
        );
    }

    let publisher = google_data.as_ref().and_then(|d| d.publisher.clone())
        .map(|p| {
            sources.publisher = Some(MetadataSource::GoogleBooks);
            p
        })
        .or_else(|| audible_data.as_ref().and_then(|d| d.publisher.clone()).map(|p| {
            sources.publisher = Some(MetadataSource::Audible);
            p
        }));

    let description = google_data.as_ref().and_then(|d| d.description.clone())
        .map(|d| {
            sources.description = Some(MetadataSource::GoogleBooks);
            d
        })
        .or_else(|| audible_data.as_ref().and_then(|d| d.description.clone()).map(|d| {
            sources.description = Some(MetadataSource::Audible);
            d
        }));

    let isbn = google_data.as_ref().and_then(|d| {
        if d.isbn.is_some() {
            sources.isbn = Some(MetadataSource::GoogleBooks);
        }
        d.isbn.clone()
    });

    let asin = audible_data.as_ref().and_then(|d| {
        if d.asin.is_some() {
            sources.asin = Some(MetadataSource::Audible);
        }
        d.asin.clone()
    });

    // Track year source
    if reliable_year.is_some() {
        sources.year = if audible_data.as_ref().and_then(|d| d.release_date.clone()).is_some() {
            Some(MetadataSource::Audible)
        } else {
            Some(MetadataSource::GoogleBooks)
        };
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
    BookMetadata {
        title: extracted_title.to_string(),
        subtitle,
        author,
        narrator,
        series,
        sequence,
        genres,
        publisher,
        year: reliable_year.clone(),
        description,
        isbn,
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
    }
}

/// PERFORMANCE: Create metadata directly from Audible without GPT
/// Used when Audible data is complete enough to skip GPT entirely
fn create_metadata_from_audible(
    extracted_title: &str,
    extracted_author: &str,
    audible_data: AudibleMetadata,
    google_data: Option<GoogleBookData>,
) -> BookMetadata {
    let mut sources = MetadataSources::default();

    // Title from Audible or extracted
    let title = audible_data.title.clone().unwrap_or_else(|| extracted_title.to_string());
    sources.title = Some(MetadataSource::Audible);

    // Author from Audible -> Google Books -> folder
    let authors = if !audible_data.authors.is_empty() {
        sources.author = Some(MetadataSource::Audible);
        audible_data.authors.clone()
    } else if let Some(ref gd) = google_data {
        if !gd.authors.is_empty() {
            sources.author = Some(MetadataSource::GoogleBooks);
            gd.authors.clone()
        } else if extracted_author.to_lowercase() != "unknown" {
            sources.author = Some(MetadataSource::Folder);
            split_authors(extracted_author)
        } else {
            vec![]
        }
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

    // Series from Audible
    let (series, sequence) = audible_data.series.first()
        .map(|s| {
            if is_valid_series(&s.name, &title) {
                sources.series = Some(MetadataSource::Audible);
                sources.sequence = Some(MetadataSource::Audible);
                (Some(normalize_series_name(&s.name)), s.position.clone())
            } else {
                (None, None)
            }
        })
        .unwrap_or((None, None));

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

    // Publisher from Audible or Google
    let publisher = audible_data.publisher.clone()
        .map(|p| { sources.publisher = Some(MetadataSource::Audible); p })
        .or_else(|| google_data.as_ref().and_then(|d| {
            d.publisher.clone().map(|p| { sources.publisher = Some(MetadataSource::GoogleBooks); p })
        }));

    // Genres from Google (Audible doesn't have genres)
    // Split combined genres (Google Books uses hierarchical format like "Fiction / Thrillers / Suspense")
    let mut genres = google_data.as_ref()
        .map(|d| {
            if !d.genres.is_empty() {
                sources.genres = Some(MetadataSource::GoogleBooks);
            }
            // Split combined genre strings into individual genres
            crate::genres::split_combined_genres(&d.genres)
        })
        .unwrap_or_default();

    // Enforce age-specific children's genres
    if !genres.is_empty() {
        crate::genres::enforce_children_age_genres(
            &mut genres,
            &title,
            series.as_deref(),
            authors.first().map(|s| s.as_str()),
        );
    }

    // ISBN from Google
    let isbn = google_data.as_ref().and_then(|d| {
        if d.isbn.is_some() {
            sources.isbn = Some(MetadataSource::GoogleBooks);
        }
        d.isbn.clone()
    });

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

    // Subtitle from Google
    let subtitle = google_data.as_ref().and_then(|d| {
        if d.subtitle.is_some() {
            sources.subtitle = Some(MetadataSource::GoogleBooks);
        }
        d.subtitle.clone()
    });

    normalize_metadata(BookMetadata {
        title,
        subtitle,
        author,
        narrator,
        series,
        sequence,
        genres,
        publisher,
        year,
        description,
        isbn,
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
    })
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
    api_key: Option<&str>
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

            return BookMetadata {
                title: extracted_title.to_string(),
                author: extracted_author.to_string(),
                subtitle: None,
                narrator: None,
                series: series.map(|s| normalize_series_name(&s)),
                sequence,
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
            };
        }
    };

    // IMPROVED prompt - encourage GPT to use knowledge for well-known series
    let prompt = format!(
r#"You are enriching audiobook metadata using your knowledge.

FOLDER NAME: {}
TITLE: {}
AUTHOR: {}
COMMENT TAG: {:?}

Based on your knowledge, provide metadata for this audiobook:

1. Narrator: Check comment field or use your knowledge
2. Series: If this book is part of a known series, provide the series name. Examples:
   - "Mr. Putter and Tabby Pour the Tea" → series: "Mr. Putter & Tabby"
   - "Harry Potter and the Sorcerer's Stone" → series: "Harry Potter"
   - "The Name of the Wind" → series: "The Kingkiller Chronicle"
   - "1984" → series: null (standalone book)
   The series name should be SHORT (just the series name, not the full book title).

3. Sequence: Find the book's position in the series publication order.
   
   For "Mr. Putter & Tabby" by Cynthia Rylant, here are the CORRECT positions:
   - "Pour the Tea" = 1
   - "Walk the Dog" = 2
   - "Bake the Cake" = 3
   - "Pick the Pears" = 4
   - "Row the Boat" = 5
   - "Fly the Plane" = 6
   - "Toot the Horn" = 7
   - "Take the Train" = 8
   - "Paint the Porch" = 9
   - "Feed the Fish" = 10
   - "Catch the Cold" = 11
   - "Stir the Soup" = 12
   - "Write the Book" = 13
   - "Make a Wish" = 14
   - "Spin the Yarn" = 15
   - "Run the Race" = 16
   - "Spill the Beans" = 17
   - "Clear the Decks" = 18
   - "Ring the Bell" = 19
   - "Dance the Dance" = 20
   - "Turn the Page" = 21
   - "See the Stars" = 22
   - "Hit the Slope" = 23
   - "Drop the Ball" = 24
   
   MATCH the book title to this list and return the corresponding number.
   For other series, use your knowledge of publication order.

4. Genres: Provide 1-3 appropriate genres from this list: {}
5. Publisher: If you know the publisher
6. Year: Publication year AS A STRING (YYYY format)
7. Description: A brief 2-3 sentence description

Return ONLY valid JSON:
{{
  "narrator": "narrator or null",
  "series": "SHORT series name or null",
  "sequence": "correct position number or null",
  "genres": ["Genre1", "Genre2"],
  "publisher": "publisher or null",
  "year": "YYYY or null",
  "description": "description or null"
}}

JSON:"#,
        folder_name,
        extracted_title,
        extracted_author,
        file_tags.comment,
        crate::genres::APPROVED_GENRES.join(", ")
    );
    
    match call_gpt_api(&prompt, api_key, "gpt-4o-mini", 800).await {
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
                    
                    // Get and VALIDATE series
                    let raw_series = json.get("series").and_then(get_string);
                    let sequence = json.get("sequence").and_then(get_string);

                    let (series, sequence) = if let Some(ref s) = raw_series {
                        if is_valid_series(s, extracted_title) {
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

                    // Build sources tracking
                    let mut sources = MetadataSources::default();
                    sources.title = Some(MetadataSource::Folder);
                    sources.author = Some(MetadataSource::Folder);
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

                    normalize_metadata(BookMetadata {
                        title: extracted_title.to_string(),
                        author: extracted_author.to_string(),
                        subtitle: None,
                        narrator: narrator.clone(),
                        series,
                        sequence,
                        genres,
                        publisher,
                        year,
                        description,
                        isbn: None,
                        asin: None,
                        cover_mime: None,
                        cover_url: None,
                        // NEW FIELDS
                        authors: split_authors(extracted_author),
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
                    })
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
                    normalize_metadata(BookMetadata {
                        title: extracted_title.to_string(),
                        author: extracted_author.to_string(),
                        subtitle: None,
                        narrator: None,
                        series: series.map(|s| normalize_series_name(&s)),
                        sequence,
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
            normalize_metadata(BookMetadata {
                title: extracted_title.to_string(),
                author: extracted_author.to_string(),
                subtitle: None,
                narrator: None,
                series: series.map(|s| normalize_series_name(&s)),
                sequence,
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
            })
        }
    }
}

async fn call_gpt_api(
    prompt: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();
    
    let is_gpt5 = model.starts_with("gpt-5");
    
    let body = if is_gpt5 {
        serde_json::json!({
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
            ],
            "max_completion_tokens": max_tokens + 2000,
            "reasoning_effort": "high"
        })
    } else {
        serde_json::json!({
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
            ],
            "temperature": 0.3,
            "max_tokens": max_tokens
        })
    };
    
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await?;
    
    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("GPT API error: {}", error_text).into());
    }
    
    let response_text = response.text().await?;
    
    #[derive(serde::Deserialize)]
    struct Response { choices: Vec<Choice> }
    
    #[derive(serde::Deserialize)]
    struct Choice { message: Message }
    
    #[derive(serde::Deserialize)]
    struct Message { content: String }
    
    let result: Response = serde_json::from_str(&response_text)?;
    
    let content = result.choices.first()
        .ok_or("No GPT response")?
        .message.content.trim();
    
    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    
    Ok(json_str.to_string())
}

async fn fetch_google_books_data(
    title: &str,
    author: &str,
    api_key: &str,
) -> Result<Option<GoogleBookData>, Box<dyn std::error::Error + Send + Sync>> {
    // PERFORMANCE: Cache Google Books lookups by title+author
    let cache_key = format!("google_{}_{}", title.to_lowercase().replace(' ', "_"), author.to_lowercase().replace(' ', "_"));
    if let Some(cached) = cache::get::<Option<GoogleBookData>>(&cache_key) {
        println!("   ⚡ Google Books cache hit for '{}'", title);
        return Ok(cached);
    }

    // Don't include "Unknown" in the search - it hurts results
    let query = if author.to_lowercase() == "unknown" || author.is_empty() {
        format!("intitle:{}", title)
    } else {
        format!("intitle:{} inauthor:{}", title, author)
    };
    let encoded_query = query
        .replace(' ', "+")
        .replace('&', "%26")
        .replace('\'', "%27")
        .replace(':', "%3A");

    // Fetch multiple results to find best author match
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&key={}&maxResults=5",
        encoded_query, api_key
    );

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let json: serde_json::Value = response.json().await?;

    let items = match json["items"].as_array() {
        Some(arr) => arr,
        None => return Ok(None),
    };

    // Find the best matching result by validating author
    let expected_author = author.to_lowercase();
    let mut best_match: Option<&serde_json::Value> = None;
    let mut best_score = 0;

    for item in items {
        let volume_info = &item["volumeInfo"];
        let item_authors: Vec<String> = volume_info["authors"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

        // Check if any author matches
        let author_matches = item_authors.iter().any(|a| {
            crate::normalize::authors_match(author, a)
        });

        if author_matches {
            // Perfect match - use this one
            best_match = Some(item);
            best_score = 100;
            break;
        } else if best_score == 0 {
            // Keep first result as fallback if no author match found
            best_match = Some(item);
        }
    }

    let item = match best_match {
        Some(i) => i,
        None => return Ok(None),
    };

    // Log if we're using a fallback (no author match)
    if best_score == 0 && !expected_author.is_empty() && expected_author != "unknown" {
        let found_authors: Vec<String> = item["volumeInfo"]["authors"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        println!("   ⚠️ Google Books: No exact author match for '{}'. Found: {:?}", author, found_authors);
    }

    let volume_info = &item["volumeInfo"];

    let result = GoogleBookData {
        subtitle: volume_info["subtitle"].as_str().map(|s| s.to_string()),
        description: volume_info["description"].as_str().map(|s| s.to_string()),
        publisher: volume_info["publisher"].as_str().map(|s| s.to_string()),
        year: volume_info["publishedDate"].as_str()
            .and_then(|d| d.split('-').next().map(|s| s.to_string())),
        genres: volume_info["categories"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
        isbn: volume_info["industryIdentifiers"]
            .as_array()
            .and_then(|arr| {
                arr.iter()
                    .find(|id| id["type"].as_str() == Some("ISBN_13"))
                    .or_else(|| arr.iter().find(|id| id["type"].as_str() == Some("ISBN_10")))
                    .and_then(|id| id["identifier"].as_str().map(|s| s.to_string()))
            }),
        authors: volume_info["authors"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
    };

    // Cache the result for future lookups
    let _ = cache::set(&cache_key, &Some(result.clone()));
    Ok(Some(result))
}

async fn fetch_audible_metadata(title: &str, author: &str) -> Option<AudibleMetadata> {
    // PERFORMANCE: Cache Audible lookups by title+author
    let cache_key = format!("audible_{}_{}", title.to_lowercase().replace(' ', "_"), author.to_lowercase().replace(' ', "_"));
    if let Some(cached) = cache::get::<Option<AudibleMetadata>>(&cache_key) {
        println!("   ⚡ Audible cache hit for '{}'", title);
        return cached;
    }

    // Don't include "Unknown" in the search - it hurts results
    let search_query = if author.to_lowercase() == "unknown" || author.is_empty() {
        title.to_string()
    } else {
        format!("{} {}", title, author)
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

    // Parse ASIN from search results
    let asin_regex = regex::Regex::new(r#"/pd/[^/]+/([A-Z0-9]{10})"#).ok()?;
    let asin = asin_regex.captures(&html)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())?;

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

    let series_vec = if let Some(name) = series_name {
        vec![AudibleSeries {
            name,
            position: series_position,
        }]
    } else {
        vec![]
    };

    let result = AudibleMetadata {
        asin: Some(asin),
        title: extracted_title,
        authors: extracted_authors,
        narrators: extracted_narrators,
        series: series_vec,
        publisher,
        release_date,
        description,
        language,
        runtime_minutes,
        abridged,
    };

    // Cache the result for future lookups
    let _ = cache::set(&cache_key, &Some(result.clone()));
    Some(result)
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

fn extract_series_from_folder(folder_name: &str) -> (Option<String>, Option<String>) {
    if let Some(book_num) = extract_book_number_from_folder(folder_name) {
        let patterns = [
            regex::Regex::new(r"(.+?)\s+(?:Book\s*[#]?)?\d+").ok(),
            regex::Regex::new(r"(.+?)\s+[#]\d+").ok(),
            regex::Regex::new(r"\[(.+?)\s+\d+\]").ok(),
        ];
        
        for pattern in patterns.iter().flatten() {
            if let Some(caps) = pattern.captures(folder_name) {
                if let Some(series_name) = caps.get(1) {
                    return (Some(normalize_series_name(series_name.as_str().trim())), Some(book_num));
                }
            }
        }
        
        return (None, Some(book_num));
    }
    
    (None, None)
}

fn extract_book_number_from_folder(folder: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?i)book\s*[#]?(\d+)|[#](\d+)|[-_\s](\d{2})[-_\s]").ok()?;
    if let Some(caps) = re.captures(folder) {
        caps.get(1)
            .or_else(|| caps.get(2))
            .or_else(|| caps.get(3))
            .map(|m| m.as_str().to_string())
    } else {
        None
    }
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
        match call_gpt_api(&prompt, api_key, "gpt-4o-mini", 300).await {
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
    let mut total_changes = 0;

    for file in &mut group.files {
        file.changes.clear();

        // Read current tags from file to compare
        let current = read_file_tags(&file.path);

        // CRITICAL FIX: ALWAYS include all metadata fields for metadata.json writing
        // Previously only changed fields were included, causing empty values when writing

        // Title - ALWAYS include
        let title_changed = current.title.as_ref() != Some(&group.metadata.title);
        file.changes.insert("title".to_string(), MetadataChange {
            old: current.title.clone().unwrap_or_default(),
            new: group.metadata.title.clone(),
        });
        if title_changed { total_changes += 1; }

        // Author (primary) - ALWAYS include
        let author_changed = current.artist.as_ref() != Some(&group.metadata.author);
        file.changes.insert("author".to_string(), MetadataChange {
            old: current.artist.clone().unwrap_or_default(),
            new: group.metadata.author.clone(),
        });
        if author_changed { total_changes += 1; }

        // Authors array - ALWAYS include (JSON array for metadata.json)
        let authors_json = serde_json::to_string(&group.metadata.authors).unwrap_or_else(|_| "[]".to_string());
        file.changes.insert("authors_json".to_string(), MetadataChange {
            old: String::new(),
            new: authors_json,
        });

        // Album = Title - ALWAYS include
        let album_changed = current.album.as_ref() != Some(&group.metadata.title);
        file.changes.insert("album".to_string(), MetadataChange {
            old: current.album.clone().unwrap_or_default(),
            new: group.metadata.title.clone(),
        });
        if album_changed { total_changes += 1; }

        // Subtitle - ALWAYS include if present
        if let Some(ref subtitle) = group.metadata.subtitle {
            file.changes.insert("subtitle".to_string(), MetadataChange {
                old: String::new(),
                new: subtitle.clone(),
            });
        }

        // Narrators array - ALWAYS include (JSON array for metadata.json)
        let narrators_json = serde_json::to_string(&group.metadata.narrators).unwrap_or_else(|_| "[]".to_string());
        file.changes.insert("narrators_json".to_string(), MetadataChange {
            old: String::new(),
            new: narrators_json,
        });

        // Narrator (single string for audio file tags) - ALWAYS include if present
        if !group.metadata.narrators.is_empty() {
            let narrators_str = group.metadata.narrators.join("; ");
            file.changes.insert("narrator".to_string(), MetadataChange {
                old: String::new(),
                new: narrators_str,
            });
            total_changes += 1;
        } else if let Some(ref narrator) = group.metadata.narrator {
            file.changes.insert("narrator".to_string(), MetadataChange {
                old: String::new(),
                new: narrator.clone(),
            });
            total_changes += 1;
        }

        // Genres - ALWAYS include (even empty)
        let genres_str = group.metadata.genres.join(", ");
        let genre_changed = current.genre.as_ref().map(|g| g.as_str()) != Some(&genres_str);
        file.changes.insert("genre".to_string(), MetadataChange {
            old: current.genre.clone().unwrap_or_default(),
            new: genres_str,
        });
        if genre_changed && !group.metadata.genres.is_empty() { total_changes += 1; }

        // Genres array - ALWAYS include (JSON array for metadata.json)
        let genres_json = serde_json::to_string(&group.metadata.genres).unwrap_or_else(|_| "[]".to_string());
        file.changes.insert("genres_json".to_string(), MetadataChange {
            old: String::new(),
            new: genres_json,
        });

        // Series - include if present
        if let Some(ref series) = group.metadata.series {
            file.changes.insert("series".to_string(), MetadataChange {
                old: String::new(),
                new: series.clone(),
            });
            total_changes += 1;
        }

        // Sequence - include if present
        if let Some(ref sequence) = group.metadata.sequence {
            file.changes.insert("sequence".to_string(), MetadataChange {
                old: String::new(),
                new: sequence.clone(),
            });
            total_changes += 1;
        }

        // Description - include if present
        if let Some(ref description) = group.metadata.description {
            file.changes.insert("description".to_string(), MetadataChange {
                old: current.comment.clone().unwrap_or_default(),
                new: description.clone(),
            });
            total_changes += 1;
        }

        // Year - ALWAYS include if present
        if let Some(ref year) = group.metadata.year {
            let year_changed = current.year.as_ref() != Some(year);
            file.changes.insert("year".to_string(), MetadataChange {
                old: current.year.clone().unwrap_or_default(),
                new: year.clone(),
            });
            if year_changed { total_changes += 1; }
        }

        // ASIN - include if present
        if let Some(ref asin) = group.metadata.asin {
            file.changes.insert("asin".to_string(), MetadataChange {
                old: String::new(),
                new: asin.clone(),
            });
            total_changes += 1;
        }

        // ISBN - include if present
        if let Some(ref isbn) = group.metadata.isbn {
            file.changes.insert("isbn".to_string(), MetadataChange {
                old: String::new(),
                new: isbn.clone(),
            });
            total_changes += 1;
        }

        // Language - include if present
        if let Some(ref language) = group.metadata.language {
            file.changes.insert("language".to_string(), MetadataChange {
                old: String::new(),
                new: language.clone(),
            });
            total_changes += 1;
        }

        // Publisher - include if present
        if let Some(ref publisher) = group.metadata.publisher {
            file.changes.insert("publisher".to_string(), MetadataChange {
                old: String::new(),
                new: publisher.clone(),
            });
            total_changes += 1;
        }

        // Cover URL - include if present (for cover downloading)
        if let Some(ref cover_url) = group.metadata.cover_url {
            file.changes.insert("cover_url".to_string(), MetadataChange {
                old: String::new(),
                new: cover_url.clone(),
            });
        }
    }

    total_changes
}