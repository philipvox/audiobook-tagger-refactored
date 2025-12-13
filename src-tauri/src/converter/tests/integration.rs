// src-tauri/src/converter/tests/integration.rs
// Integration tests for M4B conversion pipeline

use std::path::PathBuf;
use std::process::Stdio;
use tempfile::TempDir;
use tokio::process::Command;
use serial_test::serial;

use crate::converter::{
    analyze_source, convert, check_ffmpeg, get_available_space,
    validate_output_path, generate_chapter_metadata, validate_chapters,
    chapters_from_files, FFmpegBuilder, QualityPreset, ChapterMode,
    ConversionRequest, ConversionMetadata, ConversionProgress, ChapterDefinition,
    SourceFile, SpeedPreset,
};

/// Helper to check if FFmpeg is available for tests
async fn ffmpeg_available() -> bool {
    check_ffmpeg().await.is_ok()
}

/// Helper to create a test audio file using FFmpeg
async fn create_test_audio(path: &str, duration_secs: u32) -> bool {
    let result = Command::new("ffmpeg")
        .args([
            "-y",
            "-f", "lavfi",
            "-i", &format!("sine=frequency=440:duration={}", duration_secs),
            "-c:a", "aac",
            "-b:a", "64k",
            path,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    result.map(|s| s.success()).unwrap_or(false)
}

/// Helper to create multiple test audio files
async fn create_test_audiobook(dir: &PathBuf, file_count: usize, duration_per_file: u32) -> Vec<String> {
    let mut files = Vec::new();
    for i in 0..file_count {
        let filename = format!("{:02} - Chapter {}.m4a", i + 1, i + 1);
        let path = dir.join(&filename);
        let path_str = path.to_string_lossy().to_string();
        if create_test_audio(&path_str, duration_per_file).await {
            files.push(path_str);
        }
    }
    files
}

/// Helper to verify M4B output using ffprobe
async fn verify_m4b(path: &str) -> Option<M4BVerification> {
    // Get duration
    let duration_output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .await
        .ok()?;

    let duration_str = String::from_utf8_lossy(&duration_output.stdout);
    let duration_secs: f64 = duration_str.trim().parse().unwrap_or(0.0);

    // Get chapter count
    let chapters_output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_chapters",
            path,
        ])
        .output()
        .await
        .ok()?;

    let chapters_json: serde_json::Value =
        serde_json::from_slice(&chapters_output.stdout).ok()?;
    let chapter_count = chapters_json
        .get("chapters")
        .and_then(|c| c.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    // Get metadata
    let metadata_output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            path,
        ])
        .output()
        .await
        .ok()?;

    let metadata_json: serde_json::Value =
        serde_json::from_slice(&metadata_output.stdout).ok()?;
    let tags = metadata_json
        .get("format")
        .and_then(|f| f.get("tags"));

    let title = tags
        .and_then(|t| t.get("title"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let artist = tags
        .and_then(|t| t.get("artist"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Some(M4BVerification {
        duration_secs,
        chapter_count,
        title,
        artist,
        file_size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    })
}

#[derive(Debug)]
struct M4BVerification {
    duration_secs: f64,
    chapter_count: usize,
    title: Option<String>,
    artist: Option<String>,
    file_size: u64,
}

// ============================================================================
// FFmpeg Builder Tests
// ============================================================================

#[test]
fn test_ffmpeg_builder_input_options_ordering() {
    let cmd = FFmpegBuilder::new("output.m4b")
        .concat_input("filelist.txt")
        .metadata_file("metadata.txt")
        .build();

    let cmd_str = cmd.join(" ");

    // Error flags should appear BEFORE filelist.txt
    let err_detect_pos = cmd_str.find("-err_detect");
    let filelist_pos = cmd_str.find("filelist.txt");

    assert!(err_detect_pos.is_some(), "Should have -err_detect flag");
    assert!(filelist_pos.is_some(), "Should have filelist.txt");
    assert!(
        err_detect_pos.unwrap() < filelist_pos.unwrap(),
        "Error flags should come before filelist.txt"
    );

    // Error flags should NOT appear between filelist.txt and metadata.txt
    let metadata_pos = cmd_str.find("metadata.txt").unwrap();
    let between = &cmd_str[filelist_pos.unwrap()..metadata_pos];
    assert!(
        !between.contains("-err_detect"),
        "Error flags should not appear before metadata.txt"
    );
}

#[test]
fn test_ffmpeg_builder_skip_error_tolerance() {
    let cmd = FFmpegBuilder::new("output.m4b")
        .concat_input("filelist.txt")
        .skip_error_tolerance()
        .build();

    let cmd_str = cmd.join(" ");

    assert!(
        !cmd_str.contains("-err_detect"),
        "Should not have error flags when skip_error_tolerance is set"
    );
    assert!(
        !cmd_str.contains("discardcorrupt"),
        "Should not have discardcorrupt when skip_error_tolerance is set"
    );
}

#[test]
fn test_ffmpeg_builder_metadata_format() {
    let cmd = FFmpegBuilder::new("output.m4b")
        .concat_input("filelist.txt")
        .metadata_file("metadata.txt")
        .build();

    let cmd_str = cmd.join(" ");

    // Should have -f ffmetadata before metadata.txt
    let ffmetadata_pos = cmd_str.find("-f ffmetadata");
    let metadata_pos = cmd_str.find("metadata.txt");

    assert!(ffmetadata_pos.is_some(), "Should have -f ffmetadata");
    assert!(
        ffmetadata_pos.unwrap() < metadata_pos.unwrap(),
        "-f ffmetadata should come before metadata.txt"
    );
}

#[test]
fn test_ffmpeg_builder_cover_mapping() {
    let cmd = FFmpegBuilder::new("output.m4b")
        .concat_input("filelist.txt")
        .metadata_file("metadata.txt")
        .cover_image("cover.jpg")
        .build();

    let cmd_str = cmd.join(" ");

    // Cover should be input index 2 (after concat and metadata)
    assert!(cmd_str.contains("-map 2:v"), "Should map cover from input 2");
    assert!(cmd_str.contains("-disposition:v:0 attached_pic"), "Should set attached_pic disposition");
}

#[test]
fn test_ffmpeg_builder_quality_presets() {
    // Test Economy preset
    let economy = FFmpegBuilder::new("output.m4b")
        .quality_preset(&QualityPreset::Economy, true)
        .build();
    let economy_str = economy.join(" ");
    assert!(economy_str.contains("libfdk_aac"), "Economy with libfdk should use libfdk_aac");
    assert!(economy_str.contains("aac_he"), "Economy should use HE-AAC profile");

    // Test Standard preset
    let standard = FFmpegBuilder::new("output.m4b")
        .quality_preset(&QualityPreset::Standard, true)
        .build();
    let standard_str = standard.join(" ");
    assert!(standard_str.contains("-b:a 64k"), "Standard should use 64k bitrate");

    // Test High preset
    let high = FFmpegBuilder::new("output.m4b")
        .quality_preset(&QualityPreset::High, true)
        .build();
    let high_str = high.join(" ");
    assert!(high_str.contains("-b:a 96k"), "High should use 96k bitrate");

    // Test without libfdk
    let no_fdk = FFmpegBuilder::new("output.m4b")
        .quality_preset(&QualityPreset::Standard, false)
        .build();
    let no_fdk_str = no_fdk.join(" ");
    assert!(!no_fdk_str.contains("libfdk_aac"), "Without libfdk should use native aac");
}

// ============================================================================
// Chapter Tests
// ============================================================================

#[test]
fn test_chapters_from_files() {
    let files = vec![
        SourceFile {
            path: "/test/01 - Introduction.mp3".to_string(),
            filename: "01 - Introduction.mp3".to_string(),
            duration_ms: 60000,
            size_bytes: 1000000,
            bitrate_kbps: 128,
            sample_rate: 44100,
            channels: 2,
            codec: "mp3".to_string(),
        },
        SourceFile {
            path: "/test/02 - Chapter One.mp3".to_string(),
            filename: "02 - Chapter One.mp3".to_string(),
            duration_ms: 120000,
            size_bytes: 2000000,
            bitrate_kbps: 128,
            sample_rate: 44100,
            channels: 2,
            codec: "mp3".to_string(),
        },
        SourceFile {
            path: "/test/03 - Chapter Two.mp3".to_string(),
            filename: "03 - Chapter Two.mp3".to_string(),
            duration_ms: 90000,
            size_bytes: 1500000,
            bitrate_kbps: 128,
            sample_rate: 44100,
            channels: 2,
            codec: "mp3".to_string(),
        },
    ];

    let chapters = chapters_from_files(&files);

    assert_eq!(chapters.len(), 3);

    // First chapter
    assert_eq!(chapters[0].start_ms, 0);
    assert_eq!(chapters[0].end_ms, 60000);
    assert_eq!(chapters[0].title, "Introduction");

    // Second chapter
    assert_eq!(chapters[1].start_ms, 60000);
    assert_eq!(chapters[1].end_ms, 180000);
    assert_eq!(chapters[1].title, "Chapter One");

    // Third chapter
    assert_eq!(chapters[2].start_ms, 180000);
    assert_eq!(chapters[2].end_ms, 270000);
    assert_eq!(chapters[2].title, "Chapter Two");
}

#[test]
fn test_validate_chapters_valid() {
    let chapters = vec![
        ChapterDefinition {
            title: "Chapter 1".to_string(),
            start_ms: 0,
            end_ms: 60000,
        },
        ChapterDefinition {
            title: "Chapter 2".to_string(),
            start_ms: 60000,
            end_ms: 120000,
        },
    ];

    let issues = validate_chapters(&chapters, 120000);
    assert!(issues.is_empty(), "Valid chapters should have no issues: {:?}", issues);
}

#[test]
fn test_validate_chapters_gap() {
    let chapters = vec![
        ChapterDefinition {
            title: "Chapter 1".to_string(),
            start_ms: 0,
            end_ms: 50000,
        },
        ChapterDefinition {
            title: "Chapter 2".to_string(),
            start_ms: 60000, // Gap of 10 seconds
            end_ms: 120000,
        },
    ];

    let issues = validate_chapters(&chapters, 120000);
    assert!(!issues.is_empty(), "Should detect gap between chapters");
    assert!(issues.iter().any(|i| i.contains("Gap") || i.contains("overlap")));
}

#[test]
fn test_validate_chapters_not_starting_at_zero() {
    let chapters = vec![
        ChapterDefinition {
            title: "Chapter 1".to_string(),
            start_ms: 1000, // Doesn't start at 0
            end_ms: 60000,
        },
    ];

    let issues = validate_chapters(&chapters, 60000);
    assert!(issues.iter().any(|i| i.contains("start at 0")));
}

// ============================================================================
// Disk Space Tests
// ============================================================================

#[test]
fn test_get_available_space_current_dir() {
    let result = get_available_space(".");
    assert!(result.is_ok(), "Should get space for current directory");
    assert!(result.unwrap() > 0, "Available space should be positive");
}

#[test]
fn test_get_available_space_nonexistent_path() {
    // Should fall back to parent directory
    let result = get_available_space("/tmp/nonexistent_file_12345.m4b");
    assert!(result.is_ok(), "Should get space for parent of nonexistent path");
}

// ============================================================================
// Metadata Escaping Tests
// ============================================================================

#[test]
fn test_chapter_metadata_generation() {
    let chapters = vec![
        ChapterDefinition {
            title: "Chapter 1: The Beginning".to_string(),
            start_ms: 0,
            end_ms: 60000,
        },
        ChapterDefinition {
            title: "Chapter 2; Continued".to_string(), // Has semicolon
            start_ms: 60000,
            end_ms: 120000,
        },
    ];

    let metadata = ConversionMetadata {
        title: "Test Book".to_string(),
        author: "Test Author".to_string(),
        narrator: Some("Test Narrator".to_string()),
        ..Default::default()
    };

    let temp = tempfile::tempdir().unwrap();
    let metadata_path = temp.path().join("metadata.txt");
    let result = generate_chapter_metadata(&chapters, &metadata, &metadata_path.to_string_lossy());

    assert!(result.is_ok());

    let content = std::fs::read_to_string(&metadata_path).unwrap();
    assert!(content.contains(";FFMETADATA1"));
    assert!(content.contains("title=Test Book"));
    assert!(content.contains("artist=Test Author"));
    assert!(content.contains("[CHAPTER]"));
    assert!(content.contains("TIMEBASE=1/1000"));
    // Semicolon should be escaped
    assert!(content.contains("Chapter 2\\; Continued"));
}

// ============================================================================
// Full Pipeline Integration Tests (require FFmpeg)
// ============================================================================

#[tokio::test]
#[serial]
async fn test_full_conversion_pipeline() {
    if !ffmpeg_available().await {
        eprintln!("Skipping test: FFmpeg not available");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let source_dir = temp_dir.path().join("source");
    std::fs::create_dir(&source_dir).unwrap();

    // Create test audio files (3 files, 5 seconds each)
    let files = create_test_audiobook(&source_dir, 3, 5).await;
    if files.len() < 3 {
        eprintln!("Skipping test: Could not create test audio files");
        return;
    }

    let output_path = temp_dir.path().join("output.m4b");

    let request = ConversionRequest {
        source_path: source_dir.to_string_lossy().to_string(),
        output_path: Some(output_path.to_string_lossy().to_string()),
        quality_preset: QualityPreset::Standard,
        chapter_mode: ChapterMode::PerFile,
        metadata: ConversionMetadata {
            title: "Test Audiobook".to_string(),
            author: "Test Author".to_string(),
            ..Default::default()
        },
        delete_source: false,
        verify_output: true,
        speed_preset: SpeedPreset::Fast, // Use fast for tests
    };

    let mut last_progress: Option<ConversionProgress> = None;
    let result = convert(request, |p| {
        last_progress = Some(p);
    }).await;

    assert!(result.is_ok(), "Conversion should succeed: {:?}", result.err());
    let result = result.unwrap();

    assert!(result.success, "Conversion result should be success");
    assert!(output_path.exists(), "Output file should exist");

    // Verify the output
    if let Some(verification) = verify_m4b(&output_path.to_string_lossy()).await {
        assert!(verification.duration_secs > 10.0, "Duration should be ~15 seconds, got {}", verification.duration_secs);
        assert!(verification.chapter_count >= 1 && verification.chapter_count <= 3,
            "Should have 1-3 chapters, got {}", verification.chapter_count);
        assert_eq!(verification.title.as_deref(), Some("Test Audiobook"));
        assert_eq!(verification.artist.as_deref(), Some("Test Author"));
    }

    // Check progress was reported
    assert!(last_progress.is_some(), "Should have received progress updates");
}

#[tokio::test]
#[serial]
async fn test_analyze_source() {
    if !ffmpeg_available().await {
        eprintln!("Skipping test: FFmpeg not available");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let source_dir = temp_dir.path().join("source");
    std::fs::create_dir(&source_dir).unwrap();

    // Create test audio files
    let files = create_test_audiobook(&source_dir, 2, 3).await;
    if files.len() < 2 {
        eprintln!("Skipping test: Could not create test audio files");
        return;
    }

    let result = analyze_source(&source_dir.to_string_lossy()).await;
    assert!(result.is_ok(), "Analysis should succeed: {:?}", result.err());

    let analysis = result.unwrap();
    assert_eq!(analysis.files.len(), 2, "Should find 2 files");
    assert!(analysis.total_duration_ms > 5000, "Total duration should be > 5 seconds");
    assert!(analysis.total_size_bytes > 0, "Should have positive size");
}

#[tokio::test]
#[serial]
async fn test_conversion_with_cover() {
    if !ffmpeg_available().await {
        eprintln!("Skipping test: FFmpeg not available");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let source_dir = temp_dir.path().join("source");
    std::fs::create_dir(&source_dir).unwrap();

    // Create test audio files
    let files = create_test_audiobook(&source_dir, 2, 3).await;
    if files.len() < 2 {
        eprintln!("Skipping test: Could not create test audio files");
        return;
    }

    // Create a simple test cover image using FFmpeg
    let cover_path = source_dir.join("cover.jpg");
    let cover_created = Command::new("ffmpeg")
        .args([
            "-y",
            "-f", "lavfi",
            "-i", "color=c=blue:s=300x300:d=1",
            "-frames:v", "1",
            &cover_path.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);

    if !cover_created {
        eprintln!("Skipping cover test: Could not create test cover");
        return;
    }

    // Keep temp_dir alive by storing the output path separately
    let output_path_str = temp_dir.path().join("output.m4b").to_string_lossy().to_string();
    let source_dir_str = source_dir.to_string_lossy().to_string();
    let cover_path_str = cover_path.to_string_lossy().to_string();

    let request = ConversionRequest {
        source_path: source_dir_str,
        output_path: Some(output_path_str.clone()),
        quality_preset: QualityPreset::Standard,
        chapter_mode: ChapterMode::PerFile,
        metadata: ConversionMetadata {
            title: "Book With Cover".to_string(),
            author: "Cover Author".to_string(),
            cover_path: Some(cover_path_str),
            ..Default::default()
        },
        delete_source: false,
        verify_output: true,
        speed_preset: SpeedPreset::Fast,
    };

    let result = convert(request, |_| {}).await;

    // The temp_dir is still in scope here
    assert!(result.is_ok(), "Conversion with cover should succeed: {:?}", result.err());

    let result = result.unwrap();
    assert!(result.success);

    // Verify cover was embedded
    if let Some(verification) = &result.verification {
        assert!(verification.cover_embedded, "Cover should be embedded");
    }

    // temp_dir drops here, cleaning up
}

#[tokio::test]
#[serial]
async fn test_conversion_quality_presets() {
    if !ffmpeg_available().await {
        eprintln!("Skipping test: FFmpeg not available");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let source_dir = temp_dir.path().join("source");
    std::fs::create_dir(&source_dir).unwrap();

    // Create one test file
    let files = create_test_audiobook(&source_dir, 1, 10).await;
    if files.is_empty() {
        eprintln!("Skipping test: Could not create test audio file");
        return;
    }

    let presets = [
        (QualityPreset::Economy, "economy"),
        (QualityPreset::Standard, "standard"),
        (QualityPreset::High, "high"),
    ];

    let mut sizes: Vec<(String, u64)> = Vec::new();

    for (preset, name) in presets {
        let output_path = temp_dir.path().join(format!("output_{}.m4b", name));

        let request = ConversionRequest {
            source_path: source_dir.to_string_lossy().to_string(),
            output_path: Some(output_path.to_string_lossy().to_string()),
            quality_preset: preset,
            chapter_mode: ChapterMode::PerFile,
            metadata: ConversionMetadata {
                title: format!("Test {}", name),
                author: "Test".to_string(),
                ..Default::default()
            },
            delete_source: false,
            verify_output: false,
            speed_preset: SpeedPreset::MaxSpeed, // Use max speed for quality preset tests
        };

        let result = convert(request, |_| {}).await;
        if let Ok(r) = result {
            if r.success {
                sizes.push((name.to_string(), r.output_size_bytes));
            }
        }
    }

    // Verify that higher quality = larger file (generally)
    if sizes.len() == 3 {
        let economy_size = sizes.iter().find(|(n, _)| n == "economy").map(|(_, s)| *s).unwrap_or(0);
        let high_size = sizes.iter().find(|(n, _)| n == "high").map(|(_, s)| *s).unwrap_or(0);
        assert!(
            high_size > economy_size,
            "High quality ({}) should be larger than economy ({})",
            high_size, economy_size
        );
    }
}
