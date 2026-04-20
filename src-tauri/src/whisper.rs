// src-tauri/src/whisper.rs
// Audio intro extraction: FFmpeg + OpenAI Whisper + regex parsing
// Extracts narrator, author, publisher from first 60s of audiobook audio

use regex::Regex;
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tempfile::NamedTempFile;

static CANCELLED: AtomicBool = AtomicBool::new(false);

/// Result of audio intro extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioIntroResult {
    pub item_id: String,
    pub transcript: Option<String>,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub narrators: Vec<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub audio_publisher: Option<String>,
    pub language: Option<String>,
    pub parse_method: String,
    pub confidence: f32,
}

/// Request for audio intro extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioIntroRequest {
    pub item_id: String,
    pub source: String,            // "abs" or "local"
    pub title: Option<String>,
    pub author: Option<String>,
    pub file_ino: Option<String>,
    pub file_path: Option<String>,
    pub abs_base_url: Option<String>,
    pub abs_api_token: Option<String>,
    pub openai_api_key: Option<String>,
    pub use_local_ai: Option<bool>,
    pub ollama_model: Option<String>,
    pub ollama_base_url: Option<String>,
    pub use_local_whisper: Option<bool>,
    pub whisper_model: Option<String>,
}

/// Book info extracted from transcript via regex
#[derive(Debug, Clone, Default)]
struct ExtractedBookInfo {
    title: Option<String>,
    subtitle: Option<String>,
    author: Option<String>,
    narrator: Option<String>,
    publisher: Option<String>,
    audio_publisher: Option<String>,
}

// ---- Tauri commands ----

#[tauri::command]
pub fn cancel_audio_extraction() -> Result<String, String> {
    CANCELLED.store(true, Ordering::SeqCst);
    Ok("Cancelled".to_string())
}

#[tauri::command]
pub async fn extract_audio_intro(request: AudioIntroRequest, window: tauri::Window) -> Result<AudioIntroResult, String> {
    if !check_ffmpeg_available() {
        return Err("FFmpeg is not installed. Install it with: brew install ffmpeg".to_string());
    }

    // Check cache
    if let Some(cached) = get_cached_transcript(&request.item_id) {
        return Ok(cached);
    }

    Ok(extract_intro_metadata_with_stages(&request, &window, 1, 1).await)
}

#[tauri::command]
pub async fn batch_extract_audio_intros(
    items: Vec<AudioIntroRequest>,
    force: bool,
    window: tauri::Window,
) -> Result<Vec<AudioIntroResult>, String> {
    use tauri::Emitter;

    if !check_ffmpeg_available() {
        return Err("FFmpeg is not installed. Install it with: brew install ffmpeg".to_string());
    }

    // Reset cancel flag
    CANCELLED.store(false, Ordering::SeqCst);

    let total = items.len();
    let mut results = Vec::with_capacity(total);
    let mut found_count = 0;
    let mut cached_count = 0;
    let mut skipped_count = 0;

    for (i, request) in items.into_iter().enumerate() {
        // Check if cancelled
        if CANCELLED.load(Ordering::SeqCst) {
            let _ = window.emit("audio_intro_progress", serde_json::json!({
                "current": i, "total": total, "found": found_count, "cached": cached_count,
                "stage": "cancelled",
                "status": format!("Cancelled after {} of {} books ({} found)", i, total, found_count),
            }));
            break;
        }

        let title = request.title.as_deref().unwrap_or(&request.item_id);

        // Check cache first
        if !force {
            if let Some(cached) = get_cached_transcript(&request.item_id) {
                if !cached.narrators.is_empty() { found_count += 1; }
                cached_count += 1;
                let _ = window.emit("audio_intro_progress", serde_json::json!({
                    "current": i + 1, "total": total, "found": found_count, "cached": cached_count,
                    "stage": "cached",
                    "status": format!("{} (cached)", title),
                }));
                results.push(cached);
                continue;
            }
        }

        // Stage: downloading
        let _ = window.emit("audio_intro_progress", serde_json::json!({
            "current": i + 1, "total": total, "found": found_count, "cached": cached_count,
            "stage": "downloading",
            "status": format!("Downloading audio: {}", title),
        }));

        let result = extract_intro_metadata_with_stages(&request, &window, i + 1, total).await;
        if !result.narrators.is_empty() { found_count += 1; }
        if result.narrators.is_empty() && result.transcript.is_none() { skipped_count += 1; }
        results.push(result);
    }

    // Clean up any lingering temp files in the system temp dir
    cleanup_temp_files();

    if !CANCELLED.load(Ordering::SeqCst) {
        let _ = window.emit("audio_intro_progress", serde_json::json!({
            "current": total, "total": total, "found": found_count, "cached": cached_count,
            "stage": "complete",
            "status": format!("Done! {} found, {} cached, {} skipped", found_count, cached_count, skipped_count),
        }));
    }

    Ok(results)
}

// ---- Pipeline ----

/// Pipeline with stage-by-stage progress events
/// Tries multiple time windows if first pass finds nothing useful
async fn extract_intro_metadata_with_stages(
    request: &AudioIntroRequest,
    window: &tauri::Window,
    current: usize,
    total: usize,
) -> AudioIntroResult {
    use tauri::Emitter;
    let item_id = request.item_id.clone();
    let title = request.title.as_deref().unwrap_or(&item_id);

    // Try progressively deeper into the audio if first pass finds nothing
    // Pass 1: 0-60s (most intros are here)
    // Pass 2: 60-180s (skip dedication/music, catch late intros)
    // Pass 3: 0-180s (grab everything, longer context)
    let time_windows: &[(u32, u32, &str)] = &[
        (0, 60, "first 60s"),
        (60, 120, "60-180s"),
        (0, 180, "first 3 min"),
    ];

    for (pass_idx, &(start_secs, duration_secs, label)) in time_windows.iter().enumerate() {
        let is_retry = pass_idx > 0;

        let _ = window.emit("audio_intro_progress", serde_json::json!({
            "current": current, "total": total,
            "stage": if is_retry { "deep_scan" } else { "extracting" },
            "status": format!("{}: {} ({})", if is_retry { "Deep scan" } else { "Extracting" }, title, label),
        }));

        let result = try_extract_at_offset(request, window, current, total, start_secs, duration_secs).await;

        // Consider it a good result if we found at least 2 useful fields
        let fields_found = [
            result.title.is_some(),
            !result.narrators.is_empty(),
            !result.authors.is_empty(),
            result.publisher.is_some() || result.audio_publisher.is_some(),
        ].iter().filter(|&&v| v).count();

        if fields_found >= 2 {
            cache_transcript(&result);
            return result;
        }

        // If this is the last pass, return whatever we got (even if empty)
        if pass_idx == time_windows.len() - 1 {
            cache_transcript(&result);
            return result;
        }

        // Otherwise, try next window
        let _ = window.emit("audio_intro_progress", serde_json::json!({
            "current": current, "total": total,
            "stage": "deep_scan",
            "status": format!("No metadata in {}, scanning deeper: {}", label, title),
        }));
    }

    // Should not reach here, but just in case
    empty_result(&item_id)
}

/// Try extracting metadata from a specific time window in the audio
async fn try_extract_at_offset(
    request: &AudioIntroRequest,
    window: &tauri::Window,
    current: usize,
    total: usize,
    start_secs: u32,
    duration_secs: u32,
) -> AudioIntroResult {
    use tauri::Emitter;
    let item_id = request.item_id.clone();
    let title = request.title.as_deref().unwrap_or(&item_id);

    let use_local_whisper = request.use_local_whisper.unwrap_or(false);
    let whisper_model = request.whisper_model.as_deref().unwrap_or("base");

    // Output format: WAV for local whisper, MP3 for cloud
    let (out_suffix, out_format) = if use_local_whisper {
        (".wav", "wav")
    } else {
        (".mp3", "mp3")
    };

    let temp_audio = match NamedTempFile::with_suffix(out_suffix) {
        Ok(f) => f,
        Err(e) => {
            println!("   Temp file error for {}: {}", item_id, e);
            return empty_result(&item_id);
        }
    };
    let out_path = temp_audio.path().to_string_lossy().to_string();

    // Build FFmpeg input: stream from ABS URL or read local file
    let extract_result = if request.source == "abs" {
        // Stream directly from ABS - FFmpeg fetches only what it needs (no full download)
        let abs_url = match build_abs_audio_url(request).await {
            Ok(url) => url,
            Err(e) => {
                println!("   ABS URL error for {}: {}", item_id, e);
                return empty_result(&item_id);
            }
        };
        let token = request.abs_api_token.as_deref().unwrap_or("");

        extract_audio_from_url_with_offset(&abs_url, token, &out_path, start_secs, duration_secs, out_format)
    } else {
        // Local file
        let local_path = request.file_path.as_deref().unwrap_or("");
        extract_audio_segment(local_path, &out_path, start_secs, duration_secs, out_format)
    };

    if let Err(e) = extract_result {
        println!("   FFmpeg error for {}: {}", item_id, e);
        return empty_result(&item_id);
    }

    let audio_data = match std::fs::read(&out_path) {
        Ok(data) if data.len() > 100 => data,
        _ => {
            println!("   Extracted audio too small for {}", item_id);
            return empty_result(&item_id);
        }
    };

    // Stage: transcribing
    let (transcript, detected_language) = if use_local_whisper {
        let _ = window.emit("audio_intro_progress", serde_json::json!({
            "current": current, "total": total,
            "stage": "transcribing",
            "status": format!("Local Whisper: {}", title),
        }));

        match crate::whisper_local::transcribe_local(&out_path, whisper_model) {
            Ok((text, lang)) => (text, lang),
            Err(e) => {
                println!("   Local whisper failed for {}: {}", item_id, e);
                let _ = window.emit("audio_intro_progress", serde_json::json!({
                    "current": current, "total": total,
                    "stage": "error",
                    "status": format!("Local Whisper failed: {}", e),
                }));
                return empty_result(&item_id);
            }
        }
    } else {
        let _ = window.emit("audio_intro_progress", serde_json::json!({
            "current": current, "total": total,
            "stage": "transcribing",
            "status": format!("Whisper transcribing: {}", title),
        }));

        match try_cloud_whisper(&audio_data, request.openai_api_key.as_deref()).await {
            Ok(r) => (r.text, r.language),
            Err(e) => {
                println!("   Whisper API error for {}: {}", item_id, e);
                return empty_result(&item_id);
            }
        }
    };

    if transcript.len() < 20 {
        return AudioIntroResult {
            item_id, transcript: Some(transcript), title: None, subtitle: None,
            narrators: vec![], authors: vec![],
            publisher: None, audio_publisher: None,
            language: detected_language,
            parse_method: "none".to_string(), confidence: 0.0,
        };
    }

    // Stage: parsing
    let _ = window.emit("audio_intro_progress", serde_json::json!({
        "current": current, "total": total,
        "stage": "parsing",
        "status": format!("Parsing transcript: {}", title),
    }));

    // Try LLM parsing first (more accurate), fall back to regex
    let (extracted, method) = match try_llm_parse(&transcript, request.title.as_deref(), request).await {
        Ok(info) => (info, "llm"),
        Err(e) => {
            println!("   LLM parse failed, using regex: {}", e);
            (parse_book_info_from_transcript(&transcript), "regex")
        }
    };

    let mut narrators = vec![];
    if let Some(n) = &extracted.narrator { narrators.push(n.clone()); }
    let mut authors = vec![];
    if let Some(a) = &extracted.author { authors.push(a.clone()); }

    let confidence = calculate_confidence(&extracted);

    let result = AudioIntroResult {
        item_id, transcript: Some(transcript),
        title: extracted.title,
        subtitle: extracted.subtitle,
        narrators, authors,
        publisher: extracted.publisher,
        audio_publisher: extracted.audio_publisher,
        language: detected_language,
        parse_method: method.to_string(),
        confidence,
    };

    result
}

// ---- Audio streaming + extraction ----

/// Build the ABS audio URL for streaming (resolves file_ino if needed)
async fn build_abs_audio_url(request: &AudioIntroRequest) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let base_url = request.abs_base_url.as_deref().ok_or("No ABS base URL")?;
    let token = request.abs_api_token.as_deref().ok_or("No ABS API token")?;

    if base_url.is_empty() || token.is_empty() {
        return Err("ABS URL or token is empty".into());
    }

    // If we have file_ino, use it directly
    if let Some(ino) = request.file_ino.as_deref() {
        return Ok(format!("{}/api/items/{}/file/{}", base_url.trim_end_matches('/'), request.item_id, ino));
    }

    // Otherwise fetch the item to get the first audio file's ino
    let item_url = format!("{}/api/items/{}?expanded=1", base_url.trim_end_matches('/'), request.item_id);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()?;
    let response = client.get(&item_url)
        .header("Authorization", format!("Bearer {}", token))
        .send().await?;

    if !response.status().is_success() {
        return Err(format!("ABS item fetch failed: HTTP {}", response.status()).into());
    }

    let item: serde_json::Value = response.json().await?;
    let ino = item["media"]["audioFiles"][0]["ino"].as_str()
        .ok_or("Could not find audio file ino from ABS item")?;

    Ok(format!("{}/api/items/{}/file/{}", base_url.trim_end_matches('/'), request.item_id, ino))
}

/// Extract audio from an HTTP URL using FFmpeg streaming (no full download)
fn extract_audio_from_url_with_offset(
    url: &str, auth_token: &str, output_path: &str, start_secs: u32, duration_secs: u32, format: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut args = vec![
        "-y".to_string(),
        "-headers".to_string(), format!("Authorization: Bearer {}\r\n", auth_token),
        "-ss".to_string(), start_secs.to_string(),
        "-i".to_string(), url.to_string(),
        "-t".to_string(), duration_secs.to_string(),
        "-vn".to_string(),
        "-ar".to_string(), "16000".to_string(),
        "-ac".to_string(), "1".to_string(),
    ];

    if format == "wav" {
        args.extend(["-f".to_string(), "wav".to_string()]);
    } else {
        args.extend(["-acodec".to_string(), "libmp3lame".to_string(), "-q:a".to_string(), "9".to_string()]);
    }

    args.push(output_path.to_string());

    let output = Command::new("ffmpeg")
        .args(&args)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg stream failed: {}", stderr).into());
    }
    if std::fs::metadata(output_path)?.len() == 0 {
        return Err("FFmpeg produced empty output".into());
    }
    Ok(())
}

/// Extract first N seconds from a local file using FFmpeg
fn extract_audio_segment(
    input_path: &str, output_path: &str, start_secs: u32, duration_secs: u32, format: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(), input_path.to_string(),
        "-ss".to_string(), start_secs.to_string(),
        "-t".to_string(), duration_secs.to_string(),
        "-vn".to_string(),
        "-ar".to_string(), "16000".to_string(),
        "-ac".to_string(), "1".to_string(),
    ];

    if format == "wav" {
        args.extend(["-f".to_string(), "wav".to_string()]);
    } else {
        args.extend(["-acodec".to_string(), "libmp3lame".to_string(), "-q:a".to_string(), "9".to_string()]);
    }

    args.push(output_path.to_string());

    let output = Command::new("ffmpeg")
        .args(&args)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed: {}", stderr).into());
    }
    if std::fs::metadata(output_path)?.len() == 0 {
        return Err("FFmpeg produced empty output".into());
    }
    Ok(())
}

fn check_ffmpeg_available() -> bool {
    Command::new("ffmpeg").arg("-version").output()
        .map(|o| o.status.success()).unwrap_or(false)
}

// ---- Whisper API ----

/// Whisper result with transcript and detected language
struct WhisperResult {
    text: String,
    language: Option<String>,
}

/// Try cloud Whisper (OpenAI API). Returns error if no API key.
async fn try_cloud_whisper(
    audio_data: &[u8], api_key: Option<&str>,
) -> Result<WhisperResult, Box<dyn std::error::Error + Send + Sync>> {
    let key = api_key.filter(|k| !k.is_empty())
        .ok_or("No OpenAI API key for cloud Whisper")?;
    call_whisper_api(audio_data.to_vec(), key).await
}

async fn call_whisper_api(
    audio_data: Vec<u8>, api_key: &str,
) -> Result<WhisperResult, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();

    let part = multipart::Part::bytes(audio_data)
        .file_name("audio.mp3").mime_str("audio/mpeg")?;

    // Use verbose_json format to get language detection
    // Don't set language param - let Whisper auto-detect
    let form = multipart::Form::new()
        .text("model", "whisper-1")
        .text("response_format", "verbose_json")
        .part("file", part);

    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send().await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Whisper API error {}: {}", status, body).into());
    }

    let data: serde_json::Value = response.json().await?;
    let text = data["text"].as_str().unwrap_or("").trim().to_string();
    let language = data["language"].as_str().map(|s| s.to_string());

    Ok(WhisperResult { text, language })
}

// ---- Transcript cache ----

fn transcript_cache_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or("Cannot find data directory")?
        .join("Audiobook Tagger")
        .join("transcript_cache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cache dir error: {}", e))?;
    Ok(dir)
}

fn get_cached_transcript(item_id: &str) -> Option<AudioIntroResult> {
    let cache_dir = transcript_cache_dir().ok()?;
    let cache_file = cache_dir.join(format!("{}.json", sanitize_filename(item_id)));
    let data = std::fs::read_to_string(cache_file).ok()?;
    serde_json::from_str(&data).ok()
}

fn cache_transcript(result: &AudioIntroResult) {
    if let Ok(cache_dir) = transcript_cache_dir() {
        let cache_file = cache_dir.join(format!("{}.json", sanitize_filename(&result.item_id)));
        if let Ok(json) = serde_json::to_string_pretty(result) {
            let _ = std::fs::write(cache_file, json);
        }
    }
}

fn sanitize_filename(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

// ---- Temp file cleanup ----

/// Clean up any whisper-related temp files that may have leaked
fn cleanup_temp_files() {
    let temp_dir = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                // NamedTempFile creates files like .tmpXXXXXX.mp3 or .wav
                if (name.ends_with(".mp3") || name.ends_with(".wav") || name.ends_with(".m4b"))
                    && name.starts_with(".tmp")
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

// ---- LLM parsing ----

/// Send transcript to LLM (GPT or Ollama) for structured extraction.
async fn try_llm_parse(
    transcript: &str,
    known_title: Option<&str>,
    request: &AudioIntroRequest,
) -> Result<ExtractedBookInfo, Box<dyn std::error::Error + Send + Sync>> {
    let system_prompt = "You extract audiobook metadata from transcripts. Return only valid JSON.";

    let user_prompt = format!(
        r#"Extract metadata from this audiobook audio intro transcript.

Return ONLY a JSON object:
{{
  "title": "book title or null",
  "subtitle": "subtitle or null",
  "author": "author full name or null",
  "narrator": "narrator/reader full name or null",
  "publisher": "print publisher or null",
  "audio_publisher": "audiobook publisher or null"
}}

RULES:
- Extract the book title and author even if mentioned indirectly (e.g. "Larry McMurtry's transformative novel" means author is "Larry McMurtry")
- Extract narrator if announced (e.g. "read by Name", "narrated by Name")
- "This is Audible" means audio_publisher is "Audible", NOT the title
- "Lonesome Dove" mentioned as a novel title means title is "Lonesome Dove"
- Fix phonetic misspellings from speech-to-text (e.g. "Condeed" -> "Candide")
- PRESERVE correct punctuation and hyphens in titles (e.g. "The Tell-Tale Heart" NOT "The Telltale Heart")
- Use the standard published form of titles and names, not simplified versions
- Separate title from subtitle
- Do NOT invent information not present in the transcript at all
- Person names only for author/narrator fields

Transcript: "{}""#,
        &transcript[..transcript.len().min(800)]
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let use_local = request.use_local_ai.unwrap_or(false);

    let content = if use_local {
        // Ollama: OpenAI-compatible chat completions
        let model = request.ollama_model.as_deref().unwrap_or("qwen3:4b");
        let body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ],
            "max_tokens": 300,
            "temperature": 0.1,
            "stream": false
        });

        let response = client
            .post(format!("{}/v1/chat/completions", crate::ollama::effective_base(request.ollama_base_url.as_deref().unwrap_or(""))))
            .json(&body)
            .send().await?;

        if !response.status().is_success() {
            let err = response.text().await.unwrap_or_default();
            return Err(format!("Ollama error: {}", err).into());
        }

        let resp: serde_json::Value = response.json().await?;
        resp["choices"][0]["message"]["content"]
            .as_str()
            .ok_or("No content in Ollama response")?
            .to_string()
    } else {
        // OpenAI Responses API (gpt-5-nano)
        let api_key = request.openai_api_key.as_deref()
            .ok_or("No OpenAI API key")?;

        let body = serde_json::json!({
            "model": "gpt-5-nano",
            "input": [
                { "role": "developer", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ],
            "text": { "format": { "type": "json_object" } },
            "max_output_tokens": 200,
            "reasoning": { "effort": "minimal" }
        });

        let response = client
            .post("https://api.openai.com/v1/responses")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let err_body = response.text().await.unwrap_or_default();
            return Err(format!("LLM API error {}: {}", status, err_body).into());
        }

        let resp: serde_json::Value = response.json().await?;
        resp["output_text"].as_str()
            .or_else(|| {
                resp["output"].as_array()?.iter()
                    .find(|item| item["type"] == "message")?
                    ["content"].as_array()?.iter()
                    .find(|c| c["type"] == "output_text" || c["type"] == "text")?
                    ["text"].as_str()
            })
            .ok_or("No text in LLM response")?
            .to_string()
    };

    let json_str = content.trim()
        .trim_start_matches("```json").trim_start_matches("```")
        .trim_end_matches("```").trim();

    let parsed: serde_json::Value = serde_json::from_str(json_str)?;

    let parse_field = |key: &str| -> Option<String> {
        parsed[key].as_str().filter(|s| !s.is_empty() && *s != "null").map(|s| s.to_string())
    };

    Ok(ExtractedBookInfo {
        title: parse_field("title"),
        subtitle: parse_field("subtitle"),
        author: parse_field("author"),
        narrator: parse_field("narrator"),
        publisher: parse_field("publisher"),
        audio_publisher: parse_field("audio_publisher"),
    })
}

// ---- Regex parsing ----

fn parse_book_info_from_transcript(transcript: &str) -> ExtractedBookInfo {
    let mut info = ExtractedBookInfo::default();
    let text = transcript.replace('\n', " ").replace('\r', " ");
    let text = text.trim();

    lazy_static::lazy_static! {
        // Name pattern: 1-5 capitalized words, handles initials (J.K., J.R.R., Dr.)
        // More restrictive than before to avoid grabbing book text
        static ref NAME_PATTERN: &'static str = r"(?:[A-Z][a-zA-Z.]{0,15}\.?\s+){0,4}[A-Z][a-zA-Z.]+";

        static ref TITLE_BY_AUTHOR_NARRATOR: Regex = Regex::new(
            &format!(r"(?i)^(.+?)\s+by\s+({})\s*[,.]?\s+(?:read|narrated|performed)\s+by\s+({})", *NAME_PATTERN, *NAME_PATTERN)
        ).unwrap();

        static ref THIS_IS_BY: Regex = Regex::new(
            &format!(r"(?i)(?:this is|welcome to|you are listening to)\s+(.+?)\s+by\s+({})", *NAME_PATTERN)
        ).unwrap();

        static ref WRITTEN_BY: Regex = Regex::new(
            &format!(r"(?i)^(.+?),?\s+written\s+by\s+({})", *NAME_PATTERN)
        ).unwrap();

        static ref SIMPLE_BY: Regex = Regex::new(
            &format!(r"(?i)^(.+?)\s+by\s+({})", *NAME_PATTERN)
        ).unwrap();

        static ref NARRATOR_PATTERN: Regex = Regex::new(
            &format!(r"(?i)(?:narrated|read|performed)\s+by\s+({})", *NAME_PATTERN)
        ).unwrap();

        static ref PUBLISHED_BY: Regex = Regex::new(
            r"(?i)(?:published|produced)\s+by\s+(.+?)(?:\.|,|$)"
        ).unwrap();

        static ref PUBLISHER_PRODUCTION: Regex = Regex::new(
            r"(?i)a\s+(.+?)\s+(?:production|recording|audiobook)"
        ).unwrap();
    }

    // Try full pattern with narrator
    if let Some(caps) = TITLE_BY_AUTHOR_NARRATOR.captures(text) {
        info.title = caps.get(1).map(|m| m.as_str().trim().to_string());
        info.author = caps.get(2).map(|m| clean_person_name(m.as_str()));
        info.narrator = caps.get(3).map(|m| clean_person_name(m.as_str()));
    }

    if info.title.is_none() {
        if let Some(caps) = THIS_IS_BY.captures(text) {
            info.title = caps.get(1).map(|m| m.as_str().trim().to_string());
            info.author = caps.get(2).map(|m| clean_person_name(m.as_str()));
        }
    }

    if info.title.is_none() {
        if let Some(caps) = WRITTEN_BY.captures(text) {
            info.title = caps.get(1).map(|m| m.as_str().trim().to_string());
            info.author = caps.get(2).map(|m| clean_person_name(m.as_str()));
        }
    }

    if info.title.is_none() {
        if let Some(caps) = SIMPLE_BY.captures(text) {
            let t = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            if t.len() < 100 && t.split_whitespace().count() < 15 {
                info.title = Some(t.trim().to_string());
                info.author = caps.get(2).map(|m| clean_person_name(m.as_str()));
            }
        }
    }

    if info.narrator.is_none() {
        if let Some(caps) = NARRATOR_PATTERN.captures(text) {
            info.narrator = caps.get(1).map(|m| clean_person_name(m.as_str()));
        }
    }

    // Publisher extraction
    if info.publisher.is_none() {
        if let Some(caps) = PUBLISHED_BY.captures(text) {
            let pub_name = caps.get(1).map(|m| m.as_str().trim().to_string());
            if let Some(ref name) = pub_name {
                let lower = name.to_lowercase();
                if lower.contains("audio") || lower.contains("record") || lower.contains("audible")
                    || lower.contains("brilliance") || lower.contains("tantor")
                    || lower.contains("blackstone") || lower.contains("listening library")
                {
                    info.audio_publisher = pub_name;
                } else {
                    info.publisher = pub_name;
                }
            }
        }
    }
    if info.audio_publisher.is_none() {
        if let Some(caps) = PUBLISHER_PRODUCTION.captures(text) {
            info.audio_publisher = caps.get(1).map(|m| m.as_str().trim().to_string());
        }
    }

    info
}

/// Clean a person name extracted from transcript.
/// Strips trailing non-name words (book text that got captured),
/// sentence boundaries, and common false matches.
fn clean_person_name(raw: &str) -> String {
    // Split on sentence boundary first
    let name = raw.split(". ").next().unwrap_or(raw);

    // Words that are NOT part of a person's name - if we hit one, stop
    let stop_words: &[&str] = &[
        "this", "the", "a", "an", "and", "but", "or", "for", "in", "on", "at",
        "to", "from", "with", "is", "was", "are", "were", "be", "been", "have",
        "has", "had", "do", "does", "did", "will", "would", "could", "should",
        "may", "might", "shall", "can", "it", "its", "that", "which", "who",
        "whom", "whose", "where", "when", "how", "what", "why", "not", "no",
        "so", "if", "then", "than", "as", "of", "by", "chapter", "part",
        "book", "volume", "copyright", "all", "rights", "reserved",
    ];

    let words: Vec<&str> = name.split_whitespace().collect();
    let mut clean_words = Vec::new();

    for word in &words {
        let lower = word.to_lowercase();
        let lower = lower.trim_end_matches(['.', ',', ';', ':']);

        // Stop at common English words (not part of a name)
        if stop_words.contains(&&*lower) {
            break;
        }

        // Stop at lowercase words that aren't initials (names are capitalized)
        // Allow: "de", "van", "von", "le", "la", "del", "da" (name particles)
        let name_particles = ["de", "van", "von", "le", "la", "del", "da", "di", "el", "al"];
        if word.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
            && !name_particles.contains(&&*lower)
        {
            break;
        }

        clean_words.push(*word);
    }

    // A person name should be 1-5 words
    if clean_words.len() > 5 {
        clean_words.truncate(5);
    }

    let result = clean_words.join(" ");
    result.trim_end_matches(['.', ',', ';', ':']).trim().to_string()
}

fn calculate_confidence(info: &ExtractedBookInfo) -> f32 {
    let mut score = 0.0f32;
    if info.narrator.is_some() { score += 0.3; }
    if info.author.is_some() { score += 0.3; }
    if info.publisher.is_some() || info.audio_publisher.is_some() { score += 0.2; }
    if info.title.is_some() { score += 0.1; }
    score.min(1.0)
}

fn empty_result(item_id: &str) -> AudioIntroResult {
    AudioIntroResult {
        item_id: item_id.to_string(), transcript: None, title: None, subtitle: None,
        narrators: vec![], authors: vec![],
        publisher: None, audio_publisher: None, language: None,
        parse_method: "none".to_string(), confidence: 0.0,
    }
}
