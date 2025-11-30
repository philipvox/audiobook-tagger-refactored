//! Text normalization utilities for audiobook metadata
//!
//! This module provides functions to clean and normalize metadata fields
//! like titles, author names, and narrator names.

use regex::Regex;
use std::collections::HashSet;

/// Words that should remain lowercase in titles (unless first/last word)
const LOWERCASE_WORDS: &[&str] = &[
    "a", "an", "the", "and", "but", "or", "nor", "for", "yet", "so",
    "at", "by", "in", "of", "on", "to", "up", "as", "is", "it",
    "if", "be", "vs", "via", "de", "la", "le", "el", "en", "et",
];

/// Common junk suffixes to remove from titles
const JUNK_SUFFIXES: &[&str] = &[
    "(Unabridged)",
    "[Unabridged]",
    "(Abridged)",
    "[Abridged]",
    "(Audiobook)",
    "[Audiobook]",
    "- Audiobook",
    "- Unabridged",
    "(Retail)",
    "[Retail]",
    "(MP3)",
    "[MP3]",
    "(M4B)",
    "[M4B]",
    "320kbps",
    "256kbps",
    "128kbps",
    "64kbps",
    "(HQ)",
    "[HQ]",
    "(Complete)",
    "[Complete]",
    "(Full Cast)",
    "[Full Cast]",
];

/// Prefixes that indicate narration info in titles
const NARRATOR_PREFIXES: &[&str] = &[
    "Read by",
    "Narrated by",
    "Performed by",
    "With",
];

/// Convert a title to proper title case
///
/// # Examples
/// ```
/// assert_eq!(to_title_case("the lord of the rings"), "The Lord of the Rings");
/// assert_eq!(to_title_case("A TALE OF TWO CITIES"), "A Tale of Two Cities");
/// ```
pub fn to_title_case(title: &str) -> String {
    let words: Vec<&str> = title.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }

    let lowercase_set: HashSet<&str> = LOWERCASE_WORDS.iter().copied().collect();

    let mut result: Vec<String> = Vec::new();
    for (i, word) in words.iter().enumerate() {
        let is_first = i == 0;
        let is_last = i == words.len() - 1;

        // Check if word is already properly capitalized (e.g., "iPhone", "NASA")
        if looks_like_proper_noun(word) || looks_like_acronym(word) {
            result.push(word.to_string());
            continue;
        }

        let lower = word.to_lowercase();

        if (is_first || is_last) || !lowercase_set.contains(lower.as_str()) {
            // Capitalize first letter
            result.push(capitalize_first(&lower));
        } else {
            result.push(lower);
        }
    }

    result.join(" ")
}

/// Capitalize the first letter of a word
fn capitalize_first(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

/// Check if a word looks like a proper noun (mixed case)
fn looks_like_proper_noun(word: &str) -> bool {
    if word.len() < 2 {
        return false;
    }

    // Check for camelCase or internal capitals (e.g., "iPhone", "McDonald")
    let has_internal_capital = word.chars().skip(1).any(|c| c.is_uppercase());
    let starts_uppercase = word.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);

    has_internal_capital || (starts_uppercase && word.chars().skip(1).any(|c| c.is_lowercase()))
}

/// Check if a word looks like an acronym (all caps, 2-5 chars)
fn looks_like_acronym(word: &str) -> bool {
    word.len() >= 2 &&
    word.len() <= 5 &&
    word.chars().all(|c| c.is_uppercase() || c.is_numeric())
}

/// Remove junk suffixes from a title
///
/// # Examples
/// ```
/// assert_eq!(remove_junk_suffixes("The Hobbit (Unabridged)"), "The Hobbit");
/// assert_eq!(remove_junk_suffixes("1984 [Audiobook] 320kbps"), "1984");
/// ```
pub fn remove_junk_suffixes(title: &str) -> String {
    let mut result = title.to_string();

    // Remove each junk suffix (case-insensitive)
    for suffix in JUNK_SUFFIXES {
        let suffix_lower = suffix.to_lowercase();
        loop {
            let lower = result.to_lowercase();
            if let Some(pos) = lower.rfind(&suffix_lower) {
                result = result[..pos].trim().to_string() + &result[pos + suffix.len()..];
                result = result.trim().to_string();
            } else {
                break;
            }
        }
    }

    // Remove trailing dashes
    result = result.trim_end_matches('-').trim().to_string();
    result = result.trim_end_matches('–').trim().to_string();

    result
}

/// Remove series information from a title
///
/// # Examples
/// ```
/// assert_eq!(strip_series_from_title("The Eye of the World (Wheel of Time #1)"), "The Eye of the World");
/// assert_eq!(strip_series_from_title("Harry Potter, Book 1"), "Harry Potter");
/// ```
pub fn strip_series_from_title(title: &str) -> String {
    let mut result = title.to_string();

    // Pattern: (Series Name #N) or (Series Name, Book N)
    if let Ok(re) = Regex::new(r"\s*\([^)]+(?:#\d+|Book\s*\d+|Vol\.?\s*\d+)\s*\)\s*$") {
        result = re.replace(&result, "").to_string();
    }

    // Pattern: [Series Name #N]
    if let Ok(re) = Regex::new(r"\s*\[[^\]]+(?:#\d+|Book\s*\d+|Vol\.?\s*\d+)\s*\]\s*$") {
        result = re.replace(&result, "").to_string();
    }

    // Pattern: Title, Book N or Title Book N
    if let Ok(re) = Regex::new(r",?\s*Book\s*\d+\s*$") {
        result = re.replace(&result, "").to_string();
    }

    // Pattern: Title #N at end
    if let Ok(re) = Regex::new(r"\s*#\d+\s*$") {
        result = re.replace(&result, "").to_string();
    }

    result.trim().to_string()
}

/// Extract subtitle from a title that contains both
///
/// # Returns
/// (title, subtitle) tuple
///
/// # Examples
/// ```
/// assert_eq!(extract_subtitle("Dune: The Desert Planet"), ("Dune", Some("The Desert Planet")));
/// assert_eq!(extract_subtitle("A Game of Thrones - Book One"), ("A Game of Thrones", Some("Book One")));
/// ```
pub fn extract_subtitle(title: &str) -> (String, Option<String>) {
    // Check for colon separator
    if let Some(pos) = title.find(':') {
        let main_title = title[..pos].trim();
        let subtitle = title[pos + 1..].trim();

        // Only treat as subtitle if it's substantial
        if !subtitle.is_empty() && subtitle.len() > 2 {
            return (main_title.to_string(), Some(subtitle.to_string()));
        }
    }

    // Check for dash/em-dash separator (only if not part of a hyphenated word)
    for sep in &[" - ", " – ", " — "] {
        if let Some(pos) = title.find(sep) {
            let main_title = title[..pos].trim();
            let subtitle = title[pos + sep.len()..].trim();

            // Only treat as subtitle if it's substantial and not a narrator credit
            if !subtitle.is_empty() &&
               subtitle.len() > 2 &&
               !NARRATOR_PREFIXES.iter().any(|p| subtitle.to_lowercase().starts_with(&p.to_lowercase())) {
                return (main_title.to_string(), Some(subtitle.to_string()));
            }
        }
    }

    (title.to_string(), None)
}

/// Clean an author name
///
/// - Removes "by", "written by" prefixes
/// - Normalizes name format
/// - Handles suffixes like "Jr.", "III"
pub fn clean_author_name(author: &str) -> String {
    let mut result = author.trim().to_string();

    // Remove common prefixes (case-insensitive)
    let prefixes = ["by ", "written by ", "author: "];
    for prefix in prefixes {
        if result.to_lowercase().starts_with(prefix) {
            result = result[prefix.len()..].trim().to_string();
        }
    }

    // Remove quotes
    result = result.trim_matches('"').trim_matches('\'').trim().to_string();

    // Handle "Last, First" format - convert to "First Last"
    if let Some(comma_pos) = result.find(',') {
        let last_name = result[..comma_pos].trim();
        let first_name = result[comma_pos + 1..].trim();

        // Check if it's actually a suffix like "Jr." or "III"
        let suffixes = ["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "phd", "md"];
        if !suffixes.contains(&first_name.to_lowercase().as_str()) {
            result = format!("{} {}", first_name, last_name);
        }
    }

    // Title case the name
    let words: Vec<String> = result
        .split_whitespace()
        .map(|w| {
            // Don't modify suffixes or particles
            let lower = w.to_lowercase();
            if ["de", "van", "von", "la", "le", "da", "di", "del", "jr.", "sr.", "ii", "iii", "iv"].contains(&lower.as_str()) {
                w.to_string()
            } else {
                capitalize_first(&lower)
            }
        })
        .collect();

    words.join(" ")
}

/// Clean a narrator name (same rules as author)
pub fn clean_narrator_name(narrator: &str) -> String {
    let mut result = narrator.trim().to_string();

    // Remove common prefixes
    let prefixes = ["read by ", "narrated by ", "performed by ", "narrator: "];
    for prefix in prefixes {
        if result.to_lowercase().starts_with(prefix) {
            result = result[prefix.len()..].trim().to_string();
        }
    }

    // Apply same cleaning as author
    clean_author_name(&result)
}

/// Clean and normalize a full title
///
/// Combines all title cleaning operations:
/// 1. Remove junk suffixes
/// 2. Strip series info
/// 3. Apply title case
/// 4. Trim whitespace
pub fn normalize_title(title: &str) -> String {
    let cleaned = remove_junk_suffixes(title);
    let no_series = strip_series_from_title(&cleaned);
    let title_cased = to_title_case(&no_series);
    title_cased.trim().to_string()
}

/// Validate and potentially fix a year value
///
/// Returns None if the year is invalid
pub fn validate_year(year: &str) -> Option<String> {
    // Try to parse as a number
    if let Ok(year_num) = year.trim().parse::<u32>() {
        // Must be a reasonable year
        if year_num >= 1800 && year_num <= 2100 {
            return Some(year_num.to_string());
        }
    }

    // Try to extract a 4-digit year from the string
    if let Ok(re) = Regex::new(r"(19|20)\d{2}") {
        if let Some(caps) = re.captures(year) {
            return Some(caps[0].to_string());
        }
    }

    None
}

/// Validate an author name
///
/// Returns false for obviously invalid names
pub fn is_valid_author(author: &str) -> bool {
    let lower = author.to_lowercase().trim().to_string();

    // Reject known bad values
    let invalid = [
        "unknown", "unknown author", "various", "various authors",
        "n/a", "na", "none", "author", "audiobook", "narrator",
    ];
    if invalid.contains(&lower.as_str()) {
        return false;
    }

    // Must contain at least one letter
    if !author.chars().any(|c| c.is_alphabetic()) {
        return false;
    }

    // Should be at least 2 characters
    if author.len() < 2 {
        return false;
    }

    true
}

/// Validate a narrator name
pub fn is_valid_narrator(narrator: &str) -> bool {
    // Same rules as author
    is_valid_author(narrator)
}

/// Normalize a description
///
/// - Remove excessive whitespace
/// - Remove HTML tags if present
/// - Trim length if too long
pub fn normalize_description(description: &str, max_length: Option<usize>) -> String {
    let mut result = description.to_string();

    // Remove HTML tags
    if let Ok(re) = Regex::new(r"<[^>]+>") {
        result = re.replace_all(&result, "").to_string();
    }

    // Decode common HTML entities
    result = result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("\\n", "\n")
        .replace("\\r", "");

    // Normalize whitespace
    if let Ok(re) = Regex::new(r"\s+") {
        result = re.replace_all(&result, " ").to_string();
    }

    // Trim
    result = result.trim().to_string();

    // Optionally truncate
    if let Some(max) = max_length {
        if result.len() > max {
            // Try to truncate at a sentence boundary
            if let Some(pos) = result[..max].rfind(". ") {
                result = result[..pos + 1].to_string();
            } else if let Some(pos) = result[..max].rfind(' ') {
                result = result[..pos].to_string() + "...";
            } else {
                result = result[..max].to_string() + "...";
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_title_case() {
        assert_eq!(to_title_case("the lord of the rings"), "The Lord of the Rings");
        assert_eq!(to_title_case("a tale of two cities"), "A Tale of Two Cities");
        assert_eq!(to_title_case("THE HOBBIT"), "The Hobbit");
        assert_eq!(to_title_case("war and peace"), "War and Peace");
    }

    #[test]
    fn test_remove_junk_suffixes() {
        assert_eq!(remove_junk_suffixes("The Hobbit (Unabridged)"), "The Hobbit");
        assert_eq!(remove_junk_suffixes("1984 [Audiobook] 320kbps"), "1984");
        assert_eq!(remove_junk_suffixes("Dune (Retail)"), "Dune");
    }

    #[test]
    fn test_strip_series_from_title() {
        assert_eq!(strip_series_from_title("The Eye of the World (Wheel of Time #1)"), "The Eye of the World");
        assert_eq!(strip_series_from_title("A Game of Thrones, Book 1"), "A Game of Thrones");
    }

    #[test]
    fn test_extract_subtitle() {
        assert_eq!(extract_subtitle("Dune: The Desert Planet"), ("Dune".to_string(), Some("The Desert Planet".to_string())));
        assert_eq!(extract_subtitle("Simple Title"), ("Simple Title".to_string(), None));
    }

    #[test]
    fn test_validate_year() {
        assert_eq!(validate_year("2020"), Some("2020".to_string()));
        assert_eq!(validate_year("1984"), Some("1984".to_string()));
        assert_eq!(validate_year("invalid"), None);
        assert_eq!(validate_year("Released in 2015"), Some("2015".to_string()));
    }

    #[test]
    fn test_is_valid_author() {
        assert!(is_valid_author("Stephen King"));
        assert!(is_valid_author("J.R.R. Tolkien"));
        assert!(!is_valid_author("Unknown"));
        assert!(!is_valid_author(""));
        assert!(!is_valid_author("12345"));
    }
}
