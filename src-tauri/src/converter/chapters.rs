// src-tauri/src/converter/chapters.rs
// Chapter generation and metadata formatting

use anyhow::Result;
use regex::Regex;
use std::path::Path;

use super::ffmpeg::detect_silence;
use super::types::{ChapterDefinition, ChapterMode, ConversionMetadata, SilenceMarker, SourceFile};

/// Generate FFmpeg metadata file with chapters
pub fn generate_chapter_metadata(
    chapters: &[ChapterDefinition],
    metadata: &ConversionMetadata,
    output_path: &str,
) -> Result<()> {
    let mut content = String::from(";FFMETADATA1\n");

    // Global metadata
    content.push_str(&format!("title={}\n", escape_metadata(&metadata.title)));
    content.push_str(&format!("artist={}\n", escape_metadata(&metadata.author)));
    content.push_str(&format!("album={}\n", escape_metadata(&metadata.title)));

    if let Some(narrator) = &metadata.narrator {
        content.push_str(&format!("composer={}\n", escape_metadata(narrator)));
    }

    if !metadata.genres.is_empty() {
        content.push_str(&format!(
            "genre={}\n",
            escape_metadata(&metadata.genres.join(", "))
        ));
    }

    if let Some(year) = &metadata.year {
        content.push_str(&format!("date={}\n", year));
    }

    if let Some(publisher) = &metadata.publisher {
        content.push_str(&format!("publisher={}\n", escape_metadata(publisher)));
    }

    if let Some(description) = &metadata.description {
        // Description/comment - limit length
        let desc = if description.len() > 1000 {
            format!("{}...", &description[..997])
        } else {
            description.clone()
        };
        content.push_str(&format!("comment={}\n", escape_metadata(&desc)));
    }

    // Chapters
    for chapter in chapters {
        content.push_str("\n[CHAPTER]\n");
        content.push_str("TIMEBASE=1/1000\n");
        content.push_str(&format!("START={}\n", chapter.start_ms));
        content.push_str(&format!("END={}\n", chapter.end_ms));
        content.push_str(&format!("title={}\n", escape_metadata(&chapter.title)));
    }

    std::fs::write(output_path, content)?;
    Ok(())
}

/// Extract chapter name from filename
pub fn extract_chapter_name(filename: &str) -> String {
    let name = Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string());

    // Try various patterns to extract clean chapter name
    let patterns = [
        // "01 - Chapter Name" or "01 _ Chapter Name" or "01. Chapter Name"
        (r"^\d+\s*[-_\.]\s*(.+)$", 1),
        // "Chapter 01 - Name" or "Chapter 1: Name"
        (r"^[Cc]hapter\s*\d+\s*[-_:\.]\s*(.+)$", 1),
        // "Part 1 - Name"
        (r"^[Pp]art\s*\d+\s*[-_:\.]\s*(.+)$", 1),
        // "Track 01 - Name"
        (r"^[Tt]rack\s*\d+\s*[-_:\.]\s*(.+)$", 1),
        // "01_chapter_name" or "01-chapter_name"
        (r"^\d+[-_](.+)$", 1),
        // "(01) Chapter Name"
        (r"^\(\d+\)\s*(.+)$", 1),
        // "[01] Chapter Name"
        (r"^\[\d+\]\s*(.+)$", 1),
    ];

    for (pattern, group) in &patterns {
        if let Ok(re) = Regex::new(pattern) {
            if let Some(captures) = re.captures(&name) {
                if let Some(m) = captures.get(*group) {
                    return clean_chapter_name(m.as_str());
                }
            }
        }
    }

    // Fallback: use cleaned filename
    clean_chapter_name(&name)
}

/// Clean up chapter name
fn clean_chapter_name(name: &str) -> String {
    name.replace("_", " ")
        .replace("  ", " ")
        .trim()
        .to_string()
}

/// Escape special characters for FFmpeg metadata
fn escape_metadata(s: &str) -> String {
    s.replace("\\", "\\\\")
        .replace("=", "\\=")
        .replace(";", "\\;")
        .replace("#", "\\#")
        .replace("\n", " ")
        .replace("\r", "")
}

/// Generate chapters from source files based on chapter mode
pub async fn generate_chapters(
    mode: &ChapterMode,
    files: &[SourceFile],
    total_duration_ms: u64,
) -> Result<Vec<ChapterDefinition>> {
    match mode {
        ChapterMode::PerFile => Ok(chapters_from_files(files)),
        ChapterMode::SilenceDetection {
            min_silence_seconds,
            noise_threshold_db,
        } => {
            // For silence detection, we need a single file or concatenated source
            if files.len() == 1 {
                chapters_from_silence(&files[0].path, *noise_threshold_db, *min_silence_seconds, total_duration_ms).await
            } else {
                // Fall back to per-file for multiple files
                println!("⚠️ Silence detection requires single file, using per-file chapters");
                Ok(chapters_from_files(files))
            }
        }
        ChapterMode::None => Ok(Vec::new()),
        ChapterMode::Custom { chapters } => Ok(chapters.clone()),
    }
}

/// Generate chapters from file boundaries
pub fn chapters_from_files(files: &[SourceFile]) -> Vec<ChapterDefinition> {
    let mut chapters = Vec::new();
    let mut current_start = 0u64;

    for file in files {
        chapters.push(ChapterDefinition {
            title: extract_chapter_name(&file.filename),
            start_ms: current_start,
            end_ms: current_start + file.duration_ms,
        });
        current_start += file.duration_ms;
    }

    chapters
}

/// Generate chapters from silence detection
async fn chapters_from_silence(
    path: &str,
    noise_threshold_db: i32,
    min_silence_seconds: f64,
    total_duration_ms: u64,
) -> Result<Vec<ChapterDefinition>> {
    let silences = detect_silence(path, noise_threshold_db, min_silence_seconds).await?;

    if silences.is_empty() {
        // No silence found, create single chapter
        return Ok(vec![ChapterDefinition {
            title: "Chapter 1".to_string(),
            start_ms: 0,
            end_ms: total_duration_ms,
        }]);
    }

    let mut chapters = Vec::new();
    let mut chapter_start = 0.0f64;

    for (i, silence) in silences.iter().enumerate() {
        // End previous chapter at silence start
        chapters.push(ChapterDefinition {
            title: format!("Chapter {}", i + 1),
            start_ms: (chapter_start * 1000.0) as u64,
            end_ms: (silence.start * 1000.0) as u64,
        });
        // Next chapter starts at silence end
        chapter_start = silence.end;
    }

    // Add final chapter
    chapters.push(ChapterDefinition {
        title: format!("Chapter {}", silences.len() + 1),
        start_ms: (chapter_start * 1000.0) as u64,
        end_ms: total_duration_ms,
    });

    // Filter out very short chapters (< 10 seconds)
    chapters.retain(|c| c.duration_ms() >= 10000);

    // Renumber after filtering
    for (i, chapter) in chapters.iter_mut().enumerate() {
        chapter.title = format!("Chapter {}", i + 1);
    }

    Ok(chapters)
}

/// Merge consecutive short chapters
pub fn merge_short_chapters(chapters: &[ChapterDefinition], min_duration_ms: u64) -> Vec<ChapterDefinition> {
    if chapters.is_empty() {
        return Vec::new();
    }

    let mut merged = Vec::new();
    let mut current = chapters[0].clone();

    for chapter in chapters.iter().skip(1) {
        if current.duration_ms() < min_duration_ms {
            // Extend current chapter to include this one
            current.end_ms = chapter.end_ms;
            // Keep the first chapter's title
        } else {
            merged.push(current);
            current = chapter.clone();
        }
    }
    merged.push(current);

    merged
}

/// Validate chapter definitions
pub fn validate_chapters(chapters: &[ChapterDefinition], total_duration_ms: u64) -> Vec<String> {
    let mut issues = Vec::new();

    if chapters.is_empty() {
        return issues; // No chapters is valid (ChapterMode::None)
    }

    // Check first chapter starts at 0
    if let Some(first) = chapters.first() {
        if first.start_ms != 0 {
            issues.push(format!(
                "First chapter should start at 0, but starts at {}ms",
                first.start_ms
            ));
        }
    }

    // Check last chapter ends at total duration
    if let Some(last) = chapters.last() {
        let diff = (last.end_ms as i64 - total_duration_ms as i64).abs();
        if diff > 1000 {
            // Allow 1 second tolerance
            issues.push(format!(
                "Last chapter ends at {}ms but total duration is {}ms",
                last.end_ms, total_duration_ms
            ));
        }
    }

    // Check chapters are continuous and non-overlapping
    for window in chapters.windows(2) {
        let prev = &window[0];
        let next = &window[1];

        if prev.end_ms != next.start_ms {
            issues.push(format!(
                "Gap or overlap between chapters '{}' and '{}': {}ms to {}ms",
                prev.title, next.title, prev.end_ms, next.start_ms
            ));
        }
    }

    // Check for empty titles
    for (i, chapter) in chapters.iter().enumerate() {
        if chapter.title.trim().is_empty() {
            issues.push(format!("Chapter {} has empty title", i + 1));
        }
    }

    // Check for very short chapters
    for chapter in chapters {
        if chapter.duration_ms() < 1000 {
            issues.push(format!(
                "Chapter '{}' is very short: {}ms",
                chapter.title,
                chapter.duration_ms()
            ));
        }
    }

    issues
}

/// Auto-number chapters if they have generic names
pub fn auto_number_chapters(chapters: &mut [ChapterDefinition]) {
    // Check if chapters need numbering (all have same name or generic names)
    let needs_numbering = chapters.iter().all(|c| {
        c.title.is_empty()
            || c.title == "Chapter"
            || chapters.iter().filter(|other| other.title == c.title).count() > 1
    });

    if needs_numbering {
        for (i, chapter) in chapters.iter_mut().enumerate() {
            chapter.title = format!("Chapter {}", i + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_chapter_name() {
        assert_eq!(extract_chapter_name("01 - Introduction.mp3"), "Introduction");
        assert_eq!(extract_chapter_name("Chapter 01 - The Beginning.mp3"), "The Beginning");
        assert_eq!(extract_chapter_name("Part 1 - Prologue.mp3"), "Prologue");
        assert_eq!(extract_chapter_name("01_some_chapter.mp3"), "some chapter");
        assert_eq!(extract_chapter_name("Track 05 - Scene Five.mp3"), "Scene Five");
        assert_eq!(extract_chapter_name("Simple Name.mp3"), "Simple Name");
    }

    #[test]
    fn test_escape_metadata() {
        assert_eq!(escape_metadata("Hello"), "Hello");
        assert_eq!(escape_metadata("Key=Value"), "Key\\=Value");
        assert_eq!(escape_metadata("A;B"), "A\\;B");
        assert_eq!(escape_metadata("Line1\nLine2"), "Line1 Line2");
    }
}
