// src-tauri/src/converter/ffmpeg.rs
// FFmpeg command builder and utilities

use anyhow::{anyhow, Result};
use std::process::{Command, Stdio};
use tokio::process::Command as AsyncCommand;

use super::types::{FFmpegInfo, QualityPreset, SpeedPreset};

/// Check if FFmpeg is available and get version info
pub async fn check_ffmpeg() -> Result<FFmpegInfo> {
    let output = AsyncCommand::new("ffmpeg")
        .args(["-version"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let version = stdout
                .lines()
                .next()
                .unwrap_or("Unknown version")
                .to_string();

            // Check for codec support
            let codecs = AsyncCommand::new("ffmpeg")
                .args(["-codecs"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await;

            let (has_libfdk_aac, has_aac) = if let Ok(c) = codecs {
                let codec_output = String::from_utf8_lossy(&c.stdout);
                (
                    codec_output.contains("libfdk_aac"),
                    codec_output.contains(" aac "),
                )
            } else {
                (false, false)
            };

            Ok(FFmpegInfo {
                available: true,
                version,
                has_libfdk_aac,
                has_aac,
            })
        }
        Ok(_) => Err(anyhow!("FFmpeg returned an error")),
        Err(e) => Err(anyhow!("FFmpeg not found: {}", e)),
    }
}

/// Check if ffprobe is available
pub async fn check_ffprobe() -> Result<bool> {
    let output = AsyncCommand::new("ffprobe")
        .args(["-version"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    Ok(output.map(|o| o.status.success()).unwrap_or(false))
}

/// Builder for FFmpeg commands
#[derive(Debug, Clone)]
pub struct FFmpegBuilder {
    inputs: Vec<InputSpec>,
    output: String,
    audio_codec: String,
    audio_bitrate: String,
    sample_rate: Option<u32>,
    channels: Option<u8>,
    metadata_file: Option<String>,
    cover_image: Option<String>,
    use_concat: bool,
    extra_input_args: Vec<String>,
    extra_output_args: Vec<String>,
    overwrite: bool,
    skip_error_flags: bool, // Skip error tolerance flags (for clean inputs like WAV)
    threads: usize,         // FFmpeg thread count (0 = auto)
}

#[derive(Debug, Clone)]
struct InputSpec {
    path: String,
    format: Option<String>,
}

impl FFmpegBuilder {
    pub fn new(output: &str) -> Self {
        Self {
            inputs: Vec::new(),
            output: output.to_string(),
            audio_codec: "aac".to_string(),
            audio_bitrate: "64k".to_string(),
            sample_rate: None,
            channels: None,
            metadata_file: None,
            cover_image: None,
            use_concat: false,
            extra_input_args: Vec::new(),
            extra_output_args: Vec::new(),
            overwrite: true,
            skip_error_flags: false,
            threads: 0, // 0 = auto
        }
    }

    /// Add an input file
    pub fn input(mut self, path: &str) -> Self {
        self.inputs.push(InputSpec {
            path: path.to_string(),
            format: None,
        });
        self
    }

    /// Add a concat demuxer input (file list)
    pub fn concat_input(mut self, list_file: &str) -> Self {
        self.use_concat = true;
        self.inputs.push(InputSpec {
            path: list_file.to_string(),
            format: Some("concat".to_string()),
        });
        self
    }

    /// Set quality preset
    pub fn quality_preset(mut self, preset: &QualityPreset, has_libfdk: bool) -> Self {
        self.quality_preset_with_speed(preset, has_libfdk, &SpeedPreset::default())
    }

    /// Set quality preset with speed consideration
    pub fn quality_preset_with_speed(mut self, preset: &QualityPreset, has_libfdk: bool, speed: &SpeedPreset) -> Self {
        let use_afterburner = speed.use_afterburner();
        self.threads = speed.ffmpeg_threads();

        match preset {
            QualityPreset::Economy => {
                if has_libfdk {
                    self.audio_codec = "libfdk_aac".to_string();
                    self.extra_output_args
                        .extend(["-profile:a".to_string(), "aac_he".to_string()]);
                    self.audio_bitrate = "32k".to_string();
                } else {
                    self.audio_codec = "aac".to_string();
                    self.audio_bitrate = "48k".to_string();
                }
                self.channels = Some(1); // Mono for economy
            }
            QualityPreset::Standard => {
                if has_libfdk {
                    self.audio_codec = "libfdk_aac".to_string();
                    self.extra_output_args.extend([
                        "-profile:a".to_string(),
                        "aac_low".to_string(),
                        "-cutoff".to_string(),
                        "18000".to_string(),
                    ]);
                    if use_afterburner {
                        self.extra_output_args.extend([
                            "-afterburner".to_string(),
                            "1".to_string(),
                        ]);
                    }
                } else {
                    self.audio_codec = "aac".to_string();
                }
                self.audio_bitrate = "64k".to_string();
            }
            QualityPreset::High => {
                if has_libfdk {
                    self.audio_codec = "libfdk_aac".to_string();
                    self.extra_output_args.extend([
                        "-profile:a".to_string(),
                        "aac_low".to_string(),
                        "-cutoff".to_string(),
                        "20000".to_string(),
                    ]);
                    if use_afterburner {
                        self.extra_output_args.extend([
                            "-afterburner".to_string(),
                            "1".to_string(),
                        ]);
                    }
                } else {
                    self.audio_codec = "aac".to_string();
                }
                self.audio_bitrate = "96k".to_string();
            }
            QualityPreset::Custom(q) => {
                self.audio_codec = "aac".to_string();
                self.audio_bitrate = format!("{}k", q.bitrate_kbps);
                self.sample_rate = Some(q.sample_rate);
                self.channels = Some(q.channels);
            }
        }
        self
    }

    /// Set metadata file (FFmpeg metadata format)
    pub fn metadata_file(mut self, path: &str) -> Self {
        self.metadata_file = Some(path.to_string());
        self
    }

    /// Set cover image to embed
    pub fn cover_image(mut self, path: &str) -> Self {
        self.cover_image = Some(path.to_string());
        self
    }

    /// Set sample rate
    pub fn sample_rate(mut self, rate: u32) -> Self {
        self.sample_rate = Some(rate);
        self
    }

    /// Set number of channels
    pub fn channels(mut self, ch: u8) -> Self {
        self.channels = Some(ch);
        self
    }

    /// Don't overwrite output
    pub fn no_overwrite(mut self) -> Self {
        self.overwrite = false;
        self
    }

    /// Skip error tolerance flags (for clean inputs like decoded WAV files)
    pub fn skip_error_tolerance(mut self) -> Self {
        self.skip_error_flags = true;
        self
    }

    /// Build the command arguments
    ///
    /// IMPORTANT: FFmpeg input options must appear BEFORE the -i they apply to.
    /// Error tolerance flags should only apply to audio inputs, NOT metadata files.
    pub fn build(&self) -> Vec<String> {
        let mut args = Vec::new();

        // Global options (apply to entire command)
        if self.overwrite {
            args.push("-y".to_string());
        } else {
            args.push("-n".to_string());
        }
        args.push("-hide_banner".to_string());

        // === INPUT 0: Audio files ===
        // Error tolerance flags BEFORE the audio input (only if not skipped)
        // Skip for clean inputs like decoded WAV files
        if !self.skip_error_flags {
            args.extend([
                "-err_detect".to_string(), "ignore_err".to_string(),
                "-fflags".to_string(), "+genpts+discardcorrupt+igndts".to_string(),
            ]);
        }

        for input in &self.inputs {
            if let Some(fmt) = &input.format {
                args.push("-f".to_string());
                args.push(fmt.clone());
                if fmt == "concat" {
                    args.push("-safe".to_string());
                    args.push("0".to_string());
                }
            }
            args.push("-i".to_string());
            args.push(input.path.clone());
        }

        // === INPUT 1: Metadata file (NO error flags - it's a text file) ===
        if let Some(meta) = &self.metadata_file {
            // -f ffmetadata tells FFmpeg this is a metadata file, not media
            args.push("-f".to_string());
            args.push("ffmetadata".to_string());
            args.push("-i".to_string());
            args.push(meta.clone());
        }

        // === INPUT 2: Cover image (NO error flags) ===
        if let Some(cover) = &self.cover_image {
            args.push("-i".to_string());
            args.push(cover.clone());
        }

        // === Stream mapping ===
        // Map audio from first input (the concat/audio input)
        args.push("-map".to_string());
        args.push("0:a".to_string());

        // Map metadata from metadata file input
        if self.metadata_file.is_some() {
            args.push("-map_metadata".to_string());
            args.push("1".to_string());
        }

        // Map cover if present
        if self.cover_image.is_some() {
            let cover_idx = if self.metadata_file.is_some() { 2 } else { 1 };
            args.push("-map".to_string());
            args.push(format!("{}:v", cover_idx));
            args.push("-c:v".to_string());
            args.push("copy".to_string());
            args.push("-disposition:v:0".to_string());
            args.push("attached_pic".to_string());
        }

        // === Output options ===
        // Audio codec and bitrate
        args.push("-c:a".to_string());
        args.push(self.audio_codec.clone());
        args.push("-b:a".to_string());
        args.push(self.audio_bitrate.clone());

        // Force consistent audio parameters for concat compatibility
        args.push("-ar".to_string());
        args.push(self.sample_rate.map(|s| s.to_string()).unwrap_or_else(|| "44100".to_string()));
        args.push("-ac".to_string());
        args.push(self.channels.map(|c| c.to_string()).unwrap_or_else(|| "2".to_string()));

        // Prevent muxing queue overflow
        args.push("-max_muxing_queue_size".to_string());
        args.push("9999".to_string());

        // Threading options for speed
        if self.threads > 0 {
            args.push("-threads".to_string());
            args.push(self.threads.to_string());
        }

        // Extra output args (codec profiles, etc.)
        args.extend(self.extra_output_args.clone());

        // Output format (mp4 container for m4b)
        args.push("-f".to_string());
        args.push("mp4".to_string());

        // Output file (must be last)
        args.push(self.output.clone());

        args
    }

    /// Execute the FFmpeg command
    pub async fn execute(&self) -> Result<()> {
        let args = self.build();

        println!("🎬 FFmpeg command: ffmpeg {}", args.join(" "));

        let output = AsyncCommand::new("ffmpeg")
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!("FFmpeg failed: {}", stderr));
        }

        Ok(())
    }

    /// Execute with progress callback (parses FFmpeg progress output)
    pub async fn execute_with_progress<F>(
        &self,
        total_duration_ms: u64,
        mut on_progress: F,
    ) -> Result<()>
    where
        F: FnMut(f32, &str),
    {
        let args = self.build();

        // Log the command for debugging
        log::info!("=== FFmpeg Encode Command ===");
        log::info!("ffmpeg {}", args.join(" "));
        log::info!("=============================");

        let mut cmd = AsyncCommand::new("ffmpeg");
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        log::info!("Spawning FFmpeg process...");
        let mut child = cmd.spawn()?;
        log::info!("FFmpeg process spawned, reading output...");

        // Collect stderr content for error reporting
        let mut stderr_content = String::new();
        let mut last_progress_log = std::time::Instant::now();

        // Read stderr for progress - FFmpeg uses \r for progress updates, not \n
        if let Some(stderr) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut buffer = [0u8; 1024];
            let mut bytes_read_total = 0usize;

            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) => {
                        log::info!("FFmpeg stderr EOF reached, total bytes read: {}", bytes_read_total);
                        break; // EOF
                    }
                    Ok(n) => {
                        bytes_read_total += n;
                        let chunk = String::from_utf8_lossy(&buffer[..n]);
                        stderr_content.push_str(&chunk);

                        // Parse time= from FFmpeg output (can appear anywhere in the chunk)
                        if let Some(time_str) = extract_time_from_line(&chunk) {
                            let current_ms = parse_time_to_ms(&time_str);
                            let percent = if total_duration_ms > 0 {
                                (current_ms as f32 / total_duration_ms as f32 * 100.0).min(100.0)
                            } else {
                                0.0
                            };

                            // Log progress every 5 seconds
                            if last_progress_log.elapsed().as_secs() >= 5 {
                                log::info!("FFmpeg progress: {:.1}% (time={})", percent, time_str);
                                last_progress_log = std::time::Instant::now();
                            }

                            on_progress(percent, &chunk);
                        }
                    }
                    Err(e) => {
                        log::warn!("Error reading FFmpeg stderr: {}", e);
                        break;
                    }
                }
            }
        } else {
            log::warn!("Could not capture FFmpeg stderr");
        }

        log::info!("Waiting for FFmpeg process to exit...");
        let status = child.wait().await?;
        log::info!("FFmpeg process exited with status: {:?}", status);
        if !status.success() {
            // Extract error message from FFmpeg output
            let stderr_lines: Vec<&str> = stderr_content.lines().collect();
            let error_lines: Vec<&str> = stderr_lines
                .iter()
                .filter(|line| {
                    line.contains("Error") ||
                    line.contains("error") ||
                    line.contains("Invalid") ||
                    line.contains("No such file") ||
                    line.contains("Permission denied") ||
                    line.contains("does not contain")
                })
                .copied()
                .collect();

            let error_msg = if error_lines.is_empty() {
                // Get last few lines if no obvious error found
                let last_lines: Vec<&str> = stderr_lines
                    .iter()
                    .rev()
                    .take(5)
                    .copied()
                    .collect();
                format!("FFmpeg encoding failed. Last output:\n{}", last_lines.join("\n"))
            } else {
                format!("FFmpeg encoding failed:\n{}", error_lines.join("\n"))
            };

            return Err(anyhow!("{}", error_msg));
        }

        Ok(())
    }
}

/// Extract time value from FFmpeg output line
fn extract_time_from_line(line: &str) -> Option<String> {
    // FFmpeg outputs: time=00:01:23.45
    if let Some(idx) = line.find("time=") {
        let start = idx + 5;
        let rest = &line[start..];
        if let Some(end) = rest.find(|c: char| c.is_whitespace()) {
            return Some(rest[..end].to_string());
        } else if rest.len() >= 11 {
            return Some(rest[..11].to_string());
        }
    }
    None
}

/// Parse FFmpeg time format (HH:MM:SS.ms) to milliseconds
fn parse_time_to_ms(time_str: &str) -> u64 {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() == 3 {
        let hours: f64 = parts[0].parse().unwrap_or(0.0);
        let minutes: f64 = parts[1].parse().unwrap_or(0.0);
        let seconds: f64 = parts[2].parse().unwrap_or(0.0);
        ((hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0) as u64
    } else {
        0
    }
}

/// Create a concat file list for FFmpeg
pub fn create_concat_file_list(files: &[String], output_path: &str) -> Result<()> {
    let mut content = String::new();
    for file in files {
        // Escape single quotes in paths
        let escaped = file.replace("'", "'\\''");
        content.push_str(&format!("file '{}'\n", escaped));
    }
    std::fs::write(output_path, content)?;
    Ok(())
}

/// Get audio duration using ffprobe
pub async fn get_audio_duration_ms(path: &str) -> Result<u64> {
    let output = AsyncCommand::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if output.status.success() {
        let duration_str = String::from_utf8_lossy(&output.stdout);
        let seconds: f64 = duration_str.trim().parse().unwrap_or(0.0);
        Ok((seconds * 1000.0) as u64)
    } else {
        Err(anyhow!("Failed to get duration for {}", path))
    }
}

/// Get detailed audio info using ffprobe
pub async fn get_audio_info(path: &str) -> Result<AudioInfo> {
    let output = AsyncCommand::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        return Err(anyhow!("ffprobe failed for {}", path));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&json_str)?;

    // Extract format info
    let format = json.get("format").ok_or_else(|| anyhow!("No format info"))?;

    let duration: f64 = format
        .get("duration")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    let size: u64 = format
        .get("size")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let bitrate: u32 = format
        .get("bit_rate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .map(|b| (b / 1000) as u32)
        .unwrap_or(0);

    // Extract audio stream info
    let streams = json.get("streams").and_then(|s| s.as_array());
    let audio_stream = streams.and_then(|arr| {
        arr.iter()
            .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"))
    });

    let (sample_rate, channels, codec) = if let Some(stream) = audio_stream {
        let sr: u32 = stream
            .get("sample_rate")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or(44100);
        let ch: u8 = stream
            .get("channels")
            .and_then(|v| v.as_u64())
            .map(|c| c as u8)
            .unwrap_or(2);
        let codec_name: String = stream
            .get("codec_name")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| "unknown".to_string());
        (sr, ch, codec_name)
    } else {
        (44100, 2, "unknown".to_string())
    };

    // Extract metadata
    let tags = format.get("tags");
    let title = tags
        .and_then(|t| t.get("title"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let artist = tags
        .and_then(|t| t.get("artist"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let album = tags
        .and_then(|t| t.get("album"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Ok(AudioInfo {
        duration_ms: (duration * 1000.0) as u64,
        size_bytes: size,
        bitrate_kbps: bitrate,
        sample_rate,
        channels,
        codec,
        title,
        artist,
        album,
    })
}

/// Audio file information from ffprobe
#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub duration_ms: u64,
    pub size_bytes: u64,
    pub bitrate_kbps: u32,
    pub sample_rate: u32,
    pub channels: u8,
    pub codec: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

impl AudioInfo {
    /// Check if this file can be stream-copied (no re-encoding needed)
    pub fn can_stream_copy(&self) -> bool {
        // AAC files can be stream-copied directly into M4B container
        self.codec == "aac"
    }
}

/// Extract embedded cover art from audio file
pub async fn extract_cover_art(input_path: &str, output_path: &str) -> Result<bool> {
    let output = AsyncCommand::new("ffmpeg")
        .args(["-y", "-i", input_path, "-an", "-vcodec", "copy", output_path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    // Check if output file was created and has content
    if output.status.success() {
        if let Ok(meta) = std::fs::metadata(output_path) {
            if meta.len() > 100 {
                // Validate it's actually a valid image
                if validate_image_file(output_path).await {
                    return Ok(true);
                }
            }
        }
    }

    // Cleanup empty/failed/invalid file
    let _ = std::fs::remove_file(output_path);
    Ok(false)
}

/// Validate that a file is a valid image that FFmpeg can read
pub async fn validate_image_file(path: &str) -> bool {
    log::info!("Validating image file: {}", path);

    // First check file exists and has reasonable size
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("Cannot read image file metadata: {} - {}", path, e);
            return false;
        }
    };

    if metadata.len() == 0 {
        log::warn!("Image file is empty: {}", path);
        return false;
    }

    if metadata.len() > 50 * 1024 * 1024 {
        log::warn!("Image file too large (>50MB): {} - {} bytes", path, metadata.len());
        return false;
    }

    log::info!("Image file size: {} bytes", metadata.len());

    // Use ffprobe to check if it's a valid image
    let output = AsyncCommand::new("ffprobe")
        .args([
            "-v", "error",  // Show errors instead of quiet
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height",
            "-of", "default=noprint_wrappers=1",
            path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);

            log::info!("ffprobe stdout: {}", stdout.trim());
            if !stderr.is_empty() {
                log::warn!("ffprobe stderr: {}", stderr.trim());
            }

            // Check if we got valid image info (should have width and height)
            let has_width = stdout.contains("width=");
            let has_height = stdout.contains("height=");
            let valid = has_width && has_height;

            if valid {
                log::info!("Image validated successfully: {}", path);
            } else {
                log::warn!("Image validation failed - missing dimensions. has_width={}, has_height={}", has_width, has_height);
            }

            valid
        }
        Err(e) => {
            log::error!("ffprobe failed for {}: {}", path, e);
            false
        }
    }
}

/// Convert image to JPEG if needed for better M4B compatibility
pub async fn prepare_cover_for_m4b(source_path: &str, output_dir: &std::path::Path) -> Option<String> {
    log::info!("Preparing cover for M4B: {}", source_path);

    // Check if already a JPEG
    let ext = std::path::Path::new(source_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase());

    if matches!(ext.as_deref(), Some("jpg") | Some("jpeg")) {
        // Validate and use as-is if it's already JPEG
        if validate_image_file(source_path).await {
            log::info!("Cover is already JPEG and valid, using directly");
            return Some(source_path.to_string());
        }
    }

    // Convert to JPEG using FFmpeg for better compatibility
    let output_path = output_dir.join("cover_converted.jpg");
    let output_str = output_path.to_string_lossy().to_string();

    log::info!("Converting cover to JPEG: {} -> {}", source_path, output_str);

    let result = AsyncCommand::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel", "warning",
            "-i", source_path,
            "-vf", "scale='min(1400,iw)':'min(1400,ih)':force_original_aspect_ratio=decrease",
            "-q:v", "2",  // High quality JPEG
            &output_str,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    match result {
        Ok(out) => {
            if out.status.success() {
                if validate_image_file(&output_str).await {
                    log::info!("Cover converted successfully: {}", output_str);
                    return Some(output_str);
                } else {
                    log::warn!("Converted cover failed validation");
                }
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                log::error!("Cover conversion failed: {}", stderr);
            }
        }
        Err(e) => {
            log::error!("FFmpeg failed for cover conversion: {}", e);
        }
    }

    // Fall back to original if conversion fails
    if validate_image_file(source_path).await {
        log::info!("Using original cover as fallback");
        Some(source_path.to_string())
    } else {
        log::error!("Could not prepare cover for M4B embedding");
        None
    }
}

/// Detect silence periods in audio
pub async fn detect_silence(
    path: &str,
    noise_threshold_db: i32,
    min_duration_seconds: f64,
) -> Result<Vec<super::types::SilenceMarker>> {
    let filter = format!(
        "silencedetect=n={}dB:d={}",
        noise_threshold_db, min_duration_seconds
    );

    let output = AsyncCommand::new("ffmpeg")
        .args(["-i", path, "-af", &filter, "-f", "null", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut markers = Vec::new();
    let mut current_start: Option<f64> = None;

    for line in stderr.lines() {
        if line.contains("silence_start:") {
            if let Some(val) = extract_silence_value(line, "silence_start:") {
                current_start = Some(val);
            }
        } else if line.contains("silence_end:") {
            if let (Some(start), Some(end)) = (
                current_start,
                extract_silence_value(line, "silence_end:"),
            ) {
                let duration = extract_silence_value(line, "silence_duration:")
                    .unwrap_or(end - start);
                markers.push(super::types::SilenceMarker {
                    start,
                    end,
                    duration,
                });
                current_start = None;
            }
        }
    }

    Ok(markers)
}

fn extract_silence_value(line: &str, key: &str) -> Option<f64> {
    if let Some(idx) = line.find(key) {
        let start = idx + key.len();
        let rest = line[start..].trim();
        let end = rest.find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
            .unwrap_or(rest.len());
        rest[..end].trim().parse().ok()
    } else {
        None
    }
}
