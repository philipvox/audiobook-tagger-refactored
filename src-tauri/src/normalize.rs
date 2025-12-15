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
    "- Audiobook Edition",
    "- Audiobook",
    "- Unabridged Edition",
    "- Unabridged",
    "Audiobook Edition",
    "Unabridged Edition",
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
    // But NOT all-caps words (which should be converted to title case)
    let has_lowercase = word.chars().any(|c| c.is_lowercase());
    let has_uppercase_after_first = word.chars().skip(1).any(|c| c.is_uppercase());

    // True mixed case: has both upper and lower, with internal capitals
    // e.g., "iPhone" (lower then upper), "McDonald" (upper-lower-upper)
    has_lowercase && has_uppercase_after_first
}

/// Check if a word looks like an acronym (all caps, 2-4 chars)
/// Uses a whitelist approach - only known acronym patterns are treated as acronyms
fn looks_like_acronym(word: &str) -> bool {
    // Acronyms are typically 2-4 characters (very few 5+ char acronyms in titles)
    if word.len() < 2 || word.len() > 4 {
        return false;
    }

    if !word.chars().all(|c| c.is_uppercase() || c.is_numeric()) {
        return false;
    }

    // Known acronyms that should stay uppercase
    let known_acronyms: HashSet<&str> = [
        // Organizations/standards
        "NASA", "FBI", "CIA", "MIT", "BBC", "CNN", "HBO", "NBA", "NFL", "MLB",
        "NCAA", "NATO", "UN", "EU", "UK", "USA", "IBM", "AT&T", "NYPD", "LAPD",
        // Technical
        "AI", "API", "CEO", "CFO", "CTO", "PhD", "MD", "DNA", "RNA", "HIV",
        "AIDS", "PTSD", "ADHD", "IQ", "EQ", "GPS", "TV", "DVD", "CD", "PC",
        "VR", "AR", "IoT", "SaaS", "PDF", "USB", "HTML", "CSS", "SQL",
        // Common in titles
        "WWII", "WWI", "WWIII", "NYC", "LA", "DC", "SF",
    ].iter().copied().collect();

    known_acronyms.contains(word)
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

    // Pattern: Title, Vol. N or Title, Volume N
    if let Ok(re) = Regex::new(r",?\s*Vol\.?\s*\d+\s*$") {
        result = re.replace(&result, "").to_string();
    }
    if let Ok(re) = Regex::new(r",?\s*Volume\s*\d+\s*$") {
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

    // Remove common prefixes (case-insensitive) - check longest first
    let prefixes = ["written by: ", "written by ", "author: ", "by: ", "by "];
    for prefix in prefixes {
        if result.to_lowercase().starts_with(prefix) {
            result = result[prefix.len()..].trim().to_string();
            break; // Only remove one prefix
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

    // Title case the name, handling initials specially
    let words: Vec<String> = result
        .split_whitespace()
        .map(|w| {
            // Don't modify suffixes or particles
            let lower = w.to_lowercase();
            if ["de", "van", "von", "la", "le", "da", "di", "del", "jr.", "sr.", "ii", "iii", "iv"].contains(&lower.as_str()) {
                w.to_string()
            } else {
                // Handle initials like "j.r.r." or "j.k."
                capitalize_name_part(&lower)
            }
        })
        .collect();

    words.join(" ")
}

/// Capitalize a name part, handling initials like "j.r.r." or "j.k."
fn capitalize_name_part(word: &str) -> String {
    // Check if this looks like initials (contains periods)
    if word.contains('.') {
        // Capitalize each letter before a period
        word.split('.')
            .map(|part| {
                if part.is_empty() {
                    String::new()
                } else {
                    capitalize_first(part)
                }
            })
            .collect::<Vec<_>>()
            .join(".")
    } else {
        capitalize_first(word)
    }
}

/// Clean a narrator name (same rules as author)
pub fn clean_narrator_name(narrator: &str) -> String {
    let mut result = narrator.trim().to_string();

    // Remove common prefixes - check longest first
    let prefixes = [
        "narrated by: ", "narrated by ",
        "performed by: ", "performed by ",
        "read by: ", "read by ",
        "narrator: ",
    ];
    for prefix in prefixes {
        if result.to_lowercase().starts_with(prefix) {
            result = result[prefix.len()..].trim().to_string();
            break; // Only remove one prefix
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
    // 1. Strip leading track numbers (e.g., "1 - Title" -> "Title")
    let no_track_num = strip_leading_track_number(title);

    // 2. Strip track-derived suffixes (e.g., ": Opening Credits")
    let no_track_suffix = strip_track_suffixes(&no_track_num);

    // 3. Remove junk suffixes (Unabridged, Audiobook, etc.)
    let cleaned = remove_junk_suffixes(&no_track_suffix);

    // 4. Remove series info
    let no_series = strip_series_from_title(&cleaned);

    // 5. Apply title case
    let title_cased = to_title_case(&no_series);

    title_cased.trim().to_string()
}

/// Validate and potentially fix a year value
///
/// Returns None if the year is invalid
pub fn validate_year(year: &str) -> Option<String> {
    // Try to parse as a number
    if let Ok(year_num) = year.trim().parse::<u32>() {
        // Must be a reasonable year for audiobooks (1900-2099)
        // Pre-1900 books exist but audiobook recordings are much more recent
        if year_num >= 1900 && year_num <= 2099 {
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

/// Validate a series name - returns false for invalid/placeholder values
///
/// This filters out GPT artifacts like "or null", "Standalone", etc.
/// Check if a string looks like a person's name (2-3 words, capitalized, no numbers)
/// Used to detect when GPT returns author names as series
fn looks_like_person_name(s: &str) -> bool {
    let words: Vec<&str> = s.split_whitespace().collect();

    // Person names are typically 2-3 words
    if words.len() < 2 || words.len() > 4 {
        return false;
    }

    // Check if all words look like name parts (capitalized, no numbers, reasonable length)
    for word in &words {
        // Skip common name suffixes
        let lower = word.to_lowercase();
        if ["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "phd", "md", "dr", "dr."].contains(&lower.as_str()) {
            continue;
        }

        // Names shouldn't have numbers
        if word.chars().any(|c| c.is_numeric()) {
            return false;
        }

        // Names are typically shorter than 15 chars per word
        if word.len() > 15 {
            return false;
        }

        // First letter should be uppercase for proper names
        if let Some(first) = word.chars().next() {
            if !first.is_uppercase() && first.is_alphabetic() {
                return false;
            }
        }
    }

    // Additional check: common "series-like" words suggest it's not a name
    let lower = s.to_lowercase();
    let series_indicators = ["series", "saga", "chronicles", "trilogy", "book", "collection",
                             "adventures", "mysteries", "tales", "stories", "cycle"];
    if series_indicators.iter().any(|ind| lower.contains(ind)) {
        return false;
    }

    true
}

pub fn is_valid_series(series: &str) -> bool {
    is_valid_series_with_author(series, None)
}

/// Validate series name, optionally comparing against author name
pub fn is_valid_series_with_author(series: &str, author: Option<&str>) -> bool {
    let s = series.trim();

    // Empty or too short
    if s.is_empty() || s.len() < 2 {
        return false;
    }

    let lower = s.to_lowercase();

    // Reject known bad values from GPT
    let invalid = [
        // Placeholder values
        "null", "or null", "none", "n/a", "na", "unknown", "unknown series",
        "standalone", "stand-alone", "stand alone", "single", "single book",
        "not a series", "no series", "not part of a series", "no series name",
        "series name", "series", "title", "book", "audiobook",
        "undefined", "not applicable", "not available", "tbd", "tba",
        // Genres that GPT incorrectly returns as series
        "biography", "autobiography", "memoir", "memoirs", "fiction", "non-fiction",
        "nonfiction", "mystery", "thriller", "romance", "fantasy", "science fiction",
        "sci-fi", "horror", "historical fiction", "literary fiction", "self-help",
        "self help", "history", "true crime", "comedy", "humor", "drama",
        "adventure", "action", "suspense", "classic", "classics", "poetry",
        "essay", "essays", "short stories", "anthology", "collection",
        "young adult", "ya", "children", "kids", "juvenile", "teen",
        "business", "economics", "psychology", "philosophy", "religion",
        "spirituality", "health", "wellness", "cooking", "travel", "science",
        "technology", "politics", "sociology", "education", "reference",
    ];

    if invalid.contains(&lower.as_str()) {
        return false;
    }

    // Reject if it's just punctuation or numbers
    if !s.chars().any(|c| c.is_alphabetic()) {
        return false;
    }

    // Reject if it contains "or null" anywhere
    if lower.contains("or null") || lower.contains("#or null") {
        return false;
    }

    // Reject if series matches the author name (GPT sometimes returns author as series)
    if let Some(auth) = author {
        let auth_lower = auth.to_lowercase().trim().to_string();
        if lower == auth_lower {
            return false;
        }
        // Also check if series is contained in author or vice versa
        // e.g., "Eric Carle" in "Eric Carle, Mary Smith"
        if auth_lower.contains(&lower) || lower.contains(&auth_lower.split(',').next().unwrap_or("").trim()) {
            return false;
        }

        // If we have author context and series looks like a person name,
        // check if it matches the author pattern
        if looks_like_person_name(s) {
            // Calculate similarity - if it's very close to the author, reject
            let similarity = calculate_name_similarity(s, auth);
            if similarity >= 0.4 {
                return false;
            }
        }
    }

    // Note: We don't reject person-looking names without author context
    // because series names like "Harry Potter" or "Jack Reacher" look like person names
    // but are valid series names

    true
}

/// Clean a series name - returns None if invalid, or cleaned version
pub fn clean_series(series: Option<&str>) -> Option<String> {
    clean_series_with_author(series, None)
}

/// Clean a series name with author comparison - returns None if invalid or matches author
pub fn clean_series_with_author(series: Option<&str>, author: Option<&str>) -> Option<String> {
    let s = series?.trim();
    if is_valid_series_with_author(s, author) {
        Some(s.to_string())
    } else {
        None
    }
}

/// Clean a sequence/book number - returns None if invalid
pub fn clean_sequence(seq: Option<&str>) -> Option<String> {
    let s = seq?.trim();

    // Empty check
    if s.is_empty() {
        return None;
    }

    let lower = s.to_lowercase();

    // Reject known bad values
    let invalid = ["null", "or null", "none", "n/a", "na", "unknown", "?", "tbd"];
    if invalid.contains(&lower.as_str()) {
        return None;
    }

    // Try to extract just the number
    // Handle formats like "1", "Book 1", "#1", "1.0", "1.5"
    if let Some(num) = extract_sequence_number(s) {
        return Some(num);
    }

    None
}

/// Extract sequence number from various formats
fn extract_sequence_number(s: &str) -> Option<String> {
    // Try parsing as a simple number first
    if let Ok(n) = s.parse::<f64>() {
        // Reject zero and negative numbers
        if n <= 0.0 {
            return None;
        }
        // Return as integer if whole number, otherwise with decimal
        if n.fract() == 0.0 {
            return Some((n as i64).to_string());
        } else {
            return Some(format!("{:.1}", n));
        }
    }

    // Try to find a number in the string (e.g., "Book 1", "#2", "Part 3")
    let re = regex::Regex::new(r"(\d+(?:\.\d+)?)").ok()?;
    if let Some(caps) = re.captures(s) {
        let num_str = &caps[1];
        if let Ok(n) = num_str.parse::<f64>() {
            // Reject zero
            if n <= 0.0 {
                return None;
            }
            if n.fract() == 0.0 {
                return Some((n as i64).to_string());
            } else {
                return Some(format!("{:.1}", n));
            }
        }
    }

    None
}

/// Calculate similarity between two strings (0.0 to 1.0)
///
/// Uses word-based matching for author names
fn calculate_name_similarity(name1: &str, name2: &str) -> f64 {
    let n1 = name1.to_lowercase();
    let n2 = name2.to_lowercase();

    // Exact match
    if n1 == n2 {
        return 1.0;
    }

    // Extract words (split on spaces, hyphens, periods)
    let words1: Vec<&str> = n1.split(|c: char| c.is_whitespace() || c == '-' || c == '.')
        .filter(|s| !s.is_empty() && s.len() > 1)
        .collect();
    let words2: Vec<&str> = n2.split(|c: char| c.is_whitespace() || c == '-' || c == '.')
        .filter(|s| !s.is_empty() && s.len() > 1)
        .collect();

    if words1.is_empty() || words2.is_empty() {
        return 0.0;
    }

    // Count matching words
    let mut matches = 0;
    for w1 in &words1 {
        for w2 in &words2 {
            // Exact word match
            if w1 == w2 {
                matches += 2;
                break;
            }
            // One contains the other (for initials like "J." matching "James")
            if w1.starts_with(w2) || w2.starts_with(w1) {
                matches += 1;
                break;
            }
        }
    }

    // Calculate score based on total possible matches
    let max_possible = (words1.len() + words2.len()) as f64;
    (matches as f64) / max_possible
}

/// Check if two author names are similar enough to be considered a match
///
/// Returns true if the names are likely the same person
pub fn authors_match(expected: &str, found: &str) -> bool {
    let expected_clean = expected.trim().to_lowercase();
    let found_clean = found.trim().to_lowercase();

    // Exact match (case-insensitive)
    if expected_clean == found_clean {
        return true;
    }

    // Empty or invalid - don't match
    if expected_clean.is_empty() || found_clean.is_empty()
        || expected_clean == "unknown" || found_clean == "unknown" {
        return false;
    }

    // Check if one contains the other (for partial matches like "King" vs "Stephen King")
    if expected_clean.split_whitespace().count() == 1 || found_clean.split_whitespace().count() == 1 {
        // Single word - check if it matches any word in the other name
        let expected_words: Vec<&str> = expected_clean.split_whitespace().collect();
        let found_words: Vec<&str> = found_clean.split_whitespace().collect();

        for exp_word in &expected_words {
            if found_words.iter().any(|&fw| fw == *exp_word) {
                return true;
            }
        }
        for found_word in &found_words {
            if expected_words.iter().any(|&ew| ew == *found_word) {
                return true;
            }
        }
    }

    // Check for common famous author mismatches - these should never match
    // Only apply if both have at least 2 words (full names)
    let exp_word_count = expected_clean.split_whitespace().count();
    let found_word_count = found_clean.split_whitespace().count();

    if exp_word_count >= 2 && found_word_count >= 2 {
        let famous_authors = [
            "j.k. rowling", "jk rowling", "j. k. rowling",
            "stephen king", "james patterson", "john grisham",
            "dan brown", "agatha christie", "tolkien",
        ];

        let expected_is_famous = famous_authors.iter().any(|&f| expected_clean.contains(f));
        let found_is_famous = famous_authors.iter().any(|&f| found_clean.contains(f));

        // If both are famous but different, they don't match
        if expected_is_famous && found_is_famous {
            for famous in &famous_authors {
                let exp_has = expected_clean.contains(famous);
                let found_has = found_clean.contains(famous);
                if exp_has != found_has {
                    return false;
                }
            }
        }
    }

    // Calculate similarity score
    let similarity = calculate_name_similarity(&expected_clean, &found_clean);

    // Require at least 50% similarity
    // This allows for variations like:
    // - "Brandon Sanderson" vs "Sanderson, Brandon"
    // - "J.R.R. Tolkien" vs "J. R. R. Tolkien"
    // - "Will Wight" vs "Wight, Will"
    similarity >= 0.5
}

/// Check if found author is acceptable given expected author
///
/// More lenient than authors_match - allows accepting if found is valid
/// and expected was "Unknown" or very generic
pub fn author_is_acceptable(expected: &str, found: &str) -> bool {
    // If they match, accept
    if authors_match(expected, found) {
        return true;
    }

    let expected_clean = expected.trim().to_lowercase();

    // If expected was unknown/generic, accept any valid author
    let generic_expected = [
        "unknown", "unknown author", "various", "various authors",
        "author", "n/a", "", "audiobook",
    ];

    if generic_expected.contains(&expected_clean.as_str()) && is_valid_author(found) {
        return true;
    }

    false
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

/// Strip leading track/chapter numbers from titles
/// Examples: "1 - Title" -> "Title", "01. Title" -> "Title", "Track 1 - Title" -> "Title"
pub fn strip_leading_track_number(title: &str) -> String {
    let mut result = title.trim().to_string();

    // Pattern: "1 - Title", "01 - Title", "1. Title", "01. Title"
    if let Ok(re) = Regex::new(r"^(?:\d{1,3})\s*[-–.]\s*(.+)$") {
        if let Some(caps) = re.captures(&result) {
            if let Some(m) = caps.get(1) {
                result = m.as_str().trim().to_string();
            }
        }
    }

    // Pattern: "Track 1 - Title", "Chapter 1 - Title", "Part 1 - Title"
    if let Ok(re) = Regex::new(r"(?i)^(?:track|chapter|part|ch\.?|disc|cd)\s*\d+\s*[-–:]\s*(.+)$") {
        if let Some(caps) = re.captures(&result) {
            if let Some(m) = caps.get(1) {
                result = m.as_str().trim().to_string();
            }
        }
    }

    result
}

/// Strip common track/file-derived suffixes from titles
/// Examples: "Title: Opening Credits" -> "Title", "Title - Track 1" -> "Title"
pub fn strip_track_suffixes(title: &str) -> String {
    let mut result = title.to_string();

    // Common track-derived suffixes to remove
    let track_suffixes = [
        // Credits-related
        ": Opening Credits", ": Opening", ": Closing Credits", ": Credits",
        " - Opening Credits", " - Opening", " - Closing Credits", " - Credits",
        // Track/Chapter suffixes
        ": Track 1", ": Chapter 1", ": Part 1", ": Intro",
        " - Track 1", " - Chapter 1", " - Part 1", " - Intro",
        // Prologue/Epilogue
        ": Prologue", ": Epilogue", " - Prologue", " - Epilogue",
    ];

    for suffix in &track_suffixes {
        if result.to_lowercase().ends_with(&suffix.to_lowercase()) {
            result = result[..result.len() - suffix.len()].trim().to_string();
            break;
        }
    }

    // Pattern: "(Part N of M)" or "(Track N of M)" - common in multi-disc sets
    if let Ok(re) = Regex::new(r"(?i)\s*\(\s*(?:part|track|disc|cd)\s*\d+\s*(?:of\s*\d+)?\s*\)\s*$") {
        result = re.replace(&result, "").to_string();
    }

    // Also try pattern matching for more flexible removal
    // Pattern: ": Track N" or " - Track N" at end
    if let Ok(re) = Regex::new(r"(?i)[:\s-]+(?:track|chapter|part|opening|closing|credits|intro|prologue|epilogue)\s*\d*\s*$") {
        result = re.replace(&result, "").to_string();
    }

    result.trim().to_string()
}

/// Clean a title by applying all title-cleaning operations
pub fn clean_title(title: &str) -> String {
    let mut result = title.to_string();

    // 1. Strip leading track numbers
    result = strip_leading_track_number(&result);

    // 2. Strip track-derived suffixes
    result = strip_track_suffixes(&result);

    // 3. Remove junk suffixes (Unabridged, Audiobook, etc.)
    result = remove_junk_suffixes(&result);

    // 4. Apply title case
    result = to_title_case(&result);

    result.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Title Case Tests
    // =========================================================================

    #[test]
    fn test_to_title_case() {
        assert_eq!(to_title_case("the lord of the rings"), "The Lord of the Rings");
        assert_eq!(to_title_case("a tale of two cities"), "A Tale of Two Cities");
        assert_eq!(to_title_case("THE HOBBIT"), "The Hobbit");
        assert_eq!(to_title_case("war and peace"), "War and Peace");
    }

    #[test]
    fn test_to_title_case_with_articles() {
        // Articles should stay lowercase except at start
        assert_eq!(to_title_case("the art of war"), "The Art of War");
        assert_eq!(to_title_case("an unexpected journey"), "An Unexpected Journey");
    }

    // =========================================================================
    // Junk Suffix Tests
    // =========================================================================

    #[test]
    fn test_remove_junk_suffixes() {
        assert_eq!(remove_junk_suffixes("The Hobbit (Unabridged)"), "The Hobbit");
        assert_eq!(remove_junk_suffixes("1984 [Audiobook] 320kbps"), "1984");
        assert_eq!(remove_junk_suffixes("Dune (Retail)"), "Dune");
    }

    #[test]
    fn test_remove_junk_suffixes_multiple() {
        assert_eq!(remove_junk_suffixes("Book Title (Unabridged) [Audiobook]"), "Book Title");
        assert_eq!(remove_junk_suffixes("Title - Audiobook Edition"), "Title");
    }

    // =========================================================================
    // Series Extraction Tests
    // =========================================================================

    #[test]
    fn test_strip_series_from_title() {
        assert_eq!(strip_series_from_title("The Eye of the World (Wheel of Time #1)"), "The Eye of the World");
        assert_eq!(strip_series_from_title("A Game of Thrones, Book 1"), "A Game of Thrones");
    }

    #[test]
    fn test_strip_series_various_formats() {
        assert_eq!(strip_series_from_title("Title (Series Book 5)"), "Title");
        assert_eq!(strip_series_from_title("Title [Series #10]"), "Title");
        assert_eq!(strip_series_from_title("Title, Vol. 3"), "Title");
    }

    // =========================================================================
    // Subtitle Extraction Tests
    // =========================================================================

    #[test]
    fn test_extract_subtitle() {
        assert_eq!(extract_subtitle("Dune: The Desert Planet"), ("Dune".to_string(), Some("The Desert Planet".to_string())));
        assert_eq!(extract_subtitle("Simple Title"), ("Simple Title".to_string(), None));
    }

    #[test]
    fn test_extract_subtitle_dash_separator() {
        let (title, subtitle) = extract_subtitle("Main Title - A Subtitle Here");
        assert_eq!(title, "Main Title");
        assert!(subtitle.is_some());
    }

    // =========================================================================
    // Year Validation Tests
    // =========================================================================

    #[test]
    fn test_validate_year() {
        assert_eq!(validate_year("2020"), Some("2020".to_string()));
        assert_eq!(validate_year("1984"), Some("1984".to_string()));
        assert_eq!(validate_year("invalid"), None);
        assert_eq!(validate_year("Released in 2015"), Some("2015".to_string()));
    }

    #[test]
    fn test_validate_year_edge_cases() {
        assert_eq!(validate_year("1800"), None); // Too old (pre-audiobook era)
        assert_eq!(validate_year("1899"), None); // Too old
        assert_eq!(validate_year("1900"), Some("1900".to_string())); // Valid minimum
        assert_eq!(validate_year("2099"), Some("2099".to_string())); // Valid maximum
        assert_eq!(validate_year("2100"), None); // Too far future
        assert_eq!(validate_year("©2020"), Some("2020".to_string()));
    }

    // =========================================================================
    // Author Validation Tests
    // =========================================================================

    #[test]
    fn test_is_valid_author() {
        assert!(is_valid_author("Stephen King"));
        assert!(is_valid_author("J.R.R. Tolkien"));
        assert!(!is_valid_author("Unknown"));
        assert!(!is_valid_author(""));
        assert!(!is_valid_author("12345"));
    }

    #[test]
    fn test_is_valid_author_edge_cases() {
        assert!(!is_valid_author("Unknown Author"));
        assert!(!is_valid_author("Various Authors"));
        assert!(!is_valid_author("N/A"));
        assert!(is_valid_author("Mary Pope Osborne"));
    }

    // =========================================================================
    // Author Name Cleaning Tests
    // =========================================================================

    #[test]
    fn test_clean_author_name_basic() {
        assert_eq!(clean_author_name("stephen king"), "Stephen King");
        assert_eq!(clean_author_name("BRANDON SANDERSON"), "Brandon Sanderson");
    }

    #[test]
    fn test_clean_author_name_with_suffixes() {
        // Should remove "by" prefix
        assert_eq!(clean_author_name("by Stephen King"), "Stephen King");
        assert_eq!(clean_author_name("By: J.K. Rowling"), "J.K. Rowling");
    }

    #[test]
    fn test_clean_author_name_initials() {
        assert_eq!(clean_author_name("j.r.r. tolkien"), "J.R.R. Tolkien");
        assert_eq!(clean_author_name("c.s. lewis"), "C.S. Lewis");
    }

    // =========================================================================
    // Narrator Name Cleaning Tests
    // =========================================================================

    #[test]
    fn test_clean_narrator_name_basic() {
        assert_eq!(clean_narrator_name("stephen fry"), "Stephen Fry");
    }

    #[test]
    fn test_clean_narrator_name_with_prefix() {
        assert_eq!(clean_narrator_name("Narrated by Jim Dale"), "Jim Dale");
        assert_eq!(clean_narrator_name("Read by: Kate Reading"), "Kate Reading");
    }

    // =========================================================================
    // Sequence Cleaning Tests
    // =========================================================================

    #[test]
    fn test_clean_sequence_basic() {
        assert_eq!(clean_sequence(Some("1")), Some("1".to_string()));
        assert_eq!(clean_sequence(Some("10")), Some("10".to_string()));
        assert_eq!(clean_sequence(Some("1.5")), Some("1.5".to_string()));
    }

    #[test]
    fn test_clean_sequence_with_text() {
        assert_eq!(clean_sequence(Some("Book 5")), Some("5".to_string()));
        assert_eq!(clean_sequence(Some("#3")), Some("3".to_string()));
        assert_eq!(clean_sequence(Some("Volume 7")), Some("7".to_string()));
    }

    #[test]
    fn test_clean_sequence_invalid() {
        assert_eq!(clean_sequence(Some("")), None);
        assert_eq!(clean_sequence(Some("null")), None);
        assert_eq!(clean_sequence(None), None);
    }

    #[test]
    fn test_clean_sequence_edge_cases() {
        assert_eq!(clean_sequence(Some("0")), None); // Zero is invalid
        assert_eq!(clean_sequence(Some("-1")), None); // Negative is invalid
        assert_eq!(clean_sequence(Some("Part 2")), Some("2".to_string()));
    }

    // =========================================================================
    // Series Validation Tests
    // =========================================================================

    #[test]
    fn test_is_valid_series() {
        assert!(is_valid_series("Wheel of Time"));
        assert!(is_valid_series("Harry Potter"));
        assert!(!is_valid_series("")); // Empty
        assert!(!is_valid_series("null")); // Null string
    }

    #[test]
    fn test_is_valid_series_with_author() {
        // Series that matches author name should be invalid
        assert!(!is_valid_series_with_author("Stephen King", Some("Stephen King")));
        assert!(is_valid_series_with_author("The Dark Tower", Some("Stephen King")));
    }

    // =========================================================================
    // Author Matching Tests
    // =========================================================================

    #[test]
    fn test_authors_match_exact() {
        assert!(authors_match("Stephen King", "Stephen King"));
        assert!(authors_match("J.K. Rowling", "J.K. Rowling"));
    }

    #[test]
    fn test_authors_match_case_insensitive() {
        assert!(authors_match("stephen king", "Stephen King"));
        assert!(authors_match("BRANDON SANDERSON", "Brandon Sanderson"));
    }

    #[test]
    fn test_authors_match_partial() {
        // Last name match should work
        assert!(authors_match("King", "Stephen King"));
        assert!(authors_match("Sanderson", "Brandon Sanderson"));
    }

    // =========================================================================
    // Narrator Validation Tests
    // =========================================================================

    #[test]
    fn test_is_valid_narrator() {
        assert!(is_valid_narrator("Jim Dale"));
        assert!(is_valid_narrator("Stephen Fry"));
        assert!(!is_valid_narrator("")); // Empty
        assert!(!is_valid_narrator("Unknown")); // Invalid
    }

    // =========================================================================
    // Description Normalization Tests
    // =========================================================================

    #[test]
    fn test_normalize_description_basic() {
        let desc = "  This is a test description.  ";
        assert_eq!(normalize_description(desc, None), "This is a test description.");
    }

    #[test]
    fn test_normalize_description_html_removal() {
        let desc = "<p>This is <b>bold</b> text.</p>";
        let result = normalize_description(desc, None);
        assert!(!result.contains("<p>"));
        assert!(!result.contains("<b>"));
    }

    #[test]
    fn test_normalize_description_max_length() {
        let desc = "This is a very long description that should be truncated.";
        let result = normalize_description(desc, Some(20));
        assert!(result.len() <= 23); // 20 + "..."
    }

    // =========================================================================
    // Track Number Stripping Tests
    // =========================================================================

    #[test]
    fn test_strip_leading_track_number() {
        assert_eq!(strip_leading_track_number("01 - Chapter One"), "Chapter One");
        assert_eq!(strip_leading_track_number("Track 05 - Title"), "Title");
        assert_eq!(strip_leading_track_number("No Number Here"), "No Number Here");
    }

    #[test]
    fn test_strip_track_suffixes() {
        assert_eq!(strip_track_suffixes("Title - Track 01"), "Title");
        assert_eq!(strip_track_suffixes("Title (Part 1 of 10)"), "Title");
    }

    // =========================================================================
    // Full Title Cleaning Tests
    // =========================================================================

    #[test]
    fn test_clean_title_full() {
        assert_eq!(clean_title("01 - the hobbit (unabridged)"), "The Hobbit");
        assert_eq!(clean_title("DUNE [Audiobook]"), "Dune");
    }

    #[test]
    fn test_clean_title_preserves_valid() {
        assert_eq!(clean_title("The Lord of the Rings"), "The Lord of the Rings");
        assert_eq!(clean_title("1984"), "1984");
    }
}
