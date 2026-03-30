// src-tauri/src/commands/age_rating.rs
//
// Commands for age rating resolution using API data + GPT synthesis

use crate::age_rating_resolver::{resolve_age_rating, AgeRatingInput};
use crate::config::Config;
use serde::{Deserialize, Serialize};
use tauri::command;

/// Request to resolve age rating for a single book
#[derive(Debug, Deserialize)]
pub struct AgeRatingRequest {
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub description: Option<String>,
    pub genres: Vec<String>,
    pub publisher: Option<String>,
}

/// Response with age rating result
#[derive(Debug, Serialize)]
pub struct AgeRatingResponse {
    pub success: bool,
    pub age_category: Option<String>,
    pub min_age: Option<u8>,
    pub content_rating: Option<String>,
    pub age_tags: Vec<String>,
    pub confidence: Option<String>,
    pub reasoning: Option<String>,
    pub sources_used: Vec<String>,
    pub error: Option<String>,
}

/// Resolve age rating for a book using API data + GPT synthesis
#[command]
pub async fn resolve_book_age_rating(request: AgeRatingRequest) -> AgeRatingResponse {
    println!("\n🎯 resolve_book_age_rating called");
    println!("   Title: '{}'", request.title);
    println!("   Author: '{}'", request.author);

    // Load config (needed for API keys and custom providers)
    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            return AgeRatingResponse {
                success: false,
                age_category: None,
                min_age: None,
                content_rating: None,
                age_tags: vec![],
                confidence: None,
                reasoning: None,
                sources_used: vec![],
                error: Some(format!("Failed to load config: {}", e)),
            };
        }
    };

    let input = AgeRatingInput {
        title: request.title,
        author: request.author,
        series: request.series,
        description: request.description,
        genres: request.genres,
        publisher: request.publisher,
    };

    match resolve_age_rating(&config, &input).await {
        Ok(result) => AgeRatingResponse {
            success: true,
            age_category: Some(result.age_category),
            min_age: result.min_age,
            content_rating: Some(result.content_rating),
            age_tags: result.age_tags,
            confidence: Some(result.confidence),
            reasoning: Some(result.reasoning),
            sources_used: result.sources_used,
            error: None,
        },
        Err(e) => AgeRatingResponse {
            success: false,
            age_category: None,
            min_age: None,
            content_rating: None,
            age_tags: vec![],
            confidence: None,
            reasoning: None,
            sources_used: vec![],
            error: Some(e),
        },
    }
}

/// Batch resolve age ratings for multiple books
#[command]
pub async fn resolve_age_ratings_batch(
    requests: Vec<AgeRatingRequest>,
) -> Vec<AgeRatingResponse> {
    println!("\n🎯 resolve_age_ratings_batch called for {} books", requests.len());

    // Load config (needed for API keys and custom providers)
    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            return requests.iter().map(|_| AgeRatingResponse {
                success: false,
                age_category: None,
                min_age: None,
                content_rating: None,
                age_tags: vec![],
                confidence: None,
                reasoning: None,
                sources_used: vec![],
                error: Some(format!("Failed to load config: {}", e)),
            }).collect();
        }
    };

    // Process sequentially (API calls are rate-limited)
    let mut results = Vec::new();

    for (idx, request) in requests.into_iter().enumerate() {
        println!("\n   [{}/batch] Processing '{}'...", idx + 1, request.title);

        let input = AgeRatingInput {
            title: request.title,
            author: request.author,
            series: request.series,
            description: request.description,
            genres: request.genres,
            publisher: request.publisher,
        };

        let response = match resolve_age_rating(&config, &input).await {
            Ok(result) => AgeRatingResponse {
                success: true,
                age_category: Some(result.age_category),
                min_age: result.min_age,
                content_rating: Some(result.content_rating),
                age_tags: result.age_tags,
                confidence: Some(result.confidence),
                reasoning: Some(result.reasoning),
                sources_used: result.sources_used,
                error: None,
            },
            Err(e) => AgeRatingResponse {
                success: false,
                age_category: None,
                min_age: None,
                content_rating: None,
                age_tags: vec![],
                confidence: None,
                reasoning: None,
                sources_used: vec![],
                error: Some(e),
            },
        };

        results.push(response);
    }

    results
}
