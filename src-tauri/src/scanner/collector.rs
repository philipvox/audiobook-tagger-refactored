// src-tauri/src/scanner/collector.rs
use super::types::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::path::Path;
use walkdir::WalkDir;
use std::collections::HashMap;
use regex::Regex;

const AUDIO_EXTENSIONS: &[&str] = &["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"];

pub async fn collect_and_group_files(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    
    let mut all_files = Vec::new();
    
    for path in paths {
        if let Some(ref flag) = cancel_flag {
            if flag.load(Ordering::SeqCst) {
                println!("Collection cancelled");
                return Ok(vec![]);
            }
        }
        
        let files = collect_audio_files_from_path(path)?;
        all_files.extend(files);
    }
    
    println!("📁 Collected {} audio files", all_files.len());
    
    let groups = group_files_by_book(all_files);
    
    Ok(groups)
}

fn collect_audio_files_from_path(path: &str) -> Result<Vec<RawFileData>, Box<dyn std::error::Error + Send + Sync>> {
    let mut files = Vec::new();
    
    for entry in WalkDir::new(path)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                if let Some(dir_name) = e.path().file_name().and_then(|n| n.to_str()) {
                    if dir_name.starts_with("backup_") || 
                       dir_name == "backups" || 
                       dir_name == ".backups" {
                        println!("⏭️  Skipping backup directory: {}", e.path().display());
                        return false;
                    }
                }
            }
            
            if let Some(file_name) = e.path().file_name().and_then(|n| n.to_str()) {
                if file_name.starts_with("._") {
                    return false;
                }
            }
            
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        
        let path = entry.path();
        
        if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
            if file_name.starts_with("._") {
                continue;
            }
        }
        
        if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            // Skip .bak files (used to hide original files from ABS after chapter splitting)
            if ext_lower == "bak" {
                continue;
            }
            // Also skip files ending with .m4b.bak, .mp3.bak, etc.
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if file_name.ends_with(".bak") {
                    continue;
                }
            }
            if AUDIO_EXTENSIONS.contains(&ext_lower.as_str()) {
                let parent = path.parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
                    .to_string();
                
                files.push(RawFileData {
                    path: path.to_string_lossy().to_string(),
                    filename: path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    parent_dir: parent,
                });
            }
        }
    }
    
    Ok(files)
}

fn group_files_by_book(files: Vec<RawFileData>) -> Vec<BookGroup> {
    let mut dir_groups: HashMap<String, Vec<RawFileData>> = HashMap::new();

    // First, group by parent directory
    for file in files {
        dir_groups.entry(file.parent_dir.clone())
            .or_insert_with(Vec::new)
            .push(file);
    }

    let mut all_book_groups: Vec<BookGroup> = Vec::new();

    for (parent_dir, mut dir_files) in dir_groups {
        dir_files.sort_by(|a, b| a.filename.cmp(&b.filename));

        let folder_name = Path::new(&parent_dir)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Try to detect multiple books in the same folder
        let book_groups = split_into_books(dir_files, &folder_name);

        for (book_title, files) in book_groups {
            let group_type = detect_group_type(&files);

            let audio_files: Vec<AudioFile> = files.iter()
                .map(|f| AudioFile {
                    id: uuid::Uuid::new_v4().to_string(),
                    path: f.path.clone(),
                    filename: f.filename.clone(),
                    changes: HashMap::new(),
                    status: "unchanged".to_string(),
                })
                .collect();

            all_book_groups.push(BookGroup {
                id: uuid::Uuid::new_v4().to_string(),
                group_name: book_title.clone(),
                group_type,
                metadata: BookMetadata {
                    title: book_title,
                    author: "Unknown".to_string(),
                    subtitle: None,
                    narrator: None,
                    series: None,
                    sequence: None,
                    genres: vec![],
                    description: None,
                    publisher: None,
                    year: None,
                    isbn: None,
                    asin: None,
                    cover_url: None,
                    cover_mime: None,
                    // NEW FIELDS
                    authors: vec!["Unknown".to_string()],
                    narrators: vec![],
                    language: None,
                    abridged: None,
                    runtime_minutes: None,
                    explicit: None,
                    publish_date: None,
                    sources: None,
                },
                files: audio_files,
                total_changes: 0,
            });
        }
    }

    all_book_groups
}

/// Extract the book title from a filename, removing chapter/part numbers and file extensions
fn extract_book_title(filename: &str) -> String {
    // Remove file extension
    let name = Path::new(filename)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    lazy_static::lazy_static! {
        // Pattern: "01 Book Title" or "01 - Book Title" or "01. Book Title"
        static ref LEADING_NUM: Regex = Regex::new(r"^\d{1,3}[\s._-]+").unwrap();
        // Pattern: " - Part 1", " - Chapter 1", " Part 1", " Ch. 1", etc. at end
        static ref TRAILING_PART: Regex = Regex::new(r"(?i)\s*[-_]?\s*(part|pt|chapter|ch|disc|disk|cd|track|section|seg)\.?\s*\d+\s*$").unwrap();
        // Pattern: " (Part 1)", " [Part 1]", " - 01", " - 001" at end
        static ref TRAILING_NUM: Regex = Regex::new(r"\s*[-_]?\s*[\[(]?\s*(part|pt|chapter|ch)?\s*\d{1,3}\s*[\])]?\s*$").unwrap();
        // Pattern for "Author - Series - Book Title" format
        static ref AUTHOR_SERIES_TITLE: Regex = Regex::new(r"^([^-]+)\s*-\s*([^-]+)\s*-\s*(.+)$").unwrap();
    }

    let cleaned = LEADING_NUM.replace(&name, "").to_string();
    let cleaned = TRAILING_PART.replace(&cleaned, "").to_string();
    let cleaned = TRAILING_NUM.replace(&cleaned, "").to_string();

    cleaned.trim().to_string()
}

/// Split files in a directory into separate book groups based on detected titles
fn split_into_books(files: Vec<RawFileData>, folder_name: &str) -> Vec<(String, Vec<RawFileData>)> {
    if files.len() <= 1 {
        // Single file - use folder name
        return vec![(folder_name.to_string(), files)];
    }

    // Extract titles from all filenames
    let mut title_to_files: HashMap<String, Vec<RawFileData>> = HashMap::new();

    for file in &files {
        let title = extract_book_title(&file.filename);
        title_to_files.entry(title)
            .or_insert_with(Vec::new)
            .push(file.clone());
    }

    // If we detected multiple distinct book titles
    if title_to_files.len() > 1 {
        println!("📚 Detected {} distinct books in folder '{}':", title_to_files.len(), folder_name);
        for (title, book_files) in &title_to_files {
            println!("   - '{}' ({} files)", title, book_files.len());
        }

        // Check if the titles are meaningful (not just numbers or empty)
        let meaningful_titles: Vec<_> = title_to_files.iter()
            .filter(|(title, _)| {
                let t = title.trim();
                !t.is_empty() && !t.chars().all(|c| c.is_numeric() || c.is_whitespace())
            })
            .collect();

        // Only split if we have meaningful distinct titles
        if meaningful_titles.len() > 1 {
            return title_to_files.into_iter()
                .map(|(title, mut files)| {
                    files.sort_by(|a, b| a.filename.cmp(&b.filename));
                    let display_title = if title.is_empty() { folder_name.to_string() } else { title };
                    (display_title, files)
                })
                .collect();
        }
    }

    // Check for .m4b files - each .m4b is typically a complete book
    let m4b_files: Vec<_> = files.iter()
        .filter(|f| f.filename.to_lowercase().ends_with(".m4b"))
        .collect();

    if m4b_files.len() > 1 {
        // Multiple .m4b files - each is likely a separate book
        println!("📚 Detected {} separate .m4b books in folder '{}'", m4b_files.len(), folder_name);

        let mut result: Vec<(String, Vec<RawFileData>)> = Vec::new();
        let mut non_m4b_files: Vec<RawFileData> = Vec::new();

        for file in files {
            if file.filename.to_lowercase().ends_with(".m4b") {
                // Each .m4b is its own book - use filename as title
                let title = Path::new(&file.filename)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                result.push((title, vec![file]));
            } else {
                non_m4b_files.push(file);
            }
        }

        // If there are non-m4b files left over, group them by folder name
        if !non_m4b_files.is_empty() {
            result.push((folder_name.to_string(), non_m4b_files));
        }

        return result;
    }

    // Default: all files belong to one book (folder name)
    vec![(folder_name.to_string(), files)]
}

fn detect_group_type(files: &[RawFileData]) -> GroupType {
    if files.len() == 1 {
        GroupType::Single
    } else if files.iter().any(|f| {
        let lower = f.filename.to_lowercase();
        is_multi_part_filename(&lower)
    }) {
        GroupType::MultiPart
    } else {
        GroupType::Chapters
    }
}

/// Check if a filename indicates it's part of a multi-part/chapter set
/// Returns true for common chapter/part naming conventions
fn is_multi_part_filename(filename: &str) -> bool {
    use regex::Regex;

    // Direct keyword matches (case-insensitive, filename already lowercased)
    let keywords = [
        "part", "disk", "disc", "cd", "chapter", "chap", "ch.",
        "track", "section", "segment", "volume", "vol.", "book",
        "episode", "ep.", "side"
    ];

    if keywords.iter().any(|k| filename.contains(k)) {
        return true;
    }

    // Pattern: starts with number followed by separator (01 - Title, 01_title, 01.title)
    // This catches files like "01 - Chapter One.mp3", "01_intro.m4a"
    lazy_static::lazy_static! {
        static ref LEADING_NUM: Regex = Regex::new(r"^\d{1,3}[\s._-]").unwrap();
        // Roman numerals: "I - ", "II.", "III_", "IV -", "V.", "VI_", etc.
        static ref ROMAN_NUMERAL: Regex = Regex::new(r"(?i)\b(i{1,3}|iv|vi{0,3}|ix|xi{0,3}|xiv|xvi{0,3}|xix|xxi{0,3})[\s._-]").unwrap();
        // Patterns like "pt1", "pt.1", "pt 1", "part1"
        static ref PART_NUM: Regex = Regex::new(r"(?i)(pt|part|ch|chap|chapter|ep|episode|sec|section|track|trk)\.?\s*\d").unwrap();
    }

    if LEADING_NUM.is_match(filename) {
        return true;
    }

    if ROMAN_NUMERAL.is_match(filename) {
        return true;
    }

    if PART_NUM.is_match(filename) {
        return true;
    }

    false
}