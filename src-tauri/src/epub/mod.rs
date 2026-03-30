//! EPUB parsing module for text extraction and chapter detection.
//!
//! This module provides:
//! - EPUB file parsing (ZIP-based format)
//! - Table of contents extraction
//! - Plain text extraction per chapter
//! - Metadata extraction

pub mod parser;

use serde::{Deserialize, Serialize};

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/// Complete content extracted from an EPUB
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpubContent {
    pub metadata: EpubMetadata,
    pub chapters: Vec<EpubChapter>,
    pub full_text: String,
}

/// EPUB metadata
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EpubMetadata {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub language: Option<String>,
    pub identifier: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
}

/// A single chapter extracted from an EPUB
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpubChapter {
    pub index: usize,
    pub title: String,
    pub href: String,
    pub text: String,
    pub start_char: usize,  // Start position in full_text
    pub end_char: usize,    // End position in full_text
    pub word_count: usize,
}

impl EpubChapter {
    /// Create a new chapter with calculated word count
    pub fn new(
        index: usize,
        title: String,
        href: String,
        text: String,
        start_char: usize,
        end_char: usize,
    ) -> Self {
        let word_count = text.split_whitespace().count();
        Self {
            index,
            title,
            href,
            text,
            start_char,
            end_char,
            word_count,
        }
    }
}

/// Preview info for an EPUB (before full parsing)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpubPreview {
    pub path: String,
    pub metadata: EpubMetadata,
    pub chapter_count: usize,
    pub estimated_words: usize,
}

// Re-export parser functions
pub use parser::parse_epub;
pub use parser::preview_epub;
