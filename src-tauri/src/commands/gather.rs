// commands/gather.rs
// Phase 1 of optimized Run All: gather ALL external API data in one pass
// This eliminates redundant API calls across metadata, ISBN, and year steps.

use serde::{Deserialize, Serialize};
use futures::stream::{self, StreamExt};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Window};

#[derive(Debug, Clone, Deserialize)]
pub struct GatherRequest {
    pub id: String,
    pub title: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct GatheredBookData {
    pub id: String,

    // ABS results (Audible/Google/iTunes via ABS proxy)
    pub abs_title: Option<String>,
    pub abs_author: Option<String>,
    pub abs_subtitle: Option<String>,
    pub abs_series: Option<String>,
    pub abs_sequence: Option<String>,
    pub abs_narrator: Option<String>,
    pub abs_year: Option<String>,
    pub abs_description: Option<String>,

    // Custom provider results (Goodreads/Hardcover/Storytel)
    pub isbn: Option<String>,
    pub asin: Option<String>,
    pub provider_year: Option<String>,
    pub provider_description: Option<String>,
    pub provider_genres: Vec<String>,
    pub provider_narrator: Option<String>,

    // Open Library
    pub ol_year: Option<String>,
    pub ol_date: Option<String>,

    // Google Books
    pub gb_year: Option<String>,
    pub gb_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatherBatchResponse {
    pub results: Vec<GatheredBookData>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
struct GatherProgressEvent {
    pub current: usize,
    pub total: usize,
    pub title: String,
}

/// Phase 1: Gather all external API data for books in parallel.
/// Calls ABS, custom providers, Open Library, and Google Books simultaneously per book.
#[tauri::command]
pub async fn gather_external_data(
    window: Window,
    books: Vec<GatherRequest>,
    config: crate::config::Config,
) -> Result<GatherBatchResponse, String> {
    let total = books.len();
    println!("📡 Phase 1: Gathering external data for {} books", total);

    let counter = Arc::new(AtomicUsize::new(0));

    let results: Vec<GatheredBookData> = stream::iter(books)
        .map(|book| {
            let config = config.clone();
            let window = window.clone();
            let counter = counter.clone();
            async move {
                let title = book.title.clone();
                let result = gather_single_book(book, &config).await;

                let current = counter.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = window.emit("gather-progress", GatherProgressEvent {
                    current,
                    total,
                    title,
                });

                result
            }
        })
        .buffer_unordered(25)
        .collect()
        .await;

    println!("✅ Phase 1 complete: gathered data for {} books", results.len());

    Ok(GatherBatchResponse { results, total })
}

async fn gather_single_book(
    book: GatherRequest,
    config: &crate::config::Config,
) -> GatheredBookData {
    let mut data = GatheredBookData {
        id: book.id.clone(),
        ..Default::default()
    };

    // Run all 4 API sources in parallel
    let (abs_result, provider_result, ol_result, gb_result) = tokio::join!(
        crate::abs_search::search_metadata_waterfall(config, &book.title, &book.author),
        crate::custom_providers::search_custom_providers(config, &book.title, &book.author),
        super::genres::lookup_open_library_pub(&book.title, &book.author),
        super::genres::lookup_google_books_pub(&book.title, &book.author),
    );

    // Process ABS results
    if let Some(abs) = abs_result {
        data.abs_title = abs.title;
        data.abs_author = abs.author;
        data.abs_subtitle = abs.subtitle;
        data.abs_narrator = abs.narrator;
        data.abs_year = abs.published_year;
        data.abs_description = abs.description;
        if let Some(first_series) = abs.series.first() {
            data.abs_series = first_series.series.clone();
            data.abs_sequence = first_series.sequence.clone();
        }
    }

    // Process custom provider results — find first with ISBN/ASIN, collect all data
    for result in &provider_result {
        if data.isbn.is_none() {
            data.isbn = result.isbn.clone();
        }
        if data.asin.is_none() {
            data.asin = result.asin.clone();
        }
        if data.provider_year.is_none() {
            data.provider_year = result.published_year.clone();
        }
        if data.provider_description.is_none() {
            data.provider_description = result.description.clone();
        }
        if data.provider_narrator.is_none() {
            data.provider_narrator = result.narrator.clone();
        }
        if data.provider_genres.is_empty() {
            data.provider_genres = result.genres.clone();
        }
    }

    // Process Open Library
    if let Some((year, date)) = ol_result {
        data.ol_year = Some(year.to_string());
        data.ol_date = Some(date);
    }

    // Process Google Books
    if let Some((year, date)) = gb_result {
        data.gb_year = Some(year.to_string());
        data.gb_date = Some(date);
    }

    println!("   📡 {} : ABS={} Provider={} OL={} GB={}",
        book.title,
        if data.abs_title.is_some() { "✓" } else { "✗" },
        if data.isbn.is_some() || data.asin.is_some() { "✓" } else { "✗" },
        if data.ol_year.is_some() { "✓" } else { "✗" },
        if data.gb_year.is_some() { "✓" } else { "✗" },
    );

    data
}
