// src-tauri/src/title_resolver.rs
//
// GPT-based title resolver - focuses ONLY on title, subtitle, and author.
// For series/sequence resolution, see series_resolver.rs

use serde::{Deserialize, Serialize};
use crate::scanner::processor::call_gpt_api;

/// Input for the title resolver - all available information about the audiobook
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TitleResolverInput {
    /// Raw filename (e.g., "01 - The Eye of the World (Unabridged).m4b")
    pub filename: Option<String>,
    /// Folder name (e.g., "Robert Jordan - Wheel of Time 01")
    pub folder_name: Option<String>,
    /// Full folder path for additional context (e.g., "/audiobooks/Robert Jordan/The Wheel of Time/01 - The Eye of the World")
    pub folder_path: Option<String>,
    /// Current/existing title from tags or metadata
    pub current_title: Option<String>,
    /// Current/existing author
    pub current_author: Option<String>,
    /// Current/existing series name
    pub current_series: Option<String>,
    /// Current/existing sequence number
    pub current_sequence: Option<String>,
    /// Any additional context (e.g., from Audible search results, description snippets)
    pub additional_context: Option<String>,
}

/// Output from the title resolver - cleaned/resolved title metadata only
/// NOTE: For series/sequence, use series_resolver.rs instead
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TitleResolverOutput {
    /// The correct, clean title
    pub title: String,
    /// The correct author (extracted from folder path if metadata is wrong)
    pub author: Option<String>,
    /// Subtitle if detected
    pub subtitle: Option<String>,
    /// Confidence level (0-100)
    pub confidence: u8,
    /// Explanation of what was changed/detected
    pub notes: Option<String>,
    /// Suggested title from folder/filename (when confidence is low)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_title: Option<String>,
    /// Suggested author from folder path (when confidence is low)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_author: Option<String>,
    /// Source of suggestion (e.g., "folder", "filename", "path")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion_source: Option<String>,
}

/// GPT response structure for title resolution (title-only, no series)
#[derive(Debug, Deserialize)]
struct GptTitleResponse {
    title: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    confidence: Option<u8>,
    #[serde(default)]
    notes: Option<String>,
}

/// Resolve title, author, and subtitle using GPT
/// NOTE: For series/sequence resolution, use series_resolver.rs
///
/// This function takes messy audiobook metadata and uses GPT to determine
/// the correct title, author, and subtitle. It does NOT handle series info.
///
/// # Arguments
/// * `input` - All available information about the audiobook
/// * `api_key` - OpenAI API key
///
/// # Returns
/// * `Ok(TitleResolverOutput)` - Resolved title metadata (no series)
/// * `Err(String)` - Error message if resolution failed
pub async fn resolve_title_with_gpt(
    input: &TitleResolverInput,
    api_key: &str,
) -> Result<TitleResolverOutput, String> {
    // FIRST: Extract folder-based suggestions as fallback
    let (folder_title, folder_author, folder_source) = extract_from_folder_and_filename(input);

    println!("   📁 Folder extraction: title={:?}, author={:?}, source={}",
        folder_title, folder_author, folder_source);

    // Build context string from available information
    let mut context_parts = Vec::new();

    if let Some(filename) = &input.filename {
        context_parts.push(format!("Filename: \"{}\"", filename));
    }
    if let Some(folder) = &input.folder_name {
        context_parts.push(format!("Folder name: \"{}\"", folder));
    }
    if let Some(folder_path) = &input.folder_path {
        context_parts.push(format!("Full folder path: \"{}\"", folder_path));
    }
    if let Some(title) = &input.current_title {
        context_parts.push(format!("Current metadata title: \"{}\"", title));
    }
    if let Some(author) = &input.current_author {
        context_parts.push(format!("Author: \"{}\"", author));
    }
    if let Some(series) = &input.current_series {
        context_parts.push(format!("Current series: \"{}\"", series));
    }
    if let Some(seq) = &input.current_sequence {
        context_parts.push(format!("Current sequence: \"{}\"", seq));
    }
    if let Some(ctx) = &input.additional_context {
        context_parts.push(format!("Additional info: {}", ctx));
    }

    if context_parts.is_empty() {
        // No input data - use folder extraction if available
        if let Some(title) = folder_title {
            return Ok(TitleResolverOutput {
                title,
                author: folder_author,
                subtitle: None,
                confidence: 60,
                notes: Some(format!("Extracted from {}", folder_source)),
                suggested_title: None,
                suggested_author: None,
                suggestion_source: None,
            });
        }
        return Err("No input data provided".to_string());
    }

    let context = context_parts.join("\n");

    let prompt = format!(
r#"Analyze this audiobook and determine the CORRECT title, author, and subtitle.
NOTE: Do NOT include series or sequence - that is handled separately.

INPUT:
{}

CRITICAL: The folder path and folder name are MORE RELIABLE than corrupted metadata!
- If title is generic like "Books", "Audiobook", "Track" - it's WRONG, use folder name
- If author equals series name (e.g., author="Magic Tree House") - it's WRONG, extract from path
- Folder structure: /audiobooks/AUTHOR_NAME/SERIES_NAME/BOOK_TITLE/
- The folder name usually contains the correct book title after cleaning

RULES:
1. TITLE: The actual book name. Clean it up:
   - Remove "01 -" prefixes
   - Remove "(Unabridged)" or "(Audiobook)" suffixes
   - "Winter of the Ice Wizard" not "01 - Winter of the Ice Wizard (Unabridged)"

2. AUTHOR: Real author name from folder path (first folder after /audiobooks/).
   - "Mary Pope Osborne" not "The Magic Tree House"

3. SUBTITLE: If the book has a subtitle, extract it.
   - Title: "Dune", Subtitle: "Book One of the Dune Chronicles"

4. CONFIDENCE: Rate your confidence 0-100:
   - 90-100: Very confident, verified info matches
   - 70-89: Confident, extracted from reliable source
   - 50-69: Low confidence, using folder/filename as best guess
   - Below 50: Very uncertain, user should verify

Return ONLY valid JSON (NO series/sequence fields):
{{"title":"Book Title","author":"Author Name","subtitle":null,"confidence":90,"notes":"brief"}}"#,
        context
    );

    // Call GPT API with timeout
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        call_gpt_api(&prompt, api_key, &crate::scanner::processor::preferred_model(), 1000)
    ).await;

    match result {
        Ok(Ok(response)) => {
            // Try to parse the response
            match serde_json::from_str::<GptTitleResponse>(&response) {
                Ok(parsed) => {
                    let confidence = parsed.confidence.unwrap_or(80);

                    // If confidence is low (< 70), include folder-based suggestions
                    let (suggested_title, suggested_author, suggestion_source) = if confidence < 70 {
                        println!("   ⚠️ Low confidence ({}), including folder suggestions", confidence);
                        (folder_title.clone(), folder_author.clone(), Some(folder_source.clone()))
                    } else {
                        (None, None, None)
                    };

                    Ok(TitleResolverOutput {
                        title: parsed.title,
                        author: parsed.author.filter(|s| !s.is_empty()),
                        subtitle: parsed.subtitle.filter(|s| !s.is_empty()),
                        confidence,
                        notes: parsed.notes,
                        suggested_title,
                        suggested_author,
                        suggestion_source,
                    })
                }
                Err(e) => {
                    println!("   ⚠️ GPT title parse error: {}", e);
                    println!("   📝 Raw response: {}", response);

                    // Try to extract at least the title from the response
                    // Sometimes GPT returns slightly malformed JSON
                    if let Some(title) = extract_title_from_response(&response) {
                        Ok(TitleResolverOutput {
                            title,
                            author: None,
                            subtitle: None,
                            confidence: 50,
                            notes: Some("Partial parse - check results".to_string()),
                            suggested_title: folder_title,
                            suggested_author: folder_author,
                            suggestion_source: Some(folder_source),
                        })
                    } else if let Some(folder_title) = folder_title {
                        // GPT failed completely, use folder extraction
                        println!("   📁 Using folder extraction as fallback");
                        Ok(TitleResolverOutput {
                            title: folder_title,
                            author: folder_author,
                            subtitle: None,
                            confidence: 60,
                            notes: Some(format!("GPT parse failed, using {}", folder_source)),
                            suggested_title: None,
                            suggested_author: None,
                            suggestion_source: None,
                        })
                    } else {
                        Err(format!("Failed to parse GPT response: {}", e))
                    }
                }
            }
        }
        Ok(Err(e)) => {
            // GPT API error - try folder fallback
            if let Some(title) = folder_title {
                println!("   📁 GPT error, using folder extraction");
                Ok(TitleResolverOutput {
                    title,
                    author: folder_author,
                    subtitle: None,
                    confidence: 60,
                    notes: Some(format!("GPT error ({}), using {}", e, folder_source)),
                    suggested_title: None,
                    suggested_author: None,
                    suggestion_source: None,
                })
            } else {
                Err(format!("GPT API error: {}", e))
            }
        }
        Err(_) => {
            // Timeout - try folder fallback
            if let Some(title) = folder_title {
                println!("   📁 GPT timeout, using folder extraction");
                Ok(TitleResolverOutput {
                    title,
                    author: folder_author,
                    subtitle: None,
                    confidence: 60,
                    notes: Some(format!("GPT timeout, using {}", folder_source)),
                    suggested_title: None,
                    suggested_author: None,
                    suggestion_source: None,
                })
            } else {
                Err("GPT request timed out".to_string())
            }
        }
    }
}

/// Try to extract title from a malformed GPT response
fn extract_title_from_response(response: &str) -> Option<String> {
    // Try to find "title": "..." pattern
    let re = regex::Regex::new(r#""title"\s*:\s*"([^"]+)""#).ok()?;
    re.captures(response)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// Extract title and author from folder name, filename, and folder path
/// This is used as a fallback when GPT confidence is low or fails
/// Returns (title, author, source) where source indicates where the info came from
pub fn extract_from_folder_and_filename(input: &TitleResolverInput) -> (Option<String>, Option<String>, String) {
    // Priority order:
    // 1. Folder name (immediate parent folder) - usually has the book title
    // 2. Folder path - can extract author from structure like /audiobooks/Author/Series/Book
    // 3. Filename - last resort

    let mut title: Option<String> = None;
    let mut author: Option<String> = None;
    let mut source = String::new();

    // Try folder path first - structure is usually /audiobooks/Author/Series/Book
    if let Some(ref path) = input.folder_path {
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

        // Find "audiobooks" or similar marker to identify structure
        if let Some(audiobooks_idx) = parts.iter().position(|&p|
            p.eq_ignore_ascii_case("audiobooks") ||
            p.eq_ignore_ascii_case("audiobook") ||
            p.eq_ignore_ascii_case("books")
        ) {
            // Author is typically right after audiobooks folder
            if parts.len() > audiobooks_idx + 1 {
                let potential_author = parts[audiobooks_idx + 1];
                // Validate it looks like an author name (not a series or book title)
                if looks_like_author_name(potential_author) {
                    author = Some(potential_author.to_string());
                }
            }

            // Book title is usually the last folder
            if parts.len() > audiobooks_idx + 2 {
                let last_folder = parts[parts.len() - 1];
                title = Some(clean_folder_title(last_folder));
                source = "folder_path".to_string();
            }
        }
    }

    // Try folder name (immediate parent)
    if title.is_none() {
        if let Some(ref folder) = input.folder_name {
            let cleaned = clean_folder_title(folder);
            if !cleaned.is_empty() && cleaned.len() > 2 {
                title = Some(cleaned);
                source = "folder_name".to_string();
            }
        }
    }

    // Try filename as last resort
    if title.is_none() {
        if let Some(ref filename) = input.filename {
            let cleaned = clean_filename_title(filename);
            if !cleaned.is_empty() && cleaned.len() > 2 {
                title = Some(cleaned);
                source = "filename".to_string();
            }
        }
    }

    // If we still don't have author, check folder name for "Author - Title" pattern
    if author.is_none() {
        if let Some(ref folder) = input.folder_name {
            if let Some((extracted_author, extracted_title)) = parse_author_title_from_folder(folder) {
                author = Some(extracted_author);
                if title.is_none() {
                    title = Some(extracted_title);
                    source = "folder_name".to_string();
                }
            }
        }
    }

    (title, author, source)
}

/// Check if a string looks like an author name
fn looks_like_author_name(s: &str) -> bool {
    // Author names typically:
    // - Have 2-4 words
    // - Don't start with numbers
    // - Don't contain "Book", "Series", "Vol", etc.

    let lower = s.to_lowercase();
    let words: Vec<&str> = s.split_whitespace().collect();

    if words.is_empty() || words.len() > 5 {
        return false;
    }

    // Check for series/book indicators
    let bad_words = ["book", "series", "vol", "volume", "part", "chapter",
                     "collection", "complete", "trilogy", "saga", "unabridged"];
    if bad_words.iter().any(|w| lower.contains(w)) {
        return false;
    }

    // Check if starts with a number (like "01 - Book Title")
    if s.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        return false;
    }

    true
}

/// Clean a folder name to extract just the book title
fn clean_folder_title(folder: &str) -> String {
    let mut title = folder.to_string();

    // Remove leading numbers like "01 - ", "1. ", "Book 01 - "
    let patterns = [
        r"^\d+\s*[-–—.]\s*",           // "01 - ", "1. "
        r"^Book\s*\d+\s*[-–—.]\s*",    // "Book 01 - "
        r"^Vol\.?\s*\d+\s*[-–—.]\s*",  // "Vol. 1 - "
        r"^Part\s*\d+\s*[-–—.]\s*",    // "Part 1 - "
    ];

    for pattern in &patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            title = re.replace(&title, "").to_string();
        }
    }

    // Remove trailing tags
    let suffixes = [
        "(Unabridged)", "(Abridged)", "(Audiobook)", "(Audio)",
        "[Unabridged]", "[Abridged]", "[Audiobook]", "[Audio]",
        "- Unabridged", "- Abridged",
    ];

    for suffix in &suffixes {
        if let Some(pos) = title.to_lowercase().find(&suffix.to_lowercase()) {
            title = title[..pos].trim().to_string();
        }
    }

    title.trim().to_string()
}

/// Clean a filename to extract just the book title
fn clean_filename_title(filename: &str) -> String {
    let mut title = filename.to_string();

    // Remove file extension
    if let Some(pos) = title.rfind('.') {
        title = title[..pos].to_string();
    }

    // Apply same cleaning as folder
    clean_folder_title(&title)
}

/// Parse "Author - Title" or "Author Name - Book Title" patterns from folder name
fn parse_author_title_from_folder(folder: &str) -> Option<(String, String)> {
    // Look for " - " separator
    if let Some(pos) = folder.find(" - ") {
        let potential_author = folder[..pos].trim();
        let potential_title = folder[pos + 3..].trim();

        // Validate author looks like a name
        if looks_like_author_name(potential_author) && !potential_title.is_empty() {
            return Some((
                potential_author.to_string(),
                clean_folder_title(potential_title)
            ));
        }
    }

    None
}

/// Batch resolve multiple titles with GPT
/// More efficient than calling one at a time
pub async fn resolve_titles_batch(
    inputs: Vec<TitleResolverInput>,
    api_key: String,
) -> Vec<Result<TitleResolverOutput, String>> {
    use futures::stream::{self, StreamExt};

    // Process up to 5 concurrently
    stream::iter(inputs.into_iter().enumerate())
        .map(|(idx, input)| {
            let key = api_key.clone();
            async move {
                println!("   [{}/batch] Processing...", idx + 1);
                resolve_title_with_gpt(&input, &key).await
            }
        })
        .buffer_unordered(5)
        .collect()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_title_from_response() {
        let response = r#"{"title": "The Eye of the World", "series": "The Wheel of Time"}"#;
        assert_eq!(
            extract_title_from_response(response),
            Some("The Eye of the World".to_string())
        );
    }

    #[test]
    fn test_extract_title_from_malformed() {
        let response = r#"Here's the result: {"title": "Dune", incomplete..."#;
        assert_eq!(
            extract_title_from_response(response),
            Some("Dune".to_string())
        );
    }
}
