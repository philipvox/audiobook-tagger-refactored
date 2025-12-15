// src-tauri/src/scanner/types.rs
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

/// Helper to deserialize a value that can be either a string or an integer into Option<String>
/// GPT sometimes returns numbers as integers instead of strings
fn deserialize_string_or_int<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::{self, Visitor};

    struct StringOrIntVisitor;

    impl<'de> Visitor<'de> for StringOrIntVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string, integer, or null")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserializer.deserialize_any(StringOrIntInnerVisitor)
        }
    }

    struct StringOrIntInnerVisitor;

    impl<'de> Visitor<'de> for StringOrIntInnerVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or integer")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(Some(value))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            // For floats, check if it's a whole number
            if value.fract() == 0.0 {
                Ok(Some((value as i64).to_string()))
            } else {
                Ok(Some(value.to_string()))
            }
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(None)
        }
    }

    deserializer.deserialize_option(StringOrIntVisitor)
}

/// Metadata source - where did this piece of data come from?
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MetadataSource {
    /// Extracted from existing file tags (ID3, M4A atoms, etc.)
    FileTag,
    /// Inferred from folder structure/naming
    Folder,
    /// Scraped from Audible
    Audible,
    /// Retrieved from iTunes/Apple Books API
    ITunes,
    /// Cleaned/enhanced by GPT
    Gpt,
    /// Manually entered by user
    Manual,
    /// Unknown/default source
    Unknown,
    /// Retrieved via AudiobookShelf search API (proxied Audible/Google/iTunes)
    Abs,
    /// Retrieved from custom providers (Goodreads, Hardcover, Storytel via abs-agg)
    CustomProvider,
}

impl Default for MetadataSource {
    fn default() -> Self {
        MetadataSource::Unknown
    }
}

/// Tracks the source of each metadata field
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MetadataSources {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrator: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genres: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asin: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<MetadataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<MetadataSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub groups: Vec<BookGroup>,
    pub total_files: usize,
    pub total_groups: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookGroup {
    pub id: String,
    pub group_name: String,
    pub group_type: GroupType,
    pub metadata: BookMetadata,
    pub files: Vec<AudioFile>,
    pub total_changes: usize,
    /// Indicates how metadata was obtained (loaded from file vs new scan)
    #[serde(default = "default_scan_status")]
    pub scan_status: ScanStatus,
}

fn default_scan_status() -> ScanStatus {
    ScanStatus::NotScanned
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupType {
    Single,
    Chapters,
    MultiPart,
}

/// Indicates how metadata was obtained for this book
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScanStatus {
    /// Metadata was loaded from existing metadata.json file (no API calls needed)
    LoadedFromFile,
    /// Metadata was fetched fresh from APIs (new scan)
    NewScan,
    /// Book was imported but not yet scanned
    NotScanned,
}

/// Scan mode options for different rescan behaviors
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScanMode {
    /// Default: Skip if metadata.json exists
    #[default]
    Normal,
    /// Bypass metadata.json but use cached API results (quick refresh)
    RefreshMetadata,
    /// Clear all caches AND bypass metadata.json (full fresh scan)
    ForceFresh,
    /// Re-fetch only specified fields (selective refresh)
    SelectiveRefresh,
    /// Maximum accuracy mode: retries, multi-source validation, GPT on all books
    SuperScanner,
}

/// Specifies which metadata fields to refresh during a selective rescan
/// When a field is true, it will be re-fetched from APIs (ignoring cached/file values)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct SelectiveRefreshFields {
    /// Refresh author/authors from API sources
    #[serde(default)]
    pub authors: bool,
    /// Refresh narrator/narrators from API sources
    #[serde(default)]
    pub narrators: bool,
    /// Refresh description from API sources
    #[serde(default)]
    pub description: bool,
    /// Refresh series/sequence from API sources
    #[serde(default)]
    pub series: bool,
    /// Refresh genres from API sources
    #[serde(default)]
    pub genres: bool,
    /// Refresh publisher from API sources
    #[serde(default)]
    pub publisher: bool,
    /// Refresh cover art
    #[serde(default)]
    pub cover: bool,
    /// Refresh all fields (equivalent to ForceFresh but preserves file structure)
    #[serde(default)]
    pub all: bool,
}

impl SelectiveRefreshFields {
    /// Returns true if any field is selected for refresh
    pub fn any_selected(&self) -> bool {
        self.authors || self.narrators || self.description ||
        self.series || self.genres || self.publisher || self.cover || self.all
    }

    /// Create a SelectiveRefreshFields with all fields enabled
    pub fn all_fields() -> Self {
        Self {
            authors: true,
            narrators: true,
            description: true,
            series: true,
            genres: true,
            publisher: true,
            cover: true,
            all: true,
        }
    }
}

/// Confidence scores for metadata fields (0-100)
/// Used by SuperScanner to indicate data quality
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MetadataConfidence {
    /// Confidence in title accuracy (0-100)
    #[serde(default)]
    pub title: u8,
    /// Confidence in author accuracy (0-100)
    #[serde(default)]
    pub author: u8,
    /// Confidence in narrator accuracy (0-100)
    #[serde(default)]
    pub narrator: u8,
    /// Confidence in series accuracy (0-100)
    #[serde(default)]
    pub series: u8,
    /// Overall metadata confidence (0-100)
    #[serde(default)]
    pub overall: u8,
    /// List of sources that contributed to this metadata
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources_used: Vec<String>,
}

/// Priority order for metadata sources (higher = more trusted)
/// API sources are now prioritized over file metadata
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SourcePriority {
    /// File tags are lowest priority (may be corrupted/wrong)
    FileTag = 1,
    /// Folder name parsing
    Folder = 2,
    /// Unknown source
    Unknown = 3,
    /// iTunes/Apple Books API
    ITunes = 4,
    /// Audible scraping (highly reliable for audiobooks)
    Audible = 5,
    /// GPT-enhanced (validated against APIs)
    Gpt = 6,
    /// User manually entered (highest trust)
    Manual = 7,
}

impl From<MetadataSource> for SourcePriority {
    fn from(source: MetadataSource) -> Self {
        match source {
            MetadataSource::FileTag => SourcePriority::FileTag,
            MetadataSource::Folder => SourcePriority::Folder,
            MetadataSource::Unknown => SourcePriority::Unknown,
            MetadataSource::ITunes => SourcePriority::ITunes,
            MetadataSource::Audible => SourcePriority::Audible,
            MetadataSource::Abs => SourcePriority::Audible, // Same priority as Audible (proxied)
            MetadataSource::CustomProvider => SourcePriority::Audible, // Same priority as Audible (Goodreads/Hardcover)
            MetadataSource::Gpt => SourcePriority::Gpt,
            MetadataSource::Manual => SourcePriority::Manual,
        }
    }
}

/// Represents a single series entry with name, position, and source
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SeriesInfo {
    /// Series name (e.g., "Merlin Missions", "Magic Tree House")
    pub name: String,
    /// Position/sequence in this series (e.g., "1", "2.5", "1-3")
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_string_or_int")]
    pub sequence: Option<String>,
    /// Where this series info came from
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<MetadataSource>,
}

impl SeriesInfo {
    pub fn new(name: String, sequence: Option<String>, source: Option<MetadataSource>) -> Self {
        Self { name, sequence, source }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BookMetadata {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_string_or_int")]
    pub sequence: Option<String>,
    /// Multiple series support - books can belong to multiple series
    /// e.g., "Magic Tree House: Merlin Missions" belongs to both "Magic Tree House" AND "Merlin Missions"
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub all_series: Vec<SeriesInfo>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_string_or_int")]
    pub year: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_mime: Option<String>,

    // NEW FIELDS for complete metadata capture
    /// Multiple authors support (for "Author1 & Author2" cases)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    /// Multiple narrators support (ABS supports multiple)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub narrators: Vec<String>,
    /// ISO language code (e.g., "en", "es", "de")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Whether the audiobook is abridged
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abridged: Option<bool>,
    /// Total runtime in minutes
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_minutes: Option<u32>,
    /// Content is explicit (contains mature content)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explicit: Option<bool>,
    /// Full publish date in YYYY-MM-DD format
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish_date: Option<String>,

    /// Source tracking - where each metadata field came from
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<MetadataSources>,

    // COLLECTION DETECTION FIELDS
    /// Whether this audiobook is a collection/omnibus containing multiple books
    #[serde(default)]
    pub is_collection: bool,
    /// List of individual book titles if this is a collection
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub collection_books: Vec<String>,

    // CONFIDENCE TRACKING (SuperScanner)
    /// Confidence scores for metadata accuracy (only set by SuperScanner mode)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<MetadataConfidence>,

    // THEMES & TROPES (GPT-generated insights)
    /// Philosophical/conceptual themes the book explores (max 3)
    /// e.g., "Mortality", "Identity", "The Cost of Power"
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub themes: Vec<String>,
    /// Plot-based story elements/patterns (max 3, spoiler-free)
    /// e.g., "Revenge", "Heist", "Enemies to Lovers"
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tropes: Vec<String>,
    /// Source of themes data: "gpt", "api", or "manual"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub themes_source: Option<String>,
    /// Source of tropes data: "gpt", "api", or "manual"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tropes_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFile {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub changes: HashMap<String, MetadataChange>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataChange {
    pub old: String,
    pub new: String,
}

pub type FieldChange = MetadataChange;

// RawFileData - simple version for collector.rs
// processor.rs defines its own local version with tags
#[derive(Debug, Clone)]
pub struct RawFileData {
    pub path: String,
    pub filename: String,
    pub parent_dir: String,
}