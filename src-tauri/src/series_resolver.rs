// src-tauri/src/series_resolver.rs
//
// Series resolver using ABS/Audible lookup + GPT validation.
// Provides robust series name and sequence number resolution.

use serde::{Deserialize, Serialize};
use crate::abs_search::search_metadata_waterfall;
use crate::config::Config;
use crate::scanner::processor::call_gpt_api;

/// Input for the series resolver
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesResolverInput {
    /// Book title (required for Audible lookup)
    pub title: String,
    /// Author name (required for Audible lookup)
    pub author: String,
    /// Current series name from metadata (may be wrong/inconsistent)
    pub current_series: Option<String>,
    /// Current sequence number from metadata (may be wrong)
    pub current_sequence: Option<String>,
}

/// Output from the series resolver
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesResolverOutput {
    /// The canonical series name
    pub series: Option<String>,
    /// The correct sequence number (handles 0, 0.5, 2.5, etc.)
    pub sequence: Option<String>,
    /// What Audible returned (for reference/debugging)
    pub audible_series: Option<String>,
    /// What Audible returned for sequence
    pub audible_sequence: Option<String>,
    /// Confidence level (0-100)
    pub confidence: u8,
    /// Explanation of what was found/changed
    pub notes: Option<String>,
}

/// GPT response structure for series resolution
#[derive(Debug, Deserialize)]
struct GptSeriesResponse {
    #[serde(default)]
    series: Option<String>,
    #[serde(default, deserialize_with = "deserialize_sequence")]
    sequence: Option<String>,
    #[serde(default)]
    confidence: Option<u8>,
    #[serde(default)]
    notes: Option<String>,
}

/// Helper to deserialize sequence that could be string or number
fn deserialize_sequence<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Visitor;

    struct SequenceVisitor;

    impl<'de> Visitor<'de> for SequenceVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string, number, or null")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
            if value.is_empty() {
                Ok(None)
            } else {
                Ok(Some(value.to_string()))
            }
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
            if value.is_empty() {
                Ok(None)
            } else {
                Ok(Some(value))
            }
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
            Ok(Some(value.to_string()))
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
            Ok(Some(value.to_string()))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
            // Handle decimal sequences like 0.5, 2.5
            if value.fract() == 0.0 {
                Ok(Some((value as i64).to_string()))
            } else {
                Ok(Some(value.to_string()))
            }
        }
    }

    deserializer.deserialize_any(SequenceVisitor)
}

/// Resolve series using ABS/Audible lookup + GPT validation
///
/// This function:
/// 1. Searches Audible via ABS for the book
/// 2. Extracts series info from Audible if found
/// 3. Uses GPT to validate/correct the series name and sequence
///
/// # Arguments
/// * `input` - Book title, author, and current series info
/// * `config` - App config (for ABS connection)
/// * `api_key` - OpenAI API key
///
/// # Returns
/// * `Ok(SeriesResolverOutput)` - Resolved series info
/// * `Err(String)` - Error message if resolution failed
pub async fn resolve_series_with_abs_and_gpt(
    input: &SeriesResolverInput,
    config: &Config,
    api_key: &str,
) -> Result<SeriesResolverOutput, String> {
    println!("📚 Series resolver starting for: \"{}\" by {}", input.title, input.author);

    // 1. Try ABS/Audible lookup first
    let abs_result = search_metadata_waterfall(config, &input.title, &input.author).await;

    // 2. Extract series info from Audible result
    let audible_series = abs_result.as_ref()
        .and_then(|r| r.series.first())
        .and_then(|s| s.series.clone());
    let audible_sequence = abs_result.as_ref()
        .and_then(|r| r.series.first())
        .and_then(|s| s.sequence.clone());

    if let Some(ref series) = audible_series {
        println!("   ✅ Audible found series: \"{}\" #{:?}", series, audible_sequence);
    } else {
        println!("   ⚠️ Audible did not return series info");
    }

    // 3. Build GPT prompt with all context
    let prompt = build_series_prompt(input, audible_series.as_deref(), audible_sequence.as_deref());

    // 4. Call GPT to validate/enhance
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        call_gpt_api(&prompt, api_key, &crate::scanner::processor::preferred_model(), 1000)
    ).await;

    match result {
        Ok(Ok(response)) => {
            parse_series_response(&response, audible_series, audible_sequence)
        }
        Ok(Err(e)) => {
            // GPT failed, but we might have Audible data
            if audible_series.is_some() {
                println!("   ⚠️ GPT failed but using Audible data: {}", e);
                Ok(SeriesResolverOutput {
                    series: audible_series.clone(),
                    sequence: audible_sequence.clone(),
                    audible_series,
                    audible_sequence,
                    confidence: 70,
                    notes: Some(format!("GPT validation failed ({}), using Audible data", e)),
                })
            } else {
                Err(format!("Series resolution failed: {}", e))
            }
        }
        Err(_) => {
            // Timeout, but we might have Audible data
            if audible_series.is_some() {
                println!("   ⚠️ GPT timed out but using Audible data");
                Ok(SeriesResolverOutput {
                    series: audible_series.clone(),
                    sequence: audible_sequence.clone(),
                    audible_series,
                    audible_sequence,
                    confidence: 70,
                    notes: Some("GPT timed out, using Audible data".to_string()),
                })
            } else {
                Err("Series resolution timed out".to_string())
            }
        }
    }
}

/// Build the GPT prompt for series validation
fn build_series_prompt(
    input: &SeriesResolverInput,
    audible_series: Option<&str>,
    audible_sequence: Option<&str>,
) -> String {
    let mut context_parts = Vec::new();

    context_parts.push(format!("Title: \"{}\"", input.title));
    context_parts.push(format!("Author: \"{}\"", input.author));

    if let Some(series) = audible_series {
        context_parts.push(format!("Audible series: \"{}\"", series));
    }
    if let Some(seq) = audible_sequence {
        context_parts.push(format!("Audible sequence: \"{}\"", seq));
    }
    if let Some(ref series) = input.current_series {
        context_parts.push(format!("Current metadata series: \"{}\"", series));
    }
    if let Some(ref seq) = input.current_sequence {
        context_parts.push(format!("Current metadata sequence: \"{}\"", seq));
    }

    let context = context_parts.join("\n");

    format!(
r#"Determine the CANONICAL series name and book number for this audiobook.

INPUT:
{}

RULES:
1. SERIES NAME: Use the official, canonical series name
   - "The Wheel of Time" not "Wheel of Time"
   - "A Song of Ice and Fire" not "Game of Thrones"
   - "The Stormlight Archive" not "Stormlight"

2. SEQUENCE NUMBER: Determine the correct position
   - Prequels: Use 0 or 0.5 (e.g., "New Spring" is Wheel of Time #0)
   - Novellas between books: Use decimals (e.g., Edgedancer is Stormlight #2.5)
   - Split audiobooks: Use letters if needed (e.g., 14a, 14b)
   - Regular books: Just the number (1, 2, 3...)

3. If Audible data is provided, VALIDATE it:
   - Correct any spelling/capitalization issues
   - Fix incorrect sequence numbers (Audible sometimes gets novellas wrong)

4. If this is a STANDALONE book (not part of a series):
   - Return series: null, sequence: null

Return ONLY valid JSON:
{{"series":"Series Name","sequence":"1","confidence":90,"notes":"brief explanation"}}"#,
        context
    )
}

/// Parse GPT response into SeriesResolverOutput
fn parse_series_response(
    response: &str,
    audible_series: Option<String>,
    audible_sequence: Option<String>,
) -> Result<SeriesResolverOutput, String> {
    match serde_json::from_str::<GptSeriesResponse>(response) {
        Ok(parsed) => {
            println!("   ✅ Series resolved: {:?} #{:?}", parsed.series, parsed.sequence);
            Ok(SeriesResolverOutput {
                series: parsed.series.filter(|s| !s.is_empty()),
                sequence: parsed.sequence,
                audible_series,
                audible_sequence,
                confidence: parsed.confidence.unwrap_or(80),
                notes: parsed.notes,
            })
        }
        Err(e) => {
            println!("   ⚠️ GPT series parse error: {}", e);
            println!("   📝 Raw response: {}", response);

            // Try to extract series from malformed response
            if let Some(series) = extract_series_from_response(response) {
                Ok(SeriesResolverOutput {
                    series: Some(series),
                    sequence: extract_sequence_from_response(response),
                    audible_series,
                    audible_sequence,
                    confidence: 50,
                    notes: Some("Partial parse - check results".to_string()),
                })
            } else if audible_series.is_some() {
                // Fall back to Audible data
                Ok(SeriesResolverOutput {
                    series: audible_series.clone(),
                    sequence: audible_sequence.clone(),
                    audible_series,
                    audible_sequence,
                    confidence: 60,
                    notes: Some("GPT parse failed, using Audible data".to_string()),
                })
            } else {
                Err(format!("Failed to parse series response: {}", e))
            }
        }
    }
}

/// Try to extract series name from a malformed GPT response
fn extract_series_from_response(response: &str) -> Option<String> {
    let re = regex::Regex::new(r#""series"\s*:\s*"([^"]+)""#).ok()?;
    re.captures(response)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .filter(|s| s != "null" && !s.is_empty())
}

/// Try to extract sequence from a malformed GPT response
fn extract_sequence_from_response(response: &str) -> Option<String> {
    let re = regex::Regex::new(r#""sequence"\s*:\s*"?([^",}]+)"?"#).ok()?;
    re.captures(response)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| s != "null" && !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_series_from_response() {
        let response = r#"{"series": "The Wheel of Time", "sequence": "1"}"#;
        assert_eq!(
            extract_series_from_response(response),
            Some("The Wheel of Time".to_string())
        );
    }

    #[test]
    fn test_extract_sequence_from_response() {
        let response = r#"{"series": "Stormlight", "sequence": "2.5"}"#;
        assert_eq!(
            extract_sequence_from_response(response),
            Some("2.5".to_string())
        );
    }

    #[test]
    fn test_extract_null_series() {
        let response = r#"{"series": null, "sequence": null}"#;
        assert_eq!(extract_series_from_response(response), None);
    }
}
