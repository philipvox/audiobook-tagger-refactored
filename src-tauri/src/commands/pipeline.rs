// commands/pipeline.rs
// Tauri commands for the metadata pipeline

use crate::config;
use crate::pipeline::{MetadataPipeline, SourceData, SeriesEntry};
use crate::scanner::BookMetadata;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Emitter;

/// Request to process books through the metadata pipeline
#[derive(Debug, Clone, Deserialize)]
pub struct PipelineRequest {
    /// Books to process
    pub books: Vec<PipelineBookInput>,
    /// Maximum concurrent operations (default 5)
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
}

fn default_concurrency() -> usize {
    5
}

/// Input for a single book in the pipeline
#[derive(Debug, Clone, Deserialize)]
pub struct PipelineBookInput {
    /// ABS library item ID (required for fetching fresh metadata)
    pub abs_id: Option<String>,
    /// Initial/existing data
    pub title: Option<String>,
    pub author: Option<String>,
    pub narrator: Option<String>,
    #[serde(default)]
    pub series: Vec<SeriesInput>,
    #[serde(default)]
    pub genres: Vec<String>,
    pub description: Option<String>,
    pub subtitle: Option<String>,
    pub year: Option<String>,
    pub publisher: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SeriesInput {
    pub name: String,
    pub sequence: Option<String>,
}

/// Result from pipeline processing
#[derive(Debug, Clone, Serialize)]
pub struct PipelineResult {
    pub success: bool,
    pub processed: usize,
    pub failed: usize,
    pub books: Vec<PipelineBookResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PipelineBookResult {
    pub abs_id: Option<String>,
    pub success: bool,
    pub error: Option<String>,
    pub metadata: Option<BookMetadata>,
    pub reasoning: Option<String>,
}

/// Process books through the metadata pipeline
#[tauri::command]
pub async fn process_with_pipeline(
    window: tauri::Window,
    request: PipelineRequest,
) -> Result<PipelineResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let total = request.books.len();

    println!("📚 Pipeline: Processing {} books", total);

    let _ = window.emit("pipeline_progress", json!({
        "phase": "starting",
        "message": format!("Starting pipeline for {} books...", total),
        "current": 0,
        "total": total
    }));

    let pipeline = MetadataPipeline::new(config);

    // Use concurrency from request (default 5, capped for GPT rate limits)
    let concurrency = request.concurrency.min(150).max(1);  // Tier 3: 5000 RPM, 4M TPM
    println!("📚 Pipeline: Using concurrency {}", concurrency);

    // Build items for batch processing
    let items: Vec<(String, SourceData)> = request.books.iter().enumerate()
        .map(|(idx, book)| {
            let abs_id = book.abs_id.clone().unwrap_or_else(|| format!("temp_{}", idx));
            let source = input_to_source_data(book);
            (abs_id, source)
        })
        .collect();

    // Create a map of abs_id -> original book for result matching
    let book_map: std::collections::HashMap<String, &PipelineBookInput> = request.books.iter()
        .enumerate()
        .map(|(idx, book)| {
            let abs_id = book.abs_id.clone().unwrap_or_else(|| format!("temp_{}", idx));
            (abs_id, book)
        })
        .collect();

    let _ = window.emit("pipeline_progress", json!({
        "phase": "processing",
        "message": format!("Processing {} books with {} concurrent...", total, concurrency),
        "current": 0,
        "total": total
    }));

    // Process batch with concurrency and real-time progress updates
    let batch_results = pipeline.process_batch_with_window(
        items,
        concurrency,
        window.clone(),
    ).await;

    // Convert batch results to pipeline results
    let mut results = Vec::new();
    let mut processed = 0;
    let mut failed = 0;

    for (abs_id, result) in batch_results {
        let original_abs_id = book_map.get(&abs_id).and_then(|b| b.abs_id.clone());
        match result {
            Ok(metadata) => {
                processed += 1;
                results.push(PipelineBookResult {
                    abs_id: original_abs_id,
                    success: true,
                    error: None,
                    metadata: Some(metadata),
                    reasoning: None,
                });
            }
            Err(e) => {
                failed += 1;
                println!("   ❌ Pipeline failed for '{}': {}", abs_id, e);
                results.push(PipelineBookResult {
                    abs_id: original_abs_id,
                    success: false,
                    error: Some(e),
                    metadata: None,
                    reasoning: None,
                });
            }
        }
    }

    let _ = window.emit("pipeline_progress", json!({
        "phase": "complete",
        "message": format!("Pipeline complete: {} processed, {} failed", processed, failed),
        "current": total,
        "total": total
    }));

    Ok(PipelineResult {
        success: failed == 0,
        processed,
        failed,
        books: results,
    })
}

/// Convert a single ABS item through the pipeline (for direct use)
#[tauri::command]
pub async fn process_abs_item(
    abs_id: String,
    initial_title: Option<String>,
    initial_author: Option<String>,
) -> Result<BookMetadata, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let pipeline = MetadataPipeline::new(config);

    // Build minimal initial data
    let mut initial = SourceData::new("initial", 70);
    initial.title = initial_title;
    initial.authors = initial_author.map(|a| vec![a]).unwrap_or_default();

    pipeline.process_book(&abs_id, initial).await
}

/// Preview what the pipeline would do without making changes
#[tauri::command]
pub async fn preview_pipeline(
    book: PipelineBookInput,
) -> Result<serde_json::Value, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let pipeline = MetadataPipeline::new(config);

    let initial = input_to_source_data(&book);
    let abs_id = book.abs_id.clone().unwrap_or_else(|| "preview".to_string());

    match pipeline.process_book(&abs_id, initial).await {
        Ok(metadata) => {
            Ok(json!({
                "success": true,
                "metadata": metadata,
                "sources_would_query": ["abs_api", "custom_providers"],
            }))
        }
        Err(e) => {
            Ok(json!({
                "success": false,
                "error": e,
            }))
        }
    }
}

/// Convert PipelineBookInput to SourceData
fn input_to_source_data(book: &PipelineBookInput) -> SourceData {
    let mut source = SourceData::new("initial", 80);

    source.title = book.title.clone();
    source.subtitle = book.subtitle.clone();
    source.authors = book.author.clone().map(|a| vec![a]).unwrap_or_default();
    source.narrators = book.narrator.clone().map(|n| vec![n]).unwrap_or_default();
    source.series = book.series
        .iter()
        .map(|s| SeriesEntry::new(s.name.clone(), s.sequence.clone()))
        .collect();
    source.genres = book.genres.clone();
    source.description = book.description.clone();
    source.year = book.year.clone();
    source.publisher = book.publisher.clone();

    source
}

// ============================================================================
// RUN ALL ENRICHMENT - Unified enrichment in single GPT call per book
// ============================================================================

/// Request for unified enrichment
#[derive(Debug, Clone, Deserialize)]
pub struct RunAllEnrichmentRequest {
    /// Books to enrich (uses existing book data, not ABS IDs)
    pub books: Vec<EnrichmentBookInput>,
    /// Maximum concurrent operations (default 20)
    #[serde(default = "default_enrichment_concurrency")]
    pub concurrency: usize,
    /// Force re-processing even if book is already complete
    #[serde(default)]
    pub force: bool,
}

fn default_enrichment_concurrency() -> usize {
    20
}

/// Input for a single book in enrichment
#[derive(Debug, Clone, Deserialize)]
pub struct EnrichmentBookInput {
    /// Unique identifier for this book (group_id or path)
    pub id: String,
    /// Current metadata
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    #[serde(default)]
    pub authors: Vec<String>,
    pub narrator: Option<String>,
    #[serde(default)]
    pub narrators: Vec<String>,
    #[serde(default)]
    pub series: Vec<SeriesInput>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub year: Option<String>,
    pub publisher: Option<String>,
}

/// Result from enrichment
#[derive(Debug, Clone, Serialize)]
pub struct EnrichmentResult {
    pub success: bool,
    pub processed: usize,
    pub failed: usize,
    pub books: Vec<EnrichmentBookResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnrichmentBookResult {
    pub id: String,
    pub success: bool,
    pub error: Option<String>,
    /// The enriched metadata
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub authors: Vec<String>,
    pub narrator: Option<String>,
    pub narrators: Vec<String>,
    pub series_name: Option<String>,
    pub series_sequence: Option<String>,
    pub genres: Vec<String>,
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub themes: Vec<String>,
    pub tropes: Vec<String>,
    pub reasoning: Option<String>,
}

/// What parts of a book's metadata need enrichment
#[derive(Debug, Clone, Default)]
struct EnrichmentNeeds {
    needs_tags: bool,
    needs_genres: bool,
    needs_title: bool,
    needs_author: bool,
    needs_description: bool,
    needs_series: bool,
}

impl EnrichmentNeeds {
    fn any(&self) -> bool {
        self.needs_tags || self.needs_genres || self.needs_title ||
        self.needs_author || self.needs_description || self.needs_series
    }

    fn summary(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if self.needs_tags { missing.push("tags"); }
        if self.needs_genres { missing.push("genres"); }
        if self.needs_title { missing.push("title"); }
        if self.needs_author { missing.push("author"); }
        if self.needs_description { missing.push("description"); }
        if self.needs_series { missing.push("series"); }
        missing
    }
}

/// Check what parts of a book's metadata need enrichment
fn check_enrichment_needs(book: &EnrichmentBookInput) -> EnrichmentNeeds {
    EnrichmentNeeds {
        // Tags need enrichment if missing required ratings
        needs_tags: !crate::genres::are_tags_complete(&book.tags),

        // Genres need enrichment if empty
        needs_genres: book.genres.is_empty(),

        // Title needs enrichment if empty or very short
        needs_title: book.title.as_ref().map(|t| t.trim().len() < 2).unwrap_or(true),

        // Author needs enrichment if empty
        needs_author: book.author.as_ref().map(|a| a.trim().is_empty()).unwrap_or(true) && book.authors.is_empty(),

        // Description needs enrichment if empty or too short
        needs_description: book.description.as_ref().map(|d| d.trim().len() < 50).unwrap_or(true),

        // Series needs enrichment if missing (and it's not standalone based on title)
        needs_series: book.series.is_empty() && !is_likely_standalone(book.title.as_deref().unwrap_or("")),
    }
}

/// Check if a book is likely standalone (doesn't need series lookup)
fn is_likely_standalone(title: &str) -> bool {
    let lower = title.to_lowercase();
    // Look for series indicators
    let series_patterns = ["book 1", "book 2", "vol.", "volume", "#1", "#2", "part 1", "part 2"];
    !series_patterns.iter().any(|p| lower.contains(p))
}

/// Run all enrichment actions in a single GPT call per book
/// This consolidates: title fixing, series resolution, description cleaning,
/// genre mapping, and tag assignment into ONE GPT call per book
///
/// SMART MERGE: For each field, only use GPT results if the existing value is incomplete.
/// If tags are already complete, keep existing tags. Same for genres, title, etc.
#[tauri::command]
pub async fn run_all_enrichment(
    window: tauri::Window,
    request: RunAllEnrichmentRequest,
) -> Result<EnrichmentResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    let total = request.books.len();

    println!("🚀 Run All Enrichment: Checking {} books (force={})", total, request.force);

    // Check what each book needs and separate into "needs processing" and "already complete"
    let mut books_to_process: Vec<(&EnrichmentBookInput, EnrichmentNeeds)> = Vec::new();
    let mut already_complete: Vec<&EnrichmentBookInput> = Vec::new();

    for book in &request.books {
        let needs = check_enrichment_needs(book);
        // If force mode, process ALL books regardless of current state
        if request.force || needs.any() {
            let effective_needs = if request.force {
                // Force mode: mark all fields as needing enrichment
                EnrichmentNeeds {
                    needs_genres: true,
                    needs_tags: true,
                    needs_title: true,
                    needs_author: true,
                    needs_description: true,
                    needs_series: true,
                }
            } else {
                needs
            };
            println!("   📝 '{}' needs: {:?}{}",
                book.title.as_deref().unwrap_or("Unknown"), effective_needs.summary(),
                if request.force { " (FORCED)" } else { "" });
            books_to_process.push((book, effective_needs));
        } else {
            println!("   ✅ '{}' - fully complete, skipping entirely",
                book.title.as_deref().unwrap_or("Unknown"));
            already_complete.push(book);
        }
    }

    let skipped = already_complete.len();
    let to_process = books_to_process.len();

    println!("🚀 Run All Enrichment: {} to process, {} fully complete (skipped)", to_process, skipped);

    let _ = window.emit("enrichment_progress", json!({
        "phase": "starting",
        "message": format!("Processing {} books ({} already complete)", to_process, skipped),
        "current": 0,
        "total": to_process,
        "skipped": skipped
    }));

    let mut results = Vec::new();
    let mut processed = 0;
    let mut failed = 0;

    // Add already-complete books to results (no changes needed)
    for book in already_complete {
        results.push(EnrichmentBookResult {
            id: book.id.clone(),
            success: true,
            error: None,
            title: book.title.clone(),
            subtitle: book.subtitle.clone(),
            author: book.author.clone(),
            authors: book.authors.clone(),
            narrator: book.narrator.clone(),
            narrators: book.narrators.clone(),
            series_name: book.series.first().map(|s| s.name.clone()),
            series_sequence: book.series.first().and_then(|s| s.sequence.clone()),
            genres: book.genres.clone(),
            tags: book.tags.clone(),
            description: book.description.clone(),
            themes: vec![],
            tropes: vec![],
            reasoning: Some("Fully complete - skipped".to_string()),
        });
    }

    // Process books that need enrichment
    if to_process > 0 {
        let pipeline = MetadataPipeline::new(config);
        let concurrency = request.concurrency.min(150).max(1);

        println!("🚀 Run All: Using concurrency {}", concurrency);

        // Build a map of book id -> (original book, needs)
        let needs_map: std::collections::HashMap<String, (&EnrichmentBookInput, EnrichmentNeeds)> =
            books_to_process.iter()
                .map(|(book, needs)| (book.id.clone(), (*book, needs.clone())))
                .collect();

        // Build items for processing
        let items: Vec<(String, SourceData)> = books_to_process.iter()
            .map(|(book, _)| {
                let source = enrichment_input_to_source_data(book);
                (book.id.clone(), source)
            })
            .collect();

        let _ = window.emit("enrichment_progress", json!({
            "phase": "processing",
            "message": format!("Enriching {} books with GPT...", to_process),
            "current": 0,
            "total": to_process,
            "skipped": skipped
        }));

        // Process through pipeline with progress updates
        let batch_results = pipeline.process_batch_with_window(
            items,
            concurrency,
            window.clone(),
        ).await;

        // Convert results with smart merging
        for (id, result) in batch_results {
            match result {
                Ok(metadata) => {
                    processed += 1;

                    // Get original book and what it needed
                    if let Some((original, needs)) = needs_map.get(&id) {
                        // Smart merge: only use GPT values for fields that needed enrichment
                        let merged = EnrichmentBookResult {
                            id: id.clone(),
                            success: true,
                            error: None,
                            // Title: use GPT if needed, else keep original
                            title: if needs.needs_title {
                                Some(metadata.title.clone())
                            } else {
                                original.title.clone()
                            },
                            subtitle: metadata.subtitle.clone(),  // Always use GPT for subtitle
                            // Author: use GPT if needed, else keep original
                            author: if needs.needs_author {
                                Some(metadata.author.clone())
                            } else {
                                original.author.clone()
                            },
                            authors: if needs.needs_author {
                                metadata.authors.clone()
                            } else {
                                original.authors.clone()
                            },
                            narrator: metadata.narrator.clone(),  // Always accept GPT narrator
                            narrators: metadata.narrators.clone(),
                            // Series: use GPT if needed, else keep original
                            series_name: if needs.needs_series {
                                metadata.series.clone()
                            } else {
                                original.series.first().map(|s| s.name.clone())
                            },
                            series_sequence: if needs.needs_series {
                                metadata.sequence.clone()
                            } else {
                                original.series.first().and_then(|s| s.sequence.clone())
                            },
                            // Genres: use GPT if needed, else keep original
                            genres: if needs.needs_genres {
                                metadata.genres.clone()
                            } else {
                                original.genres.clone()
                            },
                            // Tags: use GPT if needed, else keep original (IMPORTANT!)
                            tags: if needs.needs_tags {
                                metadata.tags.clone()
                            } else {
                                println!("   🏷️  '{}' - keeping existing complete tags", original.title.as_deref().unwrap_or("Unknown"));
                                original.tags.clone()
                            },
                            // Description: use GPT if needed, else keep original
                            description: if needs.needs_description {
                                metadata.description.clone()
                            } else {
                                original.description.clone()
                            },
                            themes: metadata.themes.clone(),  // Always use GPT themes
                            tropes: metadata.tropes.clone(),  // Always use GPT tropes
                            reasoning: Some(format!("Enriched: {:?}", needs.summary())),
                        };
                        results.push(merged);
                    } else {
                        // Fallback: use all GPT values
                        results.push(EnrichmentBookResult {
                            id,
                            success: true,
                            error: None,
                            title: Some(metadata.title),
                            subtitle: metadata.subtitle,
                            author: Some(metadata.author),
                            authors: metadata.authors,
                            narrator: metadata.narrator,
                            narrators: metadata.narrators,
                            series_name: metadata.series,
                            series_sequence: metadata.sequence,
                            genres: metadata.genres,
                            tags: metadata.tags,
                            description: metadata.description,
                            themes: metadata.themes,
                            tropes: metadata.tropes,
                            reasoning: None,
                        });
                    }
                }
                Err(e) => {
                    failed += 1;
                    println!("   ❌ Enrichment failed for '{}': {}", id, e);
                    results.push(EnrichmentBookResult {
                        id,
                        success: false,
                        error: Some(e),
                        title: None,
                        subtitle: None,
                        author: None,
                        authors: vec![],
                        narrator: None,
                        narrators: vec![],
                        series_name: None,
                        series_sequence: None,
                        genres: vec![],
                        tags: vec![],
                        description: None,
                        themes: vec![],
                        tropes: vec![],
                        reasoning: None,
                    });
                }
            }
        }
    }

    let _ = window.emit("enrichment_progress", json!({
        "phase": "complete",
        "message": format!("Complete: {} enriched, {} skipped, {} failed", processed, skipped, failed),
        "current": to_process,
        "total": to_process,
        "skipped": skipped
    }));

    println!("✅ Run All Enrichment: {} enriched, {} skipped (complete), {} failed", processed, skipped, failed);

    Ok(EnrichmentResult {
        success: failed == 0,
        processed: processed + skipped,  // Total successful (including skipped)
        failed,
        books: results,
    })
}

/// Convert EnrichmentBookInput to SourceData
fn enrichment_input_to_source_data(book: &EnrichmentBookInput) -> SourceData {
    let mut source = SourceData::new("current", 85);  // High confidence - it's existing data

    source.title = book.title.clone();
    source.subtitle = book.subtitle.clone();

    // Use authors array if provided, fall back to single author
    if !book.authors.is_empty() {
        source.authors = book.authors.clone();
    } else if let Some(ref author) = book.author {
        source.authors = vec![author.clone()];
    }

    // Use narrators array if provided, fall back to single narrator
    if !book.narrators.is_empty() {
        source.narrators = book.narrators.clone();
    } else if let Some(ref narrator) = book.narrator {
        source.narrators = vec![narrator.clone()];
    }

    source.series = book.series
        .iter()
        .map(|s| SeriesEntry::new(s.name.clone(), s.sequence.clone()))
        .collect();
    source.genres = book.genres.clone();
    source.description = book.description.clone();
    source.year = book.year.clone();
    source.publisher = book.publisher.clone();

    source
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_input_to_source_data() {
        let input = PipelineBookInput {
            abs_id: Some("test-123".to_string()),
            title: Some("Test Book".to_string()),
            author: Some("Test Author".to_string()),
            narrator: Some("Test Narrator".to_string()),
            series: vec![SeriesInput {
                name: "Test Series".to_string(),
                sequence: Some("1".to_string()),
            }],
            genres: vec!["Fantasy".to_string()],
            description: Some("A test description".to_string()),
            subtitle: None,
            year: Some("2023".to_string()),
            publisher: None,
        };

        let source = input_to_source_data(&input);

        assert_eq!(source.title, Some("Test Book".to_string()));
        assert_eq!(source.authors, vec!["Test Author"]);
        assert_eq!(source.series.len(), 1);
        assert_eq!(source.series[0].name, "Test Series");
        assert_eq!(source.genres, vec!["Fantasy"]);
    }

    #[test]
    fn test_enrichment_input_to_source_data() {
        let input = EnrichmentBookInput {
            id: "test-book".to_string(),
            title: Some("Test Book".to_string()),
            subtitle: None,
            author: Some("Test Author".to_string()),
            authors: vec![],
            narrator: Some("Test Narrator".to_string()),
            narrators: vec![],
            series: vec![SeriesInput {
                name: "Test Series".to_string(),
                sequence: Some("1".to_string()),
            }],
            genres: vec!["Fantasy".to_string()],
            tags: vec!["epic-fantasy".to_string()],
            description: Some("A test description".to_string()),
            year: Some("2023".to_string()),
            publisher: None,
        };

        let source = enrichment_input_to_source_data(&input);

        assert_eq!(source.title, Some("Test Book".to_string()));
        assert_eq!(source.authors, vec!["Test Author"]);
        assert_eq!(source.narrators, vec!["Test Narrator"]);
        assert_eq!(source.series.len(), 1);
        assert_eq!(source.genres, vec!["Fantasy"]);
    }
}
