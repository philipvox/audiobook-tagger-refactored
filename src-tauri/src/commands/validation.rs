// commands/validation.rs
// Commands for scanning and validating metadata across the library

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter};

use crate::scanner::types::BookGroup;
use crate::validation::{
    lookups::{AUTHOR_AS_SERIES, AUTHOR_CANONICAL, INVALID_AUTHORS, INVALID_SERIES, SERIES_OWNERSHIP},
    validate_author,
};

/// Severity levels for validation issues
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    /// Critical issue - likely an error that should be fixed
    Error,
    /// Potential issue - might be wrong
    Warning,
    /// Minor issue - could be improved
    Info,
}

/// Types of validation issues
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IssueType {
    // Author issues
    InvalidAuthor,
    AuthorNeedsNormalization,
    SuspiciousAuthor,
    MultipleAuthorFormats,
    AuthorMissingDiacritics,

    // Title issues
    TitleContainsSeriesNumber,
    TitleMatchesSeries,
    SuspiciousTitle,
    TitleAllCaps,

    // Series issues
    InvalidSeries,
    SeriesMatchesAuthor,
    SeriesOwnershipMismatch,
    OrphanSubseries,
    SuspiciousSeries,
    MissingSequence,
    InvalidSequence,

    // Narrator issues
    NarratorMatchesAuthor,
    SuspiciousNarrator,

    // Description issues
    DescriptionTooShort,
    DescriptionContainsHtml,
    DescriptionMissing,

    // General issues
    MissingField,
    InconsistentData,
}

/// A single validation issue found in a book's metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationIssue {
    /// Type of issue
    pub issue_type: IssueType,
    /// Severity of the issue
    pub severity: IssueSeverity,
    /// Which field has the issue
    pub field: String,
    /// Current value (if any)
    pub current_value: Option<String>,
    /// Suggested fix (if available)
    pub suggested_value: Option<String>,
    /// Human-readable message
    pub message: String,
}

/// Result of scanning a single book
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookValidationResult {
    /// Book ID
    pub book_id: String,
    /// Book title (for display)
    pub title: String,
    /// Book author (for display)
    pub author: String,
    /// List of issues found
    pub issues: Vec<ValidationIssue>,
    /// Total error count
    pub error_count: usize,
    /// Total warning count
    pub warning_count: usize,
}

/// Result of scanning the entire library
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryValidationResult {
    /// All books with issues
    pub books: Vec<BookValidationResult>,
    /// Total books scanned
    pub total_scanned: usize,
    /// Books with errors
    pub books_with_errors: usize,
    /// Books with warnings
    pub books_with_warnings: usize,
    /// Summary by issue type
    pub issue_summary: std::collections::HashMap<String, usize>,
}

/// Author match candidate
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorCandidate {
    /// The author name as it appears
    pub name: String,
    /// Canonical form (if available)
    pub canonical: Option<String>,
    /// Number of books with this author
    pub book_count: usize,
    /// Is this likely the correct form?
    pub is_canonical: bool,
    /// List of variations found
    pub variations: Vec<String>,
}

/// Result of author matching analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorMatchResult {
    /// All unique authors with their variations
    pub authors: Vec<AuthorCandidate>,
    /// Authors that need normalization
    pub needs_normalization: Vec<AuthorCandidate>,
    /// Authors that might be publishers
    pub suspicious_authors: Vec<AuthorCandidate>,
}

/// Progress event payload for validation
#[derive(Debug, Clone, Serialize)]
pub struct ValidationProgress {
    pub current: usize,
    pub total: usize,
    pub message: String,
}

/// Scan all books for validation issues
#[command]
pub async fn scan_metadata_errors(app: AppHandle, groups: Vec<BookGroup>) -> Result<LibraryValidationResult, String> {
    let mut books_results: Vec<BookValidationResult> = Vec::new();
    let mut issue_summary: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut books_with_errors = 0;
    let mut books_with_warnings = 0;
    let total = groups.len();

    for (idx, group) in groups.iter().enumerate() {
        // Emit progress every 50 books or on first/last
        if idx % 50 == 0 || idx == total - 1 {
            let _ = app.emit("validation_progress", ValidationProgress {
                current: idx + 1,
                total,
                message: format!("Scanning: {}", group.metadata.title),
            });
        }
        let mut issues: Vec<ValidationIssue> = Vec::new();
        let metadata = &group.metadata;

        // === AUTHOR VALIDATION ===
        validate_author_field(&metadata.author, &mut issues);

        // === TITLE VALIDATION ===
        validate_title_field(&metadata.title, &metadata.series, &metadata.author, &mut issues);

        // === SERIES VALIDATION ===
        validate_series_field(
            &metadata.series,
            &metadata.sequence,
            &metadata.author,
            &metadata.title,
            &mut issues,
        );

        // === NARRATOR VALIDATION ===
        if let Some(narrator) = &metadata.narrator {
            validate_narrator_field(narrator, &metadata.author, &mut issues);
        }

        // === DESCRIPTION VALIDATION ===
        validate_description_field(&metadata.description, &mut issues);

        // === MISSING FIELDS ===
        check_missing_fields(metadata, &mut issues);

        // Count issues by type for summary
        for issue in &issues {
            let key = format!("{:?}", issue.issue_type);
            *issue_summary.entry(key).or_insert(0) += 1;
        }

        let error_count = issues.iter().filter(|i| i.severity == IssueSeverity::Error).count();
        let warning_count = issues.iter().filter(|i| i.severity == IssueSeverity::Warning).count();

        if error_count > 0 {
            books_with_errors += 1;
        }
        if warning_count > 0 {
            books_with_warnings += 1;
        }

        // Only include books with issues
        if !issues.is_empty() {
            books_results.push(BookValidationResult {
                book_id: group.id.clone(),
                title: metadata.title.clone(),
                author: metadata.author.clone(),
                issues,
                error_count,
                warning_count,
            });
        }
    }

    // Sort by error count descending
    books_results.sort_by(|a, b| {
        b.error_count.cmp(&a.error_count)
            .then(b.warning_count.cmp(&a.warning_count))
    });

    Ok(LibraryValidationResult {
        books: books_results,
        total_scanned: groups.len(),
        books_with_errors,
        books_with_warnings,
        issue_summary,
    })
}

/// Analyze authors across the library to find matching/normalization opportunities
#[command]
pub async fn analyze_authors(groups: Vec<BookGroup>) -> Result<AuthorMatchResult, String> {
    let mut author_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut author_books: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // Collect all authors and their variations
    for group in &groups {
        let author = group.metadata.author.trim();
        if author.is_empty() {
            continue;
        }

        let lower = author.to_lowercase();
        author_map
            .entry(lower.clone())
            .or_insert_with(Vec::new)
            .push(author.to_string());
        *author_books.entry(lower).or_insert(0) += 1;
    }

    let mut authors: Vec<AuthorCandidate> = Vec::new();
    let mut needs_normalization: Vec<AuthorCandidate> = Vec::new();
    let mut suspicious_authors: Vec<AuthorCandidate> = Vec::new();

    for (lower_name, variations) in author_map {
        // Deduplicate variations while keeping order
        let unique_variations: Vec<String> = variations
            .into_iter()
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        let book_count = *author_books.get(&lower_name).unwrap_or(&0);

        // Check for canonical form
        let canonical = AUTHOR_CANONICAL.get(lower_name.as_str()).map(|s| s.to_string());

        // Use the first variation as the primary name
        let primary_name = unique_variations.first().cloned().unwrap_or(lower_name.clone());

        // Check if this is a known invalid author
        let is_invalid = INVALID_AUTHORS.contains(lower_name.as_str());

        // Check if author looks suspicious
        let validation_result = validate_author(&primary_name);
        let is_suspicious = matches!(
            validation_result.action,
            crate::validation::ValidationAction::NeedsGpt | crate::validation::ValidationAction::Rejected
        );

        let is_canonical = canonical.is_some() && Some(primary_name.clone()) == canonical;

        let candidate = AuthorCandidate {
            name: primary_name.clone(),
            canonical: canonical.clone(),
            book_count,
            is_canonical,
            variations: unique_variations.clone(),
        };

        authors.push(candidate.clone());

        // Authors that need normalization (have canonical form but don't match)
        if canonical.is_some() && !is_canonical {
            needs_normalization.push(candidate.clone());
        }

        // Suspicious authors (invalid or need GPT verification)
        if is_invalid || is_suspicious {
            suspicious_authors.push(candidate);
        }
    }

    // Sort by book count descending
    authors.sort_by(|a, b| b.book_count.cmp(&a.book_count));
    needs_normalization.sort_by(|a, b| b.book_count.cmp(&a.book_count));
    suspicious_authors.sort_by(|a, b| b.book_count.cmp(&a.book_count));

    Ok(AuthorMatchResult {
        authors,
        needs_normalization,
        suspicious_authors,
    })
}

// === VALIDATION HELPER FUNCTIONS ===

fn validate_author_field(author: &str, issues: &mut Vec<ValidationIssue>) {
    if author.trim().is_empty() {
        issues.push(ValidationIssue {
            issue_type: IssueType::MissingField,
            severity: IssueSeverity::Error,
            field: "author".to_string(),
            current_value: None,
            suggested_value: None,
            message: "Author is missing".to_string(),
        });
        return;
    }

    let result = validate_author(author);
    let lower = author.to_lowercase();

    // Check if it's a known invalid author
    if INVALID_AUTHORS.contains(lower.as_str()) {
        issues.push(ValidationIssue {
            issue_type: IssueType::InvalidAuthor,
            severity: IssueSeverity::Error,
            field: "author".to_string(),
            current_value: Some(author.to_string()),
            suggested_value: None,
            message: format!("'{}' is a publisher/organization, not an author", author),
        });
        return;
    }

    // Check for canonical normalization
    if let Some(canonical) = AUTHOR_CANONICAL.get(lower.as_str()) {
        if *canonical != author {
            issues.push(ValidationIssue {
                issue_type: IssueType::AuthorNeedsNormalization,
                severity: IssueSeverity::Warning,
                field: "author".to_string(),
                current_value: Some(author.to_string()),
                suggested_value: Some(canonical.to_string()),
                message: format!("Author should be normalized to '{}'", canonical),
            });
        }
    }

    // Check validation result
    match result.action {
        crate::validation::ValidationAction::Rejected => {
            issues.push(ValidationIssue {
                issue_type: IssueType::InvalidAuthor,
                severity: IssueSeverity::Error,
                field: "author".to_string(),
                current_value: Some(author.to_string()),
                suggested_value: None,
                message: result.reason.unwrap_or_else(|| "Author rejected by validation".to_string()),
            });
        }
        crate::validation::ValidationAction::NeedsGpt => {
            issues.push(ValidationIssue {
                issue_type: IssueType::SuspiciousAuthor,
                severity: IssueSeverity::Warning,
                field: "author".to_string(),
                current_value: Some(author.to_string()),
                suggested_value: None,
                message: result.reason.unwrap_or_else(|| "Author has suspicious patterns".to_string()),
            });
        }
        crate::validation::ValidationAction::Normalized => {
            if let Some(normalized) = &result.value {
                if normalized != author {
                    issues.push(ValidationIssue {
                        issue_type: IssueType::AuthorNeedsNormalization,
                        severity: IssueSeverity::Info,
                        field: "author".to_string(),
                        current_value: Some(author.to_string()),
                        suggested_value: Some(normalized.clone()),
                        message: format!("Author can be normalized to '{}'", normalized),
                    });
                }
            }
        }
        crate::validation::ValidationAction::Accepted => {}
    }

    // Check if ALL CAPS
    if author.len() > 5 && author == author.to_uppercase() {
        issues.push(ValidationIssue {
            issue_type: IssueType::SuspiciousAuthor,
            severity: IssueSeverity::Warning,
            field: "author".to_string(),
            current_value: Some(author.to_string()),
            suggested_value: None,
            message: "Author name is ALL CAPS - might be a format error".to_string(),
        });
    }
}

fn validate_title_field(
    title: &str,
    series: &Option<String>,
    author: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    if title.trim().is_empty() {
        issues.push(ValidationIssue {
            issue_type: IssueType::MissingField,
            severity: IssueSeverity::Error,
            field: "title".to_string(),
            current_value: None,
            suggested_value: None,
            message: "Title is missing".to_string(),
        });
        return;
    }

    // Check if title is ALL CAPS
    if title.len() > 5 && title == title.to_uppercase() {
        issues.push(ValidationIssue {
            issue_type: IssueType::TitleAllCaps,
            severity: IssueSeverity::Warning,
            field: "title".to_string(),
            current_value: Some(title.to_string()),
            suggested_value: None,
            message: "Title is ALL CAPS".to_string(),
        });
    }

    // Check if title contains book/series number patterns
    let number_patterns = [
        r"(?i)\bbook\s+\d+\b",
        r"(?i)#\d+\b",
        r"(?i)\bvol(?:ume)?\.?\s*\d+\b",
        r"(?i)\bpart\s+\d+\b",
    ];
    for pattern in &number_patterns {
        if regex::Regex::new(pattern).unwrap().is_match(title) {
            issues.push(ValidationIssue {
                issue_type: IssueType::TitleContainsSeriesNumber,
                severity: IssueSeverity::Info,
                field: "title".to_string(),
                current_value: Some(title.to_string()),
                suggested_value: None,
                message: "Title contains series/book number - could be extracted to sequence".to_string(),
            });
            break;
        }
    }

    // Check if title matches series name
    if let Some(series) = series {
        if title.to_lowercase().trim() == series.to_lowercase().trim() {
            issues.push(ValidationIssue {
                issue_type: IssueType::TitleMatchesSeries,
                severity: IssueSeverity::Warning,
                field: "title".to_string(),
                current_value: Some(title.to_string()),
                suggested_value: None,
                message: "Title is identical to series name - might be missing actual title".to_string(),
            });
        }
    }
}

fn validate_series_field(
    series: &Option<String>,
    sequence: &Option<String>,
    author: &str,
    title: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    if let Some(series_name) = series {
        let lower = series_name.to_lowercase();

        // Check if series is in invalid list
        if INVALID_SERIES.contains(lower.as_str()) {
            issues.push(ValidationIssue {
                issue_type: IssueType::InvalidSeries,
                severity: IssueSeverity::Error,
                field: "series".to_string(),
                current_value: Some(series_name.clone()),
                suggested_value: None,
                message: format!("'{}' is not a valid series (publisher/placeholder)", series_name),
            });
            return;
        }

        // Check if series matches author name
        if AUTHOR_AS_SERIES.contains(lower.as_str()) {
            issues.push(ValidationIssue {
                issue_type: IssueType::SeriesMatchesAuthor,
                severity: IssueSeverity::Error,
                field: "series".to_string(),
                current_value: Some(series_name.clone()),
                suggested_value: None,
                message: format!("'{}' is an author name, not a series", series_name),
            });
            return;
        }

        // Check series ownership
        if let Some(valid_authors) = SERIES_OWNERSHIP.get(lower.as_str()) {
            let author_lower = author.to_lowercase();
            if !valid_authors.iter().any(|a| author_lower.contains(a)) {
                issues.push(ValidationIssue {
                    issue_type: IssueType::SeriesOwnershipMismatch,
                    severity: IssueSeverity::Warning,
                    field: "series".to_string(),
                    current_value: Some(series_name.clone()),
                    suggested_value: None,
                    message: format!(
                        "'{}' series typically belongs to {} - author '{}' may be misattributed",
                        series_name,
                        valid_authors.join(" or "),
                        author
                    ),
                });
            }
        }

        // Check for missing sequence
        if sequence.is_none() || sequence.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
            issues.push(ValidationIssue {
                issue_type: IssueType::MissingSequence,
                severity: IssueSeverity::Info,
                field: "sequence".to_string(),
                current_value: None,
                suggested_value: None,
                message: format!("Book is in series '{}' but has no sequence number", series_name),
            });
        }

        // Check for invalid sequence values
        if let Some(seq) = sequence {
            let seq_lower = seq.to_lowercase();
            let invalid_seq = ["null", "or null", "none", "n/a", "na", "unknown", "?", "tbd"];
            if invalid_seq.contains(&seq_lower.as_str()) {
                issues.push(ValidationIssue {
                    issue_type: IssueType::InvalidSequence,
                    severity: IssueSeverity::Warning,
                    field: "sequence".to_string(),
                    current_value: Some(seq.clone()),
                    suggested_value: None,
                    message: "Sequence has invalid placeholder value".to_string(),
                });
            }
        }
    }
}

fn validate_narrator_field(narrator: &str, author: &str, issues: &mut Vec<ValidationIssue>) {
    if narrator.trim().is_empty() {
        return;
    }

    // Check if narrator matches author
    if narrator.to_lowercase().trim() == author.to_lowercase().trim() {
        issues.push(ValidationIssue {
            issue_type: IssueType::NarratorMatchesAuthor,
            severity: IssueSeverity::Info,
            field: "narrator".to_string(),
            current_value: Some(narrator.to_string()),
            suggested_value: None,
            message: "Narrator is the same as author - may be self-narrated".to_string(),
        });
    }

    // Check for suspicious narrator names (publishers, etc.)
    let lower = narrator.to_lowercase();
    if INVALID_AUTHORS.contains(lower.as_str()) {
        issues.push(ValidationIssue {
            issue_type: IssueType::SuspiciousNarrator,
            severity: IssueSeverity::Warning,
            field: "narrator".to_string(),
            current_value: Some(narrator.to_string()),
            suggested_value: None,
            message: format!("'{}' doesn't look like a narrator name", narrator),
        });
    }
}

fn validate_description_field(description: &Option<String>, issues: &mut Vec<ValidationIssue>) {
    match description {
        None => {
            issues.push(ValidationIssue {
                issue_type: IssueType::DescriptionMissing,
                severity: IssueSeverity::Info,
                field: "description".to_string(),
                current_value: None,
                suggested_value: None,
                message: "Description is missing".to_string(),
            });
        }
        Some(desc) => {
            let trimmed = desc.trim();

            // Check if too short
            if trimmed.len() < 50 {
                issues.push(ValidationIssue {
                    issue_type: IssueType::DescriptionTooShort,
                    severity: IssueSeverity::Info,
                    field: "description".to_string(),
                    current_value: Some(trimmed.to_string()),
                    suggested_value: None,
                    message: format!("Description is very short ({} characters)", trimmed.len()),
                });
            }

            // Check for HTML tags
            let html_regex = regex::Regex::new(r"<[^>]+>").unwrap();
            if html_regex.is_match(trimmed) {
                issues.push(ValidationIssue {
                    issue_type: IssueType::DescriptionContainsHtml,
                    severity: IssueSeverity::Warning,
                    field: "description".to_string(),
                    current_value: Some(trimmed.chars().take(100).collect()),
                    suggested_value: None,
                    message: "Description contains HTML tags".to_string(),
                });
            }
        }
    }
}

fn check_missing_fields(metadata: &crate::scanner::types::BookMetadata, issues: &mut Vec<ValidationIssue>) {
    // Check for missing cover URL
    if metadata.cover_url.is_none() {
        issues.push(ValidationIssue {
            issue_type: IssueType::MissingField,
            severity: IssueSeverity::Info,
            field: "cover".to_string(),
            current_value: None,
            suggested_value: None,
            message: "No cover art available".to_string(),
        });
    }

    // Check for missing genres
    if metadata.genres.is_empty() {
        issues.push(ValidationIssue {
            issue_type: IssueType::MissingField,
            severity: IssueSeverity::Info,
            field: "genres".to_string(),
            current_value: None,
            suggested_value: None,
            message: "No genres assigned".to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_severity_order() {
        assert!(IssueSeverity::Error != IssueSeverity::Warning);
    }
}
