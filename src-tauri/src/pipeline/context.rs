// src-tauri/src/pipeline/context.rs
// CONTEXT stage - fetch other books in series for GPT context

use crate::config::Config;
use crate::pipeline::types::{SourceData, SeriesContextBook};

/// Extract all unique series names from source data
pub fn extract_series_names(sources: &[SourceData]) -> Vec<String> {
    let mut names: Vec<String> = sources
        .iter()
        .flat_map(|s| s.series.iter().map(|se| se.name.clone()))
        .collect();

    names.sort();
    names.dedup();
    names
}

/// Fetch other books in the same series from ABS library
pub async fn fetch_series_context(
    client: &reqwest::Client,
    config: &Config,
    series_names: &[String],
) -> Vec<SeriesContextBook> {
    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() || config.abs_library_id.is_empty() {
        return vec![];
    }
    let base_url = &config.abs_base_url;
    let token = &config.abs_api_token;
    let library_id = &config.abs_library_id;

    let mut context_books = Vec::new();

    for series_name in series_names {
        match fetch_series_books(client, base_url, token, library_id, series_name).await {
            Ok(books) => context_books.extend(books),
            Err(e) => println!("   ⚠ Failed to fetch series '{}': {}", series_name, e),
        }
    }

    // Deduplicate by title
    context_books.sort_by(|a, b| a.title.cmp(&b.title));
    context_books.dedup_by(|a, b| a.title == b.title);

    context_books
}

/// Fetch all books in a specific series from ABS
async fn fetch_series_books(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    library_id: &str,
    series_name: &str,
) -> Result<Vec<SeriesContextBook>, String> {
    // Search for books in this series
    let url = format!(
        "{}/api/libraries/{}/series?filter={}",
        base_url,
        library_id,
        urlencoding::encode(&format!("name:{}", series_name))
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Status {}", response.status()));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse failed: {}", e))?;

    let mut books = Vec::new();

    // Parse series results
    if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
        for series in results {
            // Check if this is the right series (exact match)
            let name = series
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("");

            if !name.eq_ignore_ascii_case(series_name) {
                continue;
            }

            // Get books in this series
            if let Some(series_books) = series.get("books").and_then(|b| b.as_array()) {
                for book in series_books {
                    let metadata = book
                        .get("media")
                        .and_then(|m| m.get("metadata"))
                        .unwrap_or(book);

                    let title = metadata
                        .get("title")
                        .and_then(|t| t.as_str())
                        .unwrap_or("Unknown")
                        .to_string();

                    let author = metadata
                        .get("authorName")
                        .and_then(|a| a.as_str())
                        .or_else(|| {
                            metadata
                                .get("authors")
                                .and_then(|a| a.as_array())
                                .and_then(|arr| arr.first())
                                .and_then(|a| a.get("name"))
                                .and_then(|n| n.as_str())
                        })
                        .unwrap_or("Unknown")
                        .to_string();

                    // Find sequence for this specific series
                    let sequence = book
                        .get("sequence")
                        .and_then(|s| {
                            s.as_str()
                                .map(|v| v.to_string())
                                .or_else(|| s.as_f64().map(|n| n.to_string()))
                        });

                    books.push(SeriesContextBook {
                        title,
                        sequence,
                        author,
                        series_name: name.to_string(),
                    });
                }
            }
        }
    }

    // Also try searching the library directly for series items
    if books.is_empty() {
        books = fetch_series_via_search(client, base_url, token, library_id, series_name).await?;
    }

    Ok(books)
}

/// Alternative: Search library for books with matching series
async fn fetch_series_via_search(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    library_id: &str,
    series_name: &str,
) -> Result<Vec<SeriesContextBook>, String> {
    let url = format!(
        "{}/api/libraries/{}/items?filter=series.{}",
        base_url,
        library_id,
        urlencoding::encode(series_name)
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Search request failed: {}", e))?;

    if !response.status().is_success() {
        return Ok(vec![]); // Not all ABS versions support this filter
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse failed: {}", e))?;

    let mut books = Vec::new();

    if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
        for item in results {
            let metadata = item
                .get("media")
                .and_then(|m| m.get("metadata"))
                .unwrap_or(item);

            let title = metadata
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("Unknown")
                .to_string();

            let author = metadata
                .get("authorName")
                .and_then(|a| a.as_str())
                .unwrap_or("Unknown")
                .to_string();

            // Find sequence from series array
            let sequence = metadata
                .get("series")
                .and_then(|s| s.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|s| {
                            s.get("name")
                                .and_then(|n| n.as_str())
                                .map(|n| n.eq_ignore_ascii_case(series_name))
                                .unwrap_or(false)
                        })
                        .and_then(|s| {
                            s.get("sequence").and_then(|sq| {
                                sq.as_str()
                                    .map(|v| v.to_string())
                                    .or_else(|| sq.as_f64().map(|n| n.to_string()))
                            })
                        })
                });

            books.push(SeriesContextBook {
                title,
                sequence,
                author,
                series_name: series_name.to_string(),
            });
        }
    }

    Ok(books)
}

/// Get series context as a formatted string for GPT prompt
pub fn format_series_context(books: &[SeriesContextBook]) -> String {
    if books.is_empty() {
        return String::new();
    }

    let mut output = String::from("Other books in the series (from your library):\n");

    // Group by series
    let mut by_series: std::collections::HashMap<&str, Vec<&SeriesContextBook>> =
        std::collections::HashMap::new();

    for book in books {
        by_series
            .entry(&book.series_name)
            .or_default()
            .push(book);
    }

    for (series_name, mut series_books) in by_series {
        output.push_str(&format!("\n{} series:\n", series_name));

        // Sort by sequence
        series_books.sort_by(|a, b| {
            let seq_a = a.sequence.as_ref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(999.0);
            let seq_b = b.sequence.as_ref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(999.0);
            seq_a.partial_cmp(&seq_b).unwrap_or(std::cmp::Ordering::Equal)
        });

        for book in series_books {
            let seq = book.sequence.as_deref().unwrap_or("?");
            output.push_str(&format!("  #{} - {} by {}\n", seq, book.title, book.author));
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::types::SeriesEntry;

    #[test]
    fn test_extract_series_names() {
        let sources = vec![
            SourceData {
                source: "a".to_string(),
                confidence: 90,
                series: vec![
                    SeriesEntry::new("Series A".to_string(), Some("1".to_string())),
                    SeriesEntry::new("Series B".to_string(), None),
                ],
                ..Default::default()
            },
            SourceData {
                source: "b".to_string(),
                confidence: 80,
                series: vec![
                    SeriesEntry::new("Series A".to_string(), Some("1".to_string())), // Duplicate
                    SeriesEntry::new("Series C".to_string(), None),
                ],
                ..Default::default()
            },
        ];

        let names = extract_series_names(&sources);
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"Series A".to_string()));
        assert!(names.contains(&"Series B".to_string()));
        assert!(names.contains(&"Series C".to_string()));
    }

    #[test]
    fn test_format_series_context() {
        let books = vec![
            SeriesContextBook {
                title: "Book One".to_string(),
                sequence: Some("1".to_string()),
                author: "Author".to_string(),
                series_name: "Test Series".to_string(),
            },
            SeriesContextBook {
                title: "Book Two".to_string(),
                sequence: Some("2".to_string()),
                author: "Author".to_string(),
                series_name: "Test Series".to_string(),
            },
        ];

        let formatted = format_series_context(&books);
        assert!(formatted.contains("Test Series series:"));
        assert!(formatted.contains("#1 - Book One"));
        assert!(formatted.contains("#2 - Book Two"));
    }

    #[test]
    fn test_format_series_context_empty() {
        let books: Vec<SeriesContextBook> = vec![];
        let formatted = format_series_context(&books);
        assert!(formatted.is_empty());
    }
}
