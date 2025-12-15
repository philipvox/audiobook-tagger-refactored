// src-tauri/src/pipeline/decide.rs
// DECIDE stage - GPT resolves conflicts and produces unified metadata

use crate::config::Config;
use crate::pipeline::context::format_series_context;
use crate::pipeline::types::{AggregatedBookData, ResolvedMetadata, ResolvedSeries, SourceData};
use serde::Deserialize;

/// GPT system prompt for metadata resolution
const GPT_SYSTEM_PROMPT: &str = r#"You are a metadata specialist for audiobooks. Your job is to analyze metadata from multiple sources and produce the best, most accurate unified metadata.

RULES:
1. TITLE: Use the proper, official title. Remove file artifacts like "_mp3" or "[Unabridged]". Keep subtitles separate.
2. AUTHOR: Use canonical name format (typically "First Last"). For multiple authors, list primary author first.
3. NARRATOR: Same format as author. Multiple narrators should be comma-separated.
4. SERIES: CRITICAL - Be very strict about series:
   - ONLY include series that THIS SPECIFIC BOOK actually belongs to
   - REJECT series from sources that clearly matched the WRONG BOOK (different title/author)
   - Use full series names (e.g., "Discworld - Ankh-Morpork City Watch" not just "City Watch")
   - A book may belong to: main series, subseries, shared universe
   - Mark the most specific series as "is_primary: true"
   - If a series is part of another, use "is_subseries_of"
   - NEVER include series from unrelated books that happened to appear in search results
5. SEQUENCE: Must be a number or "0.5" style for in-between books. Do NOT include series name in sequence.
6. GENRES: Use standard audiobook genres. Max 5, most specific first.
7. DESCRIPTION: Use the most complete, well-written description available. Clean up HTML artifacts.

Output valid JSON only. No markdown, no explanation."#;

// Responses API structures for GPT-5 models

/// Response from Responses API
#[derive(Deserialize, Debug)]
struct ResponsesApiResponse {
    #[serde(default)]
    output: Vec<OutputItem>,
    /// Top-level output_text field (simpler format)
    output_text: Option<String>,
}

#[derive(Deserialize, Debug)]
struct OutputItem {
    content: Option<Vec<ContentItem>>,
    #[serde(rename = "type")]
    item_type: String,
}

#[derive(Deserialize, Debug)]
struct ContentItem {
    text: Option<String>,
    #[serde(rename = "type")]
    content_type: String,
}

/// Resolve metadata conflicts using GPT-5-nano via Responses API
pub async fn resolve_with_gpt(
    config: &Config,
    data: &AggregatedBookData,
) -> Result<ResolvedMetadata, String> {
    let api_key = config
        .openai_api_key
        .as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("No OpenAI API key configured")?;

    let user_prompt = build_user_prompt(data);

    // Build Responses API request body for GPT-5-nano
    let request_body = serde_json::json!({
        "model": "gpt-5-nano",
        "input": [
            {
                "role": "developer",
                "content": GPT_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": user_prompt
            }
        ],
        "max_output_tokens": 4000,
        "reasoning": {
            "effort": "low"
        },
        "text": {
            "format": {
                "type": "json_object"
            }
        }
    });

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/responses")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("GPT request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GPT returned status {}: {}", status, body));
    }

    let response_text = response.text().await
        .map_err(|e| format!("Failed to read GPT response: {}", e))?;

    // Parse Responses API format
    let result: ResponsesApiResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse Responses API response: {}. Raw: {}", e, &response_text[..response_text.len().min(500)]))?;

    // Extract text content - first try top-level output_text, then nested format
    let content = if let Some(ref text) = result.output_text {
        text.trim().to_string()
    } else {
        result.output.iter()
            .filter(|item| item.item_type == "message")
            .filter_map(|item| item.content.as_ref())
            .flatten()
            .filter(|c| c.content_type == "output_text" || c.content_type == "text")
            .filter_map(|c| c.text.as_ref())
            .next()
            .ok_or_else(|| format!("No text content in Responses API response. Raw: {}", &response_text[..response_text.len().min(500)]))?
            .trim()
            .to_string()
    };

    // Parse GPT's JSON response
    parse_gpt_response(&content)
}

/// Build the user prompt with all source data
fn build_user_prompt(data: &AggregatedBookData) -> String {
    let mut prompt = String::from("Analyze these metadata sources and produce unified metadata:\n\n");

    // Add each source
    for (i, source) in data.sources.iter().enumerate() {
        prompt.push_str(&format!(
            "SOURCE {} ({}, confidence: {}):\n",
            i + 1,
            source.source,
            source.confidence
        ));
        prompt.push_str(&format_source_data(source));
        prompt.push('\n');
    }

    // Add series context if available
    if !data.series_context.is_empty() {
        prompt.push_str(&format_series_context(&data.series_context));
        prompt.push('\n');
    }

    // Add output format
    prompt.push_str(
        r#"
Return a JSON object with this exact structure:
{
  "title": "Book Title",
  "subtitle": "Optional Subtitle" or null,
  "author": "Primary Author Name",
  "authors": ["Author 1", "Author 2"],
  "narrator": "Primary Narrator" or null,
  "narrators": ["Narrator 1", "Narrator 2"],
  "series": [
    {
      "name": "Series Name",
      "sequence": "1" or null,
      "is_primary": true/false,
      "is_subseries_of": "Parent Series" or null
    }
  ],
  "genres": ["Genre1", "Genre2"],
  "description": "Description text" or null,
  "publisher": "Publisher Name" or null,
  "year": "2023" or null,
  "language": "English" or null,
  "themes": ["Theme1", "Theme2"],
  "tropes": ["Trope1", "Trope2"],
  "reasoning": "Brief explanation of key decisions"
}

THEMES: Extract 3-5 major themes from the description (e.g., "Redemption", "Found Family", "Coming of Age", "Power and Corruption").
TROPES: Extract 3-5 story tropes (e.g., "Chosen One", "Mentor Figure", "Dark Lord", "Quest", "Hidden Heir").
"#,
    );

    prompt
}

/// Format source data for the prompt
fn format_source_data(source: &SourceData) -> String {
    let mut output = String::new();

    if let Some(ref title) = source.title {
        output.push_str(&format!("  Title: {}\n", title));
    }
    if let Some(ref subtitle) = source.subtitle {
        output.push_str(&format!("  Subtitle: {}\n", subtitle));
    }
    if !source.authors.is_empty() {
        output.push_str(&format!("  Authors: {}\n", source.authors.join(", ")));
    }
    if !source.narrators.is_empty() {
        output.push_str(&format!("  Narrators: {}\n", source.narrators.join(", ")));
    }
    if !source.series.is_empty() {
        output.push_str("  Series:\n");
        for s in &source.series {
            let seq = s.sequence.as_deref().unwrap_or("?");
            output.push_str(&format!("    - {} #{}\n", s.name, seq));
        }
    }
    if !source.genres.is_empty() {
        output.push_str(&format!("  Genres: {}\n", source.genres.join(", ")));
    }
    if let Some(ref desc) = source.description {
        // Truncate long descriptions (use chars() for proper UTF-8 handling)
        let truncated: String = desc.chars().take(500).collect();
        let truncated = if truncated.len() < desc.len() {
            format!("{}...", truncated)
        } else {
            truncated
        };
        output.push_str(&format!("  Description: {}\n", truncated));
    }
    if let Some(ref publisher) = source.publisher {
        output.push_str(&format!("  Publisher: {}\n", publisher));
    }
    if let Some(ref year) = source.year {
        output.push_str(&format!("  Year: {}\n", year));
    }
    if let Some(ref language) = source.language {
        output.push_str(&format!("  Language: {}\n", language));
    }

    output
}

/// Parse GPT's JSON response into ResolvedMetadata
fn parse_gpt_response(content: &str) -> Result<ResolvedMetadata, String> {
    // Try to extract JSON if wrapped in markdown
    let json_str = if content.contains("```json") {
        content
            .split("```json")
            .nth(1)
            .and_then(|s| s.split("```").next())
            .unwrap_or(content)
            .trim()
    } else if content.contains("```") {
        content
            .split("```")
            .nth(1)
            .unwrap_or(content)
            .trim()
    } else {
        content.trim()
    };

    let parsed: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("Invalid JSON from GPT: {}", e))?;

    Ok(ResolvedMetadata {
        title: parsed
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string(),
        subtitle: parsed
            .get("subtitle")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        author: parsed
            .get("author")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string(),
        authors: extract_string_array(&parsed, "authors"),
        narrator: parsed
            .get("narrator")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        narrators: extract_string_array(&parsed, "narrators"),
        series: extract_series(&parsed),
        genres: extract_string_array(&parsed, "genres"),
        description: parsed
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        publisher: parsed
            .get("publisher")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        year: parsed
            .get("year")
            .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string()))),
        language: parsed
            .get("language")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        themes: extract_string_array(&parsed, "themes"),
        tropes: extract_string_array(&parsed, "tropes"),
        reasoning: parsed
            .get("reasoning")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

fn extract_string_array(data: &serde_json::Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn extract_series(data: &serde_json::Value) -> Vec<ResolvedSeries> {
    data.get("series")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(|n| n.as_str())?;
                    Some(ResolvedSeries {
                        name: name.to_string(),
                        sequence: item
                            .get("sequence")
                            .and_then(|s| s.as_str().map(|v| v.to_string()).or_else(|| s.as_f64().map(|n| n.to_string()))),
                        is_primary: item
                            .get("is_primary")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                        is_subseries_of: item
                            .get("is_subseries_of")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Fallback resolution when GPT is unavailable
pub fn fallback_resolution(data: &AggregatedBookData) -> ResolvedMetadata {
    // Sort sources by confidence (highest first)
    let mut sources = data.sources.clone();
    sources.sort_by(|a, b| b.confidence.cmp(&a.confidence));

    // Take best values from each source
    let title = sources
        .iter()
        .find_map(|s| s.title.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let subtitle = sources.iter().find_map(|s| s.subtitle.clone());

    let authors: Vec<String> = sources
        .iter()
        .find(|s| !s.authors.is_empty())
        .map(|s| s.authors.clone())
        .unwrap_or_default();

    let author = authors.first().cloned().unwrap_or_else(|| "Unknown".to_string());

    let narrators: Vec<String> = sources
        .iter()
        .find(|s| !s.narrators.is_empty())
        .map(|s| s.narrators.clone())
        .unwrap_or_default();

    let narrator = narrators.first().cloned();

    // Collect all series, deduplicate
    let mut all_series: Vec<ResolvedSeries> = sources
        .iter()
        .flat_map(|s| {
            s.series.iter().map(|se| ResolvedSeries {
                name: se.name.clone(),
                sequence: se.sequence.clone(),
                is_primary: false,
                is_subseries_of: None,
            })
        })
        .collect();

    // Deduplicate by name (prefer ones with sequence)
    all_series.sort_by(|a, b| {
        a.name.cmp(&b.name).then_with(|| {
            // Prefer entries with sequence
            match (&a.sequence, &b.sequence) {
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            }
        })
    });
    all_series.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));

    // Mark first as primary
    if let Some(first) = all_series.first_mut() {
        first.is_primary = true;
    }

    // Collect genres, deduplicate
    let mut genres: Vec<String> = sources
        .iter()
        .flat_map(|s| s.genres.clone())
        .collect();
    genres.sort();
    genres.dedup();
    genres.truncate(5);

    let description = sources.iter().find_map(|s| s.description.clone());
    let publisher = sources.iter().find_map(|s| s.publisher.clone());
    let year = sources.iter().find_map(|s| s.year.clone());
    let language = sources.iter().find_map(|s| s.language.clone());

    ResolvedMetadata {
        title,
        subtitle,
        author,
        authors,
        narrator,
        narrators,
        series: all_series,
        genres,
        description,
        publisher,
        year,
        language,
        themes: vec![],  // Fallback doesn't extract themes
        tropes: vec![],  // Fallback doesn't extract tropes
        reasoning: Some("Fallback: Used highest confidence source values".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::types::SeriesEntry;

    #[test]
    fn test_fallback_resolution() {
        let data = AggregatedBookData {
            id: "test".to_string(),
            sources: vec![
                SourceData {
                    source: "low".to_string(),
                    confidence: 50,
                    title: Some("Low Title".to_string()),
                    authors: vec!["Low Author".to_string()],
                    series: vec![SeriesEntry::new("Series A".to_string(), None)],
                    ..Default::default()
                },
                SourceData {
                    source: "high".to_string(),
                    confidence: 90,
                    title: Some("High Title".to_string()),
                    authors: vec!["High Author".to_string()],
                    series: vec![SeriesEntry::new("Series B".to_string(), Some("1".to_string()))],
                    ..Default::default()
                },
            ],
            series_context: vec![],
        };

        let resolved = fallback_resolution(&data);

        // Should use high confidence values
        assert_eq!(resolved.title, "High Title");
        assert_eq!(resolved.author, "High Author");
        // Should have both series
        assert_eq!(resolved.series.len(), 2);
    }

    #[test]
    fn test_parse_gpt_response() {
        let json = r#"{
            "title": "Test Book",
            "subtitle": "A Test",
            "author": "Test Author",
            "authors": ["Test Author", "Co-Author"],
            "narrator": "Test Narrator",
            "narrators": ["Test Narrator"],
            "series": [
                {"name": "Test Series", "sequence": "1", "is_primary": true}
            ],
            "genres": ["Fantasy", "Adventure"],
            "description": "A test book",
            "publisher": "Test Pub",
            "year": "2023",
            "language": "English",
            "reasoning": "Test reasoning"
        }"#;

        let result = parse_gpt_response(json).unwrap();

        assert_eq!(result.title, "Test Book");
        assert_eq!(result.subtitle, Some("A Test".to_string()));
        assert_eq!(result.author, "Test Author");
        assert_eq!(result.authors.len(), 2);
        assert_eq!(result.narrator, Some("Test Narrator".to_string()));
        assert_eq!(result.series.len(), 1);
        assert!(result.series[0].is_primary);
        assert_eq!(result.genres, vec!["Fantasy", "Adventure"]);
    }

    #[test]
    fn test_parse_gpt_response_with_markdown() {
        let response = r#"```json
{
    "title": "Test",
    "author": "Author",
    "authors": [],
    "narrators": [],
    "series": [],
    "genres": []
}
```"#;

        let result = parse_gpt_response(response).unwrap();
        assert_eq!(result.title, "Test");
    }

    #[test]
    fn test_format_source_data() {
        let source = SourceData {
            source: "test".to_string(),
            confidence: 90,
            title: Some("Test Title".to_string()),
            authors: vec!["Author 1".to_string(), "Author 2".to_string()],
            series: vec![SeriesEntry::new("Test Series".to_string(), Some("1".to_string()))],
            genres: vec!["Fantasy".to_string()],
            ..Default::default()
        };

        let formatted = format_source_data(&source);

        assert!(formatted.contains("Title: Test Title"));
        assert!(formatted.contains("Authors: Author 1, Author 2"));
        assert!(formatted.contains("Test Series #1"));
        assert!(formatted.contains("Genres: Fantasy"));
    }
}
