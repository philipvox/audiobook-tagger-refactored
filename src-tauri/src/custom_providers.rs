// src-tauri/src/custom_providers.rs
// Custom metadata provider integration (abs-agg, etc.)
// Supports community-hosted providers like Goodreads, Hardcover, Storytel via abs-agg

use crate::config::{Config, CustomProvider};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Result from a custom provider search
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomProviderResult {
    pub provider_name: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub narrator: Option<String>,
    pub publisher: Option<String>,
    pub published_year: Option<String>,
    pub description: Option<String>,
    pub cover: Option<String>,
    pub isbn: Option<String>,
    pub asin: Option<String>,
    pub language: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub series: Vec<CustomSeriesEntry>,
    pub duration: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomSeriesEntry {
    pub series: Option<String>,
    pub sequence: Option<String>,
}

/// Search all enabled custom providers in parallel
pub async fn search_custom_providers(
    config: &Config,
    title: &str,
    author: &str,
) -> Vec<CustomProviderResult> {
    println!("\n   ═══════════════════════════════════════════════════════════");
    println!("   🔌 CUSTOM PROVIDERS SEARCH");
    println!("   ═══════════════════════════════════════════════════════════");
    println!("   📖 Title: '{}'", title);
    println!("   ✍️  Author: '{}'", author);
    println!("   📋 Total configured providers: {}", config.custom_providers.len());

    let enabled_providers: Vec<_> = config.custom_providers
        .iter()
        .filter(|p| p.enabled)
        .cloned()
        .collect();

    if enabled_providers.is_empty() {
        println!("   ⚠️  No enabled providers! Check Settings > Custom Providers");
        return Vec::new();
    }

    println!("   ✅ Enabled providers: {}", enabled_providers.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "));

    // Search all providers in parallel
    let futures: Vec<_> = enabled_providers.iter()
        .map(|provider| {
            let provider = provider.clone();
            let title = title.to_string();
            let author = author.to_string();
            async move {
                search_single_provider(&provider, &title, &author).await
            }
        })
        .collect();

    let results = futures::future::join_all(futures).await;

    // Collect successful results, sorted by priority
    let mut successful: Vec<_> = results.into_iter()
        .zip(enabled_providers.iter())
        .filter_map(|(result, provider)| {
            result.map(|mut r| {
                r.provider_name = provider.name.clone();
                (r, provider.priority)
            })
        })
        .collect();

    // Sort by priority (highest first)
    successful.sort_by(|a, b| b.1.cmp(&a.1));

    let final_results: Vec<_> = successful.into_iter().map(|(r, _)| r).collect();

    // Summary
    println!("   ───────────────────────────────────────────────────────────");
    println!("   📊 CUSTOM PROVIDERS SUMMARY");
    println!("   ───────────────────────────────────────────────────────────");
    println!("   Total results: {}", final_results.len());
    for (idx, r) in final_results.iter().enumerate() {
        println!("   {}. {} -> '{}' | Series: {:?} | Genres: {}",
            idx + 1,
            r.provider_name,
            r.title.as_deref().unwrap_or("?"),
            r.series.first().and_then(|s| s.series.as_ref()),
            r.genres.len()
        );
    }
    println!("   ═══════════════════════════════════════════════════════════\n");

    final_results
}

/// Search a single custom provider
async fn search_single_provider(
    provider: &CustomProvider,
    title: &str,
    author: &str,
) -> Option<CustomProviderResult> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;

    // Build URL: https://provider.vito0912.de/goodreads/search?title=X&author=Y
    let url = format!(
        "{}/{}/search?title={}&author={}",
        provider.base_url.trim_end_matches('/'),
        provider.provider_id,
        urlencoding::encode(title),
        urlencoding::encode(author)
    );

    println!("   🔍 {} searching: '{}'", provider.name, title);
    println!("      URL: {}", url);

    let mut request = client.get(&url);

    // Add auth token if configured (abs-agg uses plain token, not Bearer)
    if let Some(ref token) = provider.auth_token {
        request = request.header("Authorization", token);
    }

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            println!("   ❌ {} network error: {}", provider.name, e);
            return None;
        }
    };

    let status = response.status();
    if !status.is_success() {
        println!("   ❌ {} HTTP error: {}", provider.name, status);
        return None;
    }
    println!("   ✓ {} response: {}", provider.name, status);

    let body = response.text().await.ok()?;
    println!("   📦 {} body length: {} chars", provider.name, body.len());

    // Log first 500 chars of response for debugging (safe for UTF-8)
    let preview: String = body.chars().take(500).collect();
    println!("   📄 {} preview: {}...", provider.name, preview);

    // Parse response - ABS custom provider format returns array of matches
    parse_provider_response(&body, &provider.name, title)
}

/// Parse custom provider response (ABS OpenAPI format)
fn parse_provider_response(body: &str, provider_name: &str, search_title: &str) -> Option<CustomProviderResult> {
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(j) => j,
        Err(e) => {
            println!("   ❌ {} JSON parse error: {}", provider_name, e);
            return None;
        }
    };

    // Response should be an object with "matches" array
    let matches = json.get("matches")
        .and_then(|m| m.as_array())
        .or_else(|| json.as_array());

    let matches = match matches {
        Some(m) => m,
        None => {
            println!("   ❌ {} no 'matches' array found in response", provider_name);
            println!("      Response keys: {:?}", json.as_object().map(|o| o.keys().collect::<Vec<_>>()));
            return None;
        }
    };

    println!("   📊 {} found {} matches", provider_name, matches.len());

    if matches.is_empty() {
        println!("   ⚠️  {} returned empty matches array", provider_name);
        return None;
    }

    // Find best match by title similarity
    let search_lower = search_title.to_lowercase();
    let mut best_match: Option<(CustomProviderResult, i32)> = None;

    for (idx, item) in matches.iter().enumerate() {
        if let Some(result) = parse_single_match(item, provider_name) {
            // Calculate score against title, subtitle, and combined
            let title_score = result.title.as_ref()
                .map(|t| calculate_match_score(&search_lower, &t.to_lowercase()))
                .unwrap_or(0);
            let subtitle_score = result.subtitle.as_ref()
                .map(|s| calculate_match_score(&search_lower, &s.to_lowercase()))
                .unwrap_or(0);
            let combined = match (&result.title, &result.subtitle) {
                (Some(t), Some(s)) => format!("{}: {}", t, s).to_lowercase(),
                (Some(t), None) => t.to_lowercase(),
                _ => String::new(),
            };
            let combined_score = if !combined.is_empty() {
                calculate_match_score(&search_lower, &combined)
            } else { 0 };

            // Use best of title, subtitle, or combined score
            let score = title_score.max(subtitle_score).max(combined_score);

            println!("      Match {}: '{}' (score: {} [t:{}/s:{}/c:{}], series: {:?})",
                idx, result.title.as_deref().unwrap_or("?"), score, title_score, subtitle_score, combined_score,
                result.series.first().and_then(|s| s.series.as_ref()));

            if let Some((_, best_score)) = &best_match {
                if score > *best_score {
                    best_match = Some((result, score));
                }
            } else {
                best_match = Some((result, score));
            }
        }
    }

    if let Some((result, score)) = best_match {
        if score >= 40 {
            println!("   ✅ {} SELECTED: '{}' (score: {})", provider_name, result.title.as_deref().unwrap_or("?"), score);
            println!("      Series: {:?}", result.series);
            println!("      Genres: {:?}", result.genres);
            println!("      Description: {} chars", result.description.as_ref().map(|d| d.len()).unwrap_or(0));
            return Some(result);
        } else {
            println!("   ⚠️  {} best match score too low: {} (need >= 40)", provider_name, score);
        }
    }

    None
}

/// Parse a single match from the provider response
fn parse_single_match(item: &serde_json::Value, provider_name: &str) -> Option<CustomProviderResult> {
    // Log what fields are available in this item
    let keys: Vec<_> = item.as_object().map(|o| o.keys().collect()).unwrap_or_default();
    println!("      📋 {} item keys: {:?}", provider_name, keys);

    // ABS custom provider format
    let title = item.get("title").and_then(|v| v.as_str()).map(|s| s.to_string());
    let subtitle = item.get("subtitle").and_then(|v| v.as_str()).map(|s| s.to_string());
    let author = item.get("author").and_then(|v| v.as_str()).map(|s| s.to_string());
    let narrator = item.get("narrator").and_then(|v| v.as_str()).map(|s| s.to_string());
    let publisher = item.get("publisher").and_then(|v| v.as_str()).map(|s| s.to_string());
    let published_year = item.get("publishedYear")
        .or_else(|| item.get("releaseDate"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let description = item.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
    let cover = item.get("cover").and_then(|v| v.as_str()).map(|s| s.to_string());
    let isbn = item.get("isbn").and_then(|v| v.as_str()).map(|s| s.to_string());
    let asin = item.get("asin").and_then(|v| v.as_str()).map(|s| s.to_string());
    let language = item.get("language").and_then(|v| v.as_str()).map(|s| s.to_string());

    // Parse genres
    let genres: Vec<String> = item.get("genres")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|g| g.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    // Parse series - log the raw series data
    let series_raw = item.get("series");
    println!("      📚 {} raw series data: {:?}", provider_name, series_raw);

    let series: Vec<CustomSeriesEntry> = series_raw
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().filter_map(|s| {
                let entry = CustomSeriesEntry {
                    series: s.get("series").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    sequence: s.get("sequence").and_then(|v| v.as_str()).map(|s| s.to_string()),
                };
                println!("         Series entry: {:?}", entry);
                Some(entry)
            }).collect()
        })
        .unwrap_or_default();

    // Duration in minutes
    let duration = item.get("duration").and_then(|v| v.as_u64());

    Some(CustomProviderResult {
        provider_name: String::new(), // Set by caller
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
        series,
        duration,
    })
}

/// Calculate title match score (0-100)
fn calculate_match_score(search: &str, result: &str) -> i32 {
    // Exact match
    if search == result {
        return 100;
    }

    // Contains match
    if result.contains(search) || search.contains(result) {
        return 80;
    }

    // Word overlap score
    let search_words: std::collections::HashSet<_> = search.split_whitespace().collect();
    let result_words: std::collections::HashSet<_> = result.split_whitespace().collect();

    let intersection = search_words.intersection(&result_words).count();
    let union = search_words.union(&result_words).count();

    if union > 0 {
        ((intersection as f64 / union as f64) * 100.0) as i32
    } else {
        0
    }
}

/// Merge custom provider results with existing metadata
/// Returns the best combined metadata from all sources
pub fn merge_custom_results(
    results: &[CustomProviderResult],
    existing_title: Option<&str>,
    existing_author: Option<&str>,
) -> Option<CustomProviderResult> {
    if results.is_empty() {
        return None;
    }

    // Start with the highest priority result
    let mut merged = results[0].clone();

    // Fill in missing fields from other results
    for result in results.iter().skip(1) {
        if merged.description.is_none() && result.description.is_some() {
            merged.description = result.description.clone();
        }
        if merged.narrator.is_none() && result.narrator.is_some() {
            merged.narrator = result.narrator.clone();
        }
        if merged.series.is_empty() && !result.series.is_empty() {
            merged.series = result.series.clone();
        }
        if merged.genres.is_empty() && !result.genres.is_empty() {
            merged.genres = result.genres.clone();
        }
        if merged.cover.is_none() && result.cover.is_some() {
            merged.cover = result.cover.clone();
        }
        if merged.publisher.is_none() && result.publisher.is_some() {
            merged.publisher = result.publisher.clone();
        }
        if merged.published_year.is_none() && result.published_year.is_some() {
            merged.published_year = result.published_year.clone();
        }
    }

    // Preserve existing title/author if better
    if let Some(title) = existing_title {
        if !title.is_empty() && (merged.title.is_none() || merged.title.as_ref().map(|t| t.len()).unwrap_or(0) < title.len()) {
            merged.title = Some(title.to_string());
        }
    }
    if let Some(author) = existing_author {
        if !author.is_empty() && author != "Unknown" {
            merged.author = Some(author.to_string());
        }
    }

    Some(merged)
}

/// Get list of available abs-agg providers (for UI)
pub fn get_available_abs_agg_providers() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("goodreads", "Goodreads", "Best for series info, ratings, descriptions"),
        ("hardcover", "Hardcover", "Modern book database, clean data"),
        ("storytel/language:en", "Storytel (English)", "Audiobook-specific metadata"),
        ("storytel/language:de", "Storytel (German)", "German audiobooks"),
        ("librivox", "LibriVox", "Public domain audiobooks"),
        ("ardaudiothek", "ARD Audiothek", "German public broadcaster"),
        ("audioteka/lang:pl", "Audioteka (Polish)", "Polish audiobooks"),
        ("bigfinish", "Big Finish", "Doctor Who and other audio dramas"),
        ("bookbeat/market:austria", "BookBeat", "Audiobook streaming service"),
        ("graphicaudio", "Graphic Audio", "Full-cast audio productions"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_match_score_exact() {
        assert_eq!(calculate_match_score("harry potter", "harry potter"), 100);
    }

    #[test]
    fn test_match_score_contains() {
        assert_eq!(calculate_match_score("harry potter", "harry potter and the sorcerers stone"), 80);
    }

    #[test]
    fn test_match_score_partial() {
        let score = calculate_match_score("harry potter stone", "harry potter chamber");
        assert!(score > 0 && score < 80);
    }
}
