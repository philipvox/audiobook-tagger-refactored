// src-tauri/src/converter/types.rs
// Data structures for MP3 to M4B conversion

use serde::{Deserialize, Serialize};

/// Request to convert MP3 files to M4B
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionRequest {
    pub source_path: String,
    pub output_path: Option<String>,
    pub quality_preset: QualityPreset,
    pub chapter_mode: ChapterMode,
    pub metadata: ConversionMetadata,
    pub delete_source: bool,
    pub verify_output: bool,
    /// Speed preset - controls encoding speed vs quality tradeoff
    #[serde(default)]
    pub speed_preset: SpeedPreset,
}

/// Speed presets for encoding - trades quality for speed
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub enum SpeedPreset {
    /// Maximum quality, slowest encoding (afterburner enabled, single-threaded decode)
    MaxQuality,
    /// Balanced speed and quality (default)
    #[default]
    Balanced,
    /// Fast encoding with parallel decode, slight quality reduction
    Fast,
    /// Maximum speed - parallel decode, no afterburner, max threads
    MaxSpeed,
    /// Turbo mode - stream copy AAC files without re-encoding (fastest, requires AAC source)
    Turbo,
}

impl SpeedPreset {
    pub fn description(&self) -> &'static str {
        match self {
            SpeedPreset::MaxQuality => "Max Quality - Slowest, best quality",
            SpeedPreset::Balanced => "Balanced - Good speed and quality",
            SpeedPreset::Fast => "Fast - Parallel processing, slight quality tradeoff",
            SpeedPreset::MaxSpeed => "Max Speed - Fastest, uses all CPU cores",
            SpeedPreset::Turbo => "Turbo - Stream copy AAC (no re-encoding)",
        }
    }

    /// Number of parallel decode workers
    pub fn parallel_decode_workers(&self) -> usize {
        match self {
            SpeedPreset::MaxQuality => 1,
            SpeedPreset::Balanced => 2,
            SpeedPreset::Fast => num_cpus::get().min(4),
            SpeedPreset::MaxSpeed => num_cpus::get(),
            SpeedPreset::Turbo => num_cpus::get(), // Turbo doesn't decode, but this is for fallback
        }
    }

    /// Whether to use libfdk_aac afterburner (highest quality but slower)
    pub fn use_afterburner(&self) -> bool {
        match self {
            SpeedPreset::MaxQuality => true,
            SpeedPreset::Balanced => true,
            SpeedPreset::Fast => false,
            SpeedPreset::MaxSpeed => false,
            SpeedPreset::Turbo => false, // N/A for stream copy
        }
    }

    /// FFmpeg thread count for encoding
    pub fn ffmpeg_threads(&self) -> usize {
        match self {
            SpeedPreset::MaxQuality => 1,
            SpeedPreset::Balanced => 0, // 0 = auto
            SpeedPreset::Fast => 0,
            SpeedPreset::MaxSpeed => num_cpus::get(),
            SpeedPreset::Turbo => num_cpus::get(),
        }
    }

    /// Whether to attempt stream copy (skip re-encoding) for AAC sources
    pub fn prefer_stream_copy(&self) -> bool {
        matches!(self, SpeedPreset::Turbo)
    }
}

/// Quality presets for AAC encoding
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum QualityPreset {
    /// 32k HE-AAC - Good quality, smallest size
    Economy,
    /// 64k AAC-LC - Excellent quality, recommended default
    Standard,
    /// 96k AAC-LC - Pristine quality for high-quality sources
    High,
    /// Custom bitrate settings
    Custom(CustomQuality),
}

impl Default for QualityPreset {
    fn default() -> Self {
        QualityPreset::Standard
    }
}

impl QualityPreset {
    pub fn bitrate_kbps(&self) -> u32 {
        match self {
            QualityPreset::Economy => 48,   // Fallback without libfdk
            QualityPreset::Standard => 64,
            QualityPreset::High => 96,
            QualityPreset::Custom(q) => q.bitrate_kbps,
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            QualityPreset::Economy => "Economy (32k HE-AAC) - Good quality, smallest files",
            QualityPreset::Standard => "Standard (64k AAC) - Excellent quality, recommended",
            QualityPreset::High => "High (96k AAC) - Pristine quality",
            QualityPreset::Custom(_) => "Custom settings",
        }
    }
}

/// Custom quality settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomQuality {
    pub bitrate_kbps: u32,
    pub sample_rate: u32,
    pub channels: u8, // 1 = mono, 2 = stereo
}

impl Default for CustomQuality {
    fn default() -> Self {
        Self {
            bitrate_kbps: 64,
            sample_rate: 44100,
            channels: 2,
        }
    }
}

/// How to generate chapters
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ChapterMode {
    /// One chapter per input file
    PerFile,
    /// Detect chapters by silence gaps
    SilenceDetection {
        /// Minimum silence duration in seconds
        min_silence_seconds: f64,
        /// Noise threshold in dB (negative value)
        noise_threshold_db: i32,
    },
    /// No chapters
    None,
    /// User-provided chapter definitions
    Custom { chapters: Vec<ChapterDefinition> },
}

impl Default for ChapterMode {
    fn default() -> Self {
        ChapterMode::PerFile
    }
}

/// A single chapter definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterDefinition {
    pub title: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

impl ChapterDefinition {
    pub fn duration_ms(&self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }

    pub fn duration_formatted(&self) -> String {
        format_duration_ms(self.duration_ms())
    }
}

/// Metadata for the output M4B file
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConversionMetadata {
    pub title: String,
    pub author: String,
    pub narrator: Option<String>,
    pub series: Option<String>,
    pub series_part: Option<String>,
    pub genres: Vec<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub year: Option<String>,
    pub cover_path: Option<String>,
}

/// Analysis result for source files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceAnalysis {
    pub files: Vec<SourceFile>,
    pub total_duration_ms: u64,
    pub total_size_bytes: u64,
    pub detected_metadata: ConversionMetadata,
    pub detected_chapters: Vec<ChapterDefinition>,
    pub has_cover: bool,
    pub cover_source: Option<String>,
    pub source_path: String,
    /// Whether all source files are AAC and can use Turbo mode (stream copy)
    #[serde(default)]
    pub can_stream_copy: bool,
}

impl SourceAnalysis {
    pub fn total_duration_formatted(&self) -> String {
        format_duration_ms(self.total_duration_ms)
    }

    pub fn estimated_output_size(&self, preset: &QualityPreset) -> u64 {
        let bitrate_kbps = preset.bitrate_kbps();
        let duration_seconds = self.total_duration_ms as f64 / 1000.0;
        let estimated_bytes = (duration_seconds * bitrate_kbps as f64 * 1000.0 / 8.0) as u64;
        // Add ~5% overhead for container/metadata
        (estimated_bytes as f64 * 1.05) as u64
    }

    pub fn space_savings_percent(&self, preset: &QualityPreset) -> f32 {
        let output_size = self.estimated_output_size(preset) as f64;
        let input_size = self.total_size_bytes as f64;
        if input_size > 0.0 {
            ((input_size - output_size) / input_size * 100.0) as f32
        } else {
            0.0
        }
    }

    /// Check if all source files are AAC and can be stream-copied (no re-encoding)
    pub fn can_stream_copy(&self) -> bool {
        !self.files.is_empty() && self.files.iter().all(|f| f.codec == "aac")
    }

    /// Check if all files have the same sample rate and channels (required for concat)
    pub fn has_uniform_format(&self) -> bool {
        if self.files.is_empty() {
            return false;
        }
        let first = &self.files[0];
        self.files.iter().all(|f| {
            f.sample_rate == first.sample_rate && f.channels == first.channels
        })
    }

    /// Get primary codec used in source files
    pub fn primary_codec(&self) -> Option<&str> {
        self.files.first().map(|f| f.codec.as_str())
    }
}

/// Information about a single source file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceFile {
    pub path: String,
    pub filename: String,
    pub duration_ms: u64,
    pub size_bytes: u64,
    pub bitrate_kbps: u32,
    pub sample_rate: u32,
    pub channels: u8,
    /// Audio codec (e.g., "aac", "mp3", "flac")
    #[serde(default)]
    pub codec: String,
}

impl SourceFile {
    pub fn duration_formatted(&self) -> String {
        format_duration_ms(self.duration_ms)
    }
}

/// Progress update during conversion
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionProgress {
    pub phase: ConversionPhase,
    pub percent: f32,
    pub current_file: Option<String>,
    pub files_processed: usize,
    pub files_total: usize,
    pub bytes_written: u64,
    pub estimated_final_size: u64,
    pub elapsed_seconds: u64,
    pub eta_seconds: Option<u64>,
    pub message: String,
}

impl Default for ConversionProgress {
    fn default() -> Self {
        Self {
            phase: ConversionPhase::Analyzing,
            percent: 0.0,
            current_file: None,
            files_processed: 0,
            files_total: 0,
            bytes_written: 0,
            estimated_final_size: 0,
            elapsed_seconds: 0,
            eta_seconds: None,
            message: String::new(),
        }
    }
}

/// Current phase of conversion
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ConversionPhase {
    Analyzing,
    Concatenating,
    Encoding,
    ApplyingMetadata,
    EmbeddingCover,
    Verifying,
    Complete,
    Failed,
    Cancelled,
}

impl ConversionPhase {
    pub fn description(&self) -> &'static str {
        match self {
            ConversionPhase::Analyzing => "Analyzing source files...",
            ConversionPhase::Concatenating => "Merging audio files...",
            ConversionPhase::Encoding => "Encoding to AAC...",
            ConversionPhase::ApplyingMetadata => "Applying metadata and chapters...",
            ConversionPhase::EmbeddingCover => "Embedding cover art...",
            ConversionPhase::Verifying => "Verifying output...",
            ConversionPhase::Complete => "Conversion complete",
            ConversionPhase::Failed => "Conversion failed",
            ConversionPhase::Cancelled => "Conversion cancelled",
        }
    }
}

/// Result of a conversion operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionResult {
    pub success: bool,
    pub output_path: String,
    pub duration_ms: u64,
    pub chapters_count: usize,
    pub input_size_bytes: u64,
    pub output_size_bytes: u64,
    pub space_saved_percent: f32,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub verification: Option<VerificationResult>,
}

/// Result of output verification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationResult {
    pub duration_ok: bool,
    pub duration_diff_ms: u64,
    pub chapters_ok: bool,
    pub chapters_found: usize,
    pub chapters_expected: usize,
    pub metadata_ok: bool,
    pub playable: bool,
    pub cover_embedded: bool,
}

impl VerificationResult {
    pub fn all_ok(&self) -> bool {
        self.duration_ok && self.chapters_ok && self.metadata_ok && self.playable
    }
}

/// Information about FFmpeg installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FFmpegInfo {
    pub available: bool,
    pub version: String,
    pub has_libfdk_aac: bool,
    pub has_aac: bool,
}

/// Silence marker detected in audio
#[derive(Debug, Clone)]
pub struct SilenceMarker {
    pub start: f64,
    pub end: f64,
    pub duration: f64,
}

// Helper function to format duration
pub fn format_duration_ms(ms: u64) -> String {
    let total_seconds = ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, seconds)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, seconds)
    } else {
        format!("{}s", seconds)
    }
}

/// Format bytes as human-readable size
pub fn format_bytes(bytes: u64) -> String {
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
