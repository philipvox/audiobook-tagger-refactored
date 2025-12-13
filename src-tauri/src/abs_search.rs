// src-tauri/src/abs_search.rs
// AudiobookShelf Search API client - fetches metadata via ABS's provider proxy

use crate::audible::{AudibleMetadata, AudibleSeries};
use crate::config::Config;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

/// Providers in priority order for waterfall search
const PROVIDERS: &[&str] = &["audible", "google", "itunes"];

/// Series entry from ABS (Audible format: {series: "name", sequence: "1"})
#[derive(Debug, Clone, Deserialize)]
pub struct AbsSeriesEntry {
    pub series: Option<String>,
    pub sequence: Option<String>,
}

/// Result from ABS search API - handles multiple provider formats
#[derive(Debug, Clone, Deserialize)]
pub struct AbsSearchResult {
    // Common fields across providers
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub narrator: Option<String>,
    pub publisher: Option<String>,
    #[serde(alias = "publishedYear")]
    pub published_year: Option<String>,
    pub description: Option<String>,
    pub cover: Option<String>,
    pub isbn: Option<String>,
    pub asin: Option<String>,
    pub language: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Duration in minutes (Audible format)
    pub duration: Option<u64>,
    pub abridged: Option<bool>,

    // Series as array of objects (Audible format)
    #[serde(default)]
    pub series: Vec<AbsSeriesEntry>,
}

/// Cover result from ABS
#[derive(Debug, Clone)]
pub struct AbsCoverResult {
    pub url: String,
    pub provider: String,
}

/// Check if ABS is properly configured for search
pub fn is_abs_configured(config: &Config) -> bool {
    !config.abs_base_url.is_empty() && !config.abs_api_token.is_empty()
}

/// Search for metadata using waterfall strategy: Audible -> Google -> iTunes
/// Returns the first valid result found
pub async fn search_metadata_waterfall(
    config: &Config,
    title: &str,
    author: &str,
) -> Option<AbsSearchResult> {
    if !is_abs_configured(config) {
        return None;
    }

    for provider in PROVIDERS {
        println!("   🔍 ABS search via {} for '{}'...", provider, title);

        if let Some(result) = search_abs_provider(config, provider, title, author).await {
            if is_result_valid(&result) {
                println!("   ✅ ABS {} found: {:?}", provider, result.title);
                if !result.series.is_empty() {
                    println!("      Series: {:?}", result.series);
                }
                if result.narrator.is_some() {
                    println!("      Narrator: {:?}", result.narrator);
                }
                return Some(result);
            } else {
                println!("   ⚠️  ABS {} returned incomplete data, trying next...", provider);
            }
        }
    }

    println!("   ❌ ABS: No results from any provider");
    None
}

/// Search a specific provider via ABS
pub async fn search_abs_provider(
    config: &Config,
    provider: &str,
    title: &str,
    author: &str,
) -> Option<AbsSearchResult> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;

    // Build URL with query params
    let url = format!(
        "{}/api/search/books?provider={}&title={}&author={}",
        config.abs_base_url,
        urlencoding::encode(provider),
        urlencoding::encode(title),
        urlencoding::encode(author)
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        println!("   ⚠️  ABS {} returned status: {}", provider, response.status());
        return None;
    }

    let body = response.text().await.ok()?;

    // Debug: show first part of response
    if body.len() > 10 {
        // Safe truncation that respects UTF-8 character boundaries
        let truncated: String = body.chars().take(300).collect();
        println!("   DEBUG ABS {} response (first 300 chars): {}", provider, truncated);
    }

    // Parse the response - ABS returns an array of results
    parse_abs_response(&body, provider, title)
}

/// Parse ABS response handling different formats
fn parse_abs_response(body: &str, provider: &str, search_title: &str) -> Option<AbsSearchResult> {
    // First, try to parse as generic JSON to understand structure
    let json: Value = serde_json::from_str(body).ok()?;

    // ABS returns an array of results
    if let Some(arr) = json.as_array() {
        if arr.is_empty() {
            println!("   ⚠️  ABS {} returned empty array", provider);
            return None;
        }

        // Find the best matching result by title similarity
        let search_title_lower = search_title.to_lowercase();
        let search_title_normalized = normalize_for_comparison(&search_title_lower);

        let mut best_match: Option<(AbsSearchResult, i32)> = None;

        for item in arr {
            if let Some(result) = parse_single_result(item, provider) {
                if let Some(ref result_title) = result.title {
                    let result_title_lower = result_title.to_lowercase();
                    let result_title_normalized = normalize_for_comparison(&result_title_lower);

                    // Calculate match score
                    let score = calculate_title_match_score(
                        &search_title_normalized,
                        &result_title_normalized,
                        &search_title_lower,
                        &result_title_lower,
                    );

                    // Keep track of best match
                    if let Some((_, best_score)) = &best_match {
                        if score > *best_score {
                            best_match = Some((result, score));
                        }
                    } else {
                        best_match = Some((result, score));
                    }
                }
            }
        }

        if let Some((result, score)) = best_match {
            if score >= 50 {  // Minimum threshold for a valid match
                println!("   📦 Parsed {} result: title={:?}, author={:?}, narrator={:?}, series_count={}",
                    provider, result.title, result.author, result.narrator, result.series.len());
                return Some(result);
            } else {
                println!("   ⚠️  ABS {}: Best match score {} too low (title mismatch)", provider, score);
            }
        }

        return None;
    }

    // Maybe it's a single object
    if json.is_object() {
        return parse_single_result(&json, provider);
    }

    println!("   ⚠️  ABS {}: Unexpected response format", provider);
    None
}

/// Normalize a title for comparison (remove punctuation, extra spaces)
fn normalize_for_comparison(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Normalize for fuzzy matching - removes ALL spaces for compound word comparison
/// "ghosttown" == "ghost town", "treehouse" == "tree house"
fn normalize_no_spaces(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

/// Calculate how well a result title matches the search title
/// Returns a score from 0-100
fn calculate_title_match_score(
    search_normalized: &str,
    result_normalized: &str,
    search_lower: &str,
    result_lower: &str,
) -> i32 {
    // Exact match
    if search_normalized == result_normalized {
        return 100;
    }

    // Fuzzy match - compare without spaces to handle compound words
    // "ghosttown" == "ghost town", "treehouse" == "tree house"
    let search_no_spaces = normalize_no_spaces(search_normalized);
    let result_no_spaces = normalize_no_spaces(result_normalized);

    if search_no_spaces == result_no_spaces {
        return 98;  // Very high - same letters, just different spacing
    }

    // Check if one contains the other (no spaces version)
    if result_no_spaces.contains(&search_no_spaces) {
        let len_ratio = search_no_spaces.len() as f32 / result_no_spaces.len() as f32;
        if len_ratio > 0.7 {
            return 95;  // Excellent match
        } else if len_ratio > 0.5 {
            return 85;  // Good match
        } else {
            return 35;  // Likely a collection
        }
    }

    if search_no_spaces.contains(&result_no_spaces) {
        return 80;  // Result is contained in search
    }

    // Check if one contains the other (with spaces version)
    if result_normalized.contains(search_normalized) {
        let len_ratio = search_normalized.len() as f32 / result_normalized.len() as f32;
        if len_ratio > 0.5 {
            return 90;  // Good match - search title is substantial part of result
        } else {
            return 40;  // Likely a collection - search title is small part
        }
    }

    if search_normalized.contains(result_normalized) {
        return 85;  // Result is contained in search
    }

    // Check for "Collection" or "Books X-Y" patterns that indicate compilations
    if result_lower.contains("collection") ||
       result_lower.contains("books ") ||
       result_lower.contains("omnibus") ||
       result_lower.contains("box set") {
        // This is likely a collection, not the individual book
        return 20;
    }

    // Word-level matching
    let search_words: Vec<&str> = search_normalized.split_whitespace().collect();
    let result_words: Vec<&str> = result_normalized.split_whitespace().collect();

    let matching_words = search_words.iter()
        .filter(|w| result_words.contains(w))
        .count();

    let total_words = search_words.len().max(1);
    let match_ratio = matching_words as f32 / total_words as f32;

    (match_ratio * 70.0) as i32  // Max 70 for partial word matches
}

/// Parse a single result object into AbsSearchResult
fn parse_single_result(obj: &Value, provider: &str) -> Option<AbsSearchResult> {
    // Extract fields manually to handle different provider formats
    let title = obj.get("title").and_then(|v| v.as_str()).map(String::from);
    let subtitle = obj.get("subtitle").and_then(|v| v.as_str()).map(String::from);
    let author = obj.get("author").and_then(|v| v.as_str()).map(String::from);
    let narrator = obj.get("narrator").and_then(|v| v.as_str()).map(String::from);
    let publisher = obj.get("publisher").and_then(|v| v.as_str()).map(String::from);
    let published_year = obj.get("publishedYear")
        .or_else(|| obj.get("publishYear"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let description = obj.get("description").and_then(|v| v.as_str()).map(String::from);
    let cover = obj.get("cover").and_then(|v| v.as_str()).map(String::from);
    let isbn = obj.get("isbn").and_then(|v| v.as_str()).map(String::from);
    let asin = obj.get("asin").and_then(|v| v.as_str()).map(String::from);
    let language = obj.get("language").and_then(|v| v.as_str()).map(String::from);
    let duration = obj.get("duration").and_then(|v| v.as_u64());
    let abridged = obj.get("abridged").and_then(|v| v.as_bool());

    // Parse genres array
    let genres = obj.get("genres")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Parse tags array
    let tags = obj.get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Parse series array - Audible format: [{series: "Name", sequence: "1"}]
    let series = obj.get("series")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let series_name = s.get("series").and_then(|v| v.as_str()).map(String::from);
                    let sequence = s.get("sequence").and_then(|v| {
                        // sequence can be string or number
                        v.as_str().map(String::from)
                            .or_else(|| v.as_u64().map(|n| n.to_string()))
                            .or_else(|| v.as_f64().map(|n| n.to_string()))
                    });
                    Some(AbsSeriesEntry { series: series_name, sequence })
                })
                .collect()
        })
        .unwrap_or_default();

    let result = AbsSearchResult {
        title,
        subtitle,
        author,
        narrator,
        publisher,
        published_year,
        description,
        cover,
        isbn,
        asin,
        language,
        genres,
        tags,
        duration,
        abridged,
        series,
    };

    // Log what we parsed
    if result.title.is_some() {
        println!("   📦 Parsed {} result: title={:?}, author={:?}, narrator={:?}, series_count={}",
            provider,
            result.title,
            result.author,
            result.narrator,
            result.series.len()
        );
    }

    Some(result)
}

/// Check if a result has enough data to be useful
fn is_result_valid(result: &AbsSearchResult) -> bool {
    // Must have at least a title
    result.title.as_ref().map(|t| !t.is_empty()).unwrap_or(false)
}

/// Search for cover art using waterfall strategy
pub async fn search_cover_waterfall(
    config: &Config,
    title: &str,
    author: &str,
) -> Option<AbsCoverResult> {
    if !is_abs_configured(config) {
        return None;
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;

    for provider in PROVIDERS {
        let url = format!(
            "{}/api/search/covers?provider={}&title={}&author={}",
            config.abs_base_url,
            urlencoding::encode(provider),
            urlencoding::encode(title),
            urlencoding::encode(author)
        );

        if let Ok(response) = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(body) = response.text().await {
                    // Parse cover results
                    if let Some(cover_url) = parse_cover_response(&body) {
                        println!("   ✅ ABS cover found via {}", provider);
                        return Some(AbsCoverResult {
                            url: cover_url,
                            provider: provider.to_string(),
                        });
                    }
                }
            }
        }
    }

    None
}

/// Parse cover response - handles various ABS response formats
fn parse_cover_response(body: &str) -> Option<String> {
    // Try as JSON value first
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        // Array of results
        if let Some(arr) = json.as_array() {
            for item in arr {
                if let Some(url) = item.get("cover").and_then(|v| v.as_str()) {
                    if !url.is_empty() {
                        return Some(url.to_string());
                    }
                }
            }
        }
        // Single object
        if let Some(url) = json.get("cover").and_then(|v| v.as_str()) {
            if !url.is_empty() {
                return Some(url.to_string());
            }
        }
    }

    None
}

/// Convert ABS search result to AudibleMetadata (for compatibility with existing code)
pub fn convert_to_audible_metadata(result: AbsSearchResult) -> AudibleMetadata {
    // Extract author
    let authors = if let Some(author) = result.author {
        if !author.is_empty() {
            vec![author]
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    // Extract narrator
    let narrators = if let Some(narrator) = result.narrator {
        if !narrator.is_empty() {
            vec![narrator]
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    // Build series info from array
    let series: Vec<AudibleSeries> = result.series.into_iter()
        .filter_map(|s| {
            s.series.map(|name| AudibleSeries {
                name,
                position: s.sequence,
            })
        })
        .collect();

    // Duration is already in minutes from ABS
    let runtime_minutes = result.duration.map(|d| d as u32);

    AudibleMetadata {
        asin: result.asin,
        title: result.title,
        subtitle: result.subtitle,
        authors,
        narrators,
        series,
        publisher: result.publisher,
        release_date: result.published_year,
        description: result.description,
        language: result.language,
        runtime_minutes,
        abridged: result.abridged,
        genres: result.genres,
        cover_url: result.cover, // Preserve cover URL from ABS to avoid duplicate API calls
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_abs_configured() {
        let mut config = Config::default();

        // Default config has empty token
        config.abs_base_url = "http://localhost:13378".to_string();
        config.abs_api_token = "".to_string();
        assert!(!is_abs_configured(&config));

        // With token set
        config.abs_api_token = "test-token".to_string();
        assert!(is_abs_configured(&config));

        // Empty URL
        config.abs_base_url = "".to_string();
        assert!(!is_abs_configured(&config));
    }

    #[test]
    fn test_parse_audible_response() {
        let json = r#"[{
            "title": "Harry Potter and the Sorcerer's Stone",
            "author": "J.K. Rowling",
            "narrator": "Jim Dale",
            "series": [{"series": "Harry Potter", "sequence": "1"}],
            "cover": "https://example.com/cover.jpg",
            "asin": "B017V4IM1G"
        }]"#;

        let result = parse_abs_response(json, "audible", "Harry Potter and the Sorcerer's Stone").unwrap();
        assert_eq!(result.title, Some("Harry Potter and the Sorcerer's Stone".to_string()));
        assert_eq!(result.author, Some("J.K. Rowling".to_string()));
        assert_eq!(result.narrator, Some("Jim Dale".to_string()));
        assert_eq!(result.series.len(), 1);
        assert_eq!(result.series[0].series, Some("Harry Potter".to_string()));
        assert_eq!(result.series[0].sequence, Some("1".to_string()));
    }

    #[test]
    fn test_parse_google_response() {
        let json = r#"[{
            "title": "Harry Potter and the Sorcerer's Stone",
            "author": "J.K. Rowling",
            "cover": "https://example.com/cover.jpg",
            "isbn": "9780439708180"
        }]"#;

        let result = parse_abs_response(json, "google", "Harry Potter and the Sorcerer's Stone").unwrap();
        assert_eq!(result.title, Some("Harry Potter and the Sorcerer's Stone".to_string()));
        assert_eq!(result.author, Some("J.K. Rowling".to_string()));
        assert_eq!(result.narrator, None);
        assert!(result.series.is_empty());
    }

    #[test]
    fn test_convert_to_audible_metadata_with_series() {
        let abs_result = AbsSearchResult {
            title: Some("Harry Potter".to_string()),
            subtitle: None,
            author: Some("J.K. Rowling".to_string()),
            narrator: Some("Jim Dale".to_string()),
            publisher: None,
            published_year: None,
            description: None,
            cover: None,
            isbn: None,
            asin: Some("B017V4IM1G".to_string()),
            language: None,
            genres: vec![],
            tags: vec![],
            duration: Some(480),
            abridged: None,
            series: vec![AbsSeriesEntry {
                series: Some("Harry Potter".to_string()),
                sequence: Some("1".to_string()),
            }],
        };

        let metadata = convert_to_audible_metadata(abs_result);

        assert_eq!(metadata.title, Some("Harry Potter".to_string()));
        assert_eq!(metadata.authors, vec!["J.K. Rowling".to_string()]);
        assert_eq!(metadata.narrators, vec!["Jim Dale".to_string()]);
        assert_eq!(metadata.series.len(), 1);
        assert_eq!(metadata.series[0].name, "Harry Potter");
        assert_eq!(metadata.series[0].position, Some("1".to_string()));
    }
}
