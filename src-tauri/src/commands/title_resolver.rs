// src-tauri/src/commands/title_resolver.rs
//
// Tauri commands for GPT-based title and series resolution

use crate::config::Config;
use crate::title_resolver::{
    TitleResolverInput, TitleResolverOutput, resolve_title_with_gpt, resolve_titles_batch
};
use crate::series_resolver::{
    SeriesResolverInput, SeriesResolverOutput, resolve_series_with_abs_and_gpt
};
use serde::{Deserialize, Serialize};

/// Request for resolving a single title
#[derive(Debug, Deserialize)]
pub struct ResolveTitleRequest {
    /// Raw filename
    pub filename: Option<String>,
    /// Folder name
    pub folder_name: Option<String>,
    /// Full folder path for context
    pub folder_path: Option<String>,
    /// Current/existing title
    pub current_title: Option<String>,
    /// Current/existing author
    pub current_author: Option<String>,
    /// Current/existing series
    pub current_series: Option<String>,
    /// Current/existing sequence
    pub current_sequence: Option<String>,
    /// Any additional context
    pub additional_context: Option<String>,
}

impl From<ResolveTitleRequest> for TitleResolverInput {
    fn from(req: ResolveTitleRequest) -> Self {
        TitleResolverInput {
            filename: req.filename,
            folder_name: req.folder_name,
            folder_path: req.folder_path,
            current_title: req.current_title,
            current_author: req.current_author,
            current_series: req.current_series,
            current_sequence: req.current_sequence,
            additional_context: req.additional_context,
        }
    }
}

/// Response for title resolution
#[derive(Debug, Serialize)]
pub struct ResolveTitleResponse {
    pub success: bool,
    pub result: Option<TitleResolverOutput>,
    pub error: Option<String>,
}

/// Resolve a single title using GPT
#[tauri::command]
pub async fn resolve_title(request: ResolveTitleRequest) -> Result<ResolveTitleResponse, String> {
    // Load config to get API key
    let config = Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    let api_key = config.openai_api_key
        .ok_or_else(|| "OpenAI API key not configured. Please set it in Settings.".to_string())?;

    if api_key.is_empty() {
        return Err("OpenAI API key is empty. Please set it in Settings.".to_string());
    }

    let input: TitleResolverInput = request.into();

    match resolve_title_with_gpt(&input, &api_key).await {
        Ok(output) => {
            println!("   ✅ Title resolved: \"{}\"", output.title);
            if let Some(author) = &output.author {
                println!("      Author: {}", author);
            }
            Ok(ResolveTitleResponse {
                success: true,
                result: Some(output),
                error: None,
            })
        }
        Err(e) => {
            println!("   ❌ Title resolution failed: {}", e);
            Ok(ResolveTitleResponse {
                success: false,
                result: None,
                error: Some(e),
            })
        }
    }
}

/// Request for batch title resolution
#[derive(Debug, Deserialize)]
pub struct ResolveTitlesBatchRequest {
    pub items: Vec<ResolveTitleRequest>,
}

/// Response for batch title resolution
#[derive(Debug, Serialize)]
pub struct ResolveTitlesBatchResponse {
    pub results: Vec<ResolveTitleResponse>,
    pub success_count: usize,
    pub failed_count: usize,
}

/// Resolve multiple titles using GPT (batch processing)
#[tauri::command]
pub async fn resolve_titles_batch_cmd(
    request: ResolveTitlesBatchRequest
) -> Result<ResolveTitlesBatchResponse, String> {
    // Load config to get API key
    let config = Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    let api_key = config.openai_api_key
        .ok_or_else(|| "OpenAI API key not configured. Please set it in Settings.".to_string())?;

    if api_key.is_empty() {
        return Err("OpenAI API key is empty. Please set it in Settings.".to_string());
    }

    let inputs: Vec<TitleResolverInput> = request.items
        .into_iter()
        .map(|r| r.into())
        .collect();

    println!("🔍 Batch resolving {} titles with GPT...", inputs.len());

    let results = resolve_titles_batch(inputs, api_key).await;

    let mut success_count = 0;
    let mut failed_count = 0;

    let responses: Vec<ResolveTitleResponse> = results
        .into_iter()
        .map(|r| match r {
            Ok(output) => {
                success_count += 1;
                ResolveTitleResponse {
                    success: true,
                    result: Some(output),
                    error: None,
                }
            }
            Err(e) => {
                failed_count += 1;
                ResolveTitleResponse {
                    success: false,
                    result: None,
                    error: Some(e),
                }
            }
        })
        .collect();

    println!("✅ Batch complete: {} success, {} failed", success_count, failed_count);

    Ok(ResolveTitlesBatchResponse {
        results: responses,
        success_count,
        failed_count,
    })
}

/// Quick title cleanup - just cleans a title string without full resolution
#[tauri::command]
pub async fn quick_title_cleanup(
    title: String,
    author: Option<String>,
) -> Result<ResolveTitleResponse, String> {
    // Load config to get API key
    let config = Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    let api_key = config.openai_api_key
        .ok_or_else(|| "OpenAI API key not configured".to_string())?;

    let input = TitleResolverInput {
        filename: None,
        folder_name: None,
        folder_path: None,
        current_title: Some(title),
        current_author: author,
        current_series: None,
        current_sequence: None,
        additional_context: None,
    };

    match resolve_title_with_gpt(&input, &api_key).await {
        Ok(output) => Ok(ResolveTitleResponse {
            success: true,
            result: Some(output),
            error: None,
        }),
        Err(e) => Ok(ResolveTitleResponse {
            success: false,
            result: None,
            error: Some(e),
        }),
    }
}

// ============================================================================
// Series Resolution Commands
// ============================================================================

/// Request for resolving series information
#[derive(Debug, Deserialize)]
pub struct ResolveSeriesRequest {
    /// Book title (required for Audible lookup)
    pub title: String,
    /// Author name (required for Audible lookup)
    pub author: String,
    /// Current series name from metadata
    pub current_series: Option<String>,
    /// Current sequence number from metadata
    pub current_sequence: Option<String>,
}

impl From<ResolveSeriesRequest> for SeriesResolverInput {
    fn from(req: ResolveSeriesRequest) -> Self {
        SeriesResolverInput {
            title: req.title,
            author: req.author,
            current_series: req.current_series,
            current_sequence: req.current_sequence,
        }
    }
}

/// Response for series resolution
#[derive(Debug, Serialize)]
pub struct ResolveSeriesResponse {
    pub success: bool,
    pub result: Option<SeriesResolverOutput>,
    pub error: Option<String>,
}

/// Resolve series information using ABS/Audible + GPT
#[tauri::command]
pub async fn resolve_series(request: ResolveSeriesRequest) -> Result<ResolveSeriesResponse, String> {
    // Load config
    let config = Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    let api_key = config.openai_api_key.clone()
        .ok_or_else(|| "OpenAI API key not configured. Please set it in Settings.".to_string())?;

    if api_key.is_empty() {
        return Err("OpenAI API key is empty. Please set it in Settings.".to_string());
    }

    let input: SeriesResolverInput = request.into();

    println!("📚 Resolving series for: \"{}\" by {}", input.title, input.author);

    match resolve_series_with_abs_and_gpt(&input, &config, &api_key).await {
        Ok(output) => {
            if let Some(ref series) = output.series {
                println!("   ✅ Series resolved: {} #{}",
                    series,
                    output.sequence.as_deref().unwrap_or("?")
                );
            } else {
                println!("   ℹ️ No series found (standalone book)");
            }
            Ok(ResolveSeriesResponse {
                success: true,
                result: Some(output),
                error: None,
            })
        }
        Err(e) => {
            println!("   ❌ Series resolution failed: {}", e);
            Ok(ResolveSeriesResponse {
                success: false,
                result: None,
                error: Some(e),
            })
        }
    }
}
