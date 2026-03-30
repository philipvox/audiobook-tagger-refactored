//! Title validation and cleaning.
//!
//! Cleans book titles by removing junk like format descriptors,
//! ASINs, narrator info, and other metadata embedded in titles.

use once_cell::sync::Lazy;
use regex::Regex;

// ============================================================================
// REGEX PATTERNS
// ============================================================================

/// All patterns that should be removed from titles
static TITLE_JUNK_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        // Format descriptors
        Regex::new(r"(?i)\[?unabridged\]?").unwrap(),
        Regex::new(r"(?i)\[?abridged\]?").unwrap(),
        Regex::new(r"(?i)\[?mp3\]?").unwrap(),
        Regex::new(r"(?i)_mp3$").unwrap(),
        Regex::new(r"(?i)\[?m4b\]?").unwrap(),
        Regex::new(r"(?i)\(\d+kbps\)").unwrap(),
        Regex::new(r"(?i)\[\d+kbps\]").unwrap(),
        // Audible/ASIN markers
        Regex::new(r"(?i)\[asin[:\s]*[a-z0-9]+\]").unwrap(),
        Regex::new(r"(?i)\(asin[:\s]*[a-z0-9]+\)").unwrap(),
        Regex::new(r"(?i)\[audible\]").unwrap(),
        Regex::new(r"(?i)\(audible\)").unwrap(),
        Regex::new(r"(?i)\s+-\s+audiobook$").unwrap(),
        Regex::new(r"(?i)\s+audiobook$").unwrap(),
        // Narrator info embedded in title
        Regex::new(r"(?i)\s+read by .+$").unwrap(),
        Regex::new(r"(?i)\s+narrated by .+$").unwrap(),
        Regex::new(r"(?i)\s+performed by .+$").unwrap(),
        // Recording info
        Regex::new(r"(?i)\s*\[recorded \d{4}\]").unwrap(),
        Regex::new(r"(?i)\s*\(recorded \d{4}\)").unwrap(),
        // Edition markers (be careful - some are meaningful)
        Regex::new(r"(?i)\s*\[kindle edition\]").unwrap(),
        Regex::new(r"(?i)\s*\(kindle edition\)").unwrap(),
        // Publisher artifacts
        Regex::new(r"(?i)\s*\[recorded books\]").unwrap(),
        Regex::new(r"(?i)\s*\(recorded books\)").unwrap(),
    ]
});

/// Matches series info embedded in title like "Title (Series Name #3)"
static SERIES_IN_TITLE_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\s*\([^)]+(?:#|Book|Vol\.?|Part)\s*\d+(?:\.\d+)?\)$").unwrap()
});

/// Matches series info in brackets like "Title [Series Name, Book 3]"
static SERIES_IN_BRACKETS_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\s*\[[^\]]+(?:#|Book|Vol\.?|Part)\s*\d+(?:\.\d+)?\]$").unwrap()
});

/// Matches book number at the end like "Title Book 3" or "Title #3"
static BOOK_NUMBER_SUFFIX_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\s*[-–—,]?\s*(?:Book|Part|Vol\.?|Volume|#)\s*(\d+(?:\.\d+)?)\s*$").unwrap()
});

/// Matches book number at the start like "1. Title" or "01 - Title"
static BOOK_NUMBER_PREFIX_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(\d+)\s*[-–—.:]\s*").unwrap()
});

/// Matches series prefix like "Series Name: Title"
static SERIES_PREFIX_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^([^:]+):\s*(.+)$").unwrap()
});

/// Matches multiple spaces
static MULTIPLE_SPACES: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\s{2,}").unwrap()
});

// ============================================================================
// CLEANING FUNCTIONS
// ============================================================================

/// Cleans a book title by removing junk patterns.
///
/// This removes:
/// - Format descriptors (unabridged, mp3, kbps, etc.)
/// - ASIN markers
/// - Narrator info
/// - Publisher artifacts
pub fn clean_title(title: &str) -> String {
    let mut result = title.trim().to_string();

    // Apply all junk patterns
    for pattern in TITLE_JUNK_PATTERNS.iter() {
        result = pattern.replace_all(&result, "").trim().to_string();
    }

    // Clean up multiple spaces
    result = MULTIPLE_SPACES.replace_all(&result, " ").trim().to_string();

    // Clean up trailing punctuation left behind
    result = result.trim_end_matches(&['-', '–', '—', ',', ';', ':'][..]).trim().to_string();

    result
}

/// Removes book number from title, returning the number if found.
///
/// Handles patterns like:
/// - "Title Book 3" -> ("Title", Some(3.0))
/// - "Title #3" -> ("Title", Some(3.0))
/// - "3. Title" -> ("Title", Some(3.0))
pub fn remove_book_number(title: &str) -> (String, Option<f32>) {
    let title = title.trim();

    // Try suffix first (more common)
    if let Some(caps) = BOOK_NUMBER_SUFFIX_PATTERN.captures(title) {
        if let Some(num_match) = caps.get(1) {
            if let Ok(num) = num_match.as_str().parse::<f32>() {
                let clean_title = BOOK_NUMBER_SUFFIX_PATTERN
                    .replace(title, "")
                    .trim()
                    .to_string();
                return (clean_title, Some(num));
            }
        }
    }

    // Try prefix
    if let Some(caps) = BOOK_NUMBER_PREFIX_PATTERN.captures(title) {
        if let Some(num_match) = caps.get(1) {
            if let Ok(num) = num_match.as_str().parse::<f32>() {
                let clean_title = BOOK_NUMBER_PREFIX_PATTERN
                    .replace(title, "")
                    .trim()
                    .to_string();
                return (clean_title, Some(num));
            }
        }
    }

    (title.to_string(), None)
}

/// Removes series info from title if embedded.
///
/// Handles patterns like:
/// - "Title (Series Name #3)" -> "Title"
/// - "Title [Series, Book 3]" -> "Title"
pub fn remove_series_from_title(title: &str) -> String {
    let mut result = title.trim().to_string();

    // Remove parenthetical series info
    result = SERIES_IN_TITLE_PATTERN
        .replace(&result, "")
        .trim()
        .to_string();

    // Remove bracketed series info
    result = SERIES_IN_BRACKETS_PATTERN
        .replace(&result, "")
        .trim()
        .to_string();

    result
}

/// Extracts series name from title if present as prefix.
///
/// Handles pattern like "Series Name: Title" -> Some("Series Name")
pub fn extract_series_prefix(title: &str) -> Option<String> {
    if let Some(caps) = SERIES_PREFIX_PATTERN.captures(title) {
        if let Some(prefix) = caps.get(1) {
            let series_candidate = prefix.as_str().trim();
            // Only return if it looks like a series name (not too long, no weird chars)
            if series_candidate.len() > 2
                && series_candidate.len() < 50
                && !series_candidate.contains('\n')
            {
                return Some(series_candidate.to_string());
            }
        }
    }
    None
}

/// Extracts the main title when series prefix is present.
///
/// Handles pattern like "Series Name: Title" -> "Title"
pub fn extract_main_title(title: &str) -> String {
    if let Some(caps) = SERIES_PREFIX_PATTERN.captures(title) {
        if let Some(main) = caps.get(2) {
            return main.as_str().trim().to_string();
        }
    }
    title.trim().to_string()
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_title_unabridged() {
        assert_eq!(clean_title("The Great Book [Unabridged]"), "The Great Book");
        assert_eq!(clean_title("The Great Book (Unabridged)"), "The Great Book");
    }

    #[test]
    fn test_clean_title_mp3() {
        assert_eq!(clean_title("The Book [mp3]"), "The Book");
        assert_eq!(clean_title("The Book_mp3"), "The Book");
    }

    #[test]
    fn test_clean_title_bitrate() {
        assert_eq!(clean_title("The Book (128kbps)"), "The Book");
        assert_eq!(clean_title("The Book [64kbps]"), "The Book");
    }

    #[test]
    fn test_clean_title_asin() {
        assert_eq!(clean_title("The Book [ASIN: B01ABC123]"), "The Book");
        assert_eq!(clean_title("The Book (asin:B01ABC123)"), "The Book");
    }

    #[test]
    fn test_clean_title_narrator() {
        assert_eq!(
            clean_title("The Book read by John Smith"),
            "The Book"
        );
        assert_eq!(
            clean_title("The Book narrated by Jane Doe"),
            "The Book"
        );
    }

    #[test]
    fn test_clean_title_audiobook() {
        assert_eq!(clean_title("The Book - Audiobook"), "The Book");
        assert_eq!(clean_title("The Book Audiobook"), "The Book");
    }

    #[test]
    fn test_clean_title_multiple_patterns() {
        assert_eq!(
            clean_title("The Book [Unabridged] [mp3] read by John Smith"),
            "The Book"
        );
    }

    #[test]
    fn test_remove_book_number_suffix() {
        let (title, num) = remove_book_number("The Book Book 3");
        assert_eq!(title, "The Book");
        assert_eq!(num, Some(3.0));
    }

    #[test]
    fn test_remove_book_number_hash() {
        let (title, num) = remove_book_number("The Book #5");
        assert_eq!(title, "The Book");
        assert_eq!(num, Some(5.0));
    }

    #[test]
    fn test_remove_book_number_decimal() {
        let (title, num) = remove_book_number("The Book Book 2.5");
        assert_eq!(title, "The Book");
        assert_eq!(num, Some(2.5));
    }

    #[test]
    fn test_remove_book_number_prefix() {
        let (title, num) = remove_book_number("1. The Book");
        assert_eq!(title, "The Book");
        assert_eq!(num, Some(1.0));
    }

    #[test]
    fn test_remove_book_number_none() {
        let (title, num) = remove_book_number("The Book");
        assert_eq!(title, "The Book");
        assert_eq!(num, None);
    }

    #[test]
    fn test_remove_series_from_title_parens() {
        assert_eq!(
            remove_series_from_title("The Book (Great Series #3)"),
            "The Book"
        );
    }

    #[test]
    fn test_remove_series_from_title_brackets() {
        assert_eq!(
            remove_series_from_title("The Book [Series, Book 5]"),
            "The Book"
        );
    }

    #[test]
    fn test_extract_series_prefix() {
        assert_eq!(
            extract_series_prefix("The Expanse: Leviathan Wakes"),
            Some("The Expanse".to_string())
        );
    }

    #[test]
    fn test_extract_series_prefix_none() {
        assert_eq!(extract_series_prefix("Just a Title"), None);
    }

    #[test]
    fn test_extract_main_title() {
        assert_eq!(
            extract_main_title("The Expanse: Leviathan Wakes"),
            "Leviathan Wakes"
        );
    }
}
