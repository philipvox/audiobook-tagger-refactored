// commands/classify.rs
// Consolidated commands for the 3 core GPT calls:
//   Call A: resolve_metadata_batch — title + subtitle + author + series + sequence
//   Call B: classify_books_batch — genres + tags + age + DNA
//   Call C: process_descriptions_batch — validate + clean/generate descriptions

use serde::{Deserialize, Serialize};
use crate::gpt_consolidated::{
    self, ClassifyInput, ResolveMetadataInput,
    series_names_match, find_canonical_series_name,
};
use crate::book_dna;
use tauri::{Emitter, Window};
use futures::stream::{self, StreamExt};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

// =============================================================================
// Progress event payload (shared by all 3 commands)
// =============================================================================

#[derive(Debug, Clone, Serialize)]
struct BatchProgressEvent {
    pub call_type: String, // "metadata", "classify", "description"
    pub current: usize,
    pub total: usize,
    pub title: String,
    pub success: bool,
    pub error: Option<String>,
}

// =============================================================================
// Request/Response types
// =============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct ClassifyRequest {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub genres: Vec<String>,
    pub tags: Vec<String>,
    pub duration_minutes: Option<u32>,
    pub narrator: Option<String>,
    pub series_name: Option<String>,
    pub series_sequence: Option<String>,
    pub year: Option<String>,
    pub publisher: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassifyBookResult {
    pub id: String,
    pub title: String,

    // Genres
    pub genres: Vec<String>,
    pub genres_changed: bool,

    // Tags (non-DNA, non-age)
    pub tags: Vec<String>,

    // Age rating
    pub age_category: String,
    pub min_age: Option<u8>,
    pub content_rating: String,
    pub age_tags: Vec<String>,
    pub intended_for_kids: bool,

    // DNA tags
    pub dna_tags: Vec<String>,

    // Themes/tropes
    pub themes: Vec<String>,
    pub tropes: Vec<String>,

    // Description (if processed)
    pub description: Option<String>,
    pub description_changed: bool,

    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassifyBatchResponse {
    pub results: Vec<ClassifyBookResult>,
    pub total_processed: usize,
    pub total_failed: usize,
}

// =============================================================================
// Commands
// =============================================================================

/// Classify a batch of books — consolidated genres + tags + age + DNA + description
/// This replaces the separate cleanup_genres, assign_tags, age_rating, book_dna, and fix_descriptions commands
#[tauri::command]
pub async fn classify_books_batch(
    window: Window,
    books: Vec<ClassifyRequest>,
    include_description: bool,
    force_fresh: bool,
    config: crate::config::Config,
) -> Result<ClassifyBatchResponse, String> {
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    let total = books.len();
    println!("🤖 Consolidated classification for {} books", total);

    // Phase 1: Gather external data from providers (Audible, Goodreads, Hardcover, Storytel, etc.)
    println!("📡 Phase 1: Gathering external data for {} books...", total);
    let gather_counter = Arc::new(AtomicUsize::new(0));

    let books_with_data: Vec<(ClassifyRequest, ExternalBookData)> = stream::iter(books)
        .map(|book| {
            let config = config.clone();
            let window = window.clone();
            let counter = gather_counter.clone();
            async move {
                let external = gather_for_classify(&book.title, &book.author, &config).await;
                let current = counter.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = window.emit("batch-progress", BatchProgressEvent {
                    call_type: "gather".to_string(),
                    current,
                    total,
                    title: book.title.clone(),
                    success: true,
                    error: None,
                });
                (book, external)
            }
        })
        .buffer_unordered(25)
        .collect()
        .await;

    // Phase 2: Classify with AI using enriched data
    println!("🤖 Phase 2: AI classification for {} books...", total);
    let api_key = api_key.clone();
    let counter = Arc::new(AtomicUsize::new(0));

    let results: Vec<ClassifyBookResult> = stream::iter(books_with_data)
        .map(|(book, external)| {
            let api_key = api_key.clone();
            let window = window.clone();
            let counter = counter.clone();
            async move {
                let result = classify_single_book(book, external, include_description, force_fresh, &api_key).await;
                let current = counter.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = window.emit("batch-progress", BatchProgressEvent {
                    call_type: "classify".to_string(),
                    current,
                    total,
                    title: result.title.clone(),
                    success: result.error.is_none(),
                    error: result.error.clone(),
                });
                result
            }
        })
        .buffer_unordered(25)
        .collect()
        .await;

    let total_failed = results.iter().filter(|r| r.error.is_some()).count();
    let total_processed = results.len() - total_failed;

    println!("✅ Classification complete: {} processed, {} failed", total_processed, total_failed);

    Ok(ClassifyBatchResponse {
        results,
        total_processed,
        total_failed,
    })
}

/// External data gathered from providers for classification enrichment
#[derive(Debug, Clone, Default)]
struct ExternalBookData {
    description: Option<String>,
    genres: Vec<String>,
    narrator: Option<String>,
    series: Option<String>,
    year: Option<String>,
}

/// Gather external data from ABS + custom providers for a single book
async fn gather_for_classify(
    title: &str,
    author: &str,
    config: &crate::config::Config,
) -> ExternalBookData {
    let mut data = ExternalBookData::default();

    // Run ABS search + custom providers in parallel
    let (abs_result, provider_results) = tokio::join!(
        crate::abs_search::search_metadata_waterfall(config, title, author),
        crate::custom_providers::search_custom_providers(config, title, author),
    );

    // Process ABS results (Audible/Google/iTunes)
    if let Some(abs) = abs_result {
        data.description = abs.description;
        data.narrator = abs.narrator;
        data.year = abs.published_year;
        if let Some(first_series) = abs.series.first() {
            data.series = first_series.series.clone();
        }
    }

    // Process custom provider results (Goodreads, Hardcover, Storytel)
    for result in &provider_results {
        if data.description.is_none() {
            data.description = result.description.clone();
        }
        if data.narrator.is_none() {
            data.narrator = result.narrator.clone();
        }
        if data.genres.is_empty() {
            data.genres = result.genres.clone();
        }
        if data.year.is_none() {
            data.year = result.published_year.clone();
        }
    }

    let sources = [
        if data.description.is_some() { "desc" } else { "" },
        if !data.genres.is_empty() { "genres" } else { "" },
        if data.narrator.is_some() { "narrator" } else { "" },
        if data.series.is_some() { "series" } else { "" },
    ].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("+");

    if !sources.is_empty() {
        println!("   📡 {} : external data: {}", title, sources);
    }

    data
}

async fn classify_single_book(
    book: ClassifyRequest,
    external: ExternalBookData,
    include_description: bool,
    force_fresh: bool,
    api_key: &str,
) -> ClassifyBookResult {
    let input = ClassifyInput {
        title: book.title.clone(),
        author: book.author.clone(),
        description: book.description.clone(),
        genres: book.genres.clone(),
        duration_minutes: book.duration_minutes,
        narrator: book.narrator.clone(),
        series_name: book.series_name.clone(),
        series_sequence: book.series_sequence.clone(),
        year: book.year.clone(),
        publisher: book.publisher.clone(),
        external_description: external.description,
        external_genres: external.genres,
        external_narrator: external.narrator,
        external_series: external.series,
        external_year: external.year,
    };

    // Call B: Classification
    let classify_result = gpt_consolidated::classify_book(&input, api_key, force_fresh).await;

    // Call C: Description (optional)
    let desc_result = if include_description {
        Some(gpt_consolidated::process_description(
            &book.title,
            &book.author,
            &book.genres,
            book.description.as_deref(),
            api_key,
        ).await)
    } else {
        None
    };

    match classify_result {
        Ok(classification) => {
            let genres_changed = classification.genres != book.genres;
            let dna_tags = book_dna::dna_to_tags(&classification.dna);

            let (description, description_changed) = match desc_result {
                Some(Ok(desc_out)) => (Some(desc_out.description), desc_out.was_generated || !desc_out.was_valid),
                Some(Err(e)) => {
                    println!("   ⚠️ Description error for '{}': {}", book.title, e);
                    (None, false)
                }
                None => (None, false),
            };

            println!("   ✅ {} : {} genres, {} tags, {}, {} DNA tags",
                book.title,
                classification.genres.len(),
                classification.tags.len(),
                classification.age_rating.age_category,
                dna_tags.len(),
            );

            ClassifyBookResult {
                id: book.id,
                title: book.title,
                genres: classification.genres,
                genres_changed,
                tags: classification.tags,
                age_category: classification.age_rating.age_category,
                min_age: classification.age_rating.min_age,
                content_rating: classification.age_rating.content_rating,
                age_tags: classification.age_rating.age_tags,
                intended_for_kids: classification.age_rating.intended_for_kids,
                dna_tags,
                themes: classification.themes,
                tropes: classification.tropes,
                description,
                description_changed,
                error: None,
            }
        }
        Err(e) => {
            println!("   ❌ {} : {}", book.title, e);
            ClassifyBookResult {
                id: book.id,
                title: book.title,
                genres: book.genres,
                genres_changed: false,
                tags: book.tags,
                age_category: "Unknown".to_string(),
                min_age: None,
                content_rating: "Unknown".to_string(),
                age_tags: vec![],
                intended_for_kids: false,
                dna_tags: vec![],
                themes: vec![],
                tropes: vec![],
                description: None,
                description_changed: false,
                error: Some(e),
            }
        }
    }
}

// =============================================================================
// Call A: Metadata Resolution — title + subtitle + author + series + sequence
// =============================================================================

#[derive(Debug, Clone, Serialize)]
pub struct ResolveMetadataResult {
    pub id: String,
    pub title: String,
    pub author: String,
    pub subtitle: Option<String>,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub narrator: Option<String>,
    pub confidence: u8,
    pub notes: Option<String>,
    pub changed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolveMetadataBatchResponse {
    pub results: Vec<ResolveMetadataResult>,
    pub total_processed: usize,
    pub total_failed: usize,
}

/// Call A: Resolve metadata for a batch of books — ONE GPT call per book
/// Replaces separate Fix Titles + Fix Subtitles + Fix Authors + Fix Series
#[tauri::command]
pub async fn resolve_metadata_batch(
    window: Window,
    books: Vec<ResolveMetadataInput>,
    config: crate::config::Config,
) -> Result<ResolveMetadataBatchResponse, String> {
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    let total = books.len();
    println!("📝 Consolidated metadata resolution for {} books", total);

    // Step 1: Parse folder hierarchies for all books
    let mut books_with_folders: Vec<ResolveMetadataInput> = books.into_iter().map(|mut book| {
        if let Some(ref path) = book.folder_path {
            let hierarchy = crate::scanner::processor::parse_folder_hierarchy(path);
            book.folder_author = hierarchy.author;
            book.folder_series = hierarchy.series;
            book.folder_sequence = hierarchy.sequence;
        }
        book
    }).collect();

    // Step 2: Do ABS lookups in parallel FIRST (so we have Audible data for registry)
    println!("🔍 Phase 1: ABS lookups for {} books...", books_with_folders.len());
    let config_clone = config.clone();
    let abs_counter = Arc::new(AtomicUsize::new(0));
    let abs_total = books_with_folders.len();

    let books_with_audible: Vec<ResolveMetadataInput> = stream::iter(books_with_folders)
        .map(|mut book| {
            let config = config_clone.clone();
            let window = window.clone();
            let counter = abs_counter.clone();
            async move {
                // Try ABS lookup to get Audible data
                if book.audible_title.is_none() {
                    if let Some(abs_result) = crate::abs_search::search_metadata_waterfall(
                        &config, &book.current_title, &book.current_author
                    ).await {
                        book.audible_title = abs_result.title;
                        book.audible_author = abs_result.author;
                        book.audible_subtitle = abs_result.subtitle;
                        if let Some(first_series) = abs_result.series.first() {
                            book.audible_series = first_series.series.clone();
                            book.audible_sequence = first_series.sequence.clone();
                        }
                    }
                }

                let current = counter.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = window.emit("batch-progress", BatchProgressEvent {
                    call_type: "abs-lookup".to_string(),
                    current,
                    total: abs_total,
                    title: book.current_title.clone(),
                    success: true,
                    error: None,
                });

                book
            }
        })
        .buffer_unordered(25)
        .collect()
        .await;

    // Step 3: Build author-series registry WITH Audible data
    let registry = build_author_series_registry(&books_with_audible);
    println!("📚 Built author-series registry: {} authors with series", registry.len());

    // Step 4: Attach known series and dominant series to each book
    let books_ready: Vec<ResolveMetadataInput> = books_with_audible.into_iter().map(|mut book| {
        let author_key = normalize_author_for_registry(&book.current_author);
        if let Some(info) = registry.get(&author_key) {
            book.known_author_series = info.series_list.clone();
            book.dominant_author_series = info.dominant_series.clone();
        }
        book
    }).collect();

    // Step 5: Do GPT calls in parallel
    println!("🤖 Phase 2: GPT metadata resolution for {} books...", books_ready.len());
    let api_key = api_key.clone();
    let counter = Arc::new(AtomicUsize::new(0));

    let results: Vec<ResolveMetadataResult> = stream::iter(books_ready)
        .map(|book| {
            let api_key = api_key.clone();
            let window = window.clone();
            let counter = counter.clone();
            async move {
                let book_title = book.current_title.clone();

                // Call A: consolidated GPT resolution
                let result = match gpt_consolidated::resolve_metadata(&book, &api_key).await {
                    Ok(result) => {
                        let changed = result.title != book.current_title
                            || result.author != book.current_author
                            || result.subtitle != book.current_subtitle
                            || result.series != book.current_series
                            || result.sequence != book.current_sequence;

                        if changed {
                            println!("   ✅ {} → title=\"{}\", author=\"{}\", series={:?} #{:?}, confidence={}",
                                book.current_title, result.title, result.author,
                                result.series, result.sequence, result.confidence);
                        }

                        ResolveMetadataResult {
                            id: book.id,
                            title: result.title,
                            author: result.author,
                            subtitle: result.subtitle,
                            series: result.series,
                            sequence: result.sequence,
                            narrator: result.narrator,
                            confidence: result.confidence,
                            notes: result.notes,
                            changed,
                            error: None,
                        }
                    }
                    Err(e) => {
                        println!("   ❌ {} : {}", book.current_title, e);
                        ResolveMetadataResult {
                            id: book.id,
                            title: book.current_title,
                            author: book.current_author,
                            subtitle: book.current_subtitle,
                            series: book.current_series,
                            sequence: book.current_sequence,
                            narrator: None,
                            confidence: 0,
                            notes: None,
                            changed: false,
                            error: Some(e),
                        }
                    }
                };

                let current = counter.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = window.emit("batch-progress", BatchProgressEvent {
                    call_type: "metadata".to_string(),
                    current,
                    total,
                    title: book_title,
                    success: result.error.is_none(),
                    error: result.error.clone(),
                });

                result
            }
        })
        .buffer_unordered(25)
        .collect()
        .await;

    let total_failed = results.iter().filter(|r| r.error.is_some()).count();
    let total_processed = results.len() - total_failed;

    println!("✅ Metadata resolution complete: {} processed, {} failed", total_processed, total_failed);

    Ok(ResolveMetadataBatchResponse {
        results,
        total_processed,
        total_failed,
    })
}

/// Author series registry entry with list of series and the dominant one
#[derive(Debug, Clone)]
struct AuthorSeriesInfo {
    /// All unique series names for this author
    series_list: Vec<String>,
    /// The most common series (if one dominates)
    dominant_series: Option<String>,
}

/// Build a registry of author → series names for consistency checking
/// Also identifies the dominant series for each author
fn build_author_series_registry(books: &[ResolveMetadataInput]) -> std::collections::HashMap<String, AuthorSeriesInfo> {
    use std::collections::HashMap;

    // First pass: count occurrences of each series per author
    let mut series_counts: HashMap<String, HashMap<String, usize>> = HashMap::new();

    for book in books {
        let author_key = normalize_author_for_registry(&book.current_author);

        // Collect series from all sources (prioritize Audible as most reliable)
        let mut series_names = Vec::new();
        if let Some(ref s) = book.audible_series {
            if !s.is_empty() {
                series_names.push(s.clone());
            }
        }
        if let Some(ref s) = book.current_series {
            if !s.is_empty() && !series_names.contains(s) {
                series_names.push(s.clone());
            }
        }
        if let Some(ref s) = book.folder_series {
            if !s.is_empty() && !series_names.contains(s) {
                series_names.push(s.clone());
            }
        }

        // Count each series (only count once per book even if multiple sources agree)
        let author_counts = series_counts.entry(author_key).or_default();
        for series in series_names {
            *author_counts.entry(series).or_insert(0) += 1;
        }
    }

    // Second pass: normalize series names and find dominant
    series_counts.into_iter()
        .map(|(author, counts)| {
            // Get all series names and normalize/dedupe
            let all_series: Vec<String> = counts.keys().cloned().collect();
            let normalized_series = normalize_and_dedupe_series(all_series);

            // Find the most common series after normalization
            // Sum up counts for series that were merged into the same canonical name
            let mut canonical_counts: HashMap<String, usize> = HashMap::new();
            for (series, count) in &counts {
                // Find which canonical name this series maps to
                for canonical in &normalized_series {
                    if series_names_match(series, canonical) {
                        *canonical_counts.entry(canonical.clone()).or_insert(0) += count;
                        break;
                    }
                }
            }

            // Find dominant series (most common, but only if it's significantly more common)
            let total_books: usize = canonical_counts.values().sum();
            let dominant_series = if total_books >= 3 {
                // Find the series with most books
                let (top_series, top_count) = canonical_counts.iter()
                    .max_by_key(|(_, count)| *count)
                    .map(|(s, c)| (s.clone(), *c))
                    .unwrap_or_default();

                // Dominant if it has >50% of the books
                if top_count as f64 / total_books as f64 > 0.5 {
                    println!("   📚 Author \"{}\" dominant series: \"{}\" ({}/{} books)",
                             author, top_series, top_count, total_books);
                    Some(top_series)
                } else {
                    None
                }
            } else {
                None
            };

            (author, AuthorSeriesInfo {
                series_list: normalized_series,
                dominant_series,
            })
        })
        .filter(|(_, info)| !info.series_list.is_empty())
        .collect()
}

/// Normalize author name for registry lookup
fn normalize_author_for_registry(author: &str) -> String {
    author
        .to_lowercase()
        .trim()
        .replace("  ", " ")
        .to_string()
}

/// Normalize and deduplicate series names, grouping similar names and picking canonical versions
/// E.g., ["The Plantagenet and Tudor Novels", "Plantagenet and Tudor", "Tudor Court"] ->
///       ["The Plantagenet and Tudor Novels", "Tudor Court"] (first two are grouped, third is separate)
fn normalize_and_dedupe_series(series: Vec<String>) -> Vec<String> {
    if series.is_empty() {
        return series;
    }

    // Group similar series names together
    let mut groups: Vec<Vec<String>> = Vec::new();

    for s in series {
        // Find if this series matches any existing group
        let mut found_group = false;
        for group in &mut groups {
            // Check if it matches any member of the group
            if group.iter().any(|existing| series_names_match(&s, existing)) {
                group.push(s.clone());
                found_group = true;
                break;
            }
        }

        if !found_group {
            // Start a new group
            groups.push(vec![s]);
        }
    }

    // For each group, pick the canonical name
    let mut result = Vec::new();
    for group in groups {
        if let Some(canonical) = find_canonical_series_name(&group) {
            if group.len() > 1 {
                let variants: Vec<_> = group.iter().filter(|g| *g != &canonical).collect();
                if !variants.is_empty() {
                    println!("   📚 Series group normalized: {:?} → \"{}\"", variants, canonical);
                }
            }
            result.push(canonical);
        }
    }

    result
}

// =============================================================================
// Call C: Description Processing — validate + clean/generate
// =============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct DescriptionRequest {
    pub id: String,
    pub title: String,
    pub author: String,
    pub genres: Vec<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DescriptionResult {
    pub id: String,
    pub title: String,
    pub description: String,
    pub was_valid: bool,
    pub was_generated: bool,
    pub changed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DescriptionBatchResponse {
    pub results: Vec<DescriptionResult>,
    pub total_processed: usize,
    pub total_failed: usize,
}

/// Call C: Process descriptions for a batch of books — ONE GPT call per book
/// Replaces separate validate_description + fix_description
#[tauri::command]
pub async fn process_descriptions_batch(
    window: Window,
    books: Vec<DescriptionRequest>,
    config: crate::config::Config,
) -> Result<DescriptionBatchResponse, String> {
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    let total = books.len();
    println!("📝 Consolidated description processing for {} books", total);

    let api_key = api_key.clone();
    let counter = Arc::new(AtomicUsize::new(0));

    let results: Vec<DescriptionResult> = stream::iter(books)
        .map(|book| {
            let api_key = api_key.clone();
            let window = window.clone();
            let counter = counter.clone();
            async move {
                let book_title = book.title.clone();
                let result = match gpt_consolidated::process_description(
                    &book.title,
                    &book.author,
                    &book.genres,
                    book.description.as_deref(),
                    &api_key,
                ).await {
                    Ok(result) => {
                        let changed = result.was_generated || !result.was_valid;
                        if changed {
                            println!("   ✅ {} : {} ({})",
                                book.title,
                                if result.was_generated { "generated" } else { "cleaned" },
                                if result.was_valid { "was valid" } else { "was invalid" }
                            );
                        }
                        DescriptionResult {
                            id: book.id,
                            title: book.title,
                            description: result.description,
                            was_valid: result.was_valid,
                            was_generated: result.was_generated,
                            changed,
                            error: None,
                        }
                    }
                    Err(e) => {
                        println!("   ❌ {} : {}", book.title, e);
                        DescriptionResult {
                            id: book.id,
                            title: book.title,
                            description: book.description.unwrap_or_default(),
                            was_valid: true,
                            was_generated: false,
                            changed: false,
                            error: Some(e),
                        }
                    }
                };

                let current = counter.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = window.emit("batch-progress", BatchProgressEvent {
                    call_type: "description".to_string(),
                    current,
                    total,
                    title: book_title,
                    success: result.error.is_none(),
                    error: result.error.clone(),
                });

                result
            }
        })
        .buffer_unordered(25)
        .collect()
        .await;

    let total_failed = results.iter().filter(|r| r.error.is_some()).count();
    let total_processed = results.len() - total_failed;

    println!("✅ Description processing complete: {} processed, {} failed", total_processed, total_failed);

    Ok(DescriptionBatchResponse {
        results,
        total_processed,
        total_failed,
    })
}
