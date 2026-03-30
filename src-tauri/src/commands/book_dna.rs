// src-tauri/src/commands/book_dna.rs
// Tauri commands for BookDNA generation

use crate::book_dna::{self, DnaInput};
use crate::config;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Window};
use futures::stream::{self, StreamExt};

// =============================================================================
// Request/Response Types
// =============================================================================

/// Request for DNA generation (single book)
#[derive(Debug, Deserialize)]
pub struct GenerateDnaRequest {
    pub id: String,  // Group ID for tracking
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub genres: Vec<String>,
    pub tags: Vec<String>,  // Existing tags
    pub narrator: Option<String>,
    pub duration_minutes: Option<u32>,
    pub series_name: Option<String>,
    pub series_sequence: Option<String>,
    pub year: Option<String>,
}

/// Result for DNA generation
#[derive(Debug, Clone, Serialize)]
pub struct GenerateDnaResult {
    pub id: String,
    pub success: bool,
    pub dna_tags: Vec<String>,  // Generated DNA tags
    pub merged_tags: Vec<String>,  // Existing + DNA tags merged
    pub error: Option<String>,
}

/// Batch request for DNA generation
#[derive(Debug, Deserialize)]
pub struct GenerateDnaBatchRequest {
    pub items: Vec<GenerateDnaRequest>,
}

/// Progress event for batch processing
#[derive(Debug, Clone, Serialize)]
pub struct DnaProgressEvent {
    pub current: usize,
    pub total: usize,
    pub id: String,
    pub title: String,
    pub success: bool,
    pub error: Option<String>,
}

// =============================================================================
// Commands
// =============================================================================

/// Generate BookDNA tags for a single book
#[tauri::command]
pub async fn generate_book_dna(
    request: GenerateDnaRequest,
) -> Result<GenerateDnaResult, String> {
    let config = config::load_config()
        .map_err(|e| format!("Failed to load config: {}", e))?;

    let input = DnaInput {
        title: request.title.clone(),
        author: request.author.clone(),
        description: request.description.clone(),
        genres: request.genres.clone(),
        tags: request.tags.clone(),
        narrator: request.narrator.clone(),
        duration_minutes: request.duration_minutes,
        series_name: request.series_name.clone(),
        series_sequence: request.series_sequence.clone(),
        year: request.year.clone(),
    };

    match book_dna::generate_dna(&config, &input).await {
        Ok(dna) => {
            let dna_tags = book_dna::dna_to_tags(&dna);
            let merged_tags = book_dna::merge_dna_tags(&request.tags, &dna_tags);

            Ok(GenerateDnaResult {
                id: request.id,
                success: true,
                dna_tags,
                merged_tags,
                error: None,
            })
        }
        Err(e) => Ok(GenerateDnaResult {
            id: request.id,
            success: false,
            dna_tags: vec![],
            merged_tags: request.tags,
            error: Some(e),
        }),
    }
}

/// Generate BookDNA tags for multiple books
#[tauri::command]
pub async fn generate_book_dna_batch(
    window: Window,
    request: GenerateDnaBatchRequest,
) -> Result<Vec<GenerateDnaResult>, String> {
    let config = config::load_config()
        .map_err(|e| format!("Failed to load config: {}", e))?;

    let total = request.items.len();
    let concurrency = config.get_concurrency(config::ConcurrencyOp::Metadata);

    // Process items in parallel with limited concurrency
    let results: Vec<GenerateDnaResult> = stream::iter(request.items.into_iter().enumerate())
        .map(|(idx, item)| {
            let config = config.clone();
            let window = window.clone();
            async move {
                let input = DnaInput {
                    title: item.title.clone(),
                    author: item.author.clone(),
                    description: item.description.clone(),
                    genres: item.genres.clone(),
                    tags: item.tags.clone(),
                    narrator: item.narrator.clone(),
                    duration_minutes: item.duration_minutes,
                    series_name: item.series_name.clone(),
                    series_sequence: item.series_sequence.clone(),
                    year: item.year.clone(),
                };

                let result = match book_dna::generate_dna(&config, &input).await {
                    Ok(dna) => {
                        let dna_tags = book_dna::dna_to_tags(&dna);
                        let merged_tags = book_dna::merge_dna_tags(&item.tags, &dna_tags);

                        GenerateDnaResult {
                            id: item.id.clone(),
                            success: true,
                            dna_tags,
                            merged_tags,
                            error: None,
                        }
                    }
                    Err(e) => GenerateDnaResult {
                        id: item.id.clone(),
                        success: false,
                        dna_tags: vec![],
                        merged_tags: item.tags.clone(),
                        error: Some(e),
                    },
                };

                // Emit progress event
                let _ = window.emit("dna-progress", DnaProgressEvent {
                    current: idx + 1,
                    total,
                    id: result.id.clone(),
                    title: item.title,
                    success: result.success,
                    error: result.error.clone(),
                });

                result
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    // Emit completion event
    let success_count = results.iter().filter(|r| r.success).count();
    let _ = window.emit("dna-complete", serde_json::json!({
        "total": total,
        "success": success_count,
        "failed": total - success_count,
    }));

    Ok(results)
}

/// Get DNA tags from existing tags (for display purposes)
#[tauri::command]
pub fn get_dna_tags_from_tags(tags: Vec<String>) -> Vec<String> {
    tags.into_iter()
        .filter(|t| book_dna::is_dna_tag(t))
        .collect()
}

/// Remove DNA tags from a tag list
#[tauri::command]
pub fn remove_dna_tags(tags: Vec<String>) -> Vec<String> {
    tags.into_iter()
        .filter(|t| !book_dna::is_dna_tag(t))
        .collect()
}

/// Request for cache migration — list of books to validate against
#[derive(Debug, Deserialize)]
pub struct MigrateDnaCacheRequest {
    pub books: Vec<MigrateDnaCacheBook>,
}

#[derive(Debug, Deserialize)]
pub struct MigrateDnaCacheBook {
    pub title: String,
    pub author: String,
    pub series_name: Option<String>,
}

/// Migrate cached DNA entries: strip self-referential comp-vibes/comp-authors.
/// No GPT calls, no API cost. Runs locally against the sled cache.
#[tauri::command]
pub fn migrate_dna_cache(
    request: MigrateDnaCacheRequest,
) -> Result<book_dna::DnaCacheMigrationResult, String> {
    let books: Vec<(String, String, Option<String>)> = request
        .books
        .into_iter()
        .map(|b| (b.title, b.author, b.series_name))
        .collect();

    Ok(book_dna::migrate_cached_dna(&books))
}
