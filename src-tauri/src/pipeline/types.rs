// src-tauri/src/pipeline/types.rs
// Type definitions for the metadata pipeline

use serde::{Deserialize, Serialize};

// ============================================================================
// SOURCE DATA - Raw data from a single source
// ============================================================================

/// Raw data from a single source - no processing applied
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceData {
    /// Source identifier: "abs", "abs_metadata", "goodreads", "hardcover", etc.
    pub source: String,

    /// How reliable is this source? 0-100
    pub confidence: u8,

    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub narrators: Vec<String>,
    pub series: Vec<SeriesEntry>,
    pub genres: Vec<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub year: Option<String>,
    pub isbn: Option<String>,
    pub asin: Option<String>,
    pub language: Option<String>,
    pub cover_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SeriesEntry {
    pub name: String,
    pub sequence: Option<String>,
}

// ============================================================================
// AGGREGATED DATA - All sources collected before GPT processing
// ============================================================================

/// All raw data collected for one book before GPT processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedBookData {
    /// ABS item ID
    pub id: String,

    /// All sources collected for this book
    pub sources: Vec<SourceData>,

    /// Other books in the same series (for GPT context)
    pub series_context: Vec<SeriesContextBook>,
}

/// Minimal info about another book in the series
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesContextBook {
    pub title: String,
    pub sequence: Option<String>,
    pub author: String,
    pub series_name: String,
}

// ============================================================================
// RESOLVED METADATA - GPT output after processing
// ============================================================================

/// What GPT returns - the unified, decided metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedMetadata {
    pub title: String,
    pub subtitle: Option<String>,
    pub author: String,
    pub authors: Vec<String>,
    pub narrator: Option<String>,
    pub narrators: Vec<String>,
    pub series: Vec<ResolvedSeries>,
    pub genres: Vec<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub year: Option<String>,
    pub language: Option<String>,

    /// Themes extracted from description
    #[serde(default)]
    pub themes: Vec<String>,
    /// Tropes extracted from description
    #[serde(default)]
    pub tropes: Vec<String>,

    /// GPT's reasoning for debugging
    #[serde(default)]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedSeries {
    pub name: String,
    pub sequence: Option<String>,
    #[serde(default)]
    pub is_primary: bool,
    #[serde(default)]
    pub is_subseries_of: Option<String>,
}

impl Default for ResolvedMetadata {
    fn default() -> Self {
        Self {
            title: String::new(),
            subtitle: None,
            author: String::new(),
            authors: vec![],
            narrator: None,
            narrators: vec![],
            series: vec![],
            genres: vec![],
            description: None,
            publisher: None,
            year: None,
            language: None,
            themes: vec![],
            tropes: vec![],
            reasoning: None,
        }
    }
}

// ============================================================================
// PIPELINE RESULT - Final output
// ============================================================================

/// Result of processing a book through the pipeline
#[derive(Debug, Clone)]
pub struct PipelineResult {
    pub id: String,
    pub metadata: ResolvedMetadata,
    pub sources_used: Vec<String>,
    pub warnings: Vec<String>,
}

/// Batch processing progress
#[derive(Debug, Clone, Serialize)]
pub struct PipelineProgress {
    pub current: usize,
    pub total: usize,
    pub phase: String,
    pub message: String,
}

// ============================================================================
// HELPER IMPLEMENTATIONS
// ============================================================================

impl SourceData {
    /// Create a new SourceData with just the required fields
    pub fn new(source: &str, confidence: u8) -> Self {
        Self {
            source: source.to_string(),
            confidence,
            ..Default::default()
        }
    }

    /// Check if this source has any useful data
    pub fn has_data(&self) -> bool {
        self.title.is_some()
            || !self.authors.is_empty()
            || !self.series.is_empty()
            || !self.genres.is_empty()
    }
}

impl SeriesEntry {
    pub fn new(name: String, sequence: Option<String>) -> Self {
        Self { name, sequence }
    }
}

impl AggregatedBookData {
    /// Get all unique series names from all sources
    pub fn all_series_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .sources
            .iter()
            .flat_map(|s| s.series.iter().map(|se| se.name.clone()))
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// Get the highest confidence title
    pub fn best_title(&self) -> Option<String> {
        self.sources
            .iter()
            .filter(|s| s.title.is_some())
            .max_by_key(|s| s.confidence)
            .and_then(|s| s.title.clone())
    }

    /// Get the highest confidence author
    pub fn best_author(&self) -> Option<String> {
        self.sources
            .iter()
            .filter(|s| !s.authors.is_empty())
            .max_by_key(|s| s.confidence)
            .and_then(|s| s.authors.first().cloned())
    }
}

impl ResolvedSeries {
    pub fn new(name: String, sequence: Option<String>, is_primary: bool) -> Self {
        Self {
            name,
            sequence,
            is_primary,
            is_subseries_of: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_source_data_creation() {
        let source = SourceData::new("test", 90);
        assert_eq!(source.source, "test");
        assert_eq!(source.confidence, 90);
        assert!(!source.has_data());
    }

    #[test]
    fn test_source_data_with_title() {
        let mut source = SourceData::new("test", 90);
        source.title = Some("Test Book".to_string());
        assert!(source.has_data());
    }

    #[test]
    fn test_aggregated_best_title() {
        let data = AggregatedBookData {
            id: "test".to_string(),
            sources: vec![
                SourceData {
                    source: "low".to_string(),
                    confidence: 50,
                    title: Some("Low Confidence Title".to_string()),
                    ..Default::default()
                },
                SourceData {
                    source: "high".to_string(),
                    confidence: 90,
                    title: Some("High Confidence Title".to_string()),
                    ..Default::default()
                },
            ],
            series_context: vec![],
        };

        assert_eq!(
            data.best_title(),
            Some("High Confidence Title".to_string())
        );
    }

    #[test]
    fn test_all_series_names() {
        let data = AggregatedBookData {
            id: "test".to_string(),
            sources: vec![
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
            ],
            series_context: vec![],
        };

        let names = data.all_series_names();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"Series A".to_string()));
        assert!(names.contains(&"Series B".to_string()));
        assert!(names.contains(&"Series C".to_string()));
    }
}
