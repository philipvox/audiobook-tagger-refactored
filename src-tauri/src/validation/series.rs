//! Series validation and normalization.
//!
//! Validates series names before GPT calls to catch obvious errors
//! like publishers, author names misused as series, and foreign language patterns.

use once_cell::sync::Lazy;
use regex::Regex;

use super::lookups::{
    AUTHOR_AS_SERIES, DISCWORLD_ORPHANS, INVALID_SERIES, SERIES_CANONICAL, SERIES_OWNERSHIP,
    VALID_CHARACTER_SERIES,
};
use super::{ValidationAction, ValidationResult};

// ============================================================================
// REGEX PATTERNS
// ============================================================================

/// Turkish series patterns
static TURKISH_SERIES_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(dizisi|serisi|kitaplari|kitapları)\b").unwrap()
});

/// German series patterns
static GERMAN_SERIES_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(sammlung|reihe|band)\b").unwrap()
});

/// French series patterns
static FRENCH_SERIES_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(petits meurtres|collection)\b").unwrap()
});

/// Spanish series patterns
static SPANISH_SERIES_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(serie|colección|coleccion)\b").unwrap()
});

/// Generic "Book N" or "Part N" patterns
static BOOK_NUMBER_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(book|part|volume|vol\.?|issue)\s*#?\d+$").unwrap()
});

/// Matches just a number
static JUST_NUMBER_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^#?\d+(\.\d+)?$").unwrap()
});

/// Matches format descriptors embedded in series names
static FORMAT_IN_SERIES_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(unabridged|abridged|audiobook|audio|mp3|m4b)\b").unwrap()
});

/// Matches series names that are just parenthetical info
static PARENTHETICAL_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\([^)]+\)$").unwrap()
});

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/// Quick rejection check for series that are obviously invalid.
/// Use this before expensive processing.
pub fn quick_reject_series(series: &str) -> bool {
    let lower = series.to_lowercase().trim().to_string();

    // Empty or too short
    if lower.len() < 2 {
        return true;
    }

    // Just a number
    if JUST_NUMBER_PATTERN.is_match(&lower) {
        return true;
    }

    // Just "Book N" etc
    if BOOK_NUMBER_PATTERN.is_match(&lower) {
        return true;
    }

    // In invalid series set
    if INVALID_SERIES.contains(lower.as_str()) {
        return true;
    }

    // Is an author name
    if AUTHOR_AS_SERIES.contains(lower.as_str()) {
        return true;
    }

    // Foreign language patterns (likely non-English metadata)
    if TURKISH_SERIES_PATTERN.is_match(&lower) {
        return true;
    }
    if GERMAN_SERIES_PATTERN.is_match(&lower) {
        return true;
    }
    if FRENCH_SERIES_PATTERN.is_match(&lower) {
        return true;
    }
    if SPANISH_SERIES_PATTERN.is_match(&lower) {
        return true;
    }

    // Format descriptors
    if FORMAT_IN_SERIES_PATTERN.is_match(&lower) {
        return true;
    }

    // Just parenthetical info
    if PARENTHETICAL_PATTERN.is_match(series.trim()) {
        return true;
    }

    false
}

/// Validates a series name, optionally checking author ownership.
///
/// This function checks:
/// 1. Against known invalid series
/// 2. Author names incorrectly used as series
/// 3. Foreign language patterns
/// 4. Canonical name mappings
/// 5. Series-author ownership (if author provided)
pub fn validate_series(series: &str, author: Option<&str>) -> ValidationResult<String> {
    let original = series.to_string();
    let working = series.trim();

    // Empty check
    if working.is_empty() {
        return ValidationResult {
            value: None,
            original,
            action: ValidationAction::Rejected,
            reason: Some("Empty series name".to_string()),
        };
    }

    let lookup_key = working.to_lowercase();

    // Quick rejection
    if quick_reject_series(working) {
        let reason = determine_rejection_reason(working);
        return ValidationResult {
            value: None,
            original,
            action: ValidationAction::Rejected,
            reason: Some(reason),
        };
    }

    // Check for Discworld orphan subseries
    if DISCWORLD_ORPHANS.contains(lookup_key.as_str()) {
        return ValidationResult {
            value: None,
            original,
            action: ValidationAction::Rejected,
            reason: Some(format!(
                "Discworld subseries '{}' invalid without parent",
                working
            )),
        };
    }

    // Check canonical mappings
    if let Some(canonical) = SERIES_CANONICAL.get(lookup_key.as_str()) {
        // If we have a canonical form, use it
        let canonical_str = canonical.to_string();

        // Still check ownership for the canonical form
        if let Some(auth) = author {
            if let Some(valid_authors) = SERIES_OWNERSHIP.get(canonical.to_lowercase().as_str()) {
                let auth_lower = auth.to_lowercase();
                if !valid_authors.iter().any(|a| auth_lower.contains(a)) {
                    return ValidationResult {
                        value: None,
                        original,
                        action: ValidationAction::Rejected,
                        reason: Some(format!(
                            "Series '{}' belongs to {:?}, not '{}'",
                            canonical, valid_authors, auth
                        )),
                    };
                }
            }
        }

        return ValidationResult {
            value: Some(canonical_str.clone()),
            original,
            action: ValidationAction::Normalized,
            reason: Some(format!("Normalized to canonical form: {}", canonical_str)),
        };
    }

    // Check ownership for non-canonical series
    if let Some(auth) = author {
        if let Some(valid_authors) = SERIES_OWNERSHIP.get(lookup_key.as_str()) {
            let auth_lower = auth.to_lowercase();
            if !valid_authors.iter().any(|a| auth_lower.contains(a)) {
                return ValidationResult {
                    value: None,
                    original,
                    action: ValidationAction::Rejected,
                    reason: Some(format!(
                        "Series '{}' belongs to {:?}, not '{}'",
                        working, valid_authors, auth
                    )),
                };
            }
        }
    }

    // Check if it's a known valid character series
    if VALID_CHARACTER_SERIES.contains(lookup_key.as_str()) {
        return ValidationResult {
            value: Some(working.to_string()),
            original,
            action: ValidationAction::Accepted,
            reason: Some("Known valid character series".to_string()),
        };
    }

    // Check for suspicious patterns that need GPT verification
    if is_suspicious_series(working) {
        return ValidationResult {
            value: Some(working.to_string()),
            original,
            action: ValidationAction::NeedsGpt,
            reason: Some("Suspicious pattern, needs verification".to_string()),
        };
    }

    // Accept as-is
    ValidationResult {
        value: Some(working.to_string()),
        original,
        action: ValidationAction::Accepted,
        reason: None,
    }
}

/// Determines why a series was rejected (for logging).
fn determine_rejection_reason(series: &str) -> String {
    let lower = series.to_lowercase();

    if JUST_NUMBER_PATTERN.is_match(&lower) {
        return "Series is just a number".to_string();
    }

    if BOOK_NUMBER_PATTERN.is_match(&lower) {
        return "Series is just 'Book N' pattern".to_string();
    }

    if INVALID_SERIES.contains(lower.as_str()) {
        return format!("Known invalid series: {}", series);
    }

    if AUTHOR_AS_SERIES.contains(lower.as_str()) {
        return format!("Author name used as series: {}", series);
    }

    if TURKISH_SERIES_PATTERN.is_match(&lower) {
        return "Turkish series pattern detected".to_string();
    }

    if GERMAN_SERIES_PATTERN.is_match(&lower) {
        return "German series pattern detected".to_string();
    }

    if FRENCH_SERIES_PATTERN.is_match(&lower) {
        return "French series pattern detected".to_string();
    }

    if SPANISH_SERIES_PATTERN.is_match(&lower) {
        return "Spanish series pattern detected".to_string();
    }

    if FORMAT_IN_SERIES_PATTERN.is_match(&lower) {
        return "Format descriptor in series name".to_string();
    }

    "Unknown rejection reason".to_string()
}

/// Checks if a series name has suspicious patterns that need GPT verification.
fn is_suspicious_series(name: &str) -> bool {
    let lower = name.to_lowercase();

    // All caps (might be a heading or format error)
    if name.len() > 5 && name == name.to_uppercase() {
        return true;
    }

    // Contains suspicious words
    let suspicious_words = [
        "complete",
        "collection",
        "omnibus",
        "bundle",
        "set",
        "trilogy",  // might be series name or description
        "duology",
        "saga",     // might be series name or description
        "chronicles", // often valid but worth checking
    ];

    for word in suspicious_words {
        if lower.contains(word) {
            return true;
        }
    }

    // Very long series name (might be a description)
    if name.len() > 60 {
        return true;
    }

    // Contains special characters that might indicate bad data
    if name.contains("//") || name.contains("\\\\") || name.contains('\t') {
        return true;
    }

    false
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quick_reject_empty() {
        assert!(quick_reject_series(""));
        assert!(quick_reject_series(" "));
    }

    #[test]
    fn test_quick_reject_just_number() {
        assert!(quick_reject_series("1"));
        assert!(quick_reject_series("42"));
        assert!(quick_reject_series("#5"));
    }

    #[test]
    fn test_quick_reject_book_n() {
        assert!(quick_reject_series("Book 1"));
        assert!(quick_reject_series("Part 3"));
        assert!(quick_reject_series("Volume 2"));
    }

    #[test]
    fn test_quick_reject_invalid_series() {
        assert!(quick_reject_series("beginner books"));
        assert!(quick_reject_series("Penguin Classics"));
    }

    #[test]
    fn test_quick_reject_author_as_series() {
        assert!(quick_reject_series("Dr. Seuss"));
        assert!(quick_reject_series("Stephen King"));
    }

    #[test]
    fn test_quick_reject_foreign() {
        assert!(quick_reject_series("Test Serisi")); // Turkish
        assert!(quick_reject_series("Test Reihe")); // German
    }

    #[test]
    fn test_validate_valid_series() {
        let result = validate_series("The Dark Tower", None);
        assert_eq!(result.action, ValidationAction::Accepted);
    }

    #[test]
    fn test_validate_canonical_series() {
        let result = validate_series("game of thrones", None);
        assert_eq!(result.action, ValidationAction::Normalized);
        assert_eq!(result.value, Some("A Song of Ice and Fire".to_string()));
    }

    #[test]
    fn test_validate_ownership_valid() {
        let result = validate_series("Inspector Banks", Some("Peter Robinson"));
        assert_eq!(result.action, ValidationAction::Accepted);
    }

    #[test]
    fn test_validate_ownership_invalid() {
        let result = validate_series("Inspector Banks", Some("Stephen King"));
        assert_eq!(result.action, ValidationAction::Rejected);
    }

    #[test]
    fn test_validate_discworld_orphan() {
        let result = validate_series("Death", None);
        assert_eq!(result.action, ValidationAction::Rejected);
    }

    #[test]
    fn test_validate_valid_character_series() {
        let result = validate_series("Harry Potter", None);
        assert_eq!(result.action, ValidationAction::Accepted);
    }

    #[test]
    fn test_validate_suspicious_pattern() {
        let result = validate_series("THE COMPLETE CHRONICLES", None);
        assert_eq!(result.action, ValidationAction::NeedsGpt);
    }
}
