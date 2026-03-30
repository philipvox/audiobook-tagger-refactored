//! Author validation and normalization.
//!
//! Validates author names before GPT calls to catch obvious errors
//! like publishers, organizations, and placeholder values.

use once_cell::sync::Lazy;
use regex::Regex;

use super::lookups::{AUTHOR_CANONICAL, INVALID_AUTHORS};
use super::{ValidationAction, ValidationResult};

// ============================================================================
// REGEX PATTERNS
// ============================================================================

/// Matches " - Translator" suffix (various dash types)
static TRANSLATOR_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s*[-–—]\s*translator\s*$").unwrap()
});

/// Matches title prefixes like "Dr.", "Prof.", etc.
static TITLE_PREFIX_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(Dr\.?|Prof\.?|Professor|Sir|Dame|Rev\.?|Reverend|Father|Rabbi|Imam)\s+")
        .unwrap()
});

/// Matches "(Author)" or "[Author]" suffix
static AUTHOR_SUFFIX_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s*[\[\(](?:author|writer|novelist|by)\s*[\]\)]$").unwrap()
});

/// Matches "with [Name]" or "and [Name]" co-author patterns
static COAUTHOR_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s+(?:with|and)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*$").unwrap()
});

/// Matches initials like "J.K." or "J. K." or "JK"
static INITIALS_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^([A-Z])\.?\s*([A-Z])\.?\s+(.+)$").unwrap()
});

/// Matches single initials like "J." at start
static SINGLE_INITIAL_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^([A-Z])\.?\s+(.+)$").unwrap()
});

/// Matches three initials like "J.R.R." or "J. R. R."
static THREE_INITIALS_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^([A-Z])\.?\s*([A-Z])\.?\s*([A-Z])\.?\s+(.+)$").unwrap()
});

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/// Validates an author name and returns the validation result.
///
/// This function checks:
/// 1. Against known invalid authors (publishers, organizations)
/// 2. For translator suffixes (strips them)
/// 3. For canonical name mappings (diacritics, initials)
/// 4. Basic format validation
pub fn validate_author(raw: &str) -> ValidationResult<String> {
    let original = raw.to_string();
    let mut working = raw.trim().to_string();

    // Empty check
    if working.is_empty() {
        return ValidationResult {
            value: None,
            original,
            action: ValidationAction::Rejected,
            reason: Some("Empty author name".to_string()),
        };
    }

    // Strip translator suffix
    if TRANSLATOR_PATTERN.is_match(&working) {
        working = TRANSLATOR_PATTERN.replace(&working, "").trim().to_string();
    }

    // Strip author suffix like "(Author)"
    if AUTHOR_SUFFIX_PATTERN.is_match(&working) {
        working = AUTHOR_SUFFIX_PATTERN
            .replace(&working, "")
            .trim()
            .to_string();
    }

    // Normalize to lowercase for lookups
    let lookup_key = working.to_lowercase();

    // Check invalid authors list
    if INVALID_AUTHORS.contains(lookup_key.as_str()) {
        return ValidationResult {
            value: None,
            original,
            action: ValidationAction::Rejected,
            reason: Some(format!("Known invalid author: {}", working)),
        };
    }

    // Check canonical mappings
    if let Some(canonical) = AUTHOR_CANONICAL.get(lookup_key.as_str()) {
        return ValidationResult {
            value: Some(canonical.to_string()),
            original,
            action: ValidationAction::Normalized,
            reason: Some(format!("Normalized to canonical form: {}", canonical)),
        };
    }

    // Try normalizing initials
    if let Some(normalized) = normalize_author_initials(&working) {
        if normalized != working {
            return ValidationResult {
                value: Some(normalized.clone()),
                original,
                action: ValidationAction::Normalized,
                reason: Some("Normalized initials spacing".to_string()),
            };
        }
    }

    // Basic validation: should have at least a first and last name
    // (unless it's a single name like "Plato" or "Madonna")
    let parts: Vec<&str> = working.split_whitespace().collect();
    if parts.is_empty() {
        return ValidationResult {
            value: None,
            original,
            action: ValidationAction::Rejected,
            reason: Some("No name parts found".to_string()),
        };
    }

    // Check for suspicious patterns that need GPT verification
    if is_suspicious_author(&working) {
        return ValidationResult {
            value: Some(working),
            original,
            action: ValidationAction::NeedsGpt,
            reason: Some("Suspicious pattern, needs verification".to_string()),
        };
    }

    // Accept as-is
    ValidationResult {
        value: Some(working),
        original,
        action: ValidationAction::Accepted,
        reason: None,
    }
}

/// Normalizes author initials to consistent format.
///
/// Converts:
/// - "JK Rowling" -> "J. K. Rowling"
/// - "J.K.Rowling" -> "J. K. Rowling"
/// - "JRR Tolkien" -> "J. R. R. Tolkien"
pub fn normalize_author_initials(name: &str) -> Option<String> {
    let name = name.trim();

    // Check for three initials first (e.g., "JRR Tolkien")
    if let Some(caps) = THREE_INITIALS_PATTERN.captures(name) {
        let i1 = caps.get(1)?.as_str();
        let i2 = caps.get(2)?.as_str();
        let i3 = caps.get(3)?.as_str();
        let rest = caps.get(4)?.as_str();
        return Some(format!("{}. {}. {}. {}", i1, i2, i3, rest));
    }

    // Check for two initials (e.g., "JK Rowling")
    if let Some(caps) = INITIALS_PATTERN.captures(name) {
        let i1 = caps.get(1)?.as_str();
        let i2 = caps.get(2)?.as_str();
        let rest = caps.get(3)?.as_str();
        return Some(format!("{}. {}. {}", i1, i2, rest));
    }

    // Check for single initial (e.g., "J Rowling")
    if let Some(caps) = SINGLE_INITIAL_PATTERN.captures(name) {
        let initial = caps.get(1)?.as_str();
        let rest = caps.get(2)?.as_str();
        // Only normalize if it looks like an initial (single letter)
        if rest.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
            return Some(format!("{}. {}", initial, rest));
        }
    }

    None
}

/// Checks if an author name has suspicious patterns that need GPT verification.
fn is_suspicious_author(name: &str) -> bool {
    let lower = name.to_lowercase();

    // All caps (might be a heading or format error)
    if name.len() > 5 && name == name.to_uppercase() {
        return true;
    }

    // Contains suspicious words
    let suspicious_words = [
        "publishing",
        "publications",
        "press",
        "books",
        "media",
        "audio",
        "productions",
        "studios",
        "entertainment",
        "inc",
        "llc",
        "ltd",
        "corp",
        "company",
        "group",
        "editors",
        "staff",
        "team",
    ];

    for word in suspicious_words {
        if lower.contains(word) {
            return true;
        }
    }

    // Too many words (probably not a name)
    if name.split_whitespace().count() > 6 {
        return true;
    }

    // Contains numbers
    if name.chars().any(|c| c.is_ascii_digit()) {
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
    fn test_validate_valid_author() {
        let result = validate_author("Stephen King");
        assert_eq!(result.action, ValidationAction::Accepted);
        assert_eq!(result.value, Some("Stephen King".to_string()));
    }

    #[test]
    fn test_validate_invalid_publisher() {
        let result = validate_author("Charles River Editors");
        assert_eq!(result.action, ValidationAction::Rejected);
        assert!(result.value.is_none());
    }

    #[test]
    fn test_validate_canonical_diacritics() {
        let result = validate_author("Jo Nesbo");
        assert_eq!(result.action, ValidationAction::Normalized);
        assert_eq!(result.value, Some("Jo Nesbø".to_string()));
    }

    #[test]
    fn test_validate_canonical_initials() {
        let result = validate_author("j.k. rowling");
        assert_eq!(result.action, ValidationAction::Normalized);
        assert_eq!(result.value, Some("J. K. Rowling".to_string()));
    }

    #[test]
    fn test_strip_translator_suffix() {
        let result = validate_author("John Smith - Translator");
        assert_eq!(result.action, ValidationAction::Accepted);
        assert_eq!(result.value, Some("John Smith".to_string()));
    }

    #[test]
    fn test_strip_author_suffix() {
        let result = validate_author("Jane Doe (Author)");
        assert_eq!(result.action, ValidationAction::Accepted);
        assert_eq!(result.value, Some("Jane Doe".to_string()));
    }

    #[test]
    fn test_normalize_initials_two() {
        assert_eq!(
            normalize_author_initials("JK Rowling"),
            Some("J. K. Rowling".to_string())
        );
    }

    #[test]
    fn test_normalize_initials_three() {
        assert_eq!(
            normalize_author_initials("JRR Tolkien"),
            Some("J. R. R. Tolkien".to_string())
        );
    }

    #[test]
    fn test_normalize_initials_already_normalized() {
        // Should return normalized form even if close
        assert_eq!(
            normalize_author_initials("J.K. Rowling"),
            Some("J. K. Rowling".to_string())
        );
    }

    #[test]
    fn test_suspicious_publisher() {
        let result = validate_author("Random House Publishing");
        assert_eq!(result.action, ValidationAction::NeedsGpt);
    }

    #[test]
    fn test_suspicious_all_caps() {
        let result = validate_author("STEPHEN KING");
        assert_eq!(result.action, ValidationAction::NeedsGpt);
    }

    #[test]
    fn test_empty_author() {
        let result = validate_author("");
        assert_eq!(result.action, ValidationAction::Rejected);
        assert!(result.value.is_none());
    }

    #[test]
    fn test_whitespace_only() {
        let result = validate_author("   ");
        assert_eq!(result.action, ValidationAction::Rejected);
    }
}
