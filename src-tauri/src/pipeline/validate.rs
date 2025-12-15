// src-tauri/src/pipeline/validate.rs
// VALIDATE stage - catch GPT mistakes, ensure data quality

use crate::pipeline::types::{AggregatedBookData, ResolvedMetadata, ResolvedSeries};

/// Validate and clean GPT output
pub fn validate_metadata(
    mut resolved: ResolvedMetadata,
    original: &AggregatedBookData,
) -> Result<ResolvedMetadata, String> {
    // Collect warnings
    let mut warnings = Vec::new();

    // 1. Title validation
    resolved.title = validate_title(&resolved.title, original, &mut warnings);

    // 2. Author validation
    resolved.author = validate_author(&resolved.author, &resolved.authors, original, &mut warnings);

    // 3. Series validation
    resolved.series = validate_series(&resolved.series, &resolved.title, original, &mut warnings);

    // 4. Ensure authors array matches author field
    if resolved.authors.is_empty() && !resolved.author.is_empty() && resolved.author != "Unknown" {
        resolved.authors = vec![resolved.author.clone()];
    }

    // 5. Ensure narrators array matches narrator field
    if resolved.narrators.is_empty() {
        if let Some(ref narrator) = resolved.narrator {
            resolved.narrators = vec![narrator.clone()];
        }
    }

    // 6. Clean up genres
    resolved.genres = validate_genres(&resolved.genres);

    // 7. Clean description
    if let Some(ref desc) = resolved.description {
        resolved.description = Some(clean_description(desc));
    }

    // 8. Validate year
    if let Some(ref year) = resolved.year {
        if !is_valid_year(year) {
            warnings.push(format!("Invalid year '{}', removing", year));
            resolved.year = None;
        }
    }

    // Log warnings
    for warning in &warnings {
        println!("   ⚠ Validation: {}", warning);
    }

    // Add warnings to reasoning
    if !warnings.is_empty() {
        let warning_text = format!("\nValidation warnings: {}", warnings.join("; "));
        resolved.reasoning = Some(
            resolved
                .reasoning
                .map(|r| format!("{}{}", r, warning_text))
                .unwrap_or(warning_text),
        );
    }

    Ok(resolved)
}

/// Validate and clean title
fn validate_title(
    title: &str,
    original: &AggregatedBookData,
    warnings: &mut Vec<String>,
) -> String {
    let mut clean = title.trim().to_string();

    // Remove common file artifacts
    let artifacts = [
        "_mp3", ".mp3", "_m4b", ".m4b", "_m4a", ".m4a",
        "[Unabridged]", "(Unabridged)", "[unabridged]",
        "[Abridged]", "(Abridged)",
        " - Audiobook", " (Audiobook)", " [Audiobook]",
    ];

    for artifact in &artifacts {
        if clean.contains(artifact) {
            warnings.push(format!("Removed artifact '{}' from title", artifact));
            clean = clean.replace(artifact, "").trim().to_string();
        }
    }

    // If GPT returned something weird, fall back to original
    if clean.is_empty() || clean == "Unknown" {
        if let Some(original_title) = original.best_title() {
            warnings.push("GPT title was empty, using original".to_string());
            return original_title;
        }
    }

    // Check for suspiciously short titles (likely extraction errors)
    if clean.len() < 2 {
        if let Some(original_title) = original.best_title() {
            warnings.push(format!(
                "Title '{}' too short, using original",
                clean
            ));
            return original_title;
        }
    }

    clean
}

/// Validate and clean author
fn validate_author(
    author: &str,
    authors: &[String],
    original: &AggregatedBookData,
    warnings: &mut Vec<String>,
) -> String {
    let clean = author.trim();

    // Check for invalid author values
    let invalid = ["Unknown", "Various", "N/A", "", "null", "undefined"];
    if invalid.iter().any(|i| clean.eq_ignore_ascii_case(i)) {
        // Try to get from authors array
        if let Some(first) = authors.first().filter(|a| !invalid.iter().any(|i| a.eq_ignore_ascii_case(i))) {
            warnings.push(format!("Author '{}' invalid, using '{}'", author, first));
            return first.clone();
        }

        // Fall back to original
        if let Some(original_author) = original.best_author() {
            warnings.push(format!("Author '{}' invalid, using original", author));
            return original_author;
        }
    }

    // Check for narrator in author field (common GPT mistake)
    let narrator_indicators = ["narrated by", "read by", "performed by"];
    let lower = clean.to_lowercase();
    if narrator_indicators.iter().any(|ind| lower.contains(ind)) {
        warnings.push(format!("Author '{}' contains narrator info", author));
        // Try to extract just the author part
        for ind in &narrator_indicators {
            if let Some(idx) = lower.find(ind) {
                let author_part = clean[..idx].trim();
                if !author_part.is_empty() {
                    return author_part.to_string();
                }
            }
        }
    }

    clean.to_string()
}

/// Validate series entries
fn validate_series(
    series: &[ResolvedSeries],
    title: &str,
    original: &AggregatedBookData,
    warnings: &mut Vec<String>,
) -> Vec<ResolvedSeries> {
    let title_lower = title.to_lowercase();
    let title_normalized = normalize_for_comparison(title);

    let mut validated: Vec<ResolvedSeries> = series
        .iter()
        .filter(|s| {
            // Skip empty names
            if s.name.trim().is_empty() {
                warnings.push("Removed empty series name".to_string());
                return false;
            }

            // Skip series that are just the title (common GPT mistake)
            let series_normalized = normalize_for_comparison(&s.name);
            if series_normalized == title_normalized {
                // Check if it's a short title (like "Tempest")
                let word_count = title_normalized.split_whitespace().count();
                let is_short_title = word_count <= 2 && title_normalized.len() < 20;

                if is_short_title {
                    warnings.push(format!(
                        "Rejected series '{}' - matches short title",
                        s.name
                    ));
                    return false;
                }

                // Allow for longer titles like "Dungeon Crawler Carl" if has sequence
                if s.sequence.is_none() {
                    warnings.push(format!(
                        "Rejected series '{}' - matches title without sequence",
                        s.name
                    ));
                    return false;
                }
            }

            // Skip obviously invalid series names
            let invalid_series = [
                "audiobook", "unabridged", "abridged", "book", "novel",
                "fiction", "nonfiction", "audio", "mp3", "m4b",
            ];
            let lower = s.name.to_lowercase();
            if invalid_series.iter().any(|inv| lower == *inv) {
                warnings.push(format!("Rejected invalid series name '{}'", s.name));
                return false;
            }

            // Validate sequence format
            if let Some(ref seq) = s.sequence {
                if !is_valid_sequence(seq) {
                    warnings.push(format!(
                        "Series '{}' has invalid sequence '{}', removing sequence",
                        s.name, seq
                    ));
                    // Don't filter out, just note the warning
                }
            }

            true
        })
        .cloned()
        .map(|mut s| {
            // Clean up sequence
            if let Some(ref seq) = s.sequence {
                if !is_valid_sequence(seq) {
                    s.sequence = extract_sequence_number(seq);
                }
            }
            s
        })
        .collect();

    // If we filtered out all series but original had some, use original
    if validated.is_empty() && !original.all_series_names().is_empty() {
        warnings.push("All GPT series rejected, keeping original series names".to_string());
        // Recreate from original
        for source in &original.sources {
            for se in &source.series {
                let normalized = normalize_for_comparison(&se.name);
                if normalized != title_normalized {
                    validated.push(ResolvedSeries {
                        name: se.name.clone(),
                        sequence: se.sequence.clone(),
                        is_primary: validated.is_empty(),
                        is_subseries_of: None,
                    });
                }
            }
        }
        // Dedupe
        validated.sort_by(|a, b| a.name.cmp(&b.name));
        validated.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    }

    // Ensure at least one is marked primary
    if !validated.is_empty() && !validated.iter().any(|s| s.is_primary) {
        validated[0].is_primary = true;
    }

    validated
}

/// Validate and clean genres
fn validate_genres(genres: &[String]) -> Vec<String> {
    let invalid = [
        "audiobook", "audio book", "book", "ebook", "e-book",
        "fiction", "nonfiction", "non-fiction", // Too generic
    ];

    genres
        .iter()
        .filter(|g| {
            let lower = g.to_lowercase();
            !invalid.iter().any(|inv| lower == *inv)
        })
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
        .take(5)
        .collect()
}

/// Clean HTML and formatting from description
fn clean_description(desc: &str) -> String {
    let mut clean = desc.to_string();

    // Remove HTML tags
    let tag_re = regex::Regex::new(r"<[^>]+>").unwrap();
    clean = tag_re.replace_all(&clean, "").to_string();

    // Fix common HTML entities
    clean = clean
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");

    // Normalize whitespace
    let ws_re = regex::Regex::new(r"\s+").unwrap();
    clean = ws_re.replace_all(&clean, " ").trim().to_string();

    clean
}

/// Check if year is valid
fn is_valid_year(year: &str) -> bool {
    year.parse::<u32>()
        .map(|y| y >= 1800 && y <= 2100)
        .unwrap_or(false)
}

/// Check if sequence is valid format
fn is_valid_sequence(seq: &str) -> bool {
    // Valid: "1", "2.5", "0.5", "10", "1.0"
    // Invalid: "Book 1", "Volume 2", "Part One"
    let trimmed = seq.trim();

    // Pure number
    if trimmed.parse::<f64>().is_ok() {
        return true;
    }

    // Range like "1-2" or "1,2"
    if trimmed.contains('-') || trimmed.contains(',') {
        let parts: Vec<&str> = trimmed.split(&['-', ','][..]).collect();
        return parts.iter().all(|p| p.trim().parse::<f64>().is_ok());
    }

    false
}

/// Try to extract a number from a sequence string
fn extract_sequence_number(seq: &str) -> Option<String> {
    let num_re = regex::Regex::new(r"(\d+(?:\.\d+)?)").unwrap();
    num_re
        .captures(seq)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Normalize string for comparison
fn normalize_for_comparison(s: &str) -> String {
    s.to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && !c.is_whitespace(), "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::types::{SourceData, SeriesEntry};

    fn make_original(title: &str, author: &str) -> AggregatedBookData {
        AggregatedBookData {
            id: "test".to_string(),
            sources: vec![SourceData {
                source: "test".to_string(),
                confidence: 90,
                title: Some(title.to_string()),
                authors: vec![author.to_string()],
                ..Default::default()
            }],
            series_context: vec![],
        }
    }

    #[test]
    fn test_validate_title_removes_artifacts() {
        let original = make_original("Test Book", "Author");
        let mut warnings = vec![];

        let result = validate_title("Test Book [Unabridged]", &original, &mut warnings);
        assert_eq!(result, "Test Book");
        assert!(!warnings.is_empty());
    }

    #[test]
    fn test_validate_title_fallback() {
        let original = make_original("Original Title", "Author");
        let mut warnings = vec![];

        let result = validate_title("", &original, &mut warnings);
        assert_eq!(result, "Original Title");
    }

    #[test]
    fn test_validate_author_invalid() {
        let original = make_original("Book", "Original Author");
        let mut warnings = vec![];

        let result = validate_author("Unknown", &[], &original, &mut warnings);
        assert_eq!(result, "Original Author");
    }

    #[test]
    fn test_validate_author_narrator_in_field() {
        let original = make_original("Book", "Real Author");
        let mut warnings = vec![];

        let result = validate_author("John Smith narrated by Jane Doe", &[], &original, &mut warnings);
        assert_eq!(result, "John Smith");
    }

    #[test]
    fn test_validate_series_rejects_title_match() {
        let original = make_original("Tempest", "Author");
        let mut warnings = vec![];

        let series = vec![ResolvedSeries {
            name: "Tempest".to_string(),
            sequence: Some("1".to_string()),
            is_primary: true,
            is_subseries_of: None,
        }];

        let result = validate_series(&series, "Tempest", &original, &mut warnings);
        assert!(result.is_empty()); // Should be rejected - short title
    }

    #[test]
    fn test_validate_series_allows_long_title() {
        let original = make_original("Dungeon Crawler Carl", "Author");
        let mut warnings = vec![];

        let series = vec![ResolvedSeries {
            name: "Dungeon Crawler Carl".to_string(),
            sequence: Some("1".to_string()),
            is_primary: true,
            is_subseries_of: None,
        }];

        let result = validate_series(&series, "Dungeon Crawler Carl", &original, &mut warnings);
        assert_eq!(result.len(), 1); // Should be allowed - long title with sequence
    }

    #[test]
    fn test_validate_series_rejects_invalid_names() {
        let original = make_original("Book", "Author");
        let mut warnings = vec![];

        let series = vec![
            ResolvedSeries {
                name: "Audiobook".to_string(),
                sequence: None,
                is_primary: false,
                is_subseries_of: None,
            },
            ResolvedSeries {
                name: "Valid Series".to_string(),
                sequence: Some("1".to_string()),
                is_primary: true,
                is_subseries_of: None,
            },
        ];

        let result = validate_series(&series, "Book", &original, &mut warnings);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Valid Series");
    }

    #[test]
    fn test_is_valid_sequence() {
        assert!(is_valid_sequence("1"));
        assert!(is_valid_sequence("2.5"));
        assert!(is_valid_sequence("10"));
        assert!(is_valid_sequence("1-2"));

        assert!(!is_valid_sequence("Book 1"));
        assert!(!is_valid_sequence("Volume Two"));
        assert!(!is_valid_sequence("Part One"));
    }

    #[test]
    fn test_extract_sequence_number() {
        assert_eq!(extract_sequence_number("Book 1"), Some("1".to_string()));
        assert_eq!(extract_sequence_number("Volume 2.5"), Some("2.5".to_string()));
        assert_eq!(extract_sequence_number("Part 10"), Some("10".to_string()));
        assert_eq!(extract_sequence_number("One"), None);
    }

    #[test]
    fn test_clean_description() {
        let desc = "<p>This is a <b>test</b> description.</p>&nbsp;&amp;";
        let clean = clean_description(desc);
        assert_eq!(clean, "This is a test description. &");
    }

    #[test]
    fn test_validate_genres() {
        let genres = vec![
            "Fantasy".to_string(),
            "Audiobook".to_string(), // Should be removed
            "Adventure".to_string(),
            "Fiction".to_string(), // Should be removed
            "Sci-Fi".to_string(),
        ];

        let result = validate_genres(&genres);
        assert_eq!(result, vec!["Fantasy", "Adventure", "Sci-Fi"]);
    }

    #[test]
    fn test_is_valid_year() {
        assert!(is_valid_year("2023"));
        assert!(is_valid_year("1999"));
        assert!(is_valid_year("1800"));

        assert!(!is_valid_year("999"));
        assert!(!is_valid_year("2200"));
        assert!(!is_valid_year("not a year"));
    }
}
