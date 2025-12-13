// src-tauri/src/converter/encoder.rs
// Main encoding logic for MP3 to M4B conversion
//
// TWO-STEP PIPELINE:
// 1. Decode each source file to WAV (handles corruption per-file)
// 2. Concatenate clean WAVs and encode to M4B

use anyhow::{anyhow, Result};
use futures::stream::{self, StreamExt};
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use std::process::Stdio;
use tokio::sync::Mutex;

use super::analyzer::{analyze_source, get_available_space, validate_output_path};
use super::chapters::{generate_chapter_metadata, generate_chapters, validate_chapters};
use super::ffmpeg::{check_ffmpeg, create_concat_file_list, get_audio_duration_ms, FFmpegBuilder};
use super::types::*;

/// Global cancellation flag
static CANCEL_FLAG: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

/// Current conversion state (for cancellation)
static CONVERSION_STATE: Lazy<Mutex<Option<ConversionState>>> = Lazy::new(|| Mutex::new(None));

struct ConversionState {
    start_time: Instant,
    temp_files: Vec<String>,
}

/// Cancel the current conversion
pub async fn cancel() -> Result<()> {
    CANCEL_FLAG.store(true, Ordering::SeqCst);

    // Cleanup temp files
    if let Some(state) = CONVERSION_STATE.lock().await.take() {
        for temp_file in state.temp_files {
            let _ = std::fs::remove_file(&temp_file);
        }
    }

    Ok(())
}

/// Check if cancellation was requested
fn is_cancelled() -> bool {
    CANCEL_FLAG.load(Ordering::SeqCst)
}

/// Main conversion function
pub async fn convert<F>(request: ConversionRequest, mut on_progress: F) -> Result<ConversionResult>
where
    F: FnMut(ConversionProgress) + Send,
{
    log::info!("=== Starting M4B conversion ===");
    log::info!("Source: {}", request.source_path);
    log::info!("Quality: {:?}", request.quality_preset);
    log::info!("Speed: {:?}", request.speed_preset);
    log::info!("Chapter mode: {:?}", request.chapter_mode);

    // Reset cancellation flag
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let start_time = Instant::now();
    let mut temp_files = Vec::new();
    let mut warnings = Vec::new();

    // Clean up any stale temp cover files before starting
    let source_dir = Path::new(&request.source_path);
    if source_dir.is_dir() {
        let temp_cover = source_dir.join(".temp_cover.jpg");
        if temp_cover.exists() {
            log::info!("Cleaning up stale temp cover file");
            let _ = std::fs::remove_file(&temp_cover);
        }
    }

    // Store state for potential cancellation
    *CONVERSION_STATE.lock().await = Some(ConversionState {
        start_time,
        temp_files: Vec::new(),
    });

    // Phase 1: Check FFmpeg
    on_progress(ConversionProgress {
        phase: ConversionPhase::Analyzing,
        message: "Checking FFmpeg availability...".to_string(),
        percent: 0.0,
        ..Default::default()
    });

    log::info!("Checking FFmpeg availability...");
    let ffmpeg_info = check_ffmpeg().await.map_err(|e| {
        log::error!("FFmpeg not available: {}", e);
        anyhow!("FFmpeg not available: {}. Please install FFmpeg first.", e)
    })?;
    log::info!("FFmpeg version: {}", ffmpeg_info.version);
    log::info!("Has libfdk_aac: {}, Has AAC: {}", ffmpeg_info.has_libfdk_aac, ffmpeg_info.has_aac);

    if !ffmpeg_info.has_aac {
        log::error!("FFmpeg does not have AAC encoder support");
        return Err(anyhow!("FFmpeg does not have AAC encoder support"));
    }

    // Phase 2: Analyze source
    on_progress(ConversionProgress {
        phase: ConversionPhase::Analyzing,
        message: "Analyzing source files...".to_string(),
        percent: 5.0,
        ..Default::default()
    });

    if is_cancelled() {
        return Ok(cancelled_result());
    }

    log::info!("Analyzing source files...");
    let analysis = analyze_source(&request.source_path).await?;
    log::info!("Found {} audio files, total duration: {}ms, total size: {} bytes",
        analysis.files.len(), analysis.total_duration_ms, analysis.total_size_bytes);
    log::info!("Cover found: {}, source: {:?}", analysis.has_cover, analysis.cover_source);

    // Determine output path
    let output_path = if let Some(path) = &request.output_path {
        path.clone()
    } else {
        let source_dir = Path::new(&request.source_path);
        let parent = if source_dir.is_file() {
            source_dir.parent().unwrap_or(source_dir)
        } else {
            source_dir
        };
        let filename = sanitize_filename(&request.metadata.title);
        parent.join(format!("{}.m4b", filename)).to_string_lossy().to_string()
    };
    log::info!("Output path: {}", output_path);

    // Validate output path
    log::info!("Validating output path...");
    validate_output_path(&output_path)?;

    // Check disk space
    let estimated_size = analysis.estimated_output_size(&request.quality_preset);
    let available_space = get_available_space(&output_path)?;
    if available_space < estimated_size * 2 {
        // Need 2x for temp files
        return Err(anyhow!(
            "Not enough disk space. Need ~{} MB, have {} MB",
            estimated_size / (1024 * 1024),
            available_space / (1024 * 1024)
        ));
    }

    // Phase 3: Generate chapters
    on_progress(ConversionProgress {
        phase: ConversionPhase::Analyzing,
        message: "Generating chapters...".to_string(),
        percent: 10.0,
        files_total: analysis.files.len(),
        ..Default::default()
    });

    if is_cancelled() {
        return Ok(cancelled_result());
    }

    let chapters = generate_chapters(
        &request.chapter_mode,
        &analysis.files,
        analysis.total_duration_ms,
    )
    .await?;

    // Validate chapters
    let chapter_issues = validate_chapters(&chapters, analysis.total_duration_ms);
    for issue in chapter_issues {
        warnings.push(format!("Chapter warning: {}", issue));
    }

    // Determine cover path
    let cover_path = request.metadata.cover_path.clone().or(analysis.cover_source.clone());

    // Create temp directory for intermediate files
    let temp_dir = std::env::temp_dir().join(format!("m4b_convert_{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir)?;
    let temp_dir_str = temp_dir.to_string_lossy().to_string();
    temp_files.push(temp_dir_str.clone());

    // Check if we can use TURBO mode (stream copy without re-encoding)
    let use_turbo = request.speed_preset.prefer_stream_copy()
        && analysis.can_stream_copy()
        && analysis.has_uniform_format();

    if use_turbo {
        log::info!("=== TURBO MODE: Stream copy AAC without re-encoding ===");
        on_progress(ConversionProgress {
            phase: ConversionPhase::Concatenating,
            message: "Turbo mode: Stream copying AAC files...".to_string(),
            percent: 20.0,
            files_total: analysis.files.len(),
            ..Default::default()
        });

        // In turbo mode, we concatenate AAC files directly without decode/encode
        return turbo_convert(
            &analysis,
            &chapters,
            &request,
            &output_path,
            &temp_dir,
            &cover_path,
            &ffmpeg_info,
            &mut warnings,
            &mut temp_files,
            start_time,
            estimated_size,
            on_progress,
        ).await;
    }

    // Phase 4: DECODE each file to WAV first (handles corruption per-file)
    // This two-step approach is more robust than trying to concat compressed audio
    let parallel_workers = request.speed_preset.parallel_decode_workers();
    log::info!("=== DECODE PHASE: Converting {} files to WAV ({} parallel workers) ===",
        analysis.files.len(), parallel_workers);

    let total_files = analysis.files.len();
    let completed_count = Arc::new(AtomicUsize::new(0));
    let temp_dir_clone = temp_dir.clone();

    // Prepare decode tasks - each task is (index, source_file)
    let decode_tasks: Vec<(usize, SourceFile)> = analysis.files
        .iter()
        .enumerate()
        .map(|(idx, f)| (idx, f.clone()))
        .collect();

    // Run decodes in parallel with concurrency limit
    let decode_results: Vec<Result<(usize, String), (usize, String)>> = stream::iter(decode_tasks)
        .map(|(idx, source_file)| {
            let temp_dir = temp_dir_clone.clone();
            let completed = completed_count.clone();

            async move {
                if is_cancelled() {
                    return Err((idx, "Cancelled".to_string()));
                }

                let wav_path = temp_dir.join(format!("decoded_{:04}.wav", idx));
                let wav_path_str = wav_path.to_string_lossy().to_string();

                log::info!("Decoding: {} -> {}", source_file.filename, wav_path_str);

                // Decode to WAV with error tolerance (per-file, so corruption is isolated)
                let decode_result = tokio::process::Command::new("ffmpeg")
                    .args([
                        "-y",
                        "-hide_banner",
                        "-loglevel", "warning",
                        // Error tolerance for this file only
                        "-err_detect", "ignore_err",
                        "-fflags", "+genpts+discardcorrupt",
                        "-i", &source_file.path,
                        // Decode to WAV (PCM) - lossless intermediate
                        "-c:a", "pcm_s16le",
                        "-ar", "44100",
                        "-ac", "2",
                        &wav_path_str,
                    ])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await;

                // Update completed count
                completed.fetch_add(1, Ordering::SeqCst);

                match decode_result {
                    Ok(output) if output.status.success() => {
                        Ok((idx, wav_path_str))
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        log::error!("Failed to decode {}: {}", source_file.filename, stderr);
                        Err((idx, format!("Failed to decode {}: {}", source_file.filename, stderr)))
                    }
                    Err(e) => {
                        log::error!("FFmpeg error for {}: {}", source_file.filename, e);
                        Err((idx, format!("FFmpeg error for {}: {}", source_file.filename, e)))
                    }
                }
            }
        })
        .buffer_unordered(parallel_workers)
        .collect()
        .await;

    // Report final decode progress
    on_progress(ConversionProgress {
        phase: ConversionPhase::Concatenating,
        message: format!("Decoded {} files", total_files),
        percent: 30.0,
        files_total: total_files,
        files_processed: total_files,
        ..Default::default()
    });

    // Collect successful decodes and errors
    let mut decoded_files: Vec<(usize, String)> = Vec::new();
    for result in decode_results {
        match result {
            Ok((idx, path)) => {
                decoded_files.push((idx, path.clone()));
                temp_files.push(path);
            }
            Err((_idx, error)) => {
                warnings.push(error);
            }
        }
    }

    // Sort by original index to maintain file order
    decoded_files.sort_by_key(|(idx, _)| *idx);
    let decoded_files: Vec<String> = decoded_files.into_iter().map(|(_, path)| path).collect();

    if decoded_files.is_empty() {
        cleanup_temp_files(&temp_files);
        return Err(anyhow!("No files could be decoded"));
    }

    log::info!("Successfully decoded {} of {} files", decoded_files.len(), total_files);

    // Log all decoded files for debugging
    for (i, f) in decoded_files.iter().enumerate() {
        log::info!("  Decoded file {}: {}", i, f);
    }

    // Create concat list for the decoded WAV files
    let concat_list_path = temp_dir.join("concat_list.txt");
    log::info!("Creating concat list at: {}", concat_list_path.display());
    log::info!("Creating concat list for {} decoded files", decoded_files.len());
    create_concat_file_list(&decoded_files, &concat_list_path.to_string_lossy())?;

    // Log the concat list contents for debugging
    if let Ok(contents) = std::fs::read_to_string(&concat_list_path) {
        log::info!("Concat list contents:\n{}", contents);
    }

    temp_files.push(concat_list_path.to_string_lossy().to_string());

    let concat_list_for_encoding = concat_list_path.to_string_lossy().to_string();

    // Phase 5: Create metadata file
    log::info!("Creating metadata file with {} chapters...", chapters.len());
    on_progress(ConversionProgress {
        phase: ConversionPhase::ApplyingMetadata,
        message: "Creating metadata...".to_string(),
        percent: 25.0,
        files_total: analysis.files.len(),
        ..Default::default()
    });

    if is_cancelled() {
        cleanup_temp_files(&temp_files);
        return Ok(cancelled_result());
    }

    let metadata_path = temp_dir.join("metadata.txt");
    log::info!("Metadata file: {}", metadata_path.display());
    generate_chapter_metadata(&chapters, &request.metadata, &metadata_path.to_string_lossy())?;
    temp_files.push(metadata_path.to_string_lossy().to_string());
    log::info!("Metadata file created");

    // Phase 6: Encode to M4B from decoded WAV files
    // Since we decoded everything to WAV (PCM), no error tolerance needed here
    log::info!("=== ENCODE PHASE: Creating M4B from {} decoded files ===", decoded_files.len());
    log::info!("Input concat list: {}", concat_list_for_encoding);
    on_progress(ConversionProgress {
        phase: ConversionPhase::Encoding,
        message: "Encoding to AAC...".to_string(),
        percent: 30.0,
        files_total: analysis.files.len(),
        estimated_final_size: estimated_size,
        ..Default::default()
    });

    if is_cancelled() {
        cleanup_temp_files(&temp_files);
        return Ok(cancelled_result());
    }

    // Build FFmpeg command - concat the clean WAV files and encode to M4B
    // No error tolerance flags needed since WAV files are clean PCM
    log::info!("Building FFmpeg encode command...");
    let mut builder = FFmpegBuilder::new(&output_path)
        .concat_input(&concat_list_for_encoding)
        .quality_preset_with_speed(&request.quality_preset, ffmpeg_info.has_libfdk_aac, &request.speed_preset)
        .metadata_file(&metadata_path.to_string_lossy())
        .skip_error_tolerance(); // WAV files are clean, no need for error handling

    let mut use_cover = false;
    let mut prepared_cover_path: Option<String> = None;
    if let Some(cover) = &cover_path {
        log::info!("Checking cover image: {}", cover);
        if Path::new(cover).exists() {
            // Prepare cover for M4B (converts to JPEG if needed, validates)
            log::info!("Cover exists, preparing for M4B...");
            if let Some(prepared_cover) = super::ffmpeg::prepare_cover_for_m4b(cover, &temp_dir).await {
                log::info!("Cover prepared successfully: {}", prepared_cover);
                builder = builder.cover_image(&prepared_cover);
                prepared_cover_path = Some(prepared_cover.clone());
                if prepared_cover != *cover {
                    temp_files.push(prepared_cover);
                }
                use_cover = true;
            } else {
                log::warn!("Cover image could not be prepared for embedding, skipping: {}", cover);
                warnings.push(format!("Cover image could not be prepared for embedding, skipping: {}", cover));
            }
        } else {
            log::warn!("Cover image not found: {}", cover);
            warnings.push(format!("Cover image not found: {}", cover));
        }
    } else {
        log::info!("No cover image specified");
    }

    // Execute with progress tracking
    let total_duration_ms = analysis.total_duration_ms;
    log::info!("Total duration for encoding: {}ms", total_duration_ms);
    log::info!("Executing FFmpeg encode (use_cover={})...", use_cover);

    // Try encoding with cover first, retry without if it fails
    let encoding_result = {
        let progress_callback = |percent: f32, _line: &str| {
            if percent > 0.0 {
                log::debug!("Encoding progress: {:.1}%", percent);
            }
            on_progress(ConversionProgress {
                phase: ConversionPhase::Encoding,
                message: format!("Encoding: {:.1}%", percent),
                percent: 30.0 + percent * 0.6, // Encoding is 30%-90%
                files_total: analysis.files.len(),
                estimated_final_size: estimated_size,
                elapsed_seconds: start_time.elapsed().as_secs(),
                ..Default::default()
            });
        };

        builder
            .execute_with_progress(total_duration_ms, progress_callback)
            .await
    };

    // If encoding failed and we were using a cover, retry without cover
    if let Err(e) = encoding_result {
        log::error!("Encoding failed: {}", e);
        if use_cover {
            log::info!("Retrying encoding without cover...");
            warnings.push(format!("Cover embedding failed, retrying without cover: {}", e));

            // Rebuild without cover
            let builder_no_cover = FFmpegBuilder::new(&output_path)
                .concat_input(&concat_list_for_encoding)
                .quality_preset_with_speed(&request.quality_preset, ffmpeg_info.has_libfdk_aac, &request.speed_preset)
                .metadata_file(&metadata_path.to_string_lossy())
                .skip_error_tolerance();

            let progress_callback = |percent: f32, _line: &str| {
                if percent > 0.0 {
                    log::debug!("Encoding progress (no cover): {:.1}%", percent);
                }
                on_progress(ConversionProgress {
                    phase: ConversionPhase::Encoding,
                    message: format!("Encoding (no cover): {:.1}%", percent),
                    percent: 30.0 + percent * 0.6,
                    files_total: analysis.files.len(),
                    estimated_final_size: estimated_size,
                    elapsed_seconds: start_time.elapsed().as_secs(),
                    ..Default::default()
                });
            };

            builder_no_cover
                .execute_with_progress(total_duration_ms, progress_callback)
                .await?;
            log::info!("Encoding without cover succeeded");
        } else {
            return Err(e);
        }
    } else {
        log::info!("Encoding completed successfully");
    }

    // Phase 7: Verify output
    let verification = if request.verify_output {
        on_progress(ConversionProgress {
            phase: ConversionPhase::Verifying,
            message: "Verifying output...".to_string(),
            percent: 92.0,
            ..Default::default()
        });

        if is_cancelled() {
            cleanup_temp_files(&temp_files);
            let _ = std::fs::remove_file(&output_path);
            return Ok(cancelled_result());
        }

        Some(verify_output(&output_path, analysis.total_duration_ms, chapters.len()).await?)
    } else {
        None
    };

    // Check verification results
    if let Some(ref v) = verification {
        if !v.duration_ok {
            warnings.push(format!(
                "Duration mismatch: expected {}ms, got diff of {}ms",
                analysis.total_duration_ms, v.duration_diff_ms
            ));
        }
        if !v.chapters_ok {
            warnings.push(format!(
                "Chapter mismatch: expected {}, found {}",
                chapters.len(),
                v.chapters_found
            ));
        }
    }

    // Get final output size
    let output_size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Calculate space savings
    let space_saved_percent = if analysis.total_size_bytes > 0 {
        ((analysis.total_size_bytes as f64 - output_size as f64) / analysis.total_size_bytes as f64
            * 100.0) as f32
    } else {
        0.0
    };

    // Cleanup temp files
    cleanup_temp_files(&temp_files);

    // Phase 8: Complete
    on_progress(ConversionProgress {
        phase: ConversionPhase::Complete,
        message: format!(
            "Conversion complete! Saved {:.0}% ({} → {})",
            space_saved_percent,
            format_bytes(analysis.total_size_bytes),
            format_bytes(output_size)
        ),
        percent: 100.0,
        elapsed_seconds: start_time.elapsed().as_secs(),
        ..Default::default()
    });

    Ok(ConversionResult {
        success: true,
        output_path,
        duration_ms: analysis.total_duration_ms,
        chapters_count: chapters.len(),
        input_size_bytes: analysis.total_size_bytes,
        output_size_bytes: output_size,
        space_saved_percent,
        errors: Vec::new(),
        warnings,
        verification,
    })
}

/// Verify the output M4B file
async fn verify_output(
    path: &str,
    expected_duration_ms: u64,
    expected_chapters: usize,
) -> Result<VerificationResult> {
    // Get duration
    let actual_duration = get_audio_duration_ms(path).await.unwrap_or(0);
    let duration_diff = (actual_duration as i64 - expected_duration_ms as i64).abs() as u64;
    let duration_ok = duration_diff < 2000; // 2 second tolerance

    // Check chapters using ffprobe
    let chapters_output = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_chapters",
            path,
        ])
        .output()
        .await;

    let (chapters_ok, chapters_found) = if let Ok(output) = chapters_output {
        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            let count = json
                .get("chapters")
                .and_then(|c| c.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            (count == expected_chapters, count)
        } else {
            (false, 0)
        }
    } else {
        (false, 0)
    };

    // Check metadata
    let metadata_output = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            path,
        ])
        .output()
        .await;

    let (metadata_ok, cover_embedded) = if let Ok(output) = metadata_output {
        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            let tags = json
                .get("format")
                .and_then(|f| f.get("tags"));
            let has_title = tags
                .and_then(|t| t.get("title"))
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            let has_artist = tags
                .and_then(|t| t.get("artist"))
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);

            // Check for cover stream
            let streams_output = tokio::process::Command::new("ffprobe")
                .args([
                    "-v", "quiet",
                    "-print_format", "json",
                    "-show_streams",
                    "-select_streams", "v",
                    path,
                ])
                .output()
                .await;

            let has_cover = streams_output.ok()
                .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
                .and_then(|j| j.get("streams")?.as_array().map(|a| !a.is_empty()))
                .unwrap_or(false);

            (has_title && has_artist, has_cover)
        } else {
            (false, false)
        }
    } else {
        (false, false)
    };

    // Check if file is playable (basic check)
    let playable = actual_duration > 0;

    Ok(VerificationResult {
        duration_ok,
        duration_diff_ms: duration_diff,
        chapters_ok,
        chapters_found,
        chapters_expected: expected_chapters,
        metadata_ok,
        playable,
        cover_embedded,
    })
}

/// TURBO MODE: Stream copy AAC files without re-encoding
/// This is MUCH faster (~10x) for AAC source files as it skips decode+encode
async fn turbo_convert<F>(
    analysis: &SourceAnalysis,
    chapters: &[ChapterDefinition],
    request: &ConversionRequest,
    output_path: &str,
    temp_dir: &PathBuf,
    cover_path: &Option<String>,
    _ffmpeg_info: &FFmpegInfo,
    warnings: &mut Vec<String>,
    temp_files: &mut Vec<String>,
    start_time: Instant,
    _estimated_size: u64,
    mut on_progress: F,
) -> Result<ConversionResult>
where
    F: FnMut(ConversionProgress) + Send,
{
    use super::ffmpeg::create_concat_file_list;

    // Create concat file list from original AAC files (no decode needed!)
    let concat_list_path = temp_dir.join("concat_list.txt");
    let file_paths: Vec<String> = analysis.files.iter().map(|f| f.path.clone()).collect();
    create_concat_file_list(&file_paths, &concat_list_path.to_string_lossy())?;
    temp_files.push(concat_list_path.to_string_lossy().to_string());

    // Generate chapter metadata
    let metadata_path = temp_dir.join("metadata.txt");
    generate_chapter_metadata(chapters, &request.metadata, &metadata_path.to_string_lossy())?;
    temp_files.push(metadata_path.to_string_lossy().to_string());

    on_progress(ConversionProgress {
        phase: ConversionPhase::Encoding,
        message: "Turbo: Concatenating AAC streams (no re-encoding)...".to_string(),
        percent: 40.0,
        files_total: analysis.files.len(),
        ..Default::default()
    });

    // Build FFmpeg command for stream copy
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(), "warning".to_string(),
        // Concat demuxer
        "-f".to_string(), "concat".to_string(),
        "-safe".to_string(), "0".to_string(),
        "-i".to_string(), concat_list_path.to_string_lossy().to_string(),
        // Metadata file
        "-f".to_string(), "ffmetadata".to_string(),
        "-i".to_string(), metadata_path.to_string_lossy().to_string(),
    ];

    // Add cover if available (prepare for M4B compatibility)
    let mut use_cover = false;
    let mut _prepared_cover: Option<String> = None;
    if let Some(cover) = cover_path {
        if Path::new(cover).exists() {
            log::info!("Turbo mode: Preparing cover for M4B...");
            if let Some(prepared) = super::ffmpeg::prepare_cover_for_m4b(cover, temp_dir).await {
                args.push("-i".to_string());
                args.push(prepared.clone());
                if prepared != *cover {
                    temp_files.push(prepared.clone());
                }
                _prepared_cover = Some(prepared);
                use_cover = true;
            } else {
                log::warn!("Turbo mode: Cover could not be prepared, skipping");
                warnings.push("Cover could not be prepared for embedding".to_string());
            }
        }
    }

    // Stream mapping
    args.extend(["-map".to_string(), "0:a".to_string()]);      // Audio from concat
    args.extend(["-map_metadata".to_string(), "1".to_string()]); // Metadata from file

    if use_cover {
        args.extend(["-map".to_string(), "2:v".to_string()]);
        args.extend(["-c:v".to_string(), "copy".to_string()]);
        args.extend(["-disposition:v:0".to_string(), "attached_pic".to_string()]);
    }

    // STREAM COPY - no re-encoding!
    args.extend(["-c:a".to_string(), "copy".to_string()]);

    // Output format
    args.extend(["-f".to_string(), "mp4".to_string()]);
    args.push(output_path.to_string());

    log::info!("Turbo FFmpeg command: ffmpeg {}", args.join(" "));

    // Execute
    let output = tokio::process::Command::new("ffmpeg")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("Turbo mode failed: {}", stderr);

        // Fall back to normal encoding if stream copy fails
        warnings.push("Turbo mode failed, stream copy not compatible. Use a different speed preset.".to_string());
        return Err(anyhow!("Stream copy failed: {}. Files may have incompatible parameters.", stderr));
    }

    on_progress(ConversionProgress {
        phase: ConversionPhase::Verifying,
        message: "Verifying output...".to_string(),
        percent: 90.0,
        ..Default::default()
    });

    // Verify output
    let verification = if request.verify_output {
        Some(verify_output(output_path, analysis.total_duration_ms, chapters.len()).await?)
    } else {
        None
    };

    // Get output size
    let output_size = std::fs::metadata(output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Calculate space savings (usually minimal for stream copy since no re-encoding)
    let space_saved_percent = if analysis.total_size_bytes > 0 {
        ((analysis.total_size_bytes as f64 - output_size as f64) / analysis.total_size_bytes as f64
            * 100.0) as f32
    } else {
        0.0
    };

    // Cleanup
    cleanup_temp_files(temp_files);

    let elapsed = start_time.elapsed().as_secs();
    on_progress(ConversionProgress {
        phase: ConversionPhase::Complete,
        message: format!(
            "Turbo complete in {}s! {} → {}",
            elapsed,
            format_bytes(analysis.total_size_bytes),
            format_bytes(output_size)
        ),
        percent: 100.0,
        elapsed_seconds: elapsed,
        ..Default::default()
    });

    Ok(ConversionResult {
        success: true,
        output_path: output_path.to_string(),
        duration_ms: analysis.total_duration_ms,
        chapters_count: chapters.len(),
        input_size_bytes: analysis.total_size_bytes,
        output_size_bytes: output_size,
        space_saved_percent,
        errors: Vec::new(),
        warnings: warnings.clone(),
        verification,
    })
}

/// Create a cancelled result
fn cancelled_result() -> ConversionResult {
    ConversionResult {
        success: false,
        output_path: String::new(),
        duration_ms: 0,
        chapters_count: 0,
        input_size_bytes: 0,
        output_size_bytes: 0,
        space_saved_percent: 0.0,
        errors: vec!["Conversion cancelled by user".to_string()],
        warnings: Vec::new(),
        verification: None,
    }
}

/// Cleanup temporary files
fn cleanup_temp_files(files: &[String]) {
    for file in files {
        let path = Path::new(file);
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(path);
        } else if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Sanitize filename for output
fn sanitize_filename(name: &str) -> String {
    let invalid_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let mut result = name.to_string();
    for c in invalid_chars {
        result = result.replace(c, "_");
    }
    result.trim().to_string()
}

/// Delete source files after successful conversion
pub async fn delete_source_files(files: &[SourceFile]) -> Result<(usize, Vec<String>)> {
    let mut deleted = 0;
    let mut errors = Vec::new();

    for file in files {
        match std::fs::remove_file(&file.path) {
            Ok(_) => deleted += 1,
            Err(e) => errors.push(format!("{}: {}", file.filename, e)),
        }
    }

    Ok((deleted, errors))
}
