// src-tauri/src/commands/converter.rs
// Tauri IPC commands for MP3 to M4B conversion

use tauri::{Emitter, Window};

use crate::converter::{
    analyze_source, cancel, convert, delete_source_files,
    check_ffmpeg, ChapterMode, ConversionMetadata, ConversionProgress,
    ConversionRequest, ConversionResult, FFmpegInfo, QualityPreset,
    SourceAnalysis, SpeedPreset,
};

/// Check if FFmpeg is available and get version info
#[tauri::command]
pub async fn check_ffmpeg_available() -> Result<FFmpegInfo, String> {
    check_ffmpeg().await.map_err(|e| e.to_string())
}

/// Analyze a folder or file for conversion
#[tauri::command]
pub async fn analyze_for_conversion(path: String) -> Result<SourceAnalysis, String> {
    analyze_source(&path).await.map_err(|e| e.to_string())
}

/// Estimate output file size for a given quality preset
#[tauri::command]
pub async fn estimate_output_size(
    analysis: SourceAnalysis,
    preset: QualityPreset,
) -> Result<EstimatedSize, String> {
    let output_bytes = analysis.estimated_output_size(&preset);
    let savings_percent = analysis.space_savings_percent(&preset);

    Ok(EstimatedSize {
        input_bytes: analysis.total_size_bytes,
        output_bytes,
        savings_percent,
        input_formatted: format_bytes(analysis.total_size_bytes),
        output_formatted: format_bytes(output_bytes),
    })
}

#[derive(serde::Serialize)]
pub struct EstimatedSize {
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub savings_percent: f32,
    pub input_formatted: String,
    pub output_formatted: String,
}

/// Convert MP3 files to M4B
#[tauri::command]
pub async fn convert_to_m4b(
    window: Window,
    request: ConversionRequest,
) -> Result<ConversionResult, String> {
    // Emit progress events to the frontend
    let window_clone = window.clone();
    let emit_progress = move |progress: ConversionProgress| {
        let _ = window_clone.emit("conversion_progress", &progress);
    };

    convert(request, emit_progress)
        .await
        .map_err(|e| e.to_string())
}

/// Cancel the current conversion
#[tauri::command]
pub async fn cancel_conversion() -> Result<(), String> {
    cancel().await.map_err(|e| e.to_string())
}

/// Delete source files after successful conversion
#[tauri::command]
pub async fn delete_source_files_after_conversion(
    analysis: SourceAnalysis,
) -> Result<DeleteResult, String> {
    let (deleted, errors) = delete_source_files(&analysis.files)
        .await
        .map_err(|e| e.to_string())?;

    Ok(DeleteResult {
        deleted_count: deleted,
        total_count: analysis.files.len(),
        errors,
    })
}

#[derive(serde::Serialize)]
pub struct DeleteResult {
    pub deleted_count: usize,
    pub total_count: usize,
    pub errors: Vec<String>,
}

/// Get default quality presets info
#[tauri::command]
pub async fn get_quality_presets() -> Vec<PresetInfo> {
    vec![
        PresetInfo {
            id: "economy".to_string(),
            name: "Economy".to_string(),
            bitrate: "32k HE-AAC".to_string(),
            description: "Good quality, smallest files (~14 MB/hour)".to_string(),
            estimated_size_per_hour_mb: 14.0,
        },
        PresetInfo {
            id: "standard".to_string(),
            name: "Standard".to_string(),
            bitrate: "64k AAC-LC".to_string(),
            description: "Excellent quality, recommended (~28 MB/hour)".to_string(),
            estimated_size_per_hour_mb: 28.0,
        },
        PresetInfo {
            id: "high".to_string(),
            name: "High".to_string(),
            bitrate: "96k AAC-LC".to_string(),
            description: "Pristine quality for high-quality sources (~43 MB/hour)".to_string(),
            estimated_size_per_hour_mb: 43.0,
        },
    ]
}

#[derive(serde::Serialize)]
pub struct PresetInfo {
    pub id: String,
    pub name: String,
    pub bitrate: String,
    pub description: String,
    pub estimated_size_per_hour_mb: f32,
}

/// Get speed presets info
#[tauri::command]
pub async fn get_speed_presets() -> Vec<SpeedPresetInfo> {
    vec![
        SpeedPresetInfo {
            id: "max_quality".to_string(),
            name: "Max Quality".to_string(),
            description: "Slowest - best quality, single-threaded".to_string(),
            parallel_workers: 1,
        },
        SpeedPresetInfo {
            id: "balanced".to_string(),
            name: "Balanced".to_string(),
            description: "Good speed and quality (default)".to_string(),
            parallel_workers: 2,
        },
        SpeedPresetInfo {
            id: "fast".to_string(),
            name: "Fast".to_string(),
            description: "Parallel processing, slight quality tradeoff".to_string(),
            parallel_workers: num_cpus::get().min(4),
        },
        SpeedPresetInfo {
            id: "max_speed".to_string(),
            name: "Max Speed".to_string(),
            description: format!("Fastest - uses all {} CPU cores", num_cpus::get()),
            parallel_workers: num_cpus::get(),
        },
    ]
}

#[derive(serde::Serialize)]
pub struct SpeedPresetInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub parallel_workers: usize,
}

/// Format bytes as human-readable string
fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} bytes", bytes)
    }
}
