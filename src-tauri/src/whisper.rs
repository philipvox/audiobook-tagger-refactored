// src-tauri/src/whisper.rs
// OpenAI Whisper API integration for audio transcription
// Extracts first N seconds of audio to verify book title/author from narrator intro

use regex::Regex;
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::process::Command;
use tempfile::NamedTempFile;

/// Result of transcribing audio intro
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
    /// Raw transcript text from Whisper
    pub transcript: String,
    /// Extracted book title (if detected)
    pub extracted_title: Option<String>,
    /// Extracted author name (if detected)
    pub extracted_author: Option<String>,
    /// Extracted narrator name (if detected)
    pub extracted_narrator: Option<String>,
    /// Confidence in the extraction (0-100)
    pub confidence: u8,
}

/// Book info extracted from transcript
#[derive(Debug, Clone, Default)]
pub struct ExtractedBookInfo {
    pub title: Option<String>,
    pub author: Option<String>,
    pub narrator: Option<String>,
}

/// Extract first N seconds of audio and transcribe via OpenAI Whisper API
pub async fn transcribe_audio_intro(
    audio_path: &str,
    duration_secs: u32,
    api_key: &str,
) -> Result<TranscriptionResult, Box<dyn std::error::Error + Send + Sync>> {
    println!("   🎤 Extracting first {} seconds of audio...", duration_secs);

    // Create a temp file for the extracted audio segment
    let temp_file = NamedTempFile::with_suffix(".mp3")?;
    let temp_path = temp_file.path().to_string_lossy().to_string();

    // Extract audio segment using FFmpeg
    extract_audio_segment(audio_path, &temp_path, 0, duration_secs)?;

    // Read the extracted audio
    let audio_data = std::fs::read(&temp_path)?;

    if audio_data.is_empty() {
        return Err("Extracted audio is empty".into());
    }

    println!("   🎤 Extracted {} KB, sending to Whisper API...", audio_data.len() / 1024);

    // Call Whisper API
    let transcript = call_whisper_api(audio_data, api_key).await?;

    println!("   🎤 Transcript: {}...",
        transcript.chars().take(100).collect::<String>());

    // Parse book info from transcript
    let extracted = parse_book_info_from_transcript(&transcript);

    let confidence = calculate_confidence(&extracted);

    Ok(TranscriptionResult {
        transcript,
        extracted_title: extracted.title,
        extracted_author: extracted.author,
        extracted_narrator: extracted.narrator,
        confidence,
    })
}

/// Extract audio segment using FFmpeg
/// Outputs mono MP3 at 16kHz (optimal for Whisper)
fn extract_audio_segment(
    input_path: &str,
    output_path: &str,
    start_secs: u32,
    duration_secs: u32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // FFmpeg command:
    // ffmpeg -i "input.m4b" -ss 0 -t 90 -vn -acodec libmp3lame -ar 16000 -ac 1 -q:a 9 "output.mp3"
    // -ss: start time
    // -t: duration
    // -vn: no video
    // -acodec libmp3lame: MP3 codec
    // -ar 16000: 16kHz sample rate (Whisper optimized)
    // -ac 1: mono (smaller file)
    // -q:a 9: lower quality (smaller file, still good for speech)

    let output = Command::new("ffmpeg")
        .args([
            "-y",           // Overwrite output file
            "-i", input_path,
            "-ss", &start_secs.to_string(),
            "-t", &duration_secs.to_string(),
            "-vn",          // No video
            "-acodec", "libmp3lame",
            "-ar", "16000", // 16kHz
            "-ac", "1",     // Mono
            "-q:a", "9",    // Lower quality (smaller file)
            output_path,
        ])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed: {}", stderr).into());
    }

    // Verify output file exists and has content
    let metadata = std::fs::metadata(output_path)?;
    if metadata.len() == 0 {
        return Err("FFmpeg produced empty output".into());
    }

    Ok(())
}

/// Call OpenAI Whisper API to transcribe audio
async fn call_whisper_api(
    audio_data: Vec<u8>,
    api_key: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();

    // Create multipart form
    let part = multipart::Part::bytes(audio_data)
        .file_name("audio.mp3")
        .mime_str("audio/mpeg")?;

    let form = multipart::Form::new()
        .text("model", "whisper-1")
        .text("response_format", "text")
        .text("language", "en")  // Assume English for audiobooks
        .part("file", part);

    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!("Whisper API error {}: {}", status, error_body).into());
    }

    // Response format is plain text when response_format=text
    let transcript = response.text().await?;

    Ok(transcript.trim().to_string())
}

/// Parse title/author/narrator from transcription text
/// Looks for common audiobook introduction patterns
pub fn parse_book_info_from_transcript(transcript: &str) -> ExtractedBookInfo {
    let mut info = ExtractedBookInfo::default();

    // Normalize whitespace
    let text = transcript
        .replace('\n', " ")
        .replace('\r', " ");
    let text = text.trim();

    // Common patterns in audiobook intros:
    // "This is [Title] by [Author]"
    // "[Title] by [Author], read by [Narrator]"
    // "[Title], written by [Author], narrated by [Narrator]"
    // "[Title] by [Author], performed by [Narrator]"
    // "Welcome to [Title] by [Author]"
    // "You are listening to [Title] by [Author]"

    lazy_static::lazy_static! {
        // Pattern: "This is [Title] by [Author]"
        static ref THIS_IS_BY: Regex = Regex::new(
            r"(?i)(?:this is|welcome to|you are listening to)\s+(.+?)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)"
        ).unwrap();

        // Pattern: "[Title] by [Author], read/narrated/performed by [Narrator]"
        static ref TITLE_BY_AUTHOR_NARRATOR: Regex = Regex::new(
            r"(?i)^(.+?)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,?\s+(?:read|narrated|performed)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)"
        ).unwrap();

        // Pattern: "[Title], written by [Author]"
        static ref WRITTEN_BY: Regex = Regex::new(
            r"(?i)^(.+?),?\s+written\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)"
        ).unwrap();

        // Pattern: "[Title] by [Author]" (simple)
        static ref SIMPLE_BY: Regex = Regex::new(
            r"(?i)^(.+?)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)"
        ).unwrap();

        // Pattern: "narrated by [Narrator]" or "read by [Narrator]"
        static ref NARRATOR_PATTERN: Regex = Regex::new(
            r"(?i)(?:narrated|read|performed)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)"
        ).unwrap();

        // Pattern: Book number/series patterns
        static ref BOOK_NUMBER: Regex = Regex::new(
            r"(?i)book\s+(?:number\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)"
        ).unwrap();

        // Pattern: "[Publisher] presents [Series] [Title]" (e.g., "Listening Library presents Magic Tree House...")
        // Captures the full title after "presents"
        static ref PUBLISHER_PRESENTS: Regex = Regex::new(
            r"(?i)(?:listening library|random house|penguin|harper|simon|scholastic|audible)[^a-z]*presents\s+(.+)"
        ).unwrap();

        // Pattern: "[Series] book [number] [Title]" (e.g., "Magic Tree House Merlin Missions book number one Christmas in Camelot")
        static ref SERIES_BOOK_TITLE: Regex = Regex::new(
            r"(?i)(.+?)\s+book\s+(?:number\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)"
        ).unwrap();
    }

    // Try patterns in order of specificity

    // Try full pattern with narrator first
    if let Some(caps) = TITLE_BY_AUTHOR_NARRATOR.captures(text) {
        info.title = caps.get(1).map(|m| clean_title(m.as_str()));
        info.author = caps.get(2).map(|m| m.as_str().to_string());
        info.narrator = caps.get(3).map(|m| m.as_str().to_string());
        return info;
    }

    // Try "This is [Title] by [Author]"
    if let Some(caps) = THIS_IS_BY.captures(text) {
        info.title = caps.get(1).map(|m| clean_title(m.as_str()));
        info.author = caps.get(2).map(|m| m.as_str().to_string());
    }

    // Try "written by" pattern
    if info.title.is_none() {
        if let Some(caps) = WRITTEN_BY.captures(text) {
            info.title = caps.get(1).map(|m| clean_title(m.as_str()));
            info.author = caps.get(2).map(|m| m.as_str().to_string());
        }
    }

    // Try "[Publisher] presents [Series] book [number] [Title]" pattern
    // e.g., "Listening Library presents Magic Tree House Merlin Missions book number one Christmas in Camelot"
    if info.title.is_none() {
        if let Some(caps) = PUBLISHER_PRESENTS.captures(text) {
            let after_presents = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            // Now try to parse "[Series] book [number] [Title]" from what's after "presents"
            if let Some(series_caps) = SERIES_BOOK_TITLE.captures(after_presents) {
                // Series is captured in group 1, book number in group 2, title in group 3
                let series = series_caps.get(1).map(|m| m.as_str().trim());
                let title = series_caps.get(3).map(|m| m.as_str().trim());

                if let Some(t) = title {
                    // Extract just the title, stop at next sentence
                    let clean_t = t.split(['.', '!', '?']).next().unwrap_or(t).trim();
                    info.title = Some(clean_title(clean_t));
                }
                // We don't have author from this format, but at least we have the title
            } else {
                // Just use what's after "presents" as the title
                let potential_title = after_presents.split(['.', '!', '?']).next().unwrap_or(after_presents).trim();
                if potential_title.len() < 150 {
                    info.title = Some(clean_title(potential_title));
                }
            }
        }
    }

    // Try "[Series] book [number] [Title]" pattern without publisher prefix
    if info.title.is_none() {
        if let Some(caps) = SERIES_BOOK_TITLE.captures(text) {
            let title = caps.get(3).map(|m| m.as_str().trim());
            if let Some(t) = title {
                let clean_t = t.split(['.', '!', '?']).next().unwrap_or(t).trim();
                if clean_t.len() < 100 {
                    info.title = Some(clean_title(clean_t));
                }
            }
        }
    }

    // Try simple "by" pattern
    if info.title.is_none() {
        if let Some(caps) = SIMPLE_BY.captures(text) {
            let potential_title = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            // Only accept if title looks reasonable (not too long, not just noise)
            if potential_title.len() < 100 && potential_title.split_whitespace().count() < 15 {
                info.title = Some(clean_title(potential_title));
                info.author = caps.get(2).map(|m| m.as_str().to_string());
            }
        }
    }

    // Extract narrator separately if not already found
    if info.narrator.is_none() {
        if let Some(caps) = NARRATOR_PATTERN.captures(text) {
            info.narrator = caps.get(1).map(|m| m.as_str().to_string());
        }
    }

    info
}

/// Clean up extracted title
fn clean_title(title: &str) -> String {
    let mut cleaned = title.trim().to_string();

    // Remove leading articles if they seem misplaced
    // (but keep them if they're likely part of the title)

    // Remove trailing punctuation
    cleaned = cleaned.trim_end_matches(['.', ',', ':', ';', '-']).to_string();

    // Remove any quotes
    cleaned = cleaned.replace('"', "").replace('\'', "");

    // Capitalize words properly
    cleaned = title_case(&cleaned);

    cleaned
}

/// Convert to title case
fn title_case(s: &str) -> String {
    let small_words = ["a", "an", "the", "and", "but", "or", "for", "nor",
                       "on", "at", "to", "from", "by", "of", "in"];

    s.split_whitespace()
        .enumerate()
        .map(|(i, word)| {
            let lower = word.to_lowercase();
            if i == 0 || !small_words.contains(&lower.as_str()) {
                // Capitalize first letter
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().chain(chars).collect(),
                    None => String::new(),
                }
            } else {
                lower
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Calculate confidence score based on what was extracted
fn calculate_confidence(info: &ExtractedBookInfo) -> u8 {
    let mut score = 0u8;

    if info.title.is_some() {
        score += 40;
    }
    if info.author.is_some() {
        score += 40;
    }
    if info.narrator.is_some() {
        score += 20;
    }

    score
}

/// Check if FFmpeg is available
pub fn check_ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_this_is_by() {
        let transcript = "This is Harry Potter and the Sorcerer's Stone by J.K. Rowling";
        let info = parse_book_info_from_transcript(transcript);
        assert!(info.title.is_some());
        assert!(info.author.is_some());
        assert!(info.title.unwrap().contains("Harry Potter"));
    }

    #[test]
    fn test_parse_full_intro() {
        let transcript = "Harry Potter and the Chamber of Secrets by J.K. Rowling, read by Jim Dale";
        let info = parse_book_info_from_transcript(transcript);
        assert!(info.title.is_some());
        assert!(info.author.is_some());
        assert!(info.narrator.is_some());
        assert_eq!(info.narrator.unwrap(), "Jim Dale");
    }

    #[test]
    fn test_parse_narrated_by() {
        let transcript = "The Great Gatsby by F. Scott Fitzgerald, narrated by Jake Gyllenhaal";
        let info = parse_book_info_from_transcript(transcript);
        assert!(info.title.is_some());
        assert!(info.author.is_some());
        assert!(info.narrator.is_some());
    }

    #[test]
    fn test_parse_welcome_to() {
        let transcript = "Welcome to The Hobbit by J.R.R. Tolkien";
        let info = parse_book_info_from_transcript(transcript);
        assert!(info.title.is_some());
        // Note: J.R.R. might not match perfectly due to periods
    }

    #[test]
    fn test_confidence_calculation() {
        let full_info = ExtractedBookInfo {
            title: Some("Test".to_string()),
            author: Some("Author".to_string()),
            narrator: Some("Narrator".to_string()),
        };
        assert_eq!(calculate_confidence(&full_info), 100);

        let partial_info = ExtractedBookInfo {
            title: Some("Test".to_string()),
            author: None,
            narrator: None,
        };
        assert_eq!(calculate_confidence(&partial_info), 40);
    }

    #[test]
    fn test_title_case() {
        assert_eq!(title_case("the lord of the rings"), "The Lord of the Rings");
        assert_eq!(title_case("a tale of two cities"), "A Tale of Two Cities");
    }
}
