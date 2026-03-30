//! Audio-text alignment module for Immersion Reading.
//!
//! This module provides:
//! - Forced alignment between audio and text using Aeneas
//! - Chapter matching between audio and EPUB
//! - Job queue for batch processing
//! - Export to various formats (JSON, VTT, SRT)

pub mod aeneas;
pub mod queue;

use crate::chapters::Chapter as AudioChapter;
use crate::epub::{EpubChapter, EpubContent};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ============================================================================
// ALIGNMENT DATA STRUCTURES
// ============================================================================

/// Complete alignment data for a book
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookAlignment {
    pub book_id: String,
    pub title: String,
    pub author: String,
    pub language: String,
    pub granularity: AlignmentGranularity,
    pub total_duration: f64,
    pub chapters: Vec<ChapterAlignment>,
    pub created_at: DateTime<Utc>,
    pub version: String,
}

/// Alignment granularity level
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AlignmentGranularity {
    Word,
    Sentence,
    Paragraph,
}

impl Default for AlignmentGranularity {
    fn default() -> Self {
        Self::Word
    }
}

/// Alignment data for a single chapter
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterAlignment {
    pub index: usize,
    pub title: String,
    pub audio_start: f64,
    pub audio_end: f64,
    pub text_start_char: usize,
    pub text_end_char: usize,
    pub fragments: Vec<AlignedFragment>,
}

/// A single aligned text fragment (sentence or paragraph)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedFragment {
    pub id: String,
    pub begin: f64,
    pub end: f64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<AlignedWord>,
}

/// Word-level alignment
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedWord {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

// ============================================================================
// MATCHED CHAPTER (Audio <-> EPUB mapping)
// ============================================================================

/// A matched chapter (audio chapter + EPUB chapter aligned)
#[derive(Debug, Clone)]
pub struct MatchedChapter {
    pub index: usize,
    pub title: String,
    pub audio_start: f64,
    pub audio_end: f64,
    pub text: String,
    pub text_start_char: usize,
    pub text_end_char: usize,
}

// ============================================================================
// ALIGNMENT OPTIONS
// ============================================================================

/// Options for running alignment
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentOptions {
    #[serde(default)]
    pub granularity: AlignmentGranularity,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub force_realign: bool,
}

fn default_language() -> String {
    "eng".to_string()
}

impl Default for AlignmentOptions {
    fn default() -> Self {
        Self {
            granularity: AlignmentGranularity::Word,
            language: "eng".to_string(),
            force_realign: false,
        }
    }
}

// ============================================================================
// CHAPTER MATCHING
// ============================================================================

/// Match audio chapters to EPUB chapters
pub fn match_chapters(
    audio_chapters: &[AudioChapter],
    epub_chapters: &[EpubChapter],
    full_text: &str,
) -> Vec<MatchedChapter> {
    // Strategy 1: If counts match, assume 1:1 correspondence
    if audio_chapters.len() == epub_chapters.len() {
        return audio_chapters
            .iter()
            .zip(epub_chapters.iter())
            .enumerate()
            .map(|(i, (audio, epub))| MatchedChapter {
                index: i,
                title: epub.title.clone(),
                audio_start: audio.start_time,
                audio_end: audio.end_time,
                text: epub.text.clone(),
                text_start_char: epub.start_char,
                text_end_char: epub.end_char,
            })
            .collect();
    }

    // Strategy 2: Try to match by title similarity
    let mut matched = Vec::new();
    let mut used_audio: Vec<bool> = vec![false; audio_chapters.len()];
    let mut used_epub: Vec<bool> = vec![false; epub_chapters.len()];

    // First pass: exact title matches
    for (ei, epub) in epub_chapters.iter().enumerate() {
        for (ai, audio) in audio_chapters.iter().enumerate() {
            if !used_audio[ai] && !used_epub[ei] && titles_match(&audio.title, &epub.title) {
                matched.push((ai, ei));
                used_audio[ai] = true;
                used_epub[ei] = true;
                break;
            }
        }
    }

    // Second pass: fuzzy matching for unmatched
    for (ei, epub) in epub_chapters.iter().enumerate() {
        if !used_epub[ei] {
            let mut best_match = None;
            let mut best_score = 0.0;

            for (ai, audio) in audio_chapters.iter().enumerate() {
                if !used_audio[ai] {
                    let score = title_similarity(&audio.title, &epub.title);
                    if score > best_score && score > 0.4 {
                        best_score = score;
                        best_match = Some(ai);
                    }
                }
            }

            if let Some(ai) = best_match {
                matched.push((ai, ei));
                used_audio[ai] = true;
                used_epub[ei] = true;
            }
        }
    }

    // Sort by audio chapter index
    matched.sort_by_key(|(ai, _)| *ai);

    // Build result
    let result: Vec<MatchedChapter> = matched
        .iter()
        .enumerate()
        .map(|(i, (ai, ei))| {
            let audio = &audio_chapters[*ai];
            let epub = &epub_chapters[*ei];

            MatchedChapter {
                index: i,
                title: epub.title.clone(),
                audio_start: audio.start_time,
                audio_end: audio.end_time,
                text: epub.text.clone(),
                text_start_char: epub.start_char,
                text_end_char: epub.end_char,
            }
        })
        .collect();

    // If we couldn't match any chapters, fall back to treating entire book as one chapter
    if result.is_empty() {
        let total_duration = audio_chapters.last().map(|c| c.end_time).unwrap_or(0.0);

        return vec![MatchedChapter {
            index: 0,
            title: "Full Book".to_string(),
            audio_start: 0.0,
            audio_end: total_duration,
            text: full_text.to_string(),
            text_start_char: 0,
            text_end_char: full_text.len(),
        }];
    }

    result
}

/// Check if two titles are effectively the same
fn titles_match(a: &str, b: &str) -> bool {
    normalize_title(a) == normalize_title(b)
}

/// Calculate similarity between two titles (0.0 to 1.0)
fn title_similarity(a: &str, b: &str) -> f64 {
    let a = normalize_title(a);
    let b = normalize_title(b);

    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    // Jaccard similarity on words
    let words_a: std::collections::HashSet<_> = a.split_whitespace().collect();
    let words_b: std::collections::HashSet<_> = b.split_whitespace().collect();

    let intersection = words_a.intersection(&words_b).count();
    let union = words_a.union(&words_b).count();

    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

/// Normalize a title for comparison
fn normalize_title(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ============================================================================
// EXPORT FORMATS
// ============================================================================

/// Export alignment as VTT (WebVTT) subtitles
pub fn export_vtt(alignment: &BookAlignment) -> String {
    let mut output = String::from("WEBVTT\n\n");

    for chapter in &alignment.chapters {
        output.push_str(&format!("NOTE Chapter: {}\n\n", chapter.title));

        for fragment in &chapter.fragments {
            output.push_str(&format!(
                "{} --> {}\n{}\n\n",
                format_vtt_time(fragment.begin),
                format_vtt_time(fragment.end),
                fragment.text
            ));
        }
    }

    output
}

/// Export alignment as SRT subtitles
pub fn export_srt(alignment: &BookAlignment) -> String {
    let mut output = String::new();
    let mut index = 1;

    for chapter in &alignment.chapters {
        for fragment in &chapter.fragments {
            output.push_str(&format!(
                "{}\n{} --> {}\n{}\n\n",
                index,
                format_srt_time(fragment.begin),
                format_srt_time(fragment.end),
                fragment.text
            ));
            index += 1;
        }
    }

    output
}

/// Format time as VTT timestamp (HH:MM:SS.mmm)
fn format_vtt_time(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0) as u64;
    let ms = total_ms % 1000;
    let total_secs = total_ms / 1000;
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let hours = total_mins / 60;

    format!("{:02}:{:02}:{:02}.{:03}", hours, mins, secs, ms)
}

/// Format time as SRT timestamp (HH:MM:SS,mmm)
fn format_srt_time(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0) as u64;
    let ms = total_ms % 1000;
    let total_secs = total_ms / 1000;
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let hours = total_mins / 60;

    format!("{:02}:{:02}:{:02},{:03}", hours, mins, secs, ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_title() {
        assert_eq!(normalize_title("Chapter 1: The Beginning"), "chapter 1 the beginning");
        assert_eq!(normalize_title("CHAPTER ONE"), "chapter one");
    }

    #[test]
    fn test_titles_match() {
        assert!(titles_match("Chapter 1", "chapter 1"));
        assert!(titles_match("The Beginning", "The Beginning"));
        assert!(!titles_match("Chapter 1", "Chapter 2"));
    }

    #[test]
    fn test_title_similarity() {
        assert!(title_similarity("Chapter One", "Chapter 1") > 0.3);
        assert!(title_similarity("Introduction", "Prologue") < 0.5);
    }

    #[test]
    fn test_format_vtt_time() {
        assert_eq!(format_vtt_time(0.0), "00:00:00.000");
        assert_eq!(format_vtt_time(90.5), "00:01:30.500");
        assert_eq!(format_vtt_time(3661.25), "01:01:01.250");
    }

    #[test]
    fn test_format_srt_time() {
        assert_eq!(format_srt_time(0.0), "00:00:00,000");
        assert_eq!(format_srt_time(90.5), "00:01:30,500");
    }
}
