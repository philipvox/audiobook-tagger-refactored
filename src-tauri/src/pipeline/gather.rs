// src-tauri/src/pipeline/gather.rs
// GATHER stage - collect data from all sources

use crate::config::Config;
use crate::pipeline::types::{SourceData, SeriesEntry};

/// Fetch fresh metadata from ABS API for an item
pub async fn fetch_abs_metadata(
    client: &reqwest::Client,
    config: &Config,
    abs_id: &str,
) -> Result<SourceData, String> {
    if config.abs_base_url.is_empty() {
        return Err("No ABS base URL configured".to_string());
    }
    if config.abs_api_token.is_empty() {
        return Err("No ABS API token configured".to_string());
    }
    let base_url = &config.abs_base_url;
    let token = &config.abs_api_token;

    let url = format!("{}/api/items/{}", base_url, abs_id);

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("ABS request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("ABS returned status {}", response.status()));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse ABS response: {}", e))?;

    Ok(parse_abs_item(&data))
}

/// Parse ABS API response into SourceData
fn parse_abs_item(data: &serde_json::Value) -> SourceData {
    let media = data.get("media").unwrap_or(data);
    let metadata = media.get("metadata").unwrap_or(data);

    let mut source = SourceData::new("abs_api", 85);

    source.title = metadata
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    source.subtitle = metadata
        .get("subtitle")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Authors
    if let Some(authors) = metadata.get("authors").and_then(|v| v.as_array()) {
        source.authors = authors
            .iter()
            .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
            .map(|s| s.to_string())
            .collect();
    } else if let Some(author) = metadata.get("authorName").and_then(|v| v.as_str()) {
        source.authors = vec![author.to_string()];
    }

    // Narrators
    if let Some(narrators) = metadata.get("narrators").and_then(|v| v.as_array()) {
        source.narrators = narrators
            .iter()
            .filter_map(|n| n.get("name").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .collect();
    } else if let Some(narrator) = metadata.get("narratorName").and_then(|v| v.as_str()) {
        source.narrators = vec![narrator.to_string()];
    }

    // Series
    if let Some(series) = metadata.get("series").and_then(|v| v.as_array()) {
        source.series = series
            .iter()
            .filter_map(|s| {
                let name = s.get("name").and_then(|n| n.as_str())?;
                let sequence = s
                    .get("sequence")
                    .and_then(|sq| sq.as_str().map(|s| s.to_string()).or_else(|| sq.as_f64().map(|n| n.to_string())));
                Some(SeriesEntry::new(name.to_string(), sequence))
            })
            .collect();
    } else if let Some(series_name) = metadata.get("seriesName").and_then(|v| v.as_str()) {
        let sequence = metadata
            .get("seriesSequence")
            .and_then(|sq| sq.as_str().map(|s| s.to_string()).or_else(|| sq.as_f64().map(|n| n.to_string())));
        source.series = vec![SeriesEntry::new(series_name.to_string(), sequence)];
    }

    // Genres
    if let Some(genres) = metadata.get("genres").and_then(|v| v.as_array()) {
        source.genres = genres
            .iter()
            .filter_map(|g| g.as_str())
            .map(|s| s.to_string())
            .collect();
    }

    source.description = metadata
        .get("description")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    source.publisher = metadata
        .get("publisher")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    source.year = metadata
        .get("publishedYear")
        .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string())));

    source.isbn = metadata
        .get("isbn")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    source.asin = metadata
        .get("asin")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    source.language = metadata
        .get("language")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Cover URL
    if let Some(cover) = data.get("id").and_then(|id| id.as_str()) {
        // We'll construct the cover URL later when we have the base URL
        source.cover_url = Some(format!("/api/items/{}/cover", cover));
    }

    source
}

/// Fetch from custom providers (abs-agg)
pub async fn fetch_custom_providers(
    config: &Config,
    title: &str,
    author: &str,
) -> Vec<SourceData> {
    // Use the existing custom_providers module
    let results = crate::custom_providers::search_custom_providers(config, title, author).await;

    // Convert CustomProviderResult to SourceData
    results
        .into_iter()
        .map(|r| custom_provider_result_to_source_data(r))
        .filter(|s| s.has_data())
        .collect()
}

/// Convert CustomProviderResult to SourceData
fn custom_provider_result_to_source_data(result: crate::custom_providers::CustomProviderResult) -> SourceData {
    let mut source = SourceData::new(&result.provider_name, 75);

    source.title = result.title;
    source.subtitle = result.subtitle;
    source.authors = result.author.map(|a| vec![a]).unwrap_or_default();
    source.narrators = result.narrator.map(|n| vec![n]).unwrap_or_default();
    source.description = result.description;
    source.publisher = result.publisher;
    source.year = result.published_year;
    source.isbn = result.isbn;
    source.asin = result.asin;
    source.language = result.language;
    source.cover_url = result.cover;
    source.genres = result.genres;

    // Convert series entries
    source.series = result
        .series
        .into_iter()
        .filter_map(|s| {
            s.series.map(|name| SeriesEntry::new(name, s.sequence))
        })
        .collect();

    source
}

/// Convert initial BookGroup data to SourceData
pub fn book_group_to_source_data(
    title: Option<&str>,
    author: Option<&str>,
    narrator: Option<&str>,
    series: &[(String, Option<String>)],
    genres: &[String],
    description: Option<&str>,
) -> SourceData {
    let mut source = SourceData::new("initial", 80);

    source.title = title.map(|s| s.to_string());
    source.authors = author.map(|a| vec![a.to_string()]).unwrap_or_default();
    source.narrators = narrator.map(|n| vec![n.to_string()]).unwrap_or_default();
    source.series = series
        .iter()
        .map(|(name, seq)| SeriesEntry::new(name.clone(), seq.clone()))
        .collect();
    source.genres = genres.to_vec();
    source.description = description.map(|s| s.to_string());

    source
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_abs_item() {
        let json = serde_json::json!({
            "id": "test-id",
            "media": {
                "metadata": {
                    "title": "Test Book",
                    "subtitle": "A Subtitle",
                    "authors": [{"name": "John Smith"}],
                    "narrators": [{"name": "Jane Doe"}],
                    "series": [
                        {"name": "Test Series", "sequence": "1"}
                    ],
                    "genres": ["Fiction", "Fantasy"],
                    "description": "A test description",
                    "publisher": "Test Publisher",
                    "publishedYear": "2023",
                    "isbn": "1234567890",
                    "asin": "B0TEST",
                    "language": "English"
                }
            }
        });

        let source = parse_abs_item(&json);

        assert_eq!(source.source, "abs_api");
        assert_eq!(source.confidence, 85);
        assert_eq!(source.title, Some("Test Book".to_string()));
        assert_eq!(source.subtitle, Some("A Subtitle".to_string()));
        assert_eq!(source.authors, vec!["John Smith".to_string()]);
        assert_eq!(source.narrators, vec!["Jane Doe".to_string()]);
        assert_eq!(source.series.len(), 1);
        assert_eq!(source.series[0].name, "Test Series");
        assert_eq!(source.series[0].sequence, Some("1".to_string()));
        assert_eq!(source.genres, vec!["Fiction", "Fantasy"]);
        assert_eq!(source.description, Some("A test description".to_string()));
        assert_eq!(source.publisher, Some("Test Publisher".to_string()));
        assert_eq!(source.year, Some("2023".to_string()));
    }

    #[test]
    fn test_book_group_to_source_data() {
        let series = vec![
            ("Series One".to_string(), Some("1".to_string())),
            ("Series Two".to_string(), None),
        ];
        let genres = vec!["Fantasy".to_string(), "Adventure".to_string()];

        let source = book_group_to_source_data(
            Some("Test Book"),
            Some("Test Author"),
            Some("Test Narrator"),
            &series,
            &genres,
            Some("Test Description"),
        );

        assert_eq!(source.source, "initial");
        assert_eq!(source.confidence, 80);
        assert_eq!(source.title, Some("Test Book".to_string()));
        assert_eq!(source.authors, vec!["Test Author".to_string()]);
        assert_eq!(source.narrators, vec!["Test Narrator".to_string()]);
        assert_eq!(source.series.len(), 2);
        assert_eq!(source.genres, genres);
        assert_eq!(source.description, Some("Test Description".to_string()));
    }
}
