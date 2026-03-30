// commands/series_analysis.rs
//
// Comprehensive series analysis: groups books, API lookups, cross-library comparison,
// and GPT-based validation/fixes. No regex hell - let GPT handle the logic.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, State};
use tokio::sync::Semaphore;
use futures::stream::{self, StreamExt};

use crate::abs_search::search_metadata_waterfall;
use crate::config::Config;
use crate::scanner::processor::call_gpt_api;
use crate::scanner::types::{BookGroup, SeriesInfo, MetadataSource};

// Number of parallel workers for API lookups
const PARALLEL_API_WORKERS: usize = 10;
const PARALLEL_GPT_WORKERS: usize = 5;

/// Global cancellation state
pub struct ScanCancellation {
    pub cancelled: AtomicBool,
}

impl Default for ScanCancellation {
    fn default() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
        }
    }
}

// ============================================================================
// TYPES
// ============================================================================

/// Progress event for series analysis
#[derive(Debug, Clone, Serialize)]
pub struct SeriesAnalysisProgress {
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

/// A book's series info for analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookSeriesInfo {
    pub book_id: String,
    pub title: String,
    pub author: String,
    pub current_series: Option<String>,
    pub current_sequence: Option<String>,
}

/// A group of books that appear to be in the same series
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesGroup {
    /// Normalized series name (lowercase, trimmed) used as key
    pub normalized_name: String,
    /// All variations of the series name found
    pub name_variations: Vec<String>,
    /// Most common series name (suggested canonical)
    pub suggested_name: Option<String>,
    /// Books in this series group
    pub books: Vec<BookSeriesInfo>,
    /// API lookup result (from Audible)
    pub api_series_name: Option<String>,
    /// Confidence in the series grouping (0-100)
    pub confidence: u8,
    /// Issues found in this series group
    pub issues: Vec<SeriesIssue>,
}

/// An issue found within a series group
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesIssue {
    pub issue_type: SeriesIssueType,
    pub severity: String, // "error", "warning", "info"
    pub message: String,
    pub book_ids: Vec<String>,
    pub suggested_fix: Option<SeriesFix>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeriesIssueType {
    /// Multiple variations of series name in same group
    InconsistentNaming,
    /// Book missing sequence number
    MissingSequence,
    /// Duplicate sequence numbers
    DuplicateSequence,
    /// Sequence doesn't match API
    WrongSequence,
    /// Series name doesn't match API
    WrongSeriesName,
    /// Series might not exist (API returned nothing)
    UnverifiedSeries,
    /// Gap in sequence numbers
    SequenceGap,
    /// Invalid sequence value
    InvalidSequence,
}

/// A suggested fix for a series issue
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesFix {
    pub book_id: String,
    pub field: String, // "series" or "sequence"
    pub current_value: Option<String>,
    pub suggested_value: String,
    pub reason: String,
}

/// Result of analyzing all series in the library
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesAnalysisResult {
    /// All series groups found
    pub series_groups: Vec<SeriesGroup>,
    /// Total books analyzed
    pub total_books: usize,
    /// Books with series
    pub books_with_series: usize,
    /// Books without series
    pub books_without_series: usize,
    /// Total issues found
    pub total_issues: usize,
    /// All suggested fixes
    pub all_fixes: Vec<SeriesFix>,
}

/// GPT response for series analysis
#[derive(Debug, Deserialize)]
struct GptSeriesAnalysis {
    /// Canonical series name
    canonical_name: Option<String>,
    /// Book analyses
    books: Vec<GptBookAnalysis>,
    /// Overall notes
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GptBookAnalysis {
    book_id: String,
    #[serde(default)]
    correct_series: Option<String>,
    #[serde(default, deserialize_with = "deserialize_sequence")]
    correct_sequence: Option<String>,
    #[serde(default)]
    confidence: Option<u8>,
    #[serde(default)]
    issue: Option<String>,
}

/// Helper to deserialize sequence that could be string or number
fn deserialize_sequence<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};
    use std::fmt;

    struct SeqVisitor;

    impl<'de> Visitor<'de> for SeqVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("string, number, or null")
        }

        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            if v.is_empty() || v == "null" {
                Ok(None)
            } else {
                Ok(Some(v.to_string()))
            }
        }

        fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
            if v.is_empty() || v == "null" {
                Ok(None)
            } else {
                Ok(Some(v))
            }
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v.to_string()))
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v.to_string()))
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            if v.fract() == 0.0 {
                Ok(Some((v as i64).to_string()))
            } else {
                Ok(Some(v.to_string()))
            }
        }
    }

    deserializer.deserialize_any(SeqVisitor)
}

// ============================================================================
// MAIN ANALYSIS COMMAND
// ============================================================================

/// Cancel any running scan
#[command]
pub async fn cancel_series_scan(
    cancellation: State<'_, Arc<ScanCancellation>>,
) -> Result<(), String> {
    cancellation.cancelled.store(true, Ordering::SeqCst);
    Ok(())
}

/// Reset cancellation state before starting new scan
#[command]
pub async fn reset_scan_cancellation(
    cancellation: State<'_, Arc<ScanCancellation>>,
) -> Result<(), String> {
    cancellation.cancelled.store(false, Ordering::SeqCst);
    Ok(())
}

#[command]
pub async fn analyze_series_comprehensive(
    app: AppHandle,
    groups: Vec<BookGroup>,
    config: Config,
    openai_key: Option<String>,
    cancellation: State<'_, Arc<ScanCancellation>>,
) -> Result<SeriesAnalysisResult, String> {
    // Reset cancellation at start
    cancellation.cancelled.store(false, Ordering::SeqCst);

    let total_books = groups.len();

    // Phase 1: Group books by series (fuzzy matching)
    emit_progress(&app, "grouping", 0, 1, "Grouping books by series...");
    let mut series_map = group_books_by_series(&groups);
    let books_with_series = series_map.values().map(|g| g.books.len()).sum::<usize>();
    let books_without_series = total_books - books_with_series;

    emit_progress(&app, "grouping", 1, 1, &format!("Found {} series groups", series_map.len()));

    // Check for cancellation
    if cancellation.cancelled.load(Ordering::SeqCst) {
        return Err("Scan cancelled".to_string());
    }

    // Phase 2: Parallel API lookups for each series
    let series_count = series_map.len();
    let semaphore = Arc::new(Semaphore::new(PARALLEL_API_WORKERS));
    let config_arc = Arc::new(config.clone());
    let app_arc = Arc::new(app.clone());
    let cancellation_arc = Arc::clone(&cancellation);
    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    // Convert to vec for parallel processing
    let series_vec: Vec<_> = series_map.into_iter().collect();

    let api_results: Vec<_> = stream::iter(series_vec)
        .map(|(key, mut group)| {
            let sem = Arc::clone(&semaphore);
            let cfg = Arc::clone(&config_arc);
            let app_ref = Arc::clone(&app_arc);
            let cancel = Arc::clone(&cancellation_arc);
            let done = Arc::clone(&completed);
            let total = series_count;

            async move {
                // Check cancellation
                if cancel.cancelled.load(Ordering::SeqCst) {
                    return (key, group);
                }

                let _permit = sem.acquire().await.unwrap();

                // Look up series via ABS/Audible
                if let Some(first_book) = group.books.first() {
                    if let Some(result) = search_metadata_waterfall(&cfg, &first_book.title, &first_book.author).await {
                        if let Some(series_info) = result.series.first() {
                            group.api_series_name = series_info.series.clone();
                        }
                    }
                }

                let current = done.fetch_add(1, Ordering::SeqCst) + 1;
                if current % 10 == 0 || current == total {
                    emit_progress(
                        &app_ref,
                        "api_lookup",
                        current,
                        total,
                        &format!("API lookups: {}/{} ({})", current, total, group.name_variations.first().unwrap_or(&"?".to_string())),
                    );
                }

                (key, group)
            }
        })
        .buffer_unordered(PARALLEL_API_WORKERS)
        .collect()
        .await;

    // Check for cancellation
    if cancellation.cancelled.load(Ordering::SeqCst) {
        return Err("Scan cancelled".to_string());
    }

    // Convert back to map
    let mut series_map: HashMap<String, SeriesGroup> = api_results.into_iter().collect();

    // Phase 3: Parallel GPT analysis for each series group (if API key provided)
    if let Some(api_key) = openai_key.as_ref() {
        let gpt_semaphore = Arc::new(Semaphore::new(PARALLEL_GPT_WORKERS));
        let api_key_arc = Arc::new(api_key.clone());
        let gpt_completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        // Filter to only groups that need GPT analysis
        let groups_needing_gpt: Vec<_> = series_map
            .iter()
            .filter(|(_, g)| g.books.len() >= 2 || g.api_series_name.is_some())
            .map(|(k, _)| k.clone())
            .collect();

        let gpt_total = groups_needing_gpt.len();

        let gpt_results: Vec<_> = stream::iter(groups_needing_gpt)
            .map(|key| {
                let sem = Arc::clone(&gpt_semaphore);
                let api = Arc::clone(&api_key_arc);
                let app_ref = Arc::clone(&app_arc);
                let cancel = Arc::clone(&cancellation_arc);
                let done = Arc::clone(&gpt_completed);
                let group = series_map.get(&key).cloned();

                async move {
                    // Check cancellation
                    if cancel.cancelled.load(Ordering::SeqCst) {
                        return (key, None);
                    }

                    let _permit = sem.acquire().await.unwrap();

                    if let Some(g) = &group {
                        let current = done.fetch_add(1, Ordering::SeqCst) + 1;
                        emit_progress(
                            &app_ref,
                            "gpt_analysis",
                            current,
                            gpt_total,
                            &format!("GPT: {}", g.name_variations.first().unwrap_or(&"?".to_string())),
                        );

                        // Call GPT to analyze this series group
                        if let Ok(analysis) = analyze_series_group_with_gpt(g, &api).await {
                            return (key, Some(analysis));
                        }
                    }

                    (key, None)
                }
            })
            .buffer_unordered(PARALLEL_GPT_WORKERS)
            .collect()
            .await;

        // Apply GPT results
        for (key, analysis_opt) in gpt_results {
            if let Some(analysis) = analysis_opt {
                if let Some(group) = series_map.get_mut(&key) {
                    apply_gpt_analysis(group, analysis);
                }
            }
        }
    }

    // Phase 4: Detect issues and generate fixes
    emit_progress(&app, "detecting_issues", 0, 1, "Detecting issues and generating fixes...");
    let mut all_fixes = Vec::new();
    let mut total_issues = 0;

    for (_, group) in series_map.iter_mut() {
        detect_series_issues(group);
        total_issues += group.issues.len();

        // Collect all fixes
        for issue in &group.issues {
            if let Some(fix) = &issue.suggested_fix {
                all_fixes.push(fix.clone());
            }
        }
    }

    emit_progress(&app, "complete", 1, 1, &format!("Found {} issues across {} series", total_issues, series_count));

    // Convert to result
    let series_groups: Vec<SeriesGroup> = series_map.into_values().collect();

    Ok(SeriesAnalysisResult {
        series_groups,
        total_books,
        books_with_series,
        books_without_series,
        total_issues,
        all_fixes,
    })
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn emit_progress(app: &AppHandle, phase: &str, current: usize, total: usize, message: &str) {
    let _ = app.emit("series_analysis_progress", SeriesAnalysisProgress {
        phase: phase.to_string(),
        current,
        total,
        message: message.to_string(),
    });
}

/// Group books by series using fuzzy matching
fn group_books_by_series(groups: &[BookGroup]) -> HashMap<String, SeriesGroup> {
    let mut series_map: HashMap<String, SeriesGroup> = HashMap::new();

    for group in groups {
        let series = match &group.metadata.series {
            Some(s) if !s.trim().is_empty() => s.trim(),
            _ => continue,
        };

        // Normalize series name for grouping
        let normalized = normalize_series_name(series);

        // Skip obviously invalid series
        if is_obviously_invalid_series(&normalized) {
            continue;
        }

        let book_info = BookSeriesInfo {
            book_id: group.id.clone(),
            title: group.metadata.title.clone(),
            author: group.metadata.author.clone(),
            current_series: Some(series.to_string()),
            current_sequence: group.metadata.sequence.clone(),
        };

        series_map
            .entry(normalized.clone())
            .and_modify(|g| {
                // Track name variations
                if !g.name_variations.contains(&series.to_string()) {
                    g.name_variations.push(series.to_string());
                }
                g.books.push(book_info.clone());
            })
            .or_insert_with(|| SeriesGroup {
                normalized_name: normalized,
                name_variations: vec![series.to_string()],
                suggested_name: Some(series.to_string()),
                books: vec![book_info],
                api_series_name: None,
                confidence: 50,
                issues: Vec::new(),
            });
    }

    // Update suggested names based on most common variation
    for group in series_map.values_mut() {
        if group.name_variations.len() > 1 {
            // Count occurrences of each variation
            let mut counts: HashMap<&str, usize> = HashMap::new();
            for book in &group.books {
                if let Some(ref s) = book.current_series {
                    *counts.entry(s.as_str()).or_insert(0) += 1;
                }
            }
            // Pick most common
            if let Some((most_common, _)) = counts.into_iter().max_by_key(|(_, c)| *c) {
                group.suggested_name = Some(most_common.to_string());
            }
        }
    }

    series_map
}

/// Normalize series name for grouping (fuzzy matching)
fn normalize_series_name(name: &str) -> String {
    let mut s = name.to_lowercase();

    // Remove common prefixes/suffixes that don't affect identity
    let remove_patterns = [
        "the ", " series", " saga", " chronicles", " trilogy", " duology",
        " books", " novels", " collection",
    ];
    for pattern in remove_patterns {
        s = s.replace(pattern, "");
    }

    // Remove punctuation and extra whitespace
    s = s.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");

    s.trim().to_string()
}

/// Quick check for obviously invalid series names
fn is_obviously_invalid_series(normalized: &str) -> bool {
    if normalized.is_empty() || normalized.len() < 2 {
        return true;
    }

    // Just a number
    if normalized.chars().all(|c| c.is_numeric() || c.is_whitespace()) {
        return true;
    }

    // Common invalid values
    let invalid = [
        "null", "none", "na", "n a", "unknown", "standalone", "book", "audiobook",
        "fiction", "nonfiction", "non fiction", "biography", "autobiography",
    ];

    invalid.contains(&normalized.as_ref())
}

/// Analyze a series group using GPT
async fn analyze_series_group_with_gpt(
    group: &SeriesGroup,
    api_key: &str,
) -> Result<GptSeriesAnalysis, String> {
    let prompt = build_series_analysis_prompt(group);

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        call_gpt_api(&prompt, api_key, &crate::scanner::processor::preferred_model(), 2000),
    )
    .await;

    match result {
        Ok(Ok(response)) => {
            // Try to parse JSON from response
            let json_start = response.find('{');
            let json_end = response.rfind('}');

            if let (Some(start), Some(end)) = (json_start, json_end) {
                let json_str = &response[start..=end];
                serde_json::from_str(json_str)
                    .map_err(|e| format!("Failed to parse GPT response: {}", e))
            } else {
                Err("No JSON found in GPT response".to_string())
            }
        }
        Ok(Err(e)) => Err(format!("GPT API error: {}", e)),
        Err(_) => Err("GPT request timed out".to_string()),
    }
}

/// Build the GPT prompt for series analysis
fn build_series_analysis_prompt(group: &SeriesGroup) -> String {
    let mut books_info = String::new();
    for (i, book) in group.books.iter().enumerate() {
        books_info.push_str(&format!(
            "{}. ID: {}\n   Title: \"{}\"\n   Author: \"{}\"\n   Current Series: {:?}\n   Current Sequence: {:?}\n\n",
            i + 1,
            book.book_id,
            book.title,
            book.author,
            book.current_series,
            book.current_sequence
        ));
    }

    let api_info = match &group.api_series_name {
        Some(name) => format!("Audible API returned series name: \"{}\"", name),
        None => "No Audible API data available".to_string(),
    };

    format!(
r#"Analyze this series and fix any issues. You are an expert on book series.

SERIES NAME VARIATIONS FOUND: {:?}

{}

BOOKS IN THIS GROUP:
{}

YOUR TASK:
1. Determine the CANONICAL series name (official, correct spelling/capitalization)
2. For each book, determine the correct sequence number
3. Identify any books that might be incorrectly grouped

RULES:
- Use official series names: "A Song of Ice and Fire" not "Game of Thrones"
- Prequels get sequence 0 or 0.5
- Novellas between main books use decimals (2.5, 3.5)
- If a book is a standalone and NOT part of this series, set correct_series to null
- Look at title patterns to infer sequence ("Book 3", "Part Two", etc.)
- Consider publication order if sequence is unclear

Return ONLY valid JSON:
{{
  "canonical_name": "The Correct Series Name",
  "books": [
    {{
      "book_id": "id-here",
      "correct_series": "The Correct Series Name",
      "correct_sequence": "1",
      "confidence": 95,
      "issue": "optional issue description or null"
    }}
  ],
  "notes": "optional analysis notes"
}}"#,
        group.name_variations,
        api_info,
        books_info
    )
}

/// Apply GPT analysis results to the series group
fn apply_gpt_analysis(group: &mut SeriesGroup, analysis: GptSeriesAnalysis) {
    // Update canonical name if GPT provided one
    if let Some(canonical) = analysis.canonical_name {
        group.suggested_name = Some(canonical.clone());

        // If API also has a name, and they match, high confidence
        if let Some(ref api_name) = group.api_series_name {
            if api_name.to_lowercase() == canonical.to_lowercase() {
                group.confidence = 95;
            } else {
                group.confidence = 75;
            }
        } else {
            group.confidence = 80;
        }
    }

    // Create fixes based on GPT analysis
    for gpt_book in analysis.books {
        // Find the book in our group
        if let Some(book) = group.books.iter().find(|b| b.book_id == gpt_book.book_id) {
            // Check if series name needs fixing
            if let Some(ref correct_series) = gpt_book.correct_series {
                if book.current_series.as_ref() != Some(correct_series) {
                    group.issues.push(SeriesIssue {
                        issue_type: SeriesIssueType::WrongSeriesName,
                        severity: "warning".to_string(),
                        message: format!(
                            "Series name should be \"{}\" (currently {:?})",
                            correct_series, book.current_series
                        ),
                        book_ids: vec![book.book_id.clone()],
                        suggested_fix: Some(SeriesFix {
                            book_id: book.book_id.clone(),
                            field: "series".to_string(),
                            current_value: book.current_series.clone(),
                            suggested_value: correct_series.clone(),
                            reason: "GPT analysis suggested canonical name".to_string(),
                        }),
                    });
                }
            }

            // Check if sequence needs fixing
            if let Some(ref correct_seq) = gpt_book.correct_sequence {
                if book.current_sequence.as_ref() != Some(correct_seq) {
                    let severity = if book.current_sequence.is_none() { "info" } else { "warning" };
                    group.issues.push(SeriesIssue {
                        issue_type: if book.current_sequence.is_none() {
                            SeriesIssueType::MissingSequence
                        } else {
                            SeriesIssueType::WrongSequence
                        },
                        severity: severity.to_string(),
                        message: format!(
                            "Sequence should be {} (currently {:?})",
                            correct_seq, book.current_sequence
                        ),
                        book_ids: vec![book.book_id.clone()],
                        suggested_fix: Some(SeriesFix {
                            book_id: book.book_id.clone(),
                            field: "sequence".to_string(),
                            current_value: book.current_sequence.clone(),
                            suggested_value: correct_seq.clone(),
                            reason: gpt_book.issue.unwrap_or_else(|| "GPT inferred sequence".to_string()),
                        }),
                    });
                }
            }
        }
    }
}

/// Detect issues within a series group (non-GPT checks)
fn detect_series_issues(group: &mut SeriesGroup) {
    // Issue: Multiple name variations
    if group.name_variations.len() > 1 {
        let book_ids: Vec<String> = group.books.iter()
            .filter(|b| b.current_series.as_ref() != group.suggested_name.as_ref())
            .map(|b| b.book_id.clone())
            .collect();

        if !book_ids.is_empty() {
            group.issues.push(SeriesIssue {
                issue_type: SeriesIssueType::InconsistentNaming,
                severity: "warning".to_string(),
                message: format!(
                    "Found {} different spellings: {:?}",
                    group.name_variations.len(),
                    group.name_variations
                ),
                book_ids: book_ids.clone(),
                suggested_fix: group.suggested_name.as_ref().map(|name| SeriesFix {
                    book_id: book_ids.first().unwrap_or(&String::new()).clone(),
                    field: "series".to_string(),
                    current_value: None,
                    suggested_value: name.clone(),
                    reason: "Normalize to most common spelling".to_string(),
                }),
            });
        }
    }

    // Issue: Duplicate sequences
    let mut seq_counts: HashMap<String, Vec<String>> = HashMap::new();
    for book in &group.books {
        if let Some(ref seq) = book.current_sequence {
            let normalized_seq = seq.trim().to_lowercase();
            if !normalized_seq.is_empty() && normalized_seq != "null" {
                seq_counts.entry(normalized_seq)
                    .or_insert_with(Vec::new)
                    .push(book.book_id.clone());
            }
        }
    }

    for (seq, book_ids) in seq_counts {
        if book_ids.len() > 1 {
            group.issues.push(SeriesIssue {
                issue_type: SeriesIssueType::DuplicateSequence,
                severity: "error".to_string(),
                message: format!("Duplicate sequence #{} found on {} books", seq, book_ids.len()),
                book_ids,
                suggested_fix: None,
            });
        }
    }

    // Issue: Missing sequences (only if some books have sequences)
    let has_any_sequence = group.books.iter().any(|b| {
        b.current_sequence.as_ref()
            .map(|s| !s.trim().is_empty() && s.trim().to_lowercase() != "null")
            .unwrap_or(false)
    });

    if has_any_sequence {
        for book in &group.books {
            let has_seq = book.current_sequence.as_ref()
                .map(|s| !s.trim().is_empty() && s.trim().to_lowercase() != "null")
                .unwrap_or(false);

            if !has_seq {
                // Check if we already have a GPT-generated fix for this
                let already_has_fix = group.issues.iter().any(|i| {
                    i.book_ids.contains(&book.book_id) &&
                    matches!(i.issue_type, SeriesIssueType::MissingSequence)
                });

                if !already_has_fix {
                    group.issues.push(SeriesIssue {
                        issue_type: SeriesIssueType::MissingSequence,
                        severity: "info".to_string(),
                        message: format!("Book \"{}\" has no sequence number", book.title),
                        book_ids: vec![book.book_id.clone()],
                        suggested_fix: None,
                    });
                }
            }
        }
    }

    // Issue: Unverified series (no API data and low confidence)
    if group.api_series_name.is_none() && group.books.len() == 1 {
        group.issues.push(SeriesIssue {
            issue_type: SeriesIssueType::UnverifiedSeries,
            severity: "info".to_string(),
            message: "Single book series could not be verified via API".to_string(),
            book_ids: group.books.iter().map(|b| b.book_id.clone()).collect(),
            suggested_fix: None,
        });
        group.confidence = 40;
    }
}

// ============================================================================
// APPLY FIXES COMMAND
// ============================================================================

/// Apply series fixes to book groups
#[command]
pub async fn apply_series_fixes(
    groups: Vec<BookGroup>,
    fixes: Vec<SeriesFix>,
) -> Result<Vec<BookGroup>, String> {
    let fix_map: HashMap<String, Vec<&SeriesFix>> = fixes.iter()
        .fold(HashMap::new(), |mut map, fix| {
            map.entry(fix.book_id.clone()).or_insert_with(Vec::new).push(fix);
            map
        });

    let updated: Vec<BookGroup> = groups.into_iter().map(|mut group| {
        if let Some(book_fixes) = fix_map.get(&group.id) {
            let mut series_updated = false;
            let mut sequence_updated = false;
            let mut new_series: Option<String> = None;
            let mut new_sequence: Option<String> = None;

            for fix in book_fixes {
                match fix.field.as_str() {
                    "series" => {
                        group.metadata.series = Some(fix.suggested_value.clone());
                        new_series = Some(fix.suggested_value.clone());
                        series_updated = true;
                    }
                    "sequence" => {
                        group.metadata.sequence = Some(fix.suggested_value.clone());
                        new_sequence = Some(fix.suggested_value.clone());
                        sequence_updated = true;
                    }
                    _ => {}
                }
                group.total_changes += 1;
            }

            // Also update the all_series array to keep UI in sync
            if series_updated || sequence_updated {
                let series_name = new_series.or_else(|| group.metadata.series.clone());
                let series_seq = new_sequence.or_else(|| group.metadata.sequence.clone());

                if let Some(name) = series_name {
                    if group.metadata.all_series.is_empty() {
                        // Create new series entry
                        group.metadata.all_series.push(SeriesInfo {
                            name,
                            sequence: series_seq,
                            source: Some(MetadataSource::Audible),
                        });
                    } else {
                        // Update first series entry
                        group.metadata.all_series[0].name = name;
                        if let Some(seq) = series_seq {
                            group.metadata.all_series[0].sequence = Some(seq);
                        }
                        group.metadata.all_series[0].source = Some(MetadataSource::Audible);
                    }
                }
            }
        }
        group
    }).collect();

    Ok(updated)
}
