// src-tauri/src/chapters.rs
//! Chapter detection, extraction, and splitting functionality
//!
//! This module provides:
//! - FFmpeg/FFprobe detection and availability checking
//! - Chapter extraction from M4B/MP3/FLAC files
//! - Silence detection for files without embedded chapters
//! - Chapter-based file splitting without re-encoding
//! - Metadata application to split files

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/// Information about FFmpeg installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FFmpegInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
}

/// A single chapter in an audiobook
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    pub id: u32,
    pub title: String,
    pub start_time: f64,       // seconds
    pub end_time: f64,         // seconds
    pub duration: f64,         // seconds
    pub start_display: String, // "01:23:45"
    pub end_display: String,
}

impl Chapter {
    /// Create a new chapter with calculated fields
    pub fn new(id: u32, title: String, start_time: f64, end_time: f64) -> Self {
        let duration = end_time - start_time;
        Self {
            id,
            title,
            start_time,
            end_time,
            duration,
            start_display: format_duration(start_time),
            end_display: format_duration(end_time),
        }
    }
}

/// How chapters were detected
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChapterSource {
    /// Chapters embedded in file metadata (M4B, etc.)
    Embedded,
    /// Detected via silence detection
    SilenceDetection,
    /// Manually defined by user
    Manual,
    /// Derived from multiple file names
    FromFilenames,
}

/// Complete chapter information for an audiobook
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterInfo {
    pub file_path: String,
    pub total_duration: f64,
    pub total_duration_display: String,
    pub chapters: Vec<Chapter>,
    pub chapter_source: ChapterSource,
    pub has_embedded_chapters: bool,
}

/// Options for splitting audiobook by chapters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitOptions {
    pub output_dir: String,
    pub output_format: OutputFormat,
    /// Naming pattern: use {num}, {title}, {author}, {book}
    pub naming_pattern: String,
    pub copy_metadata: bool,
    pub embed_cover: bool,
    pub create_m3u_playlist: bool,
    /// Zero-pad track numbers to this width
    pub track_number_width: u8,
}

impl Default for SplitOptions {
    fn default() -> Self {
        Self {
            output_dir: String::new(),
            output_format: OutputFormat::SameAsSource,
            naming_pattern: "{num} - {title}".to_string(),
            copy_metadata: true,
            embed_cover: true,
            create_m3u_playlist: true,
            track_number_width: 2,
        }
    }
}

/// Output format for split files
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    /// Keep same format as source file
    SameAsSource,
    /// Convert to M4A (AAC)
    M4A,
    /// Convert to MP3
    MP3,
    /// Convert to Opus (smaller, better quality at low bitrates)
    Opus,
}

/// Progress update during splitting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitProgress {
    pub current_chapter: u32,
    pub total_chapters: u32,
    pub current_title: String,
    pub percent_complete: f32,
    pub status: String,
}

/// Result of a split operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitResult {
    pub success: bool,
    pub message: String,
    pub output_files: Vec<String>,
    pub playlist_path: Option<String>,
}

/// Settings for silence detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SilenceDetectionSettings {
    /// Noise threshold in dB (default: -30dB)
    pub noise_threshold_db: i32,
    /// Minimum silence duration in seconds (default: 0.5s)
    pub min_silence_duration: f64,
    /// Minimum chapter duration in seconds (ignore chapters shorter than this)
    pub min_chapter_duration: f64,
}

impl Default for SilenceDetectionSettings {
    fn default() -> Self {
        Self {
            noise_threshold_db: -30,
            min_silence_duration: 0.5,
            min_chapter_duration: 60.0, // At least 1 minute per chapter
        }
    }
}

// ============================================================================
// FFMPEG DETECTION
// ============================================================================

/// Check if FFmpeg and FFprobe are installed and get version info
pub fn check_ffmpeg() -> FFmpegInfo {
    let ffmpeg_result = Command::new("ffmpeg").arg("-version").output();

    let ffprobe_result = Command::new("ffprobe").arg("-version").output();

    let (ffmpeg_ok, ffmpeg_version, ffmpeg_path) = match ffmpeg_result {
        Ok(output) if output.status.success() => {
            let version_str = String::from_utf8_lossy(&output.stdout);
            let version = parse_ffmpeg_version(&version_str);
            let path = which_command("ffmpeg");
            (true, version, path)
        }
        _ => (false, None, None),
    };

    let (ffprobe_ok, ffprobe_path) = match ffprobe_result {
        Ok(output) if output.status.success() => {
            let path = which_command("ffprobe");
            (true, path)
        }
        _ => (false, None),
    };

    FFmpegInfo {
        installed: ffmpeg_ok && ffprobe_ok,
        version: ffmpeg_version,
        ffmpeg_path,
        ffprobe_path,
    }
}

/// Parse FFmpeg version from output
fn parse_ffmpeg_version(output: &str) -> Option<String> {
    // FFmpeg version output looks like:
    // ffmpeg version 6.0 Copyright (c) ...
    // or
    // ffmpeg version n6.0-2-g...
    let first_line = output.lines().next()?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();

    // Find "version" and get the next word
    for (i, part) in parts.iter().enumerate() {
        if *part == "version" && i + 1 < parts.len() {
            return Some(parts[i + 1].to_string());
        }
    }

    None
}

/// Try to find a command's full path
fn which_command(cmd: &str) -> Option<String> {
    Command::new("which")
        .arg(cmd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

// ============================================================================
// CHAPTER EXTRACTION
// ============================================================================

/// Extract chapters from an audio file using ffprobe
pub fn get_chapters(file_path: &str) -> Result<ChapterInfo> {
    let path = Path::new(file_path);
    if !path.exists() {
        bail!("File not found: {}", file_path);
    }

    // Get file duration first
    let duration = get_file_duration(file_path)?;

    // Run ffprobe to get chapter metadata
    let output = Command::new("ffprobe")
        .args([
            "-i",
            file_path,
            "-print_format",
            "json",
            "-show_chapters",
            "-loglevel",
            "error",
        ])
        .output()
        .context("Failed to run ffprobe")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("ffprobe failed: {}", stderr);
    }

    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("Failed to parse ffprobe JSON output")?;

    let chapters = parse_ffprobe_chapters(&json, duration);
    let has_embedded = !chapters.is_empty();

    Ok(ChapterInfo {
        file_path: file_path.to_string(),
        total_duration: duration,
        total_duration_display: format_duration(duration),
        chapters,
        chapter_source: ChapterSource::Embedded,
        has_embedded_chapters: has_embedded,
    })
}

/// Parse chapter information from ffprobe JSON output
fn parse_ffprobe_chapters(json: &serde_json::Value, total_duration: f64) -> Vec<Chapter> {
    let mut chapters = Vec::new();

    if let Some(chapter_array) = json["chapters"].as_array() {
        for (idx, chapter) in chapter_array.iter().enumerate() {
            let id = chapter["id"].as_i64().unwrap_or(idx as i64) as u32;

            // Get times - ffprobe returns them as strings or numbers
            let start_time = parse_time_value(&chapter["start_time"]);
            let end_time = parse_time_value(&chapter["end_time"]);

            // Get title from tags
            let title = chapter["tags"]["title"]
                .as_str()
                .unwrap_or(&format!("Chapter {}", idx + 1))
                .to_string();

            chapters.push(Chapter::new(id, title, start_time, end_time));
        }
    }

    // If no chapters found, create a single chapter for the whole file
    if chapters.is_empty() && total_duration > 0.0 {
        // Don't add synthetic chapter here - let the caller decide
    }

    chapters
}

/// Parse time value from JSON (can be string or number)
fn parse_time_value(value: &serde_json::Value) -> f64 {
    match value {
        serde_json::Value::String(s) => s.parse().unwrap_or(0.0),
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Get file duration using ffprobe
pub fn get_file_duration(file_path: &str) -> Result<f64> {
    let output = Command::new("ffprobe")
        .args([
            "-i",
            file_path,
            "-show_entries",
            "format=duration",
            "-v",
            "quiet",
            "-of",
            "csv=p=0",
        ])
        .output()
        .context("Failed to run ffprobe for duration")?;

    if !output.status.success() {
        bail!("ffprobe failed to get duration");
    }

    let duration_str = String::from_utf8_lossy(&output.stdout);
    duration_str
        .trim()
        .parse::<f64>()
        .context("Failed to parse duration")
}

// ============================================================================
// SILENCE DETECTION
// ============================================================================

/// Detect silence periods in an audio file and create chapters from them
pub fn detect_chapters_from_silence(
    file_path: &str,
    settings: &SilenceDetectionSettings,
) -> Result<ChapterInfo> {
    println!("   🔇 Detecting silence in file...");

    let duration = get_file_duration(file_path)?;

    // Run FFmpeg silence detection
    // ffmpeg -i input.mp3 -af silencedetect=noise=-30dB:d=0.5 -f null -
    let output = Command::new("ffmpeg")
        .args([
            "-i",
            file_path,
            "-af",
            &format!(
                "silencedetect=noise={}dB:d={}",
                settings.noise_threshold_db, settings.min_silence_duration
            ),
            "-f",
            "null",
            "-",
        ])
        .output()
        .context("Failed to run ffmpeg for silence detection")?;

    // Silence detection output goes to stderr
    let stderr = String::from_utf8_lossy(&output.stderr);

    let silence_periods = parse_silence_output(&stderr);
    println!("   📊 Found {} silence periods", silence_periods.len());

    // Convert silence periods to chapter boundaries
    let chapters = create_chapters_from_silence(&silence_periods, duration, settings);
    println!("   📚 Created {} chapters", chapters.len());

    Ok(ChapterInfo {
        file_path: file_path.to_string(),
        total_duration: duration,
        total_duration_display: format_duration(duration),
        chapters,
        chapter_source: ChapterSource::SilenceDetection,
        has_embedded_chapters: false,
    })
}

/// A detected silence period
#[derive(Debug, Clone)]
struct SilencePeriod {
    start: f64,
    end: f64,
}

/// Parse silence detection output from FFmpeg
fn parse_silence_output(output: &str) -> Vec<SilencePeriod> {
    let mut periods = Vec::new();
    let mut current_start: Option<f64> = None;

    // FFmpeg outputs lines like:
    // [silencedetect @ 0x...] silence_start: 1843.234
    // [silencedetect @ 0x...] silence_end: 1845.567 | silence_duration: 2.333

    for line in output.lines() {
        if line.contains("silence_start:") {
            if let Some(start) = extract_time_from_line(line, "silence_start:") {
                current_start = Some(start);
            }
        } else if line.contains("silence_end:") {
            if let (Some(start), Some(end)) =
                (current_start, extract_time_from_line(line, "silence_end:"))
            {
                periods.push(SilencePeriod { start, end });
                current_start = None;
            }
        }
    }

    periods
}

/// Extract time value from a silence detection line
fn extract_time_from_line(line: &str, marker: &str) -> Option<f64> {
    let idx = line.find(marker)?;
    let after = &line[idx + marker.len()..];
    let end = after
        .find(|c: char| !c.is_numeric() && c != '.' && c != ' ')
        .unwrap_or(after.len());
    after[..end].trim().parse().ok()
}

/// Create chapters from detected silence periods
fn create_chapters_from_silence(
    silence_periods: &[SilencePeriod],
    total_duration: f64,
    settings: &SilenceDetectionSettings,
) -> Vec<Chapter> {
    let mut chapters = Vec::new();

    if silence_periods.is_empty() {
        // No silence detected - create single chapter
        chapters.push(Chapter::new(
            0,
            "Chapter 1".to_string(),
            0.0,
            total_duration,
        ));
        return chapters;
    }

    // Create chapters from the gaps between silence periods
    let mut last_end = 0.0;

    for (idx, period) in silence_periods.iter().enumerate() {
        let chapter_start = last_end;
        let chapter_end = period.start;
        let chapter_duration = chapter_end - chapter_start;

        // Only create chapter if it's long enough
        if chapter_duration >= settings.min_chapter_duration {
            chapters.push(Chapter::new(
                idx as u32,
                format!("Chapter {}", chapters.len() + 1),
                chapter_start,
                chapter_end,
            ));
        }

        // Move past the silence to the start of next potential chapter
        last_end = period.end;
    }

    // Add final chapter from last silence to end
    if total_duration - last_end >= settings.min_chapter_duration {
        chapters.push(Chapter::new(
            chapters.len() as u32,
            format!("Chapter {}", chapters.len() + 1),
            last_end,
            total_duration,
        ));
    }

    // If we ended up with no chapters (all too short), create one for the whole file
    if chapters.is_empty() {
        chapters.push(Chapter::new(
            0,
            "Chapter 1".to_string(),
            0.0,
            total_duration,
        ));
    }

    chapters
}

// ============================================================================
// CHAPTER SPLITTING
// ============================================================================

/// Cover data for embedding in split files
pub struct CoverData {
    pub data: Vec<u8>,
    pub mime_type: String,
}

/// Split an audio file by chapters
pub fn split_by_chapters(
    file_path: &str,
    chapters: &[Chapter],
    options: &SplitOptions,
    progress_callback: Option<Box<dyn Fn(SplitProgress) + Send>>,
) -> Result<SplitResult> {
    split_by_chapters_with_cover(file_path, chapters, options, progress_callback, None)
}

/// Split an audio file by chapters with optional cover embedding
pub fn split_by_chapters_with_cover(
    file_path: &str,
    chapters: &[Chapter],
    options: &SplitOptions,
    progress_callback: Option<Box<dyn Fn(SplitProgress) + Send>>,
    cover: Option<&CoverData>,
) -> Result<SplitResult> {
    let path = Path::new(file_path);
    if !path.exists() {
        bail!("Source file not found: {}", file_path);
    }

    let source_ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("m4a")
        .to_lowercase();

    // Determine output extension
    let output_ext = match &options.output_format {
        OutputFormat::SameAsSource => source_ext.clone(),
        OutputFormat::M4A => "m4a".to_string(),
        OutputFormat::MP3 => "mp3".to_string(),
        OutputFormat::Opus => "opus".to_string(),
    };

    // Create output directory
    let output_dir = Path::new(&options.output_dir);
    std::fs::create_dir_all(output_dir).context("Failed to create output directory")?;

    let mut output_files = Vec::new();
    let total_chapters = chapters.len();

    for (idx, chapter) in chapters.iter().enumerate() {
        // Format track number with zero-padding
        let track_num = format!(
            "{:0width$}",
            idx + 1,
            width = options.track_number_width as usize
        );

        // Generate output filename from pattern
        let filename = options
            .naming_pattern
            .replace("{num}", &track_num)
            .replace("{title}", &sanitize_filename(&chapter.title));

        let output_path = output_dir.join(format!("{}.{}", filename, output_ext));

        // Report progress
        if let Some(ref callback) = progress_callback {
            callback(SplitProgress {
                current_chapter: (idx + 1) as u32,
                total_chapters: total_chapters as u32,
                current_title: chapter.title.clone(),
                percent_complete: (idx as f32 / total_chapters as f32) * 100.0,
                status: format!("Splitting chapter {}/{}", idx + 1, total_chapters),
            });
        }

        // Build ffmpeg command
        let mut cmd = Command::new("ffmpeg");
        cmd.args([
            "-y", // Overwrite output
            "-i",
            file_path,
            "-ss",
            &chapter.start_time.to_string(),
            "-to",
            &chapter.end_time.to_string(),
        ]);

        // Use stream copy if same format (lossless, fast)
        if options.output_format == OutputFormat::SameAsSource {
            cmd.args(["-c", "copy"]);
        } else {
            // Need to transcode
            match options.output_format {
                OutputFormat::M4A => {
                    cmd.args(["-c:a", "aac", "-b:a", "128k"]);
                }
                OutputFormat::MP3 => {
                    cmd.args(["-c:a", "libmp3lame", "-b:a", "128k"]);
                }
                OutputFormat::Opus => {
                    cmd.args(["-c:a", "libopus", "-b:a", "64k"]);
                }
                OutputFormat::SameAsSource => unreachable!(),
            }
        }

        // Add metadata
        if options.copy_metadata {
            cmd.args([
                "-metadata",
                &format!("track={}/{}", idx + 1, total_chapters),
                "-metadata",
                &format!("title={}", chapter.title),
            ]);
        }

        cmd.arg(output_path.to_string_lossy().as_ref());

        // Execute
        let output = cmd.output().context("Failed to execute ffmpeg")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("FFmpeg failed for chapter {}: {}", idx + 1, stderr);
        }

        output_files.push(output_path.to_string_lossy().to_string());
        println!("   ✅ Created: {}", output_path.display());

        // Embed cover art if provided and requested
        if options.embed_cover {
            if let Some(cover_data) = cover {
                let output_path_str = output_path.to_string_lossy().to_string();
                match crate::cover_art::embed_cover_in_file(
                    &output_path_str,
                    &cover_data.data,
                    &cover_data.mime_type,
                ) {
                    Ok(_) => {
                        println!("   🖼️  Cover embedded in chapter {}", idx + 1);
                    }
                    Err(e) => {
                        // Log but don't fail - cover embedding is optional
                        eprintln!("   ⚠️  Failed to embed cover in chapter {}: {}", idx + 1, e);
                    }
                }
            }
        }
    }

    // Create M3U playlist if requested
    let playlist_path = if options.create_m3u_playlist {
        let playlist = create_m3u_playlist(&output_files, &options.output_dir)?;
        Some(playlist)
    } else {
        None
    };

    Ok(SplitResult {
        success: true,
        message: format!("Successfully split into {} chapters", output_files.len()),
        output_files,
        playlist_path,
    })
}

/// Create an M3U playlist for the split files
fn create_m3u_playlist(files: &[String], output_dir: &str) -> Result<String> {
    let playlist_path = Path::new(output_dir).join("playlist.m3u");

    let mut content = String::from("#EXTM3U\n");
    for file in files {
        let filename = Path::new(file)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(file);
        content.push_str(&format!("{}\n", filename));
    }

    std::fs::write(&playlist_path, content).context("Failed to write playlist")?;

    Ok(playlist_path.to_string_lossy().to_string())
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/// Format duration in seconds to HH:MM:SS
pub fn format_duration(seconds: f64) -> String {
    let total_seconds = seconds as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let secs = total_seconds % 60;

    if hours > 0 {
        format!("{:02}:{:02}:{:02}", hours, minutes, secs)
    } else {
        format!("{:02}:{:02}", minutes, secs)
    }
}

/// Parse duration string (HH:MM:SS or MM:SS) to seconds
pub fn parse_duration(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        2 => {
            let minutes: f64 = parts[0].parse().ok()?;
            let seconds: f64 = parts[1].parse().ok()?;
            Some(minutes * 60.0 + seconds)
        }
        3 => {
            let hours: f64 = parts[0].parse().ok()?;
            let minutes: f64 = parts[1].parse().ok()?;
            let seconds: f64 = parts[2].parse().ok()?;
            Some(hours * 3600.0 + minutes * 60.0 + seconds)
        }
        _ => None,
    }
}

/// Sanitize a string for use as a filename
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(0.0), "00:00");
        assert_eq!(format_duration(59.0), "00:59");
        assert_eq!(format_duration(60.0), "01:00");
        assert_eq!(format_duration(3661.0), "01:01:01");
        assert_eq!(format_duration(7200.0), "02:00:00");
    }

    #[test]
    fn test_parse_duration() {
        assert_eq!(parse_duration("01:30"), Some(90.0));
        assert_eq!(parse_duration("01:00:00"), Some(3600.0));
        assert_eq!(parse_duration("01:01:01"), Some(3661.0));
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename("Chapter 1"), "Chapter 1");
        assert_eq!(
            sanitize_filename("Part 1: The Beginning"),
            "Part 1_ The Beginning"
        );
        assert_eq!(sanitize_filename("Why?"), "Why_");
    }

    #[test]
    fn test_chapter_new() {
        let chapter = Chapter::new(0, "Intro".to_string(), 0.0, 120.0);
        assert_eq!(chapter.duration, 120.0);
        assert_eq!(chapter.start_display, "00:00");
        assert_eq!(chapter.end_display, "02:00");
    }
}
