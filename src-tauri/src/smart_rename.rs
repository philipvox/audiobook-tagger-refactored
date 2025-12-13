// src-tauri/src/smart_rename.rs
// AI-powered smart rename functionality for audiobook files and folders

use anyhow::{anyhow, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

use crate::file_rename::sanitize_filename;
use crate::scanner::collector::natural_cmp;
use crate::scanner::processor::call_gpt_api;
use crate::whisper::{self, TranscriptionResult};

// ============================================================================
// Types
// ============================================================================

/// What kind of audiobook structure are we dealing with?
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AudiobookType {
    /// Single M4B file - one file = whole book
    SingleFile,
    /// Multiple parts (Part 1.mp3, Part 2.mp3) - same book split by size
    MultiPart,
    /// Chapter files (Chapter 01.mp3, Chapter 02.mp3) - one file per chapter
    ChapterSplit,
    /// Unknown/Mixed structure
    Unknown,
}

/// How the chapter name was detected
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChapterDetectionSource {
    /// Extracted from filename pattern
    Filename,
    /// From embedded metadata tags
    FileTag,
    /// GPT inference from context
    GptInference,
    /// Fallback generic naming
    Generic,
}

/// Detected chapter information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedChapter {
    pub file_path: String,
    pub original_filename: String,
    pub detected_number: Option<u32>,
    pub detected_title: Option<String>,
    pub proposed_filename: String,
    pub confidence: u8,
    pub source: ChapterDetectionSource,
}

/// Book detection result from GPT
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedBookInfo {
    pub id: String,
    pub folder_path: String,
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub year: Option<String>,
    pub audiobook_type: AudiobookType,
    pub chapters: Vec<DetectedChapter>,
    pub confidence: u8,
}

/// Type of file change proposed
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FileChangeType {
    /// Just rename the file in place
    Rename,
    /// Move to new folder and rename
    MoveAndRename,
    /// No change needed
    NoChange,
}

/// Proposed file rename
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRenameProposal {
    pub id: String,
    pub source_path: String,
    pub proposed_path: String,
    pub change_type: FileChangeType,
    pub confidence: u8,
    pub reason: String,
    pub selected: bool,
}

/// Proposed folder rename/move
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRenameProposal {
    pub id: String,
    pub source_path: String,
    pub proposed_path: String,
    pub file_count: usize,
    pub confidence: u8,
    pub reason: String,
    pub creates_structure: bool,
    pub selected: bool,
}

/// Issue types detected during analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SmartRenameIssueType {
    GenericFilenames,
    MessyBookTitle,
    MissingChapterNames,
    InconsistentNaming,
    FlatStructure,
    AmbiguousContent,
}

/// An issue found during analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartRenameIssue {
    pub path: String,
    pub issue_type: SmartRenameIssueType,
    pub description: String,
    pub severity: u8,
}

/// Statistics from the analysis
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AnalysisStatistics {
    pub total_files: usize,
    pub total_folders: usize,
    pub files_to_rename: usize,
    pub folders_to_rename: usize,
    pub chapter_files_detected: usize,
    pub single_file_books: usize,
    pub multi_part_books: usize,
}

/// Full analysis result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartRenameAnalysis {
    pub root_path: String,
    pub detected_books: Vec<DetectedBookInfo>,
    pub file_proposals: Vec<FileRenameProposal>,
    pub folder_proposals: Vec<FolderRenameProposal>,
    pub issues: Vec<SmartRenameIssue>,
    pub statistics: AnalysisStatistics,
}

/// Result of applying renames
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartRenameResult {
    pub success: bool,
    pub files_renamed: usize,
    pub folders_moved: usize,
    pub errors: Vec<String>,
    pub backup_path: Option<String>,
}

/// Options for analysis
#[derive(Debug, Clone)]
pub struct AnalysisOptions {
    pub include_subfolders: bool,
    pub infer_chapters: bool,
    pub target_structure: String,
    /// Enable audio transcription to verify title/author from narrator intro
    pub enable_transcription: bool,
    /// Force analysis even if folder/file names look good
    pub force_analysis: bool,
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        Self {
            include_subfolders: true,
            infer_chapters: true,
            target_structure: "audiobookshelf".to_string(),
            enable_transcription: false, // Off by default (requires OpenAI API)
            force_analysis: false,
        }
    }
}

// ============================================================================
// Audio file info
// ============================================================================

#[derive(Debug, Clone)]
struct AudioFileInfo {
    path: String,
    filename: String,
    extension: String,
    size_bytes: u64,
}

// Minimum size for a valid audio file (1 MB) - smaller files are likely corrupt/placeholders
const MIN_AUDIO_FILE_SIZE: u64 = 1_000_000;

fn is_audio_file(path: &Path) -> bool {
    let audio_extensions = ["mp3", "m4a", "m4b", "flac", "ogg", "opus", "wma", "aac", "wav"];
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| audio_extensions.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn collect_audio_files(folder: &str) -> Vec<AudioFileInfo> {
    let mut files = Vec::new();
    let mut skipped_tiny = Vec::new();

    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() && is_audio_file(&path) {
                let size_bytes = fs::metadata(&path)
                    .map(|m| m.len())
                    .unwrap_or(0);

                // Skip tiny files (likely corrupt/placeholders)
                if size_bytes < MIN_AUDIO_FILE_SIZE {
                    skipped_tiny.push(path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default());
                    continue;
                }

                files.push(AudioFileInfo {
                    path: path.to_string_lossy().to_string(),
                    filename: path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    extension: path.extension()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    size_bytes,
                });
            }
        }
    }

    if !skipped_tiny.is_empty() {
        println!("   Skipped {} tiny files (<1MB, likely corrupt): {:?}",
            skipped_tiny.len(), skipped_tiny);
    }

    // Sort by filename using natural sort for correct chapter ordering
    // e.g., "Chapter 2" < "Chapter 10" (not alphabetical)
    files.sort_by(|a, b| natural_cmp(&a.filename, &b.filename));
    files
}

// ============================================================================
// Audiobook type detection
// ============================================================================

fn detect_audiobook_type(files: &[AudioFileInfo]) -> AudiobookType {
    if files.is_empty() {
        return AudiobookType::Unknown;
    }

    // Single M4B file is usually a complete book
    if files.len() == 1 {
        let ext = files[0].extension.to_lowercase();
        if ext == "m4b" {
            return AudiobookType::SingleFile;
        }
    }

    lazy_static::lazy_static! {
        static ref PART_PATTERN: Regex = Regex::new(r"(?i)\bpart\s*\d+").unwrap();
        static ref DISC_PATTERN: Regex = Regex::new(r"(?i)\b(disc|disk|cd)\s*\d+").unwrap();
        static ref CHAPTER_PATTERN: Regex = Regex::new(r"(?i)\bchapter\s*\d+").unwrap();
        static ref TRACK_PATTERN: Regex = Regex::new(r"(?i)\btrack\s*\d+").unwrap();
        static ref NUMBERED_PATTERN: Regex = Regex::new(r"^\d{1,3}[\s_\-\.]").unwrap();
    }

    let mut part_count = 0;
    let mut disc_count = 0;
    let mut chapter_count = 0;
    let mut track_count = 0;
    let mut numbered_count = 0;

    for file in files {
        let name = &file.filename;
        if PART_PATTERN.is_match(name) { part_count += 1; }
        if DISC_PATTERN.is_match(name) { disc_count += 1; }
        if CHAPTER_PATTERN.is_match(name) { chapter_count += 1; }
        if TRACK_PATTERN.is_match(name) { track_count += 1; }
        if NUMBERED_PATTERN.is_match(name) { numbered_count += 1; }
    }

    let total = files.len();

    // If most files have "Part" or "Disc" pattern, it's multi-part
    if (part_count + disc_count) > total / 2 {
        return AudiobookType::MultiPart;
    }

    // If files have chapter patterns or are numbered, it's chapter-split
    if chapter_count > total / 2 || track_count > total / 2 || numbered_count > total / 2 {
        return AudiobookType::ChapterSplit;
    }

    // Few files might be multi-part even without explicit patterns
    if files.len() <= 10 {
        AudiobookType::MultiPart
    } else {
        AudiobookType::ChapterSplit
    }
}

// ============================================================================
// Generic name detection
// ============================================================================

fn has_generic_names(files: &[AudioFileInfo]) -> bool {
    lazy_static::lazy_static! {
        static ref GENERIC_PATTERNS: Vec<Regex> = vec![
            Regex::new(r"(?i)^track\s*\d+").unwrap(),
            Regex::new(r"^\d{1,3}\.(mp3|m4a|m4b|flac)$").unwrap(),
            Regex::new(r"^\d{1,3}[\s_\-]").unwrap(),
        ];
    }

    let generic_count = files.iter()
        .filter(|f| GENERIC_PATTERNS.iter().any(|p| p.is_match(&f.filename)))
        .count();

    generic_count > files.len() / 2
}

// ============================================================================
// GPT Prompts
// ============================================================================

fn build_book_detection_prompt(folder_path: &str, folder_name: &str, files: &[AudioFileInfo]) -> String {
    // For large file counts, only show first/last few files to keep prompt small
    let file_list = if files.len() > 10 {
        let first_5: Vec<_> = files.iter().take(5).map(|f| format!("- {}", f.filename)).collect();
        let last_3: Vec<_> = files.iter().rev().take(3).rev().map(|f| format!("- {}", f.filename)).collect();
        format!("{}\n... ({} more files) ...\n{}",
            first_5.join("\n"),
            files.len() - 8,
            last_3.join("\n"))
    } else {
        files.iter().map(|f| format!("- {}", f.filename)).collect::<Vec<_>>().join("\n")
    };

    // For many files, don't ask for individual chapter details - too much output
    let (chapter_instruction, chapter_example) = if files.len() > 15 {
        (
            "For chapters array, just return an EMPTY array []. We will infer chapter names separately.",
            r#""chapters": []"#.to_string()
        )
    } else {
        (
            "For chapter_split books with multiple files, include chapter info for EACH file. If you know this book's actual chapter titles, use them. Otherwise use numbered chapters.",
            format!(r#""chapters": [
    {{"filename": "{}", "number": 1, "title": "Chapter 1", "proposed_name": "01 - Chapter 1.mp3"}},
    {{"filename": "{}", "number": 2, "title": "Chapter 2", "proposed_name": "02 - Chapter 2.mp3"}}
  ]"#,
                files.first().map(|f| f.filename.as_str()).unwrap_or("Track 01.mp3"),
                files.get(1).map(|f| f.filename.as_str()).unwrap_or("Track 02.mp3")
            )
        )
    };

    format!(r#"Analyze these audiobook files and determine the correct book information.

FOLDER PATH: {folder_path}
FOLDER NAME: {folder_name}
FILES ({count} total):
{file_list}

TASK:
1. Identify the book title (clean, without ASIN codes or quality markers)
2. Identify the author name (First Last format)
3. Identify series name and sequence number if applicable
4. Determine audiobook_type: "single_file", "multi_part", or "chapter_split"
5. {chapter_instruction}

GUIDELINES:
- Remove [ASIN], (128kbps), upload tags, etc from title
- If files are named "Track 01.mp3" or "001.mp3", still try to identify the book from the folder name
- For series, extract just the series name without the book number
- IMPORTANT: Each chapter must have a unique "number" starting from 1 and incrementing

Return ONLY valid JSON (no markdown, no explanation):
{{
  "title": "Clean Book Title",
  "author": "Author Name",
  "series": null,
  "sequence": null,
  "year": null,
  "audiobook_type": "chapter_split",
  {chapter_example},
  "confidence": 85
}}"#,
        folder_path = folder_path,
        folder_name = folder_name,
        count = files.len(),
        file_list = file_list,
        chapter_instruction = chapter_instruction,
        chapter_example = chapter_example
    )
}

/// Build prompt that includes transcript from audio intro
fn build_book_detection_prompt_with_transcript(
    folder_path: &str,
    folder_name: &str,
    files: &[AudioFileInfo],
    transcription: &TranscriptionResult,
) -> String {
    // For large file counts, only show first/last few files to keep prompt small
    let file_list = if files.len() > 10 {
        let first_5: Vec<_> = files.iter().take(5).map(|f| format!("- {}", f.filename)).collect();
        let last_3: Vec<_> = files.iter().rev().take(3).rev().map(|f| format!("- {}", f.filename)).collect();
        format!("{}\n... ({} more files) ...\n{}",
            first_5.join("\n"),
            files.len() - 8,
            last_3.join("\n"))
    } else {
        files.iter().map(|f| format!("- {}", f.filename)).collect::<Vec<_>>().join("\n")
    };

    // Build extracted info section
    let mut extracted_hints = String::new();
    if let Some(ref title) = transcription.extracted_title {
        extracted_hints.push_str(&format!("- Possible title heard: \"{}\"\n", title));
    }
    if let Some(ref author) = transcription.extracted_author {
        extracted_hints.push_str(&format!("- Possible author heard: \"{}\"\n", author));
    }
    if let Some(ref narrator) = transcription.extracted_narrator {
        extracted_hints.push_str(&format!("- Narrator heard: \"{}\"\n", narrator));
    }

    // Truncate transcript to avoid huge prompts
    let transcript_preview = if transcription.transcript.len() > 500 {
        format!("{}...", &transcription.transcript[..500])
    } else {
        transcription.transcript.clone()
    };

    format!(r#"Analyze these audiobook files and determine the correct book information.

FOLDER PATH: {folder_path}
FOLDER NAME: {folder_name}
FILES ({count} total):
{file_list}

AUDIO TRANSCRIPT (first 90 seconds of narrator's introduction):
"{transcript_preview}"

EXTRACTED FROM AUDIO:
{extracted_hints}

TASK:
1. Use the audio transcript to VERIFY the book title and author
2. The narrator often says "This is [Title] by [Author]" at the start
3. If the transcript clearly states the title/author, use those values
4. Clean the title (remove ASIN codes, quality markers, etc.)
5. Format author as "First Last"
6. Identify series name and sequence number if mentioned
7. Determine audiobook_type: "single_file", "multi_part", or "chapter_split"

IMPORTANT: The audio transcript is the MOST reliable source for title/author.
Trust what the narrator says over folder names or file names.

Return ONLY valid JSON (no markdown, no explanation):
{{
  "title": "Clean Book Title",
  "author": "Author Name",
  "series": null,
  "sequence": null,
  "year": null,
  "audiobook_type": "chapter_split",
  "chapters": [],
  "confidence": 95
}}"#,
        folder_path = folder_path,
        folder_name = folder_name,
        count = files.len(),
        file_list = file_list,
        transcript_preview = transcript_preview,
        extracted_hints = if extracted_hints.is_empty() {
            "(No clear title/author detected from audio)".to_string()
        } else {
            extracted_hints
        }
    )
}

fn build_chapter_inference_prompt(title: &str, author: &str, files: &[AudioFileInfo]) -> String {
    let file_list = files.iter()
        .enumerate()
        .map(|(i, f)| format!("{}. {}", i + 1, f.filename))
        .collect::<Vec<_>>()
        .join("\n");

    format!(r#"This audiobook is "{title}" by {author}.

The audio files have generic names. If you know this book, provide the actual chapter titles.

FILES:
{file_list}

TASK:
- If you recognize this book, provide actual chapter titles
- If you don't know this book, provide generic but descriptive names like "Chapter 1", "Chapter 2"
- Match the number of chapters to the number of files

Return ONLY valid JSON:
{{
  "known_book": true,
  "chapters": [
    {{"filename": "Track 01.mp3", "number": 1, "title": "Chapter One Title", "proposed_name": "01 - Chapter One Title.mp3"}}
  ]
}}"#,
        title = title,
        author = author,
        file_list = file_list
    )
}

// ============================================================================
// GPT Response Parsing
// ============================================================================

use serde::de::{self, Deserializer};

/// Deserialize a value that could be a string or an integer into Option<String>
fn string_or_int<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Visitor;

    struct StringOrIntVisitor;

    impl<'de> Visitor<'de> for StringOrIntVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string, an integer, or null")
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

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value.is_empty() {
                Ok(None)
            } else {
                Ok(Some(value.to_string()))
            }
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value.is_empty() {
                Ok(None)
            } else {
                Ok(Some(value))
            }
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
    }

    deserializer.deserialize_any(StringOrIntVisitor)
}

/// Deserialize a string that might be null
fn nullable_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Visitor;

    struct NullableStringVisitor;

    impl<'de> Visitor<'de> for NullableStringVisitor {
        type Value = String;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or null")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(String::new())
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(String::new())
        }

        fn visit_some<D2>(self, deserializer: D2) -> Result<Self::Value, D2::Error>
        where
            D2: Deserializer<'de>,
        {
            // Handle Some(null) case - delegate to deserialize_any
            deserializer.deserialize_any(NullableStringVisitor)
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(value.to_string())
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(value)
        }
    }

    deserializer.deserialize_any(NullableStringVisitor)
}

#[derive(Debug, Deserialize)]
struct GptBookResponse {
    #[serde(default, deserialize_with = "nullable_string")]
    title: String,
    #[serde(default, deserialize_with = "nullable_string")]
    author: String,
    #[serde(default)]
    series: Option<String>,
    #[serde(default, deserialize_with = "string_or_int")]
    sequence: Option<String>,
    #[serde(default, deserialize_with = "string_or_int")]
    year: Option<String>,
    #[serde(default, deserialize_with = "nullable_string")]
    audiobook_type: String,
    #[serde(default)]
    chapters: Vec<GptChapterResponse>,
    #[serde(default)]
    confidence: u8,
}

#[derive(Debug, Deserialize)]
struct GptChapterResponse {
    #[serde(default)]
    filename: String,
    #[serde(default)]
    number: u32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    proposed_name: String,
}

#[derive(Debug, Deserialize)]
struct GptChapterInferenceResponse {
    #[serde(default)]
    known_book: bool,
    #[serde(default)]
    chapters: Vec<GptChapterResponse>,
}

fn parse_gpt_book_response(response: &str) -> Result<GptBookResponse> {
    // Try to extract JSON from the response
    let json_str = match extract_json(response) {
        Ok(json) => json,
        Err(_) => {
            // If no valid JSON found, try regex extraction as last resort
            return extract_book_info_regex(response);
        }
    };

    // Try to parse, and if chapters fail, try without chapters
    match serde_json::from_str::<GptBookResponse>(&json_str) {
        Ok(parsed) => Ok(parsed),
        Err(e) => {
            // Try to parse as a simpler structure without chapters
            #[derive(Debug, Deserialize)]
            struct SimpleBookResponse {
                #[serde(default, deserialize_with = "nullable_string")]
                title: String,
                #[serde(default, deserialize_with = "nullable_string")]
                author: String,
                #[serde(default)]
                series: Option<String>,
                #[serde(default, deserialize_with = "string_or_int")]
                sequence: Option<String>,
                #[serde(default, deserialize_with = "string_or_int")]
                year: Option<String>,
                #[serde(default, deserialize_with = "nullable_string")]
                audiobook_type: String,
                #[serde(default)]
                confidence: u8,
            }

            match serde_json::from_str::<SimpleBookResponse>(&json_str) {
                Ok(simple) => {
                    // Successfully parsed without chapters
                    Ok(GptBookResponse {
                        title: simple.title,
                        author: simple.author,
                        series: simple.series,
                        sequence: simple.sequence,
                        year: simple.year,
                        audiobook_type: simple.audiobook_type,
                        chapters: Vec::new(),
                        confidence: simple.confidence,
                    })
                }
                Err(_) => {
                    // Try repairing truncated JSON
                    let repaired = repair_truncated_json(&json_str);
                    if let Ok(parsed) = serde_json::from_str::<GptBookResponse>(&repaired) {
                        return Ok(parsed);
                    }
                    if let Ok(simple) = serde_json::from_str::<SimpleBookResponse>(&repaired) {
                        return Ok(GptBookResponse {
                            title: simple.title,
                            author: simple.author,
                            series: simple.series,
                            sequence: simple.sequence,
                            year: simple.year,
                            audiobook_type: simple.audiobook_type,
                            chapters: Vec::new(),
                            confidence: simple.confidence,
                        });
                    }

                    // Last resort: regex extraction
                    extract_book_info_regex(&json_str)
                        .map_err(|_| anyhow!("Failed to parse GPT response: {}", e))
                }
            }
        }
    }
}

/// Attempt to repair truncated JSON by closing unclosed structures
fn repair_truncated_json(json: &str) -> String {
    let mut result = json.to_string();

    // Track what needs closing
    let mut in_string = false;
    let mut escape_next = false;
    let mut open_braces: i32 = 0;
    let mut open_brackets: i32 = 0;

    for c in json.chars() {
        if escape_next {
            escape_next = false;
            continue;
        }

        match c {
            '\\' if in_string => escape_next = true,
            '"' => in_string = !in_string,
            '{' if !in_string => open_braces += 1,
            '}' if !in_string => open_braces = open_braces.saturating_sub(1),
            '[' if !in_string => open_brackets += 1,
            ']' if !in_string => open_brackets = open_brackets.saturating_sub(1),
            _ => {}
        }
    }

    // Close unclosed string
    if in_string {
        result.push('"');
    }

    // Close unclosed arrays and objects
    for _ in 0..open_brackets {
        result.push(']');
    }
    for _ in 0..open_braces {
        result.push('}');
    }

    result
}

/// Extract book info using regex when JSON parsing fails
fn extract_book_info_regex(text: &str) -> Result<GptBookResponse> {
    lazy_static::lazy_static! {
        static ref TITLE_RE: Regex = Regex::new(r#""title"\s*:\s*"([^"]+)""#).unwrap();
        static ref AUTHOR_RE: Regex = Regex::new(r#""author"\s*:\s*"([^"]+)""#).unwrap();
        static ref SERIES_RE: Regex = Regex::new(r#""series"\s*:\s*"([^"]+)""#).unwrap();
        static ref TYPE_RE: Regex = Regex::new(r#""audiobook_type"\s*:\s*"([^"]+)""#).unwrap();
        static ref CONFIDENCE_RE: Regex = Regex::new(r#""confidence"\s*:\s*(\d+)"#).unwrap();
    }

    let title = TITLE_RE.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let author = AUTHOR_RE.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    if title.is_empty() && author.is_empty() {
        return Err(anyhow!("Could not extract title or author from response"));
    }

    let series = SERIES_RE.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    let audiobook_type = TYPE_RE.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "single_file".to_string());

    let confidence = CONFIDENCE_RE.captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse().ok())
        .unwrap_or(60);

    Ok(GptBookResponse {
        title,
        author,
        series,
        sequence: None,
        year: None,
        audiobook_type,
        chapters: Vec::new(),
        confidence,
    })
}

fn parse_gpt_chapter_response(response: &str) -> Result<GptChapterInferenceResponse> {
    let json_str = extract_json(response)?;
    serde_json::from_str(&json_str)
        .map_err(|e| anyhow!("Failed to parse GPT chapter response: {}", e))
}

fn extract_json(text: &str) -> Result<String> {
    // Handle empty or whitespace-only response
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow!("Empty response"));
    }

    // Find JSON object in response - need to match braces properly
    if let Some(start) = text.find('{') {
        // Count braces to find the matching closing brace
        let mut depth = 0;
        let mut in_string = false;
        let mut escape_next = false;
        let mut end_pos = None;

        for (i, c) in text[start..].char_indices() {
            if escape_next {
                escape_next = false;
                continue;
            }

            match c {
                '\\' if in_string => escape_next = true,
                '"' => in_string = !in_string,
                '{' if !in_string => depth += 1,
                '}' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        end_pos = Some(start + i);
                        break;
                    }
                }
                _ => {}
            }
        }

        if let Some(end) = end_pos {
            let json_str = &text[start..=end];
            // Verify it's valid JSON by doing a quick parse check
            if serde_json::from_str::<serde_json::Value>(json_str).is_ok() {
                return Ok(json_str.to_string());
            }
        }

        // Fallback to simple approach if brace matching failed
        if let Some(end) = text.rfind('}') {
            if end >= start {
                return Ok(text[start..=end].to_string());
            }
        }
    }

    Err(anyhow!("No JSON found in response"))
}

// ============================================================================
// Main Analysis Function (Parallel Processing)
// ============================================================================

/// Check if a folder already has good naming (skip GPT call)
fn folder_needs_analysis(folder_name: &str, files: &[AudioFileInfo]) -> bool {
    // If folder name looks like "Author - Title" or "Author/Title", might be OK
    // But if files have generic names, we still need analysis
    if has_generic_names(files) {
        println!("   📁 {} - needs analysis (generic filenames)", folder_name);
        return true;
    }

    // Check if folder name is meaningful
    let clean_name = folder_name.to_lowercase();

    // Skip if folder is just numbers/generic
    if clean_name.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-' || c == '_') {
        println!("   📁 {} - needs analysis (generic folder name)", folder_name);
        return true;
    }

    // Check if files already have good names (not Track01, 001, etc)
    let generic_count = files.iter()
        .filter(|f| {
            let name = f.filename.to_lowercase();
            name.starts_with("track") ||
            name.chars().take_while(|c| c.is_ascii_digit()).count() >= 2
        })
        .count();

    // If most files are generic, needs analysis
    let needs_it = generic_count > files.len() / 3;

    if needs_it {
        println!("   📁 {} - needs analysis ({}/{} files have generic names)",
            folder_name, generic_count, files.len());
    } else {
        println!("   📁 {} - SKIPPING (folder and files look good, {}/{} generic)",
            folder_name, generic_count, files.len());
    }

    needs_it
}

/// Analyze a single folder (for parallel processing)
async fn analyze_single_folder(
    folder_path: String,
    files: Vec<AudioFileInfo>,
    root_path: String,
    api_key: String,
    _infer_chapters: bool,
    enable_transcription: bool,
    force_analysis: bool,
) -> FolderAnalysisResult {
    let folder_name = Path::new(&folder_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // Quick check: skip if naming looks good already (unless force mode)
    if !force_analysis && !folder_needs_analysis(&folder_name, &files) {
        return FolderAnalysisResult {
            folder_path,
            book_info: None,
            file_proposals: Vec::new(),
            folder_proposal: None,
            issues: Vec::new(),
            skipped: true,
            transcription: None,
        };
    }

    if force_analysis {
        println!("   📁 {} - analyzing (force mode)", folder_name);
    }

    let mut issues = Vec::new();

    // Detect issues
    if has_generic_names(&files) {
        issues.push(SmartRenameIssue {
            path: folder_path.clone(),
            issue_type: SmartRenameIssueType::GenericFilenames,
            description: "Files have generic names (Track01, 001, etc.)".to_string(),
            severity: 2,
        });
    }

    // Step 1: Try to transcribe first audio file's intro (if enabled)
    let transcription: Option<TranscriptionResult> = if enable_transcription && !files.is_empty() {
        // Use the first audio file (usually chapter 1 or part 1)
        let first_audio = &files[0];
        println!("   🎤 Transcribing intro of: {}", first_audio.filename);

        match whisper::transcribe_audio_intro(&first_audio.path, 90, &api_key).await {
            Ok(result) => {
                if result.extracted_title.is_some() || result.extracted_author.is_some() {
                    println!("   🎤 Heard title: {:?}", result.extracted_title);
                    println!("   🎤 Heard author: {:?}", result.extracted_author);
                    if result.extracted_narrator.is_some() {
                        println!("   🎤 Heard narrator: {:?}", result.extracted_narrator);
                    }
                } else {
                    println!("   🎤 No clear title/author detected in intro");
                }
                Some(result)
            }
            Err(e) => {
                println!("   ⚠️ Transcription failed: {}", e);
                None
            }
        }
    } else {
        None
    };

    // Step 2: Build GPT prompt (include transcript if available)
    let prompt = if let Some(ref trans) = transcription {
        build_book_detection_prompt_with_transcript(&folder_path, &folder_name, &files, trans)
    } else {
        build_book_detection_prompt(&folder_path, &folder_name, &files)
    };

    match call_gpt_api(&prompt, &api_key, "gpt-5.1-codex-mini", 2000).await {
        Ok(response) => {
            match parse_gpt_book_response(&response) {
                Ok(book_response) => {
                    println!("   📖 GPT detected: \"{}\" by {} ({} chapters returned)",
                        book_response.title, book_response.author, book_response.chapters.len());

                    // Log chapter info for debugging
                    if !book_response.chapters.is_empty() {
                        for (i, ch) in book_response.chapters.iter().take(3).enumerate() {
                            println!("      Chapter {}: num={}, filename='{}', title={:?}",
                                i, ch.number, ch.filename, ch.title);
                        }
                        if book_response.chapters.len() > 3 {
                            println!("      ... and {} more chapters", book_response.chapters.len() - 3);
                        }
                    }

                    let audiobook_type = match book_response.audiobook_type.as_str() {
                        "single_file" => AudiobookType::SingleFile,
                        "multi_part" => AudiobookType::MultiPart,
                        "chapter_split" => AudiobookType::ChapterSplit,
                        _ => detect_audiobook_type(&files),
                    };

                    // Convert GPT response to our types, or generate defaults if empty
                    // Check if GPT returned valid chapters (with actual numbers)
                    // If all chapters have number=0, fall back to generic numbering
                    let gpt_chapters_valid = !book_response.chapters.is_empty() &&
                        book_response.chapters.iter().any(|c| c.number > 0);

                    println!("   📊 GPT chapters valid: {} (using {} mode)",
                        gpt_chapters_valid,
                        if gpt_chapters_valid { "GPT chapters" } else { "fallback numbering" });

                    let chapters: Vec<DetectedChapter> = if book_response.chapters.is_empty() || !gpt_chapters_valid {
                        // Generate chapters from files with sequential numbering
                        files.iter()
                            .enumerate()
                            .map(|(idx, f)| {
                                let num = idx as u32 + 1;
                                let ext = &f.extension;
                                // Try to extract chapter title from GPT response if available
                                let gpt_chapter = book_response.chapters.iter()
                                    .find(|c| c.filename == f.filename || c.filename.is_empty())
                                    .and_then(|c| c.title.clone());

                                let has_gpt_title = gpt_chapter.is_some();
                                let proposed = if let Some(ref title) = gpt_chapter {
                                    format!("{:02} - {}.{}", num, sanitize_filename(title), ext)
                                } else {
                                    format!("{:02} - Chapter {}.{}", num, num, ext)
                                };

                                DetectedChapter {
                                    file_path: f.path.clone(),
                                    original_filename: f.filename.clone(),
                                    detected_number: Some(num),
                                    detected_title: gpt_chapter,
                                    proposed_filename: proposed,
                                    confidence: 70,
                                    source: if has_gpt_title {
                                        ChapterDetectionSource::GptInference
                                    } else {
                                        ChapterDetectionSource::Generic
                                    },
                                }
                            })
                            .collect()
                    } else {
                        // Use GPT-provided chapter info, but ensure numbering is correct
                        book_response.chapters.iter()
                            .enumerate()
                            .map(|(idx, c)| {
                                // Use actual number if valid, otherwise use index
                                let num = if c.number > 0 { c.number } else { idx as u32 + 1 };
                                let file = files.iter().find(|f| f.filename == c.filename);
                                let ext = file.map(|f| f.extension.as_str()).unwrap_or("mp3");

                                let proposed = if !c.proposed_name.is_empty() {
                                    c.proposed_name.clone()
                                } else if let Some(ref title) = c.title {
                                    format!("{:02} - {}.{}", num, sanitize_filename(title), ext)
                                } else {
                                    format!("{:02} - Chapter {}.{}", num, num, ext)
                                };

                                DetectedChapter {
                                    file_path: file.map(|f| f.path.clone()).unwrap_or_default(),
                                    original_filename: c.filename.clone(),
                                    detected_number: Some(num),
                                    detected_title: c.title.clone(),
                                    proposed_filename: proposed,
                                    confidence: book_response.confidence,
                                    source: if c.title.is_some() {
                                        ChapterDetectionSource::GptInference
                                    } else {
                                        ChapterDetectionSource::Generic
                                    },
                                }
                            })
                            .collect()
                    };

                    // Log generated chapters
                    println!("   📂 Generated {} chapters:", chapters.len());
                    for (i, ch) in chapters.iter().take(3).enumerate() {
                        println!("      [{}] {} -> {}",
                            i, ch.original_filename, ch.proposed_filename);
                    }
                    if chapters.len() > 3 {
                        println!("      ... and {} more", chapters.len() - 3);
                    }

                    // NOTE: Skipping second-pass chapter inference for speed
                    // Users can manually trigger chapter inference for specific books

                    let book_id = uuid::Uuid::new_v4().to_string();

                    let book_info = DetectedBookInfo {
                        id: book_id,
                        folder_path: folder_path.clone(),
                        title: book_response.title,
                        author: book_response.author,
                        series: book_response.series,
                        sequence: book_response.sequence,
                        year: book_response.year,
                        audiobook_type: audiobook_type.clone(),
                        chapters: chapters.clone(),
                        confidence: book_response.confidence,
                    };

                    // Generate proposals
                    let file_proposals = generate_file_proposals(&folder_path, &files, &book_info);
                    let folder_proposal = generate_folder_proposal(&folder_path, &root_path, &book_info);

                    FolderAnalysisResult {
                        folder_path,
                        book_info: Some(book_info),
                        file_proposals,
                        folder_proposal,
                        issues,
                        skipped: false,
                        transcription,
                    }
                }
                Err(e) => {
                    println!("   Failed to parse GPT response for {}: {}", folder_path, e);
                    issues.push(SmartRenameIssue {
                        path: folder_path.clone(),
                        issue_type: SmartRenameIssueType::AmbiguousContent,
                        description: format!("Could not analyze: {}", e),
                        severity: 3,
                    });
                    FolderAnalysisResult {
                        folder_path,
                        book_info: None,
                        file_proposals: Vec::new(),
                        folder_proposal: None,
                        issues,
                        skipped: false,
                        transcription,
                    }
                }
            }
        }
        Err(e) => {
            println!("   GPT API error for {}: {}", folder_path, e);
            issues.push(SmartRenameIssue {
                path: folder_path.clone(),
                issue_type: SmartRenameIssueType::AmbiguousContent,
                description: format!("API error: {}", e),
                severity: 3,
            });
            FolderAnalysisResult {
                folder_path,
                book_info: None,
                file_proposals: Vec::new(),
                folder_proposal: None,
                issues,
                skipped: false,
                transcription,
            }
        }
    }
}

struct FolderAnalysisResult {
    folder_path: String,
    book_info: Option<DetectedBookInfo>,
    file_proposals: Vec<FileRenameProposal>,
    folder_proposal: Option<FolderRenameProposal>,
    issues: Vec<SmartRenameIssue>,
    skipped: bool,
    transcription: Option<TranscriptionResult>,
}

pub async fn analyze_for_smart_rename(
    root_path: &str,
    api_key: &str,
    options: &AnalysisOptions,
) -> Result<SmartRenameAnalysis> {
    println!("AI Smart Rename: Analyzing {} (parallel mode)", root_path);

    let mut analysis = SmartRenameAnalysis {
        root_path: root_path.to_string(),
        detected_books: Vec::new(),
        file_proposals: Vec::new(),
        folder_proposals: Vec::new(),
        issues: Vec::new(),
        statistics: AnalysisStatistics::default(),
    };

    // Collect all folders with audio files
    let mut folders_with_audio: Vec<(String, Vec<AudioFileInfo>)> = Vec::new();

    if options.include_subfolders {
        for entry in WalkDir::new(root_path)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_dir())
        {
            let folder_path = entry.path().to_string_lossy().to_string();
            let files = collect_audio_files(&folder_path);
            if !files.is_empty() {
                analysis.statistics.total_files += files.len();
                folders_with_audio.push((folder_path, files));
            }
        }
    } else {
        let files = collect_audio_files(root_path);
        if !files.is_empty() {
            analysis.statistics.total_files = files.len();
            folders_with_audio.push((root_path.to_string(), files));
        }
    }

    analysis.statistics.total_folders = folders_with_audio.len();
    println!("   Found {} folders with {} audio files",
        folders_with_audio.len(), analysis.statistics.total_files);

    if folders_with_audio.is_empty() {
        return Ok(analysis);
    }

    // Process folders in parallel (up to 10 concurrent)
    let api_key = api_key.to_string();
    let root_path = root_path.to_string();
    let infer_chapters = options.infer_chapters;
    let enable_transcription = options.enable_transcription;
    let force_analysis = options.force_analysis;

    // Check FFmpeg availability if transcription is enabled
    if enable_transcription {
        if !whisper::check_ffmpeg_available() {
            println!("   ⚠️ FFmpeg not found - transcription disabled");
        } else {
            println!("   🎤 Audio transcription enabled (Whisper API)");
        }
    }

    if force_analysis {
        println!("   🔄 Force analysis mode - will analyze all folders");
    }

    // Use chunks to limit concurrency
    // Lower concurrency when transcription is enabled (more API calls per folder)
    let max_concurrent = if enable_transcription { 5 } else { 10 };

    for chunk in folders_with_audio.chunks(max_concurrent) {
        let futures: Vec<_> = chunk.iter()
            .map(|(folder_path, files)| {
                analyze_single_folder(
                    folder_path.clone(),
                    files.clone(),
                    root_path.clone(),
                    api_key.clone(),
                    infer_chapters,
                    enable_transcription && whisper::check_ffmpeg_available(),
                    force_analysis,
                )
            })
            .collect();

        let results = futures::future::join_all(futures).await;

        for result in results {
            if result.skipped {
                continue;
            }

            if let Some(book_info) = result.book_info {
                // Update statistics
                match book_info.audiobook_type {
                    AudiobookType::SingleFile => analysis.statistics.single_file_books += 1,
                    AudiobookType::MultiPart => analysis.statistics.multi_part_books += 1,
                    AudiobookType::ChapterSplit => {
                        analysis.statistics.chapter_files_detected += book_info.chapters.len();
                    }
                    _ => {}
                }
                analysis.detected_books.push(book_info);
            }

            analysis.file_proposals.extend(result.file_proposals);
            if let Some(fp) = result.folder_proposal {
                analysis.folder_proposals.push(fp);
            }
            analysis.issues.extend(result.issues);
        }

        println!("   Processed {} folders...",
            analysis.detected_books.len() + analysis.issues.len());
    }

    // Update statistics
    analysis.statistics.files_to_rename = analysis.file_proposals
        .iter()
        .filter(|p| p.change_type != FileChangeType::NoChange)
        .count();
    analysis.statistics.folders_to_rename = analysis.folder_proposals.len();

    println!("   Analysis complete: {} books, {} file renames, {} folder moves",
        analysis.detected_books.len(),
        analysis.statistics.files_to_rename,
        analysis.statistics.folders_to_rename
    );

    Ok(analysis)
}

// ============================================================================
// Chapter Name Inference
// ============================================================================

async fn infer_chapter_names(
    title: &str,
    author: &str,
    files: &[AudioFileInfo],
    api_key: &str,
) -> Result<Vec<DetectedChapter>> {
    println!("   Inferring chapter names for '{}' by {}", title, author);

    let prompt = build_chapter_inference_prompt(title, author, files);

    let response = call_gpt_api(&prompt, api_key, "gpt-5.1-codex-mini", 2000)
        .await
        .map_err(|e| anyhow!("GPT API error: {}", e))?;

    let parsed = parse_gpt_chapter_response(&response)?;

    let chapters = parsed.chapters.iter()
        .map(|c| {
            let file = files.iter().find(|f| f.filename == c.filename);
            DetectedChapter {
                file_path: file.map(|f| f.path.clone()).unwrap_or_default(),
                original_filename: c.filename.clone(),
                detected_number: Some(c.number),
                detected_title: c.title.clone(),
                proposed_filename: c.proposed_name.clone(),
                confidence: if parsed.known_book { 90 } else { 70 },
                source: if parsed.known_book {
                    ChapterDetectionSource::GptInference
                } else {
                    ChapterDetectionSource::Generic
                },
            }
        })
        .collect();

    Ok(chapters)
}

// ============================================================================
// Proposal Generation
// ============================================================================

fn generate_file_proposals(
    folder_path: &str,
    files: &[AudioFileInfo],
    book_info: &DetectedBookInfo,
) -> Vec<FileRenameProposal> {
    let mut proposals = Vec::new();

    match book_info.audiobook_type {
        AudiobookType::SingleFile => {
            // Single file: rename to "Author - Title.ext"
            if let Some(file) = files.first() {
                let new_name = format!("{} - {}.{}",
                    sanitize_filename(&book_info.author),
                    sanitize_filename(&book_info.title),
                    file.extension
                );

                if file.filename != new_name {
                    proposals.push(FileRenameProposal {
                        id: uuid::Uuid::new_v4().to_string(),
                        source_path: file.path.clone(),
                        proposed_path: format!("{}/{}", folder_path, new_name),
                        change_type: FileChangeType::Rename,
                        confidence: book_info.confidence,
                        reason: "Standardize single-file audiobook".to_string(),
                        selected: true,
                    });
                }
            }
        }
        AudiobookType::MultiPart => {
            // Multi-part: rename to "Author - Title - Part N.ext"
            for (idx, file) in files.iter().enumerate() {
                let new_name = format!("{} - {} - Part {}.{}",
                    sanitize_filename(&book_info.author),
                    sanitize_filename(&book_info.title),
                    idx + 1,
                    file.extension
                );

                if file.filename != new_name {
                    proposals.push(FileRenameProposal {
                        id: uuid::Uuid::new_v4().to_string(),
                        source_path: file.path.clone(),
                        proposed_path: format!("{}/{}", folder_path, new_name),
                        change_type: FileChangeType::Rename,
                        confidence: book_info.confidence,
                        reason: format!("Rename multi-part file {}", idx + 1),
                        selected: true,
                    });
                }
            }
        }
        AudiobookType::ChapterSplit => {
            // Chapter split: use detected chapter names
            for chapter in &book_info.chapters {
                if chapter.original_filename != chapter.proposed_filename {
                    proposals.push(FileRenameProposal {
                        id: uuid::Uuid::new_v4().to_string(),
                        source_path: chapter.file_path.clone(),
                        proposed_path: format!("{}/{}", folder_path, chapter.proposed_filename),
                        change_type: FileChangeType::Rename,
                        confidence: chapter.confidence,
                        reason: format!("Apply chapter name: {}",
                            chapter.detected_title.as_deref().unwrap_or("Chapter")),
                        selected: true,
                    });
                }
            }
        }
        AudiobookType::Unknown => {}
    }

    proposals
}

fn generate_folder_proposal(
    folder_path: &str,
    root_path: &str,
    book_info: &DetectedBookInfo,
) -> Option<FolderRenameProposal> {
    // Build ideal path
    let ideal_path = if let Some(ref series) = book_info.series {
        format!("{}/{}/{}/{}",
            root_path,
            sanitize_filename(&book_info.author),
            sanitize_filename(series),
            sanitize_filename(&book_info.title)
        )
    } else {
        format!("{}/{}/{}",
            root_path,
            sanitize_filename(&book_info.author),
            sanitize_filename(&book_info.title)
        )
    };

    // Check if already correct
    if folder_path == ideal_path {
        return None;
    }

    // Check if already in correct structure (might just have wrong folder name)
    let relative = folder_path.strip_prefix(root_path).unwrap_or(folder_path);
    let parts: Vec<_> = relative.split('/').filter(|s| !s.is_empty()).collect();

    // If it's just the root with books directly in it, we need to create structure
    let creates_structure = parts.len() <= 1;

    Some(FolderRenameProposal {
        id: uuid::Uuid::new_v4().to_string(),
        source_path: folder_path.to_string(),
        proposed_path: ideal_path,
        file_count: book_info.chapters.len().max(1),
        confidence: book_info.confidence,
        reason: format!("Reorganize to Author/{}Title structure",
            if book_info.series.is_some() { "Series/" } else { "" }),
        creates_structure,
        selected: true,
    })
}

// ============================================================================
// Apply Renames
// ============================================================================

pub async fn apply_smart_renames(
    file_proposals: Vec<FileRenameProposal>,
    folder_proposals: Vec<FolderRenameProposal>,
    create_backup: bool,
) -> Result<SmartRenameResult> {
    let mut result = SmartRenameResult {
        success: true,
        files_renamed: 0,
        folders_moved: 0,
        errors: Vec::new(),
        backup_path: None,
    };

    // Apply file renames first (before folder moves)
    for proposal in &file_proposals {
        if !proposal.selected || proposal.change_type == FileChangeType::NoChange {
            continue;
        }

        let source = Path::new(&proposal.source_path);
        let dest = Path::new(&proposal.proposed_path);

        // Create destination directory if needed
        if let Some(parent) = dest.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                result.errors.push(format!("Failed to create directory: {}", e));
                continue;
            }
        }

        // Don't overwrite existing files
        if dest.exists() && source != dest {
            result.errors.push(format!("Destination already exists: {}", proposal.proposed_path));
            continue;
        }

        match fs::rename(source, dest) {
            Ok(_) => {
                result.files_renamed += 1;
                println!("   Renamed: {} -> {}",
                    source.file_name().unwrap_or_default().to_string_lossy(),
                    dest.file_name().unwrap_or_default().to_string_lossy()
                );
            }
            Err(e) => {
                result.errors.push(format!("Failed to rename {}: {}",
                    proposal.source_path, e));
            }
        }
    }

    // Apply folder moves
    for proposal in &folder_proposals {
        if !proposal.selected {
            continue;
        }

        let source = Path::new(&proposal.source_path);
        let dest = Path::new(&proposal.proposed_path);

        if source == dest {
            continue;
        }

        // Create destination parent directory
        if let Some(parent) = dest.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                result.errors.push(format!("Failed to create directory: {}", e));
                continue;
            }
        }

        // Move the entire folder
        match fs::rename(source, dest) {
            Ok(_) => {
                result.folders_moved += 1;
                println!("   Moved folder: {} -> {}",
                    proposal.source_path, proposal.proposed_path);
            }
            Err(e) => {
                // Try copy + delete if rename fails (cross-filesystem)
                result.errors.push(format!("Failed to move folder {}: {}",
                    proposal.source_path, e));
            }
        }
    }

    result.success = result.errors.is_empty();

    println!("   Smart rename complete: {} files renamed, {} folders moved",
        result.files_renamed, result.folders_moved);

    Ok(result)
}
