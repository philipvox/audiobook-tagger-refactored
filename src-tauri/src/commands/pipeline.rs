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
}
