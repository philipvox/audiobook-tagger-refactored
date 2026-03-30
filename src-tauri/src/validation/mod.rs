//! Pre-GPT validation and normalization for audiobook metadata.
//!
//! This module provides fast, local validation that runs BEFORE
//! expensive GPT calls to filter out obvious errors and normalize
//! common variants.

mod authors;
pub mod lookups;
mod series;
mod titles;

pub use authors::{normalize_author_initials, validate_author};
pub use lookups::*;
pub use series::{quick_reject_series, validate_series};
pub use titles::{clean_title, remove_book_number, remove_series_from_title};

/// Result of validating a metadata field
#[derive(Debug, Clone)]
pub struct ValidationResult<T> {
    /// The validated/normalized value, if valid
    pub value: Option<T>,
    /// Original input for logging
    pub original: String,
    /// What action was taken
    pub action: ValidationAction,
    /// Human-readable reason (for logging/debugging)
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationAction {
    /// Valid as-is or after minor cleanup
    Accepted,
    /// Invalid, should be treated as null/None
    Rejected,
    /// Can't determine locally, needs GPT verification
    NeedsGpt,
    /// Valid but was normalized to canonical form
    Normalized,
}

impl ValidationAction {
    /// Returns true if the value should be used
    pub fn is_usable(&self) -> bool {
        matches!(self, Self::Accepted | Self::Normalized | Self::NeedsGpt)
    }

    /// Returns true if we have a definitive local answer
    pub fn is_definitive(&self) -> bool {
        matches!(self, Self::Accepted | Self::Normalized | Self::Rejected)
    }
}

/// Batch validation for processing entire library
#[derive(Debug, Default)]
pub struct ValidationStats {
    pub total: usize,
    pub accepted: usize,
    pub normalized: usize,
    pub rejected: usize,
    pub needs_gpt: usize,
}

impl ValidationStats {
    pub fn record(&mut self, action: ValidationAction) {
        self.total += 1;
        match action {
            ValidationAction::Accepted => self.accepted += 1,
            ValidationAction::Normalized => self.normalized += 1,
            ValidationAction::Rejected => self.rejected += 1,
            ValidationAction::NeedsGpt => self.needs_gpt += 1,
        }
    }

    pub fn summary(&self) -> String {
        format!(
            "Validation: {} total, {} accepted, {} normalized, {} rejected, {} need GPT",
            self.total, self.accepted, self.normalized, self.rejected, self.needs_gpt
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validation_action_usable() {
        assert!(ValidationAction::Accepted.is_usable());
        assert!(ValidationAction::Normalized.is_usable());
        assert!(ValidationAction::NeedsGpt.is_usable());
        assert!(!ValidationAction::Rejected.is_usable());
    }

    #[test]
    fn test_validation_action_definitive() {
        assert!(ValidationAction::Accepted.is_definitive());
        assert!(ValidationAction::Normalized.is_definitive());
        assert!(ValidationAction::Rejected.is_definitive());
        assert!(!ValidationAction::NeedsGpt.is_definitive());
    }

    #[test]
    fn test_validation_stats() {
        let mut stats = ValidationStats::default();
        stats.record(ValidationAction::Accepted);
        stats.record(ValidationAction::Accepted);
        stats.record(ValidationAction::Rejected);
        stats.record(ValidationAction::Normalized);

        assert_eq!(stats.total, 4);
        assert_eq!(stats.accepted, 2);
        assert_eq!(stats.rejected, 1);
        assert_eq!(stats.normalized, 1);
        assert_eq!(stats.needs_gpt, 0);
    }
}
