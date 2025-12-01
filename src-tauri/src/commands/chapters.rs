// src-tauri/src/commands/chapters.rs
//! Tauri commands for chapter detection, extraction, and splitting

use serde::{Deserialize, Serialize};
use anyhow::Result;
use crate::chapters::{
    self, FFmpegInfo, ChapterInfo, Chapter, ChapterSource,
    SplitOptions, SplitResult, SilenceDetectionSettings,
    OutputFormat,
};

/// Check if FFmpeg is installed and available
#[tauri::command]
pub fn check_ffmpeg() -> FFmpegInfo {
    chapters::check_ffmpeg()
}

/// Get chapters from an audio file
/// Returns embedded chapters if available, otherwise returns empty list
#[tauri::command]
pub async fn get_chapters(file_path: String) -> Result<ChapterInfo, String> {
    println!("📚 Getting chapters for: {}", file_path);

    // First check if FFmpeg is available
    let ffmpeg_info = chapters::check_ffmpeg();
    if !ffmpeg_info.installed {
        return Err("FFmpeg is not installed. Please install FFmpeg to use chapter features.".to_string());
    }

    chapters::get_chapters(&file_path)
        .map_err(|e| e.to_string())
}

/// Detect chapters using silence detection
/// Use this for files without embedded chapters
#[tauri::command]
pub async fn detect_chapters_silence(
    file_path: String,
    noise_threshold_db: Option<i32>,
    min_silence_duration: Option<f64>,
    min_chapter_duration: Option<f64>,
) -> Result<ChapterInfo, String> {
    println!("🔇 Detecting chapters via silence for: {}", file_path);

    // First check if FFmpeg is available
    let ffmpeg_info = chapters::check_ffmpeg();
    if !ffmpeg_info.installed {
        return Err("FFmpeg is not installed. Please install FFmpeg to use chapter features.".to_string());
    }

    let settings = SilenceDetectionSettings {
        noise_threshold_db: noise_threshold_db.unwrap_or(-30),
        min_silence_duration: min_silence_duration.unwrap_or(0.5),
        min_chapter_duration: min_chapter_duration.unwrap_or(60.0),
    };

    chapters::detect_chapters_from_silence(&file_path, &settings)
        .map_err(|e| e.to_string())
}

/// Response for get_or_detect_chapters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChaptersResponse {
    pub chapter_info: ChapterInfo,
    pub detection_method: String,
}

/// Get chapters - first try embedded, then fall back to silence detection
#[tauri::command]
pub async fn get_or_detect_chapters(
    file_path: String,
    use_silence_detection: bool,
) -> Result<ChaptersResponse, String> {
    println!("📚 Getting or detecting chapters for: {}", file_path);

    // First check if FFmpeg is available
    let ffmpeg_info = chapters::check_ffmpeg();
    if !ffmpeg_info.installed {
        return Err("FFmpeg is not installed. Please install FFmpeg to use chapter features.".to_string());
    }

    // Try to get embedded chapters first
    let chapter_info = chapters::get_chapters(&file_path)
        .map_err(|e| e.to_string())?;

    if !chapter_info.chapters.is_empty() {
        return Ok(ChaptersResponse {
            chapter_info,
            detection_method: "embedded".to_string(),
        });
    }

    // No embedded chapters - try silence detection if enabled
    if use_silence_detection {
        let settings = SilenceDetectionSettings::default();
        let detected = chapters::detect_chapters_from_silence(&file_path, &settings)
            .map_err(|e| e.to_string())?;

        return Ok(ChaptersResponse {
            chapter_info: detected,
            detection_method: "silence_detection".to_string(),
        });
    }

    // Return empty chapter info
    Ok(ChaptersResponse {
        chapter_info,
        detection_method: "none".to_string(),
    })
}

/// Request for split_audiobook_chapters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitRequest {
    pub file_path: String,
    pub chapters: Vec<Chapter>,
    pub output_dir: String,
    pub output_format: String,
    pub naming_pattern: Option<String>,
    pub copy_metadata: Option<bool>,
    pub embed_cover: Option<bool>,
    pub create_playlist: Option<bool>,
    /// Base64-encoded cover image data
    pub cover_data: Option<String>,
    /// MIME type of cover image (e.g., "image/jpeg", "image/png")
    pub cover_mime_type: Option<String>,
    /// If true, add .bak extension to original file to hide it from ABS
    pub hide_original: Option<bool>,
}

/// Split an audiobook by chapters
#[tauri::command]
pub async fn split_audiobook_chapters(request: SplitRequest) -> Result<SplitResult, String> {
    println!("✂️  Splitting audiobook: {}", request.file_path);
    println!("   Output directory: {}", request.output_dir);
    println!("   Chapters to split: {}", request.chapters.len());

    // First check if FFmpeg is available
    let ffmpeg_info = chapters::check_ffmpeg();
    if !ffmpeg_info.installed {
        return Err("FFmpeg is not installed. Please install FFmpeg to use chapter features.".to_string());
    }

    // Parse output format
    let output_format = match request.output_format.to_lowercase().as_str() {
        "same" | "sameassource" => OutputFormat::SameAsSource,
        "m4a" => OutputFormat::M4A,
        "mp3" => OutputFormat::MP3,
        "opus" => OutputFormat::Opus,
        _ => OutputFormat::SameAsSource,
    };

    let options = SplitOptions {
        output_dir: request.output_dir,
        output_format,
        naming_pattern: request.naming_pattern.unwrap_or_else(|| "{num} - {title}".to_string()),
        copy_metadata: request.copy_metadata.unwrap_or(true),
        embed_cover: request.embed_cover.unwrap_or(true),
        create_m3u_playlist: request.create_playlist.unwrap_or(true),
        track_number_width: 2,
    };

    // Parse cover data if provided
    let cover = match (&request.cover_data, &request.cover_mime_type) {
        (Some(data_base64), Some(mime_type)) => {
            use base64::Engine;
            match base64::engine::general_purpose::STANDARD.decode(data_base64) {
                Ok(data) => {
                    println!("   🖼️  Cover data provided ({} bytes)", data.len());
                    Some(chapters::CoverData {
                        data,
                        mime_type: mime_type.clone(),
                    })
                }
                Err(e) => {
                    eprintln!("   ⚠️  Failed to decode cover data: {}", e);
                    None
                }
            }
        }
        _ => None,
    };

    let result = chapters::split_by_chapters_with_cover(
        &request.file_path,
        &request.chapters,
        &options,
        None,
        cover.as_ref(),
    )
    .map_err(|e| e.to_string())?;

    // If splitting was successful and hide_original is true, rename original file to .bak
    if result.success && request.hide_original.unwrap_or(false) {
        let original_path = std::path::Path::new(&request.file_path);
        let bak_path = original_path.with_extension(
            format!("{}.bak",
                original_path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("m4b")
            )
        );

        if let Err(e) = std::fs::rename(original_path, &bak_path) {
            eprintln!("   ⚠️  Failed to hide original file: {}", e);
            // Don't fail the whole operation, just log the warning
        } else {
            println!("   📦 Original file hidden: {} -> {}",
                original_path.display(),
                bak_path.display()
            );
        }
    }

    Ok(result)
}

/// Restore a hidden original file (remove .bak extension)
#[tauri::command]
pub async fn restore_original_file(bak_file_path: String) -> Result<String, String> {
    let bak_path = std::path::Path::new(&bak_file_path);

    if !bak_path.exists() {
        return Err(format!("File not found: {}", bak_file_path));
    }

    // Check if it ends with .bak
    let file_name = bak_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    if !file_name.ends_with(".bak") {
        return Err("File does not have .bak extension".to_string());
    }

    // Remove the .bak suffix to get the original filename
    let original_name = &file_name[..file_name.len() - 4]; // Remove ".bak"
    let original_path = bak_path.with_file_name(original_name);

    if original_path.exists() {
        return Err(format!(
            "Cannot restore: original file already exists at {}",
            original_path.display()
        ));
    }

    std::fs::rename(bak_path, &original_path)
        .map_err(|e| format!("Failed to restore file: {}", e))?;

    println!("   📦 Original file restored: {} -> {}",
        bak_path.display(),
        original_path.display()
    );

    Ok(original_path.to_string_lossy().to_string())
}

/// Update chapter titles
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterUpdate {
    pub id: u32,
    pub title: String,
}

/// Apply chapter title updates
#[tauri::command]
pub fn update_chapter_titles(
    chapters: Vec<Chapter>,
    updates: Vec<ChapterUpdate>,
) -> Vec<Chapter> {
    let mut result = chapters;

    for update in updates {
        if let Some(chapter) = result.iter_mut().find(|c| c.id == update.id) {
            chapter.title = update.title;
        }
    }

    result
}

/// Get file duration
#[tauri::command]
pub async fn get_audio_duration(file_path: String) -> Result<f64, String> {
    // First check if FFmpeg is available
    let ffmpeg_info = chapters::check_ffmpeg();
    if !ffmpeg_info.installed {
        return Err("FFmpeg is not installed.".to_string());
    }

    chapters::get_file_duration(&file_path)
        .map_err(|e| e.to_string())
}

/// Create chapters from multiple files in a folder
/// Uses filenames to determine chapter titles and file order
#[tauri::command]
pub async fn create_chapters_from_files(
    file_paths: Vec<String>,
) -> Result<Vec<Chapter>, String> {
    println!("📁 Creating chapters from {} files", file_paths.len());

    // First check if FFmpeg is available
    let ffmpeg_info = chapters::check_ffmpeg();
    if !ffmpeg_info.installed {
        return Err("FFmpeg is not installed.".to_string());
    }

    let mut chapters = Vec::new();
    let mut cumulative_time = 0.0;

    for (idx, file_path) in file_paths.iter().enumerate() {
        let duration = chapters::get_file_duration(file_path)
            .map_err(|e| format!("Failed to get duration for {}: {}", file_path, e))?;

        // Extract title from filename
        let path = std::path::Path::new(file_path);
        let title = path.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| clean_chapter_title(s))
            .unwrap_or_else(|| format!("Chapter {}", idx + 1));

        chapters.push(Chapter::new(
            idx as u32,
            title,
            cumulative_time,
            cumulative_time + duration,
        ));

        cumulative_time += duration;
    }

    Ok(chapters)
}

/// Clean up a chapter title extracted from filename
fn clean_chapter_title(filename: &str) -> String {
    // Remove common prefixes like "01 - ", "01_", "Track 01", etc.
    let re = regex::Regex::new(r"^(\d+[\s_.-]+|Track\s*\d+[\s_.-]+)").unwrap();
    let cleaned = re.replace(filename, "").to_string();

    // Remove file extension if somehow still present
    let cleaned = cleaned.trim_end_matches(".mp3")
        .trim_end_matches(".m4a")
        .trim_end_matches(".m4b")
        .trim_end_matches(".flac")
        .trim_end_matches(".ogg");

    // Clean up underscores and extra spaces
    cleaned
        .replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Merge multiple chapters into one
#[tauri::command]
pub fn merge_chapters(
    chapters: Vec<Chapter>,
    start_id: u32,
    end_id: u32,
    new_title: String,
) -> Result<Vec<Chapter>, String> {
    let start_idx = chapters.iter().position(|c| c.id == start_id)
        .ok_or("Start chapter not found")?;
    let end_idx = chapters.iter().position(|c| c.id == end_id)
        .ok_or("End chapter not found")?;

    if start_idx > end_idx {
        return Err("Start chapter must come before end chapter".to_string());
    }

    let mut result = Vec::new();

    // Add chapters before the merge range
    for chapter in chapters.iter().take(start_idx) {
        result.push(chapter.clone());
    }

    // Create merged chapter
    let start_time = chapters[start_idx].start_time;
    let end_time = chapters[end_idx].end_time;
    result.push(Chapter::new(
        result.len() as u32,
        new_title,
        start_time,
        end_time,
    ));

    // Add chapters after the merge range
    for chapter in chapters.iter().skip(end_idx + 1) {
        let mut c = chapter.clone();
        c.id = result.len() as u32;
        result.push(c);
    }

    Ok(result)
}

/// Adjust chapter boundary
#[tauri::command]
pub fn adjust_chapter_boundary(
    chapters: Vec<Chapter>,
    chapter_id: u32,
    new_end_time: f64,
) -> Result<Vec<Chapter>, String> {
    let idx = chapters.iter().position(|c| c.id == chapter_id)
        .ok_or("Chapter not found")?;

    let mut result = chapters;

    // Validate new end time
    if new_end_time <= result[idx].start_time {
        return Err("End time must be after start time".to_string());
    }

    // Update this chapter's end time
    result[idx] = Chapter::new(
        result[idx].id,
        result[idx].title.clone(),
        result[idx].start_time,
        new_end_time,
    );

    // Update next chapter's start time if it exists
    if idx + 1 < result.len() {
        let next = &result[idx + 1];
        result[idx + 1] = Chapter::new(
            next.id,
            next.title.clone(),
            new_end_time,
            next.end_time,
        );
    }

    Ok(result)
}
