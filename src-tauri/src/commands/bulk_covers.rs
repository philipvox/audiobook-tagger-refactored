use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Semaphore;

use crate::config;
use crate::cover_art::{search_all_cover_sources, CoverCandidate};

/// A library item with metadata needed for cover search
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulkCoverItem {
    pub id: String,
    pub title: String,
    pub author: String,
    pub asin: Option<String>,
    pub isbn: Option<String>,
    pub has_abs_cover: bool,
}

/// A book with its cover search results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookCoverResult {
    pub id: String,
    pub title: String,
    pub author: String,
    pub asin: Option<String>,
    pub isbn: Option<String>,
    pub has_abs_cover: bool,
    pub candidates: Vec<CoverCandidateInfo>,
    pub best_candidate: Option<CoverCandidateInfo>,
    pub selected: bool, // Whether to download this cover
}

/// Simplified cover candidate for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverCandidateInfo {
    pub url: String,
    pub source: String,
    pub width: u32,
    pub height: u32,
    pub quality_score: u8,
}

impl From<CoverCandidate> for CoverCandidateInfo {
    fn from(c: CoverCandidate) -> Self {
        Self {
            url: c.url,
            source: c.source.to_string(),
            width: c.width,
            height: c.height,
            quality_score: c.quality_score,
        }
    }
}

/// Progress event payload
#[derive(Debug, Clone, Serialize)]
pub struct BulkCoverProgress {
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub current_book: Option<String>,
    pub covers_found: usize,
    pub covers_failed: usize,
}

/// Result of search phase
#[derive(Debug, Serialize)]
pub struct BulkSearchResult {
    pub books: Vec<BookCoverResult>,
    pub total_books: usize,
    pub books_with_covers: usize,
}

/// Result of download phase
#[derive(Debug, Serialize)]
pub struct BulkDownloadResult {
    pub total_selected: usize,
    pub covers_downloaded: usize,
    pub covers_failed: usize,
    pub output_folder: String,
}

/// Response structure for ABS library items with expanded metadata
#[derive(Debug, Deserialize)]
struct AbsExpandedResponse {
    results: Vec<AbsExpandedItem>,
}

#[derive(Debug, Deserialize)]
struct AbsExpandedItem {
    id: String,
    #[serde(default)]
    media: Option<AbsMedia>,
}

#[derive(Debug, Deserialize)]
struct AbsMedia {
    #[serde(default)]
    metadata: Option<AbsMetadata>,
    #[serde(default, rename = "coverPath")]
    cover_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AbsMetadata {
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "authorName")]
    author_name: Option<String>,
    #[serde(default)]
    asin: Option<String>,
    #[serde(default)]
    isbn: Option<String>,
}

/// Sanitize a string for use as a filename
fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Fetch all library items with expanded metadata
async fn fetch_library_items_expanded(
    client: &reqwest::Client,
    config: &config::Config,
    window: &tauri::Window,
) -> Result<Vec<BulkCoverItem>, String> {
    let mut items = Vec::new();
    let mut page = 0;
    let limit = 100;

    loop {
        let _ = window.emit(
            "bulk_cover_progress",
            BulkCoverProgress {
                phase: "Fetching library".to_string(),
                current: items.len(),
                total: 0,
                current_book: None,
                covers_found: 0,
                covers_failed: 0,
            },
        );

        let url = format!(
            "{}/api/libraries/{}/items?limit={}&page={}&expanded=1",
            config.abs_base_url, config.abs_library_id, limit, page
        );

        let response = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch library: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("ABS API error: {}", response.status()));
        }

        let payload: AbsExpandedResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        let result_count = payload.results.len();

        for item in payload.results {
            if let Some(media) = item.media {
                if let Some(metadata) = media.metadata {
                    let title = metadata.title.unwrap_or_default();
                    let author = metadata.author_name.unwrap_or_default();

                    if title.is_empty() || author.is_empty() {
                        continue;
                    }

                    items.push(BulkCoverItem {
                        id: item.id,
                        title,
                        author,
                        asin: metadata.asin,
                        isbn: metadata.isbn,
                        has_abs_cover: media.cover_path.is_some(),
                    });
                }
            }
        }

        if result_count < limit {
            break;
        }
        page += 1;
    }

    Ok(items)
}

/// PHASE 1: Search for covers for all books in library
#[tauri::command]
pub async fn bulk_search_covers(
    window: tauri::Window,
) -> Result<BulkSearchResult, String> {
    println!("🔍 Starting bulk cover search...");

    let config = config::load_config().map_err(|e| format!("Config error: {}", e))?;

    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() {
        return Err("ABS not configured. Please configure ABS settings first.".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    // Fetch library items
    let items = fetch_library_items_expanded(&client, &config, &window).await?;
    let total = items.len();

    println!("📚 Found {} books in library", total);

    let _ = window.emit(
        "bulk_cover_progress",
        BulkCoverProgress {
            phase: "Searching for covers".to_string(),
            current: 0,
            total,
            current_book: None,
            covers_found: 0,
            covers_failed: 0,
        },
    );

    // Counters
    let covers_found = Arc::new(AtomicUsize::new(0));
    let processed = Arc::new(AtomicUsize::new(0));

    // Process items with limited concurrency - reduced to avoid rate limits
    let semaphore = Arc::new(Semaphore::new(3)); // 3 concurrent to avoid 429 rate limits
    let mut handles = Vec::new();

    for item in items {
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let window_clone = window.clone();
        let covers_found_clone = covers_found.clone();
        let processed_clone = processed.clone();
        let total_count = total;

        let handle = tokio::spawn(async move {
            let display_name = format!("{} - {}", item.author, item.title);

            // Emit progress
            let current = processed_clone.load(Ordering::SeqCst);
            let _ = window_clone.emit(
                "bulk_cover_progress",
                BulkCoverProgress {
                    phase: "Searching for covers".to_string(),
                    current,
                    total: total_count,
                    current_book: Some(display_name.clone()),
                    covers_found: covers_found_clone.load(Ordering::SeqCst),
                    covers_failed: 0,
                },
            );

            // Search for covers
            let search_result = search_all_cover_sources(
                &item.title,
                &item.author,
                item.isbn.as_deref(),
                item.asin.as_deref(),
            )
            .await;

            let candidates: Vec<CoverCandidateInfo> = search_result
                .candidates
                .into_iter()
                .map(CoverCandidateInfo::from)
                .collect();

            let best = search_result.best_candidate.map(CoverCandidateInfo::from);
            let has_cover = best.is_some();

            if has_cover {
                covers_found_clone.fetch_add(1, Ordering::SeqCst);
            }

            processed_clone.fetch_add(1, Ordering::SeqCst);
            drop(permit);

            BookCoverResult {
                id: item.id,
                title: item.title,
                author: item.author,
                asin: item.asin,
                isbn: item.isbn,
                has_abs_cover: item.has_abs_cover,
                candidates,
                best_candidate: best,
                selected: has_cover, // Auto-select if cover found
            }
        });

        handles.push(handle);
    }

    // Collect results
    let mut books = Vec::new();
    for handle in handles {
        if let Ok(result) = handle.await {
            books.push(result);
        }
    }

    // Sort by author, then title
    books.sort_by(|a, b| {
        a.author.to_lowercase().cmp(&b.author.to_lowercase())
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    let books_with_covers = books.iter().filter(|b| b.best_candidate.is_some()).count();

    println!(
        "✅ Search complete: {} books, {} with covers",
        books.len(),
        books_with_covers
    );

    // Final progress
    let _ = window.emit(
        "bulk_cover_progress",
        BulkCoverProgress {
            phase: "Search complete".to_string(),
            current: total,
            total,
            current_book: None,
            covers_found: books_with_covers,
            covers_failed: 0,
        },
    );

    Ok(BulkSearchResult {
        books,
        total_books: total,
        books_with_covers,
    })
}

/// PHASE 2: Download selected covers
#[tauri::command]
pub async fn bulk_download_selected_covers(
    window: tauri::Window,
    books: Vec<BookCoverResult>,
    output_folder: String,
) -> Result<BulkDownloadResult, String> {
    println!("📥 Starting bulk cover download to: {}", output_folder);

    // Validate output folder
    let output_path = Path::new(&output_folder);
    if !output_path.exists() {
        std::fs::create_dir_all(output_path)
            .map_err(|e| format!("Failed to create output folder: {}", e))?;
    }

    // Filter to selected books only
    let selected: Vec<_> = books.into_iter().filter(|b| b.selected).collect();
    let total = selected.len();

    if total == 0 {
        return Ok(BulkDownloadResult {
            total_selected: 0,
            covers_downloaded: 0,
            covers_failed: 0,
            output_folder,
        });
    }

    println!("📥 Downloading {} selected covers", total);

    // Counters
    let downloaded = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    let processed = Arc::new(AtomicUsize::new(0));

    // Process with limited concurrency
    let semaphore = Arc::new(Semaphore::new(10));
    let output_folder_arc = Arc::new(output_folder.clone());
    let mut handles = Vec::new();

    for book in selected {
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let window_clone = window.clone();
        let downloaded_clone = downloaded.clone();
        let failed_clone = failed.clone();
        let processed_clone = processed.clone();
        let output_folder_clone = output_folder_arc.clone();
        let total_count = total;

        let handle = tokio::spawn(async move {
            let display_name = format!("{} - {}", book.author, book.title);
            let output_path = Path::new(output_folder_clone.as_ref());

            // Emit progress
            let current = processed_clone.load(Ordering::SeqCst);
            let _ = window_clone.emit(
                "bulk_cover_progress",
                BulkCoverProgress {
                    phase: "Downloading covers".to_string(),
                    current,
                    total: total_count,
                    current_book: Some(display_name.clone()),
                    covers_found: downloaded_clone.load(Ordering::SeqCst),
                    covers_failed: failed_clone.load(Ordering::SeqCst),
                },
            );

            // Try to download from candidates (try multiple if first fails)
            let mut success = false;

            // Get all candidate URLs to try
            let mut urls_to_try: Vec<String> = Vec::new();
            if let Some(ref best) = book.best_candidate {
                urls_to_try.push(best.url.clone());
            }
            for candidate in &book.candidates {
                if !urls_to_try.contains(&candidate.url) {
                    urls_to_try.push(candidate.url.clone());
                }
            }

            for url in urls_to_try.iter().take(5) {
                // Try up to 5 URLs
                match download_cover_to_file(url, &book.author, &book.title, output_path).await {
                    Ok(_) => {
                        success = true;
                        println!("   ✅ Saved: {} - {}", book.author, book.title);
                        break;
                    }
                    Err(e) => {
                        println!("   ⚠️  URL failed for {}: {}", display_name, e);
                    }
                }
            }

            if success {
                downloaded_clone.fetch_add(1, Ordering::SeqCst);
            } else {
                println!("   ❌ All URLs failed for: {}", display_name);
                failed_clone.fetch_add(1, Ordering::SeqCst);
            }

            processed_clone.fetch_add(1, Ordering::SeqCst);
            drop(permit);
        });

        handles.push(handle);
    }

    // Wait for all
    for handle in handles {
        let _ = handle.await;
    }

    let final_downloaded = downloaded.load(Ordering::SeqCst);
    let final_failed = failed.load(Ordering::SeqCst);

    println!(
        "✅ Download complete: {} succeeded, {} failed",
        final_downloaded, final_failed
    );

    // Final progress
    let _ = window.emit(
        "bulk_cover_progress",
        BulkCoverProgress {
            phase: "Download complete".to_string(),
            current: total,
            total,
            current_book: None,
            covers_found: final_downloaded,
            covers_failed: final_failed,
        },
    );

    Ok(BulkDownloadResult {
        total_selected: total,
        covers_downloaded: final_downloaded,
        covers_failed: final_failed,
        output_folder,
    })
}

/// Download a cover to a file
async fn download_cover_to_file(
    url: &str,
    author: &str,
    title: &str,
    output_path: &Path,
) -> Result<(), String> {
    println!("      📥 Trying URL: {}", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| {
            println!("      ❌ Client build failed: {}", e);
            e.to_string()
        })?;

    let response = client
        .get(url)
        .header("Accept", "image/webp,image/apng,image/*,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| {
            println!("      ❌ Request failed: {}", e);
            format!("Request failed: {}", e)
        })?;

    let status = response.status();
    if !status.is_success() {
        println!("      ❌ HTTP error: {}", status);
        return Err(format!("HTTP {}", status));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown");
    println!("      📦 Content-Type: {}, Status: {}", content_type, status);

    let bytes = response.bytes().await.map_err(|e| {
        println!("      ❌ Failed to read bytes: {}", e);
        e.to_string()
    })?;
    let data = bytes.to_vec();
    println!("      📦 Downloaded {} bytes", data.len());

    // Validate it's a real image - be more lenient
    if data.len() < 100 {
        println!("      ❌ Image too small: {} bytes", data.len());
        return Err(format!("Image too small: {} bytes", data.len()));
    }

    // Check magic bytes - also support WebP
    let is_png = data.len() >= 8
        && data[0] == 0x89
        && data[1] == 0x50
        && data[2] == 0x4E
        && data[3] == 0x47;
    let is_jpeg = data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8;
    let is_webp = data.len() >= 12
        && data[0] == 0x52  // R
        && data[1] == 0x49  // I
        && data[2] == 0x46  // F
        && data[3] == 0x46  // F
        && data[8] == 0x57  // W
        && data[9] == 0x45  // E
        && data[10] == 0x42 // B
        && data[11] == 0x50; // P

    if !is_png && !is_jpeg && !is_webp {
        println!("      ❌ Not a valid image, first bytes: {:02X} {:02X} {:02X} {:02X}",
            data.get(0).unwrap_or(&0), data.get(1).unwrap_or(&0),
            data.get(2).unwrap_or(&0), data.get(3).unwrap_or(&0));
        return Err("Not a valid image".to_string());
    }

    let ext = if is_png { "png" } else if is_webp { "webp" } else { "jpg" };

    // Build filename
    let safe_author = sanitize_filename(author);
    let safe_title = sanitize_filename(title);
    let filename = format!("{} - {}.{}", safe_author, safe_title, ext);
    let filepath = output_path.join(&filename);

    std::fs::write(&filepath, &data)
        .map_err(|e| {
            println!("      ❌ Failed to save: {}", e);
            format!("Failed to save: {}", e)
        })?;

    println!("      ✅ Saved: {}", filename);
    Ok(())
}

// Keep the old command for backwards compatibility but redirect to new flow
#[tauri::command]
pub async fn bulk_download_covers(
    window: tauri::Window,
    output_folder: String,
) -> Result<BulkDownloadResult, String> {
    // First search
    let search_result = bulk_search_covers(window.clone()).await?;

    // Then download all with covers
    bulk_download_selected_covers(window, search_result.books, output_folder).await
}
