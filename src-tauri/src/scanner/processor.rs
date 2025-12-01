// src-tauri/src/scanner/processor.rs
// IMPROVED VERSION - Smart Series Handling + Normalization
// GPT validates/chooses from candidates instead of inventing series names

use super::types::{AudioFile, BookGroup, BookMetadata, MetadataChange, MetadataSource, MetadataSources, ScanStatus};
use crate::cache;
use crate::config::Config;
use crate::normalize;
use futures::stream::{self, StreamExt};
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
    force: bool,
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    let total = groups.len();
    let start_time = std::time::Instant::now();

    println!("🚀 Processing {} book groups (force={})...", total, force);

    crate::progress::update_progress(0, total, "Starting...");

    let processed = Arc::new(AtomicUsize::new(0));
    let covers_found = Arc::new(AtomicUsize::new(0));
    let config = Arc::new(config.clone());

    // Process with controlled concurrency
    let results: Vec<BookGroup> = stream::iter(groups)
        .map(|group| {
            let config = config.clone();
            let cancel_flag = cancel_flag.clone();
            let processed = processed.clone();
            let covers_found = covers_found.clone();
            let total = total;
            let force = force;

            async move {
                let result = process_book_group(group, &config, cancel_flag, covers_found.clone(), force).await;
                
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
        .buffer_unordered(20)  // Increased concurrency for better throughput
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
    mut group: BookGroup,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    covers_found: Arc<AtomicUsize>,
    force: bool,
) -> Result<BookGroup, Box<dyn std::error::Error + Send + Sync>> {

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }

    // SKIP API CALLS if metadata was loaded from existing metadata.json (unless force=true)
    if !force && group.scan_status == ScanStatus::LoadedFromFile {
        println!("   ⚡ Skipping API calls for '{}' (metadata.json exists)", group.metadata.title);
        group.total_changes = calculate_changes(&mut group);
        return Ok(group);
    }

    if force && group.scan_status == ScanStatus::LoadedFromFile {
        println!("   🔄 Force rescan for '{}' (ignoring metadata.json)", group.metadata.title);
    }

    let cache_key = format!("book_{}", group.group_name);

    // Check cache first
    if let Some(cached_metadata) = cache::get::<BookMetadata>(&cache_key) {
        group.metadata = cached_metadata;
        group.scan_status = ScanStatus::NewScan; // Mark as scanned (from cache)
        group.total_changes = calculate_changes(&mut group);
        return Ok(group);
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
    
    // Extract title/author with GPT
    let (extracted_title, extracted_author) = extract_book_info_with_gpt(
        &raw_file,
        &group.group_name,
        config.openai_api_key.as_deref()
    ).await;
    
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
    }
    
    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }
    
    // Fetch cover art
    let asin = audible_data.as_ref().and_then(|d| d.asin.clone());
    let cover_art = match crate::cover_art::fetch_and_download_cover(
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

    // Merge metadata with IMPROVED series handling
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

OUTPUT FIELDS:
* title: Book title only. Remove junk and series markers.
* subtitle: Use only if provided by Google Books or Audible.
* author: Clean and standardized.
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

    // Get all authors, split if contains "&" or "and"
    let authors = audible_data.as_ref()
        .map(|d| {
            if !d.authors.is_empty() {
                sources.author = Some(MetadataSource::Audible);
            }
            d.authors.clone()
        })
        .unwrap_or_else(|| {
            sources.author = Some(MetadataSource::Folder);
            split_authors(extracted_author)
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

    let mut genres = google_data.as_ref().map(|d| {
        if !d.genres.is_empty() {
            sources.genres = Some(MetadataSource::GoogleBooks);
        }
        d.genres.clone()
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

    // Note: normalize_metadata is called by the callers of fallback_metadata
    BookMetadata {
        title: extracted_title.to_string(),
        subtitle,
        author: extracted_author.to_string(),
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

    // Author from Audible
    let author = audible_data.authors.first()
        .cloned()
        .unwrap_or_else(|| extracted_author.to_string());
    let authors = if !audible_data.authors.is_empty() {
        sources.author = Some(MetadataSource::Audible);
        audible_data.authors.clone()
    } else {
        split_authors(extracted_author)
    };

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
    let mut genres = google_data.as_ref()
        .map(|d| {
            if !d.genres.is_empty() {
                sources.genres = Some(MetadataSource::GoogleBooks);
            }
            d.genres.clone()
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
                    let genres = json.get("genres").map(get_string_array).unwrap_or_default();

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

    let query = format!("intitle:{} inauthor:{}", title, author);
    let encoded_query = query
        .replace(' ', "+")
        .replace('&', "%26")
        .replace('\'', "%27")
        .replace(':', "%3A");

    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&key={}&maxResults=1",
        encoded_query, api_key
    );

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;
    
    if !response.status().is_success() {
        return Ok(None);
    }
    
    let json: serde_json::Value = response.json().await?;
    
    let item = match json["items"].get(0) {
        Some(i) => i,
        None => return Ok(None),
    };
    
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

    let search_query = format!("{} {}", title, author);
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

    // Extract ALL authors (not just first)
    let author_regex = regex::Regex::new(r#"/author/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
    let extracted_authors: Vec<String> = author_regex
        .captures_iter(&product_html)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    // Extract ALL narrators (not just first)
    let narrator_regex = regex::Regex::new(r#"/narrator/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
    let extracted_narrators: Vec<String> = narrator_regex
        .captures_iter(&product_html)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

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

        // Compare and add changes
        if current.title.as_ref() != Some(&group.metadata.title) {
            file.changes.insert("title".to_string(), MetadataChange {
                old: current.title.unwrap_or_default(),
                new: group.metadata.title.clone(),
            });
            total_changes += 1;
        }

        if current.artist.as_ref() != Some(&group.metadata.author) {
            file.changes.insert("author".to_string(), MetadataChange {
                old: current.artist.unwrap_or_default(),
                new: group.metadata.author.clone(),
            });
            total_changes += 1;
        }

        if current.album.as_ref() != Some(&group.metadata.title) {
            file.changes.insert("album".to_string(), MetadataChange {
                old: current.album.unwrap_or_default(),
                new: group.metadata.title.clone(),
            });
            total_changes += 1;
        }

        // Handle multiple narrators - join with semicolon for ABS compatibility
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

        if !group.metadata.genres.is_empty() {
            file.changes.insert("genre".to_string(), MetadataChange {
                old: current.genre.unwrap_or_default(),
                new: group.metadata.genres.join(", "),
            });
            total_changes += 1;
        }

        if let Some(ref series) = group.metadata.series {
            file.changes.insert("series".to_string(), MetadataChange {
                old: String::new(),
                new: series.clone(),
            });
            total_changes += 1;
        }

        if let Some(ref sequence) = group.metadata.sequence {
            file.changes.insert("sequence".to_string(), MetadataChange {
                old: String::new(),
                new: sequence.clone(),
            });
            total_changes += 1;
        }

        if let Some(ref description) = group.metadata.description {
            file.changes.insert("description".to_string(), MetadataChange {
                old: current.comment.unwrap_or_default(),
                new: description.clone(),
            });
            total_changes += 1;
        }

        if let Some(ref year) = group.metadata.year {
            if current.year.as_ref() != Some(year) {
                file.changes.insert("year".to_string(), MetadataChange {
                    old: current.year.unwrap_or_default(),
                    new: year.clone(),
                });
                total_changes += 1;
            }
        }

        // NEW FIELDS - Add ASIN, ISBN, language, publisher to changes
        if let Some(ref asin) = group.metadata.asin {
            file.changes.insert("asin".to_string(), MetadataChange {
                old: String::new(),
                new: asin.clone(),
            });
            total_changes += 1;
        }

        if let Some(ref isbn) = group.metadata.isbn {
            file.changes.insert("isbn".to_string(), MetadataChange {
                old: String::new(),
                new: isbn.clone(),
            });
            total_changes += 1;
        }

        if let Some(ref language) = group.metadata.language {
            file.changes.insert("language".to_string(), MetadataChange {
                old: String::new(),
                new: language.clone(),
            });
            total_changes += 1;
        }

        if let Some(ref publisher) = group.metadata.publisher {
            file.changes.insert("publisher".to_string(), MetadataChange {
                old: String::new(),
                new: publisher.clone(),
            });
            total_changes += 1;
        }
    }

    total_changes
}