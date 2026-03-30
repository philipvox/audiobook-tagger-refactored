// src-tauri/src/commands/isbn.rs
//
// Commands for batch ISBN/ASIN lookup using connected APIs

use crate::config::Config;
use crate::custom_providers::search_custom_providers;
use serde::{Deserialize, Serialize};
use tauri::command;

/// Request to lookup ISBN for a single book
#[derive(Debug, Deserialize)]
pub struct ISBNLookupRequest {
    pub title: String,
    pub author: String,
}

/// Response with ISBN lookup result
#[derive(Debug, Serialize)]
pub struct ISBNLookupResponse {
    pub success: bool,
    pub isbn: Option<String>,
    pub asin: Option<String>,
    pub source: Option<String>,
    pub error: Option<String>,
}

/// Lookup ISBN/ASIN for a book using connected APIs
#[command]
pub async fn lookup_book_isbn(request: ISBNLookupRequest) -> ISBNLookupResponse {
    println!("\n🔍 lookup_book_isbn called");
    println!("   Title: '{}'", request.title);
    println!("   Author: '{}'", request.author);

    // Load config
    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            return ISBNLookupResponse {
                success: false,
                isbn: None,
                asin: None,
                source: None,
                error: Some(format!("Failed to load config: {}", e)),
            };
        }
    };

    // Search all custom providers
    let results = search_custom_providers(&config, &request.title, &request.author).await;

    if results.is_empty() {
        return ISBNLookupResponse {
            success: false,
            isbn: None,
            asin: None,
            source: None,
            error: Some("No results from any provider".to_string()),
        };
    }

    // Find the first result with ISBN or ASIN
    for result in &results {
        if result.isbn.is_some() || result.asin.is_some() {
            println!("   ✅ Found ISBN/ASIN from {}", result.provider_name);
            return ISBNLookupResponse {
                success: true,
                isbn: result.isbn.clone(),
                asin: result.asin.clone(),
                source: Some(result.provider_name.clone()),
                error: None,
            };
        }
    }

    // No ISBN/ASIN found in any result
    println!("   ⚠️  No ISBN/ASIN found in any provider results");
    ISBNLookupResponse {
        success: false,
        isbn: None,
        asin: None,
        source: None,
        error: Some("No ISBN/ASIN found in provider results".to_string()),
    }
}

/// Batch lookup ISBN/ASIN for multiple books
#[command]
pub async fn lookup_isbn_batch(requests: Vec<ISBNLookupRequest>) -> Vec<ISBNLookupResponse> {
    println!("\n🔍 lookup_isbn_batch called for {} books", requests.len());

    let mut results = Vec::new();

    for (idx, request) in requests.into_iter().enumerate() {
        println!("\n   [{}/batch] Looking up '{}'...", idx + 1, request.title);
        let response = lookup_book_isbn(request).await;
        results.push(response);
    }

    results
}
