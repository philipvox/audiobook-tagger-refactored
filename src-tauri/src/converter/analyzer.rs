// src-tauri/src/converter/analyzer.rs
// Analyze source files for conversion

use anyhow::{anyhow, Result};
use std::path::Path;

use super::chapters::extract_chapter_name;
use super::ffmpeg::get_audio_info;
use super::types::{ChapterDefinition, ConversionMetadata, SourceAnalysis, SourceFile};

/// Analyze a folder or file for conversion
pub async fn analyze_source(path: &str) -> Result<SourceAnalysis> {
    let source_path = Path::new(path);

    if !source_path.exists() {
        return Err(anyhow!("Path does not exist: {}", path));
    }

    // Clean up any stale temp cover files from previous runs
    if source_path.is_dir() {
        let temp_cover = source_path.join(".temp_cover.jpg");
        if temp_cover.exists() {
            let _ = std::fs::remove_file(&temp_cover);
        }
    }

    // Get list of audio files
    let audio_files = if source_path.is_file() {
        vec![path.to_string()]
    } else {
        find_audio_files(path)?
    };

    if audio_files.is_empty() {
        return Err(anyhow!("No audio files found in: {}", path));
    }

    // Analyze each file
    let mut files = Vec::new();
    let mut total_duration_ms = 0u64;
    let mut total_size_bytes = 0u64;

    for file_path in &audio_files {
        let info = get_audio_info(file_path).await?;
        let filename = Path::new(file_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| file_path.clone());

        files.push(SourceFile {
            path: file_path.clone(),
            filename,
            duration_ms: info.duration_ms,
            size_bytes: info.size_bytes,
            bitrate_kbps: info.bitrate_kbps,
            sample_rate: info.sample_rate,
            channels: info.channels,
            codec: info.codec,
        });

        total_duration_ms += info.duration_ms;
        total_size_bytes += info.size_bytes;
    }

    // Sort files naturally by filename
    files.sort_by(|a, b| natord::compare(&a.filename, &b.filename));

    // Generate chapters from files
    let detected_chapters = generate_chapters_from_files(&files);

    // Extract metadata from first file and folder name
    let detected_metadata = extract_metadata(&files, path).await;

    // Look for cover art
    let (has_cover, cover_source) = find_cover_art(path, &files).await;

    // Check if all files are AAC (can use turbo mode)
    let can_stream_copy = !files.is_empty() && files.iter().all(|f| f.codec == "aac");

    Ok(SourceAnalysis {
        files,
        total_duration_ms,
        total_size_bytes,
        detected_metadata,
        detected_chapters,
        has_cover,
        cover_source,
        source_path: path.to_string(),
        can_stream_copy,
    })
}

/// Find all audio files in a directory
fn find_audio_files(dir: &str) -> Result<Vec<String>> {
    let mut files = Vec::new();
    let extensions = ["mp3", "m4a", "m4b", "aac", "ogg", "flac", "wav"];

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_file() {
            // Get filename and skip hidden files (starting with .)
            // This includes macOS resource fork files like ._filename
            if let Some(filename) = path.file_name() {
                let filename_str = filename.to_string_lossy();
                if filename_str.starts_with('.') {
                    continue;
                }
            }

            if let Some(ext) = path.extension() {
                let ext_lower = ext.to_string_lossy().to_lowercase();
                if extensions.contains(&ext_lower.as_str()) {
                    files.push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    // Sort naturally
    files.sort_by(|a, b| natord::compare(a, b));

    Ok(files)
}

/// Generate chapter definitions from file list
fn generate_chapters_from_files(files: &[SourceFile]) -> Vec<ChapterDefinition> {
    let mut chapters = Vec::new();
    let mut current_start = 0u64;

    for file in files {
        let chapter_name = extract_chapter_name(&file.filename);
        chapters.push(ChapterDefinition {
            title: chapter_name,
            start_ms: current_start,
            end_ms: current_start + file.duration_ms,
        });
        current_start += file.duration_ms;
    }

    chapters
}

/// Extract metadata from files and folder name
async fn extract_metadata(files: &[SourceFile], folder_path: &str) -> ConversionMetadata {
    let mut metadata = ConversionMetadata::default();

    // Try to get metadata from first file
    if let Some(first_file) = files.first() {
        if let Ok(info) = get_audio_info(&first_file.path).await {
            if let Some(title) = info.title {
                // Often the title tag contains the book title
                metadata.title = clean_title(&title);
            }
            if let Some(artist) = info.artist {
                metadata.author = artist;
            }
        }
    }

    // If no title from tags, try to extract from folder name
    if metadata.title.is_empty() {
        if let Some(folder_name) = Path::new(folder_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
        {
            let (title, author, series, series_part) = parse_folder_name(&folder_name);
            if metadata.title.is_empty() {
                metadata.title = title;
            }
            if metadata.author.is_empty() && !author.is_empty() {
                metadata.author = author;
            }
            if series.is_some() {
                metadata.series = series;
                metadata.series_part = series_part;
            }
        }
    }

    metadata
}

/// Clean up title extracted from tags
fn clean_title(title: &str) -> String {
    // Remove track numbers, chapter indicators, etc.
    let patterns = [
        r"^\d+\s*[-_.]\s*",        // Leading track numbers
        r"^[Cc]hapter\s*\d+\s*[-_.]\s*", // Chapter prefixes
        r"^[Pp]art\s*\d+\s*[-_.]\s*",   // Part prefixes
    ];

    let mut cleaned = title.to_string();
    for pattern in &patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            cleaned = re.replace(&cleaned, "").to_string();
        }
    }

    cleaned.trim().to_string()
}

/// Parse folder name to extract title, author, series info
fn parse_folder_name(name: &str) -> (String, String, Option<String>, Option<String>) {
    // Common patterns:
    // "Author - Book Title"
    // "Book Title by Author"
    // "Series Name 01 - Book Title"
    // "Author - Series 01 - Book Title"

    let mut title = name.to_string();
    let mut author = String::new();
    let mut series: Option<String> = None;
    let mut series_part: Option<String> = None;

    // Try "Author - Title" pattern
    if let Some(idx) = name.find(" - ") {
        let parts: Vec<&str> = name.splitn(2, " - ").collect();
        if parts.len() == 2 {
            // Check if first part looks like an author (contains name-like words)
            let first = parts[0].trim();
            let second = parts[1].trim();

            // If second part has another " - ", might be "Author - Series - Title"
            if let Some(idx2) = second.find(" - ") {
                let second_parts: Vec<&str> = second.splitn(2, " - ").collect();
                author = first.to_string();

                // Check for series number pattern
                let series_candidate = second_parts[0].trim();
                if let Some((s, n)) = extract_series_number(series_candidate) {
                    series = Some(s);
                    series_part = Some(n);
                } else {
                    series = Some(series_candidate.to_string());
                }
                title = second_parts[1].trim().to_string();
            } else {
                author = first.to_string();
                title = second.to_string();
            }
        }
    }

    // Check title for series number
    if series.is_none() {
        if let Some((s, n)) = extract_series_number(&title) {
            // Don't set series from title alone - too unreliable
            // But we could extract sequence if pattern is clear like "Book 1"
            if title.contains("Book ") || title.contains("Vol ") || title.contains("Volume ") {
                series_part = Some(n);
            }
        }
    }

    (title, author, series, series_part)
}

/// Extract series number from text like "Series Name 01" or "Series Name Book 3"
fn extract_series_number(text: &str) -> Option<(String, String)> {
    let patterns = [
        (r"^(.+?)\s+(\d+)$", 1, 2),           // "Series Name 01"
        (r"^(.+?)\s+[Bb]ook\s*(\d+)", 1, 2),  // "Series Book 3"
        (r"^(.+?)\s+[Vv]ol\.?\s*(\d+)", 1, 2), // "Series Vol 2"
        (r"^(.+?)\s+#(\d+)", 1, 2),           // "Series #4"
    ];

    for (pattern, name_group, num_group) in &patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(text) {
                let name = caps.get(*name_group).map(|m| m.as_str().trim().to_string());
                let num = caps.get(*num_group).map(|m| m.as_str().to_string());
                if let (Some(n), Some(num)) = (name, num) {
                    return Some((n, num));
                }
            }
        }
    }
    None
}

/// Find cover art in folder (explicit files only - embedded extraction disabled for reliability)
async fn find_cover_art(folder_path: &str, _files: &[SourceFile]) -> (bool, Option<String>) {
    let folder = Path::new(folder_path);

    // Check for cover files in folder - common naming conventions
    let cover_names = [
        "cover.jpg", "cover.jpeg", "cover.png",
        "folder.jpg", "folder.jpeg", "folder.png",
        "front.jpg", "front.jpeg", "front.png",
        "artwork.jpg", "artwork.jpeg", "artwork.png",
    ];

    for name in &cover_names {
        let cover_path = folder.join(name);
        if cover_path.exists() {
            return (true, Some(cover_path.to_string_lossy().to_string()));
        }
    }

    // Also check for any image file in the folder
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    let ext_lower = ext.to_string_lossy().to_lowercase();
                    if ext_lower == "jpg" || ext_lower == "jpeg" || ext_lower == "png" {
                        // Skip hidden files
                        if let Some(name) = path.file_name() {
                            if !name.to_string_lossy().starts_with('.') {
                                return (true, Some(path.to_string_lossy().to_string()));
                            }
                        }
                    }
                }
            }
        }
    }

    // Note: Embedded cover extraction from audio files is disabled
    // as it can produce invalid files that cause FFmpeg errors.
    // Place a cover.jpg/cover.png in the folder for cover art.

    (false, None)
}

/// Validate that output path is writable
pub fn validate_output_path(path: &str) -> Result<()> {
    let output_path = Path::new(path);

    // Check parent directory exists and is writable
    if let Some(parent) = output_path.parent() {
        if !parent.exists() {
            return Err(anyhow!("Output directory does not exist: {}", parent.display()));
        }
        // Try to check if we can write
        let test_file = parent.join(".write_test");
        match std::fs::write(&test_file, "test") {
            Ok(_) => {
                let _ = std::fs::remove_file(test_file);
            }
            Err(e) => {
                return Err(anyhow!("Cannot write to output directory: {}", e));
            }
        }
    }

    // If output file exists, warn (will be overwritten)
    if output_path.exists() {
        println!("⚠️ Output file exists and will be overwritten: {}", path);
    }

    Ok(())
}

/// Get available disk space at path
pub fn get_available_space(path: &str) -> Result<u64> {
    use fs2::available_space;
    use std::path::Path;

    let check_path = Path::new(path);

    // If the path doesn't exist yet, check the parent directory
    let target = if check_path.exists() {
        check_path.to_path_buf()
    } else if let Some(parent) = check_path.parent() {
        if parent.exists() {
            parent.to_path_buf()
        } else {
            // Fall back to current directory
            std::env::current_dir().unwrap_or_else(|_| Path::new("/").to_path_buf())
        }
    } else {
        std::env::current_dir().unwrap_or_else(|_| Path::new("/").to_path_buf())
    };

    available_space(&target)
        .map_err(|e| anyhow!("Failed to get available disk space: {}", e))
}
