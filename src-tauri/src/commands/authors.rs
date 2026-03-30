// commands/authors.rs
// Tauri commands for ABS author-focused operations

use crate::{config, scanner, validation};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

// ============================================================================
// TYPES
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbsAuthor {
    pub id: String,
    pub name: String,
    #[serde(rename = "numBooks", default)]
    pub num_books: usize,
    #[serde(rename = "imagePath", default)]
    pub image_path: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbsAuthorDetail {
    pub id: String,
    pub name: String,
    #[serde(rename = "imagePath", default)]
    pub image_path: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "numBooks", default)]
    pub num_books: usize,
    #[serde(rename = "libraryItems", default)]
    pub library_items: Vec<AbsAuthorBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbsAuthorBook {
    pub id: String,
    #[serde(default)]
    pub media: Option<AbsAuthorBookMedia>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbsAuthorBookMedia {
    #[serde(default)]
    pub metadata: Option<AbsAuthorBookMetadata>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(rename = "coverPath", default)]
    pub cover_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbsAuthorBookMetadata {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    #[serde(default)]
    pub authors: Vec<AbsPersonRef>,
    #[serde(default)]
    pub narrators: Vec<String>,
    #[serde(default)]
    pub series: Vec<AbsSeriesRef>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(rename = "publishedYear")]
    pub published_year: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbsPersonRef {
    pub id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbsSeriesRef {
    pub id: Option<String>,
    pub name: String,
    pub sequence: Option<String>,
}

// Frontend-friendly detail
#[derive(Debug, Clone, Serialize)]
pub struct AuthorDetailResponse {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub has_image: bool,
    pub num_books: usize,
    pub books: Vec<AuthorBookSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthorBookSummary {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub narrators: Vec<String>,
    pub genres: Vec<String>,
    pub duration_seconds: Option<f64>,
    pub has_cover: bool,
}

// Analysis types
#[derive(Debug, Clone, Serialize)]
pub struct AuthorAnalysis {
    pub total_authors: usize,
    pub issues: Vec<AuthorIssue>,
    pub summary: AnalysisSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalysisSummary {
    pub needs_normalization: usize,
    pub suspicious: usize,
    pub potential_duplicates: usize,
    pub missing_description: usize,
    pub missing_image: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthorIssue {
    pub author_id: String,
    pub author_name: String,
    pub issue_type: AuthorIssueType,
    pub severity: String, // "error", "warning", "info"
    pub message: String,
    pub suggested_value: Option<String>,
    pub duplicate_of: Option<DuplicateInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorIssueType {
    NeedsNormalization,
    Suspicious,
    Rejected,
    PotentialDuplicate,
    MissingDescription,
    MissingImage,
    InconsistentGenres,
}

#[derive(Debug, Clone, Serialize)]
pub struct DuplicateInfo {
    pub id: String,
    pub name: String,
}

// ABS API response wrapper for authors list
#[derive(Debug, Deserialize)]
struct AbsAuthorsResponse {
    authors: Vec<AbsAuthor>,
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Fetch all authors from ABS library
#[tauri::command]
pub async fn get_abs_authors() -> Result<Vec<AbsAuthor>, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    validate_abs_config(&config)?;

    let client = make_client()?;
    let url = format!(
        "{}/api/libraries/{}/authors",
        config.abs_base_url, config.abs_library_id
    );

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch authors: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("ABS returned status {}", resp.status()));
    }

    let body: AbsAuthorsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse authors response: {}", e))?;

    Ok(body.authors)
}

/// Fetch full author detail including their books
#[tauri::command]
pub async fn get_abs_author_detail(author_id: String) -> Result<AuthorDetailResponse, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    validate_abs_config(&config)?;

    let client = make_client()?;
    let url = format!(
        "{}/api/authors/{}?include=items",
        config.abs_base_url, author_id
    );

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch author detail: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("ABS returned status {}", resp.status()));
    }

    let detail: AbsAuthorDetail = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse author detail: {}", e))?;

    Ok(to_detail_response(detail))
}

/// Analyze all authors for issues (normalization, suspicious, duplicates)
#[tauri::command]
pub async fn analyze_authors_from_abs(window: tauri::Window) -> Result<AuthorAnalysis, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    validate_abs_config(&config)?;

    let _ = window.emit("authors_progress", serde_json::json!({
        "phase": "fetching",
        "message": "Fetching authors from ABS...",
    }));

    // Fetch all authors
    let client = make_client()?;
    let url = format!(
        "{}/api/libraries/{}/authors",
        config.abs_base_url, config.abs_library_id
    );

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch authors: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("ABS returned status {}", resp.status()));
    }

    let body: AbsAuthorsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse authors: {}", e))?;

    let authors = body.authors;
    let total_authors = authors.len();

    let _ = window.emit("authors_progress", serde_json::json!({
        "phase": "analyzing",
        "message": format!("Analyzing {} authors...", total_authors),
    }));

    let mut issues: Vec<AuthorIssue> = Vec::new();

    // Build normalized name index for duplicate detection
    let mut norm_index: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for author in &authors {
        let key = normalize_for_dedup(&author.name);
        norm_index
            .entry(key)
            .or_default()
            .push((author.id.clone(), author.name.clone()));
    }

    for (i, author) in authors.iter().enumerate() {
        if i % 50 == 0 {
            let _ = window.emit("authors_progress", serde_json::json!({
                "phase": "analyzing",
                "message": format!("Analyzing author {}/{}...", i + 1, total_authors),
                "current": i + 1,
                "total": total_authors,
            }));
        }

        // Run validation
        let result = validation::validate_author(&author.name);
        match result.action {
            validation::ValidationAction::Rejected => {
                issues.push(AuthorIssue {
                    author_id: author.id.clone(),
                    author_name: author.name.clone(),
                    issue_type: AuthorIssueType::Rejected,
                    severity: "error".to_string(),
                    message: result.reason.unwrap_or_else(|| "Invalid author".to_string()),
                    suggested_value: None,
                    duplicate_of: None,
                });
            }
            validation::ValidationAction::Normalized => {
                issues.push(AuthorIssue {
                    author_id: author.id.clone(),
                    author_name: author.name.clone(),
                    issue_type: AuthorIssueType::NeedsNormalization,
                    severity: "warning".to_string(),
                    message: result.reason.unwrap_or_else(|| "Needs normalization".to_string()),
                    suggested_value: result.value,
                    duplicate_of: None,
                });
            }
            validation::ValidationAction::NeedsGpt => {
                issues.push(AuthorIssue {
                    author_id: author.id.clone(),
                    author_name: author.name.clone(),
                    issue_type: AuthorIssueType::Suspicious,
                    severity: "warning".to_string(),
                    message: result.reason.unwrap_or_else(|| "Suspicious author name".to_string()),
                    suggested_value: None,
                    duplicate_of: None,
                });
            }
            validation::ValidationAction::Accepted => {}
        }

        // Check for duplicates (same normalized name, different ABS author ID)
        let key = normalize_for_dedup(&author.name);
        if let Some(matches) = norm_index.get(&key) {
            if matches.len() > 1 {
                for (other_id, other_name) in matches {
                    if *other_id != author.id {
                        issues.push(AuthorIssue {
                            author_id: author.id.clone(),
                            author_name: author.name.clone(),
                            issue_type: AuthorIssueType::PotentialDuplicate,
                            severity: "info".to_string(),
                            message: format!("Potential duplicate of \"{}\"", other_name),
                            suggested_value: Some(other_name.clone()),
                            duplicate_of: Some(DuplicateInfo {
                                id: other_id.clone(),
                                name: other_name.clone(),
                            }),
                        });
                        break; // Only report one duplicate pair
                    }
                }
            }
        }

        // Missing description
        if author.description.as_ref().map_or(true, |d| d.trim().is_empty()) {
            issues.push(AuthorIssue {
                author_id: author.id.clone(),
                author_name: author.name.clone(),
                issue_type: AuthorIssueType::MissingDescription,
                severity: "info".to_string(),
                message: "No description".to_string(),
                suggested_value: None,
                duplicate_of: None,
            });
        }

        // Missing image
        if author.image_path.as_ref().map_or(true, |p| p.trim().is_empty()) {
            issues.push(AuthorIssue {
                author_id: author.id.clone(),
                author_name: author.name.clone(),
                issue_type: AuthorIssueType::MissingImage,
                severity: "info".to_string(),
                message: "No author image".to_string(),
                suggested_value: None,
                duplicate_of: None,
            });
        }
    }

    let _ = window.emit("authors_progress", serde_json::json!({
        "phase": "done",
        "message": format!("Analysis complete. Found {} issues.", issues.len()),
    }));

    let summary = AnalysisSummary {
        needs_normalization: issues.iter().filter(|i| matches!(i.issue_type, AuthorIssueType::NeedsNormalization)).count(),
        suspicious: issues.iter().filter(|i| matches!(i.issue_type, AuthorIssueType::Suspicious | AuthorIssueType::Rejected)).count(),
        potential_duplicates: issues.iter().filter(|i| matches!(i.issue_type, AuthorIssueType::PotentialDuplicate)).count(),
        missing_description: issues.iter().filter(|i| matches!(i.issue_type, AuthorIssueType::MissingDescription)).count(),
        missing_image: issues.iter().filter(|i| matches!(i.issue_type, AuthorIssueType::MissingImage)).count(),
    };

    Ok(AuthorAnalysis {
        total_authors,
        issues,
        summary,
    })
}

/// Rename an author in ABS
#[tauri::command]
pub async fn rename_abs_author(author_id: String, new_name: String) -> Result<AbsAuthor, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    validate_abs_config(&config)?;

    let client = make_client()?;
    let url = format!("{}/api/authors/{}", config.abs_base_url, author_id);

    let resp = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .json(&serde_json::json!({ "name": new_name }))
        .send()
        .await
        .map_err(|e| format!("Failed to rename author: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ABS returned status {}: {}", status, body));
    }

    let updated: AbsAuthor = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse rename response: {}", e))?;

    Ok(updated)
}

/// Merge authors: reassign all books from secondary to primary author
#[tauri::command]
pub async fn merge_abs_authors(
    primary_id: String,
    secondary_ids: Vec<String>,
    window: tauri::Window,
) -> Result<String, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    validate_abs_config(&config)?;

    let client = make_client()?;
    let mut merged_count = 0;

    for (i, secondary_id) in secondary_ids.iter().enumerate() {
        let _ = window.emit("authors_progress", serde_json::json!({
            "phase": "merging",
            "message": format!("Merging author {}/{}...", i + 1, secondary_ids.len()),
            "current": i + 1,
            "total": secondary_ids.len(),
        }));

        // Fetch the secondary author's books
        let detail_url = format!(
            "{}/api/authors/{}?include=items",
            config.abs_base_url, secondary_id
        );
        let detail_resp = client
            .get(&detail_url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch secondary author: {}", e))?;

        if !detail_resp.status().is_success() {
            continue;
        }

        let secondary: AbsAuthorDetail = detail_resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse secondary author: {}", e))?;

        // Fetch primary author name for replacement
        let primary_url = format!(
            "{}/api/authors/{}",
            config.abs_base_url, primary_id
        );
        let primary_resp = client
            .get(&primary_url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch primary author: {}", e))?;

        let primary_author: AbsAuthor = primary_resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse primary author: {}", e))?;

        // For each book, update authors to replace secondary with primary
        for book in &secondary.library_items {
            let media = match &book.media {
                Some(m) => m,
                None => continue,
            };
            let metadata = match &media.metadata {
                Some(m) => m,
                None => continue,
            };

            // Build new authors list replacing secondary with primary
            let new_authors: Vec<serde_json::Value> = metadata
                .authors
                .iter()
                .map(|a| {
                    if a.name == secondary.name {
                        serde_json::json!({ "name": primary_author.name })
                    } else {
                        serde_json::json!({ "name": a.name })
                    }
                })
                .collect();

            // Update the book's metadata
            let update_url = format!("{}/api/items/{}/media", config.abs_base_url, book.id);
            let _ = client
                .patch(&update_url)
                .header("Authorization", format!("Bearer {}", config.abs_api_token))
                .json(&serde_json::json!({
                    "metadata": {
                        "authors": new_authors,
                    }
                }))
                .send()
                .await;

            merged_count += 1;
        }
    }

    let _ = window.emit("authors_progress", serde_json::json!({
        "phase": "done",
        "message": format!("Merged {} books to primary author.", merged_count),
    }));

    Ok(format!("Merged {} books from {} secondary author(s)", merged_count, secondary_ids.len()))
}

// ============================================================================
// GPT DESCRIPTION GENERATION
// ============================================================================

#[derive(Debug, Clone, Serialize)]
pub struct AuthorDescriptionResult {
    pub id: String,
    pub name: String,
    pub original_description: Option<String>,
    pub new_description: Option<String>,
    pub fixed: bool,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthorDescriptionResponse {
    pub results: Vec<AuthorDescriptionResult>,
    pub total_fixed: usize,
    pub total_skipped: usize,
    pub total_failed: usize,
}

/// Generate or fix author descriptions using GPT.
/// Fetches each author's books from ABS for context (book titles + genres).
#[tauri::command]
pub async fn fix_author_descriptions_gpt(
    author_ids: Vec<String>,
    force: Option<bool>,
    window: tauri::Window,
) -> Result<AuthorDescriptionResponse, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    validate_abs_config(&config)?;

    let api_key = config.openai_api_key.as_deref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured in settings")?
        .to_string();

    let force = force.unwrap_or(false);
    let total = author_ids.len();
    let client = make_client()?;

    let _ = window.emit("authors_progress", serde_json::json!({
        "phase": "descriptions",
        "message": format!("Generating descriptions for {} authors...", total),
        "current": 0,
        "total": total,
    }));

    let processed = Arc::new(AtomicUsize::new(0));
    let fixed_count = Arc::new(AtomicUsize::new(0));
    let skipped_count = Arc::new(AtomicUsize::new(0));
    let failed_count = Arc::new(AtomicUsize::new(0));

    let results: Vec<AuthorDescriptionResult> = stream::iter(author_ids.into_iter())
        .map(|author_id| {
            let api_key = api_key.clone();
            let config = config.clone();
            let client = client.clone();
            let window = window.clone();
            let processed = Arc::clone(&processed);
            let fixed_count = Arc::clone(&fixed_count);
            let skipped_count = Arc::clone(&skipped_count);
            let failed_count = Arc::clone(&failed_count);
            let total = total;

            async move {
                // Fetch author detail with books from ABS
                let url = format!(
                    "{}/api/authors/{}?include=items",
                    config.abs_base_url, author_id
                );
                let detail = match client
                    .get(&url)
                    .header("Authorization", format!("Bearer {}", config.abs_api_token))
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        resp.json::<AbsAuthorDetail>().await.ok()
                    }
                    _ => None,
                };

                let (name, existing_desc, book_titles, genres) = match &detail {
                    Some(d) => {
                        let titles: Vec<String> = d.library_items.iter()
                            .filter_map(|item| {
                                item.media.as_ref()
                                    .and_then(|m| m.metadata.as_ref())
                                    .and_then(|m| m.title.clone())
                            })
                            .collect();
                        let genres: Vec<String> = d.library_items.iter()
                            .filter_map(|item| {
                                item.media.as_ref()
                                    .and_then(|m| m.metadata.as_ref())
                            })
                            .flat_map(|m| m.genres.iter().cloned())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        (d.name.clone(), d.description.clone(), titles, genres)
                    }
                    None => (author_id.clone(), None, vec![], vec![]),
                };

                // Skip if good description and not forcing
                let has_good_desc = existing_desc.as_ref()
                    .map(|d| d.trim().len() >= 50)
                    .unwrap_or(false);

                if has_good_desc && !force {
                    skipped_count.fetch_add(1, Ordering::Relaxed);
                    let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                    emit_progress(&window, "descriptions", current, total);
                    return AuthorDescriptionResult {
                        id: author_id,
                        name,
                        original_description: existing_desc,
                        new_description: None,
                        fixed: false,
                        skipped: true,
                        error: None,
                    };
                }

                let books_str = if book_titles.is_empty() {
                    "Unknown works".to_string()
                } else {
                    book_titles.iter().take(15).cloned().collect::<Vec<_>>().join(", ")
                };
                let genres_str = if genres.is_empty() {
                    "Various".to_string()
                } else {
                    genres.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
                };

                let prompt = build_author_desc_prompt(&name, existing_desc.as_deref(), &books_str, &genres_str);

                match scanner::processor::call_gpt_api(&prompt, &api_key, &crate::scanner::processor::preferred_model(), 500).await {
                    Ok(response) => {
                        let cleaned = clean_gpt_text_response(&response);
                        let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                        emit_progress(&window, "descriptions", current, total);

                        if cleaned.len() >= 50 {
                            fixed_count.fetch_add(1, Ordering::Relaxed);
                            AuthorDescriptionResult {
                                id: author_id, name,
                                original_description: existing_desc,
                                new_description: Some(cleaned),
                                fixed: true, skipped: false, error: None,
                            }
                        } else {
                            failed_count.fetch_add(1, Ordering::Relaxed);
                            AuthorDescriptionResult {
                                id: author_id, name,
                                original_description: existing_desc,
                                new_description: None,
                                fixed: false, skipped: false,
                                error: Some("Generated description too short".to_string()),
                            }
                        }
                    }
                    Err(e) => {
                        failed_count.fetch_add(1, Ordering::Relaxed);
                        processed.fetch_add(1, Ordering::Relaxed);
                        AuthorDescriptionResult {
                            id: author_id, name,
                            original_description: existing_desc,
                            new_description: None,
                            fixed: false, skipped: false,
                            error: Some(format!("GPT error: {}", e)),
                        }
                    }
                }
            }
        })
        .buffer_unordered(5) // 5 concurrent (each fetches from ABS + calls GPT)
        .collect()
        .await;

    let total_fixed = fixed_count.load(Ordering::Relaxed);
    let total_skipped = skipped_count.load(Ordering::Relaxed);
    let total_failed = failed_count.load(Ordering::Relaxed);

    let _ = window.emit("authors_progress", serde_json::json!({
        "phase": "done",
        "message": format!("Descriptions: {} fixed, {} skipped, {} failed", total_fixed, total_skipped, total_failed),
    }));

    Ok(AuthorDescriptionResponse {
        results,
        total_fixed,
        total_skipped,
        total_failed,
    })
}

// ============================================================================
// PUSH TO ABS
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct AuthorPushItem {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthorPushResult {
    pub updated: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

/// Push local author changes to ABS via PATCH /api/authors/{id}
#[tauri::command]
pub async fn push_author_changes_to_abs(
    items: Vec<AuthorPushItem>,
    window: tauri::Window,
) -> Result<AuthorPushResult, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    validate_abs_config(&config)?;

    let client = make_client()?;
    let total = items.len();

    let _ = window.emit("authors_progress", serde_json::json!({
        "phase": "pushing",
        "message": format!("Pushing {} author updates to ABS...", total),
        "current": 0,
        "total": total,
    }));

    let updated_count = Arc::new(AtomicUsize::new(0));
    let failed_count = Arc::new(AtomicUsize::new(0));
    let errors_list = Arc::new(std::sync::Mutex::new(Vec::new()));
    let processed = Arc::new(AtomicUsize::new(0));

    stream::iter(items.into_iter())
        .map(|item| {
            let client = client.clone();
            let config = config.clone();
            let updated = Arc::clone(&updated_count);
            let failed = Arc::clone(&failed_count);
            let errors = Arc::clone(&errors_list);
            let processed = Arc::clone(&processed);
            let window = window.clone();
            let total = total;

            async move {
                let url = format!("{}/api/authors/{}", config.abs_base_url, item.id);

                // Build payload with only the fields that changed
                let mut payload = serde_json::Map::new();
                if let Some(ref name) = item.name {
                    payload.insert("name".to_string(), serde_json::json!(name));
                }
                if let Some(ref desc) = item.description {
                    payload.insert("description".to_string(), serde_json::json!(desc));
                }

                if payload.is_empty() {
                    let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                    if current % 10 == 0 || current == total {
                        let _ = window.emit("authors_progress", serde_json::json!({
                            "phase": "pushing",
                            "message": format!("Pushing {}/{}...", current, total),
                            "current": current,
                            "total": total,
                        }));
                    }
                    return;
                }

                // Retry with backoff for 5xx errors
                let max_retries = 3;
                let mut success = false;
                let mut last_error = String::new();

                for attempt in 0..=max_retries {
                    if attempt > 0 {
                        tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
                    }

                    match client
                        .patch(&url)
                        .header("Authorization", format!("Bearer {}", config.abs_api_token))
                        .json(&serde_json::Value::Object(payload.clone()))
                        .send()
                        .await
                    {
                        Ok(response) => {
                            let status = response.status();
                            if status.is_success() {
                                updated.fetch_add(1, Ordering::Relaxed);
                                success = true;
                                break;
                            } else if status.is_server_error() && attempt < max_retries {
                                last_error = format!("HTTP {}", status);
                                continue;
                            } else {
                                last_error = format!("HTTP {}", status);
                                break;
                            }
                        }
                        Err(e) => {
                            last_error = e.to_string();
                            if attempt < max_retries { continue; }
                            break;
                        }
                    }
                }

                if !success {
                    failed.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut e) = errors.lock() {
                        let name = item.name.as_deref().unwrap_or("unknown");
                        e.push(format!("{}: {}", name, last_error));
                    }
                }

                let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if current % 10 == 0 || current == total {
                    let _ = window.emit("authors_progress", serde_json::json!({
                        "phase": "pushing",
                        "message": format!("Pushing {}/{}...", current, total),
                        "current": current,
                        "total": total,
                    }));
                }
            }
        })
        .buffer_unordered(10)
        .collect::<Vec<_>>()
        .await;

    let updated = updated_count.load(Ordering::Relaxed);
    let failed = failed_count.load(Ordering::Relaxed);
    let errors = errors_list.lock().map(|e| e.clone()).unwrap_or_default();

    let _ = window.emit("authors_progress", serde_json::json!({
        "phase": "done",
        "message": format!("Push complete: {} updated, {} failed", updated, failed),
        "current": total,
        "total": total,
    }));

    Ok(AuthorPushResult { updated, failed, errors })
}

/// Proxy author image from ABS to avoid CORS
#[tauri::command]
pub async fn get_abs_author_image(author_id: String) -> Result<Vec<u8>, String> {
    let config = config::load_config().map_err(|e| e.to_string())?;
    validate_abs_config(&config)?;

    let client = make_client()?;
    let url = format!("{}/api/authors/{}/image", config.abs_base_url, author_id);

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch author image: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("No image available (status {})", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read image bytes: {}", e))?;

    Ok(bytes.to_vec())
}

// ============================================================================
// HELPERS
// ============================================================================

fn validate_abs_config(config: &config::Config) -> Result<(), String> {
    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() {
        return Err("ABS not configured. Set URL and API token in settings.".to_string());
    }
    if config.abs_library_id.is_empty() {
        return Err("ABS library ID not configured.".to_string());
    }
    Ok(())
}

fn make_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

fn to_detail_response(detail: AbsAuthorDetail) -> AuthorDetailResponse {
    let books: Vec<AuthorBookSummary> = detail
        .library_items
        .into_iter()
        .map(|item| {
            let (title, subtitle, series, sequence, narrators, genres, duration, has_cover) =
                match item.media {
                    Some(media) => {
                        let meta = media.metadata.unwrap_or_default();
                        let series_info = meta.series.first().cloned();
                        (
                            meta.title.unwrap_or_else(|| "Unknown".to_string()),
                            meta.subtitle,
                            series_info.as_ref().map(|s| s.name.clone()),
                            series_info.and_then(|s| s.sequence),
                            meta.narrators,
                            meta.genres,
                            media.duration,
                            media.cover_path.is_some(),
                        )
                    }
                    None => ("Unknown".to_string(), None, None, None, vec![], vec![], None, false),
                };

            AuthorBookSummary {
                id: item.id,
                title,
                subtitle,
                series,
                sequence,
                narrators,
                genres,
                duration_seconds: duration,
                has_cover,
            }
        })
        .collect();

    AuthorDetailResponse {
        id: detail.id,
        name: detail.name,
        description: detail.description,
        has_image: detail.image_path.is_some(),
        num_books: books.len(),
        books,
    }
}

/// Normalize a name for duplicate detection:
/// lowercase, collapse whitespace, strip periods, normalize initials
fn normalize_for_dedup(name: &str) -> String {
    let lower = name.to_lowercase().trim().to_string();
    // Remove periods (J. K. Rowling -> j k rowling)
    let no_dots = lower.replace('.', "");
    // Collapse whitespace
    no_dots.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn emit_progress(window: &tauri::Window, phase: &str, current: usize, total: usize) {
    if current % 5 == 0 || current == total {
        let _ = window.emit("authors_progress", serde_json::json!({
            "phase": phase,
            "message": format!("Processing {}/{}...", current, total),
            "current": current,
            "total": total,
        }));
    }
}

fn build_author_desc_prompt(name: &str, existing: Option<&str>, books_str: &str, genres_str: &str) -> String {
    let has_salvageable = existing.map(|d| d.trim().len() >= 50).unwrap_or(false);

    if has_salvageable {
        format!(
            r#"Rewrite this author biography for "{}".

EXISTING DESCRIPTION:
{}

KNOWN BOOKS: {}
GENRES: {}

RULES:
1. Remove HTML tags, encoding errors, promotional text
2. Remove "click here", "buy now", review quotes
3. Keep factual biographical content
4. Third person, present tense
5. Target 150-300 characters
6. Focus on who the author is, their notable works, and writing style
7. Do NOT list individual book titles

Return ONLY the cleaned biography text."#,
            name, existing.unwrap_or(""), books_str, genres_str
        )
    } else {
        format!(
            r#"Write a brief author biography for {}.

KNOWN BOOKS: {}
GENRES: {}

RULES:
1. Write 2-3 sentences about the author
2. Third person, present tense
3. Be factual — only include what you know about this author
4. Target 150-250 characters
5. Focus on who they are, their notable works, and writing style
6. If you don't know this author, write a brief generic bio based on their genres

Return ONLY the biography text."#,
            name, books_str, genres_str
        )
    }
}

/// Clean GPT text response: handle JSON wrappers, markdown code blocks, trim quotes
fn clean_gpt_text_response(response: &str) -> String {
    let mut cleaned = response.trim().to_string();

    // Handle JSON responses like {"description":"..."} or {"text":"..."}
    if cleaned.starts_with('{') && cleaned.ends_with('}') {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&cleaned) {
            if let Some(d) = json.get("description").and_then(|v| v.as_str()) {
                cleaned = d.to_string();
            } else if let Some(t) = json.get("text").and_then(|v| v.as_str()) {
                cleaned = t.to_string();
            } else if let Some(c) = json.get("content").and_then(|v| v.as_str()) {
                cleaned = c.to_string();
            } else if let Some(b) = json.get("biography").and_then(|v| v.as_str()) {
                cleaned = b.to_string();
            } else if let Some(b) = json.get("bio").and_then(|v| v.as_str()) {
                cleaned = b.to_string();
            }
        }
    }

    // Handle markdown code blocks
    if cleaned.starts_with("```") {
        let lines: Vec<&str> = cleaned.lines().collect();
        if lines.len() > 2 {
            cleaned = lines[1..lines.len() - 1].join("\n");
        }
    }

    cleaned.trim().trim_matches('"').trim_matches('\'').trim().to_string()
}

impl Default for AbsAuthorBookMetadata {
    fn default() -> Self {
        Self {
            title: None,
            subtitle: None,
            authors: vec![],
            narrators: vec![],
            series: vec![],
            genres: vec![],
            published_year: None,
            description: None,
        }
    }
}
