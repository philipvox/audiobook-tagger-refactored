//! Aeneas forced alignment wrapper.
//!
//! Aeneas is a Python library for forced alignment of audio and text.
//! This module wraps Aeneas as a subprocess to generate word/sentence-level timestamps.

use super::{AlignedFragment, AlignedWord, AlignmentGranularity};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

/// Aeneas venv path
const AENEAS_VENV: &str = "/Users/philips/.aeneas-venv";
const AENEAS_SITE_PACKAGES: &str = "/Users/philips/.aeneas-venv/lib/python3.10/site-packages";

/// Get the Python executable path for Aeneas
fn get_aeneas_python() -> String {
    let venv_python = format!("{}/bin/python", AENEAS_VENV);
    if std::path::Path::new(&venv_python).exists() {
        return venv_python;
    }
    "python3".to_string()
}

/// Run a Python command with the aeneas venv environment properly set up
fn run_python_command(args: &[&str]) -> std::io::Result<std::process::Output> {
    let python_path = format!("{}/bin/python", AENEAS_VENV);

    // Build PATH with venv bin directory first
    let venv_bin = format!("{}/bin", AENEAS_VENV);
    let current_path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string());
    let new_path = format!("{}:/opt/homebrew/bin:{}", venv_bin, current_path);

    // Set PYTHONPATH to include site-packages
    let python_path_env = std::env::var("PYTHONPATH").unwrap_or_default();
    let new_pythonpath = if python_path_env.is_empty() {
        AENEAS_SITE_PACKAGES.to_string()
    } else {
        format!("{}:{}", AENEAS_SITE_PACKAGES, python_path_env)
    };

    Command::new(&python_path)
        .args(args)
        .env("VIRTUAL_ENV", AENEAS_VENV)
        .env("PATH", &new_path)
        .env("PYTHONPATH", &new_pythonpath)
        .env_remove("PYTHONHOME")
        .output()
}

/// Aeneas aligner wrapper
pub struct AeneasAligner {
    language: String,
    granularity: AlignmentGranularity,
    python_path: String,
}

impl AeneasAligner {
    /// Create a new Aeneas aligner
    pub fn new(language: &str, granularity: AlignmentGranularity) -> Result<Self> {
        let python_path = get_aeneas_python();

        // Verify Aeneas is installed using the venv environment
        let status = run_python_command(&["-c", "import aeneas"])
            .context("Python not found. Please install Python 3.")?;

        if !status.status.success() {
            bail!("Aeneas not installed. Run: pip install aeneas numpy scipy");
        }

        Ok(Self {
            language: language.to_string(),
            granularity,
            python_path,
        })
    }

    /// Check if Aeneas is available
    pub fn is_available() -> bool {
        let result = run_python_command(&["-c", "import aeneas"]);

        match result {
            Ok(output) => {
                let available = output.status.success();
                if !available {
                    log::warn!("Aeneas import failed: {}", String::from_utf8_lossy(&output.stderr));
                }
                available
            }
            Err(e) => {
                log::error!("Failed to check aeneas: {}", e);
                false
            }
        }
    }

    /// Run alignment on audio + text
    pub fn align(&self, audio_path: &Path, text: &str) -> Result<Vec<AlignedFragment>> {
        let temp_dir = TempDir::new().context("Failed to create temp directory")?;

        // Write text to temp file
        let text_path = temp_dir.path().join("text.txt");
        std::fs::write(&text_path, text).context("Failed to write text file")?;

        // Output JSON path
        let output_path = temp_dir.path().join("alignment.json");

        // Build Aeneas task configuration
        let task_config = self.build_task_config();

        log::info!(
            "Running Aeneas alignment: {} -> {}",
            audio_path.display(),
            output_path.display()
        );

        // Run Aeneas
        let output = Command::new(&self.python_path)
            .args([
                "-m",
                "aeneas.tools.execute_task",
                audio_path.to_str().unwrap(),
                text_path.to_str().unwrap(),
                &task_config,
                output_path.to_str().unwrap(),
            ])
            .output()
            .context("Failed to run Aeneas")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("Aeneas alignment failed: {}", stderr);
        }

        // Parse output
        let output_content =
            std::fs::read_to_string(&output_path).context("Failed to read Aeneas output")?;

        self.parse_output(&output_content)
    }

    /// Run word-level alignment within a fragment
    pub fn align_words(
        &self,
        audio_path: &Path,
        text: &str,
        start_time: f64,
        end_time: f64,
    ) -> Result<Vec<AlignedWord>> {
        let temp_dir = TempDir::new().context("Failed to create temp directory")?;

        // Extract audio segment using ffmpeg
        let segment_path = temp_dir.path().join("segment.wav");
        extract_audio_segment(audio_path, &segment_path, start_time, end_time)?;

        // Prepare text as one word per line for word-level alignment
        let words: Vec<&str> = text.split_whitespace().collect();
        let word_text = words.join("\n");

        let text_path = temp_dir.path().join("words.txt");
        std::fs::write(&text_path, &word_text).context("Failed to write word text")?;

        let output_path = temp_dir.path().join("words.json");

        // Word-level config
        let task_config = format!(
            "task_language={}|is_text_type=plain|os_task_file_format=json",
            self.language
        );

        let output = Command::new(&self.python_path)
            .args([
                "-m",
                "aeneas.tools.execute_task",
                segment_path.to_str().unwrap(),
                text_path.to_str().unwrap(),
                &task_config,
                output_path.to_str().unwrap(),
            ])
            .output()
            .context("Failed to run Aeneas word alignment")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("Aeneas word alignment failed: {}", stderr);
        }

        // Parse and adjust timestamps
        let output_content = std::fs::read_to_string(&output_path)?;
        let fragments = self.parse_output(&output_content)?;

        // Convert to AlignedWords with adjusted timestamps
        let aligned_words = fragments
            .into_iter()
            .map(|f| AlignedWord {
                word: f.text.trim().to_string(),
                start: f.begin + start_time,
                end: f.end + start_time,
            })
            .collect();

        Ok(aligned_words)
    }

    /// Build Aeneas task configuration string
    fn build_task_config(&self) -> String {
        let text_type = match self.granularity {
            AlignmentGranularity::Word => "plain",
            AlignmentGranularity::Sentence => "plain",
            AlignmentGranularity::Paragraph => "plain",
        };

        format!(
            "task_language={}|is_text_type={}|os_task_file_format=json",
            self.language, text_type
        )
    }

    /// Parse Aeneas JSON output
    fn parse_output(&self, content: &str) -> Result<Vec<AlignedFragment>> {
        #[derive(Deserialize)]
        struct AeneasOutput {
            fragments: Vec<AeneasFragment>,
        }

        #[derive(Deserialize)]
        struct AeneasFragment {
            id: String,
            begin: String,
            end: String,
            lines: Vec<String>,
        }

        let output: AeneasOutput =
            serde_json::from_str(content).context("Failed to parse Aeneas JSON output")?;

        let fragments = output
            .fragments
            .into_iter()
            .map(|f| AlignedFragment {
                id: f.id,
                begin: f.begin.parse().unwrap_or(0.0),
                end: f.end.parse().unwrap_or(0.0),
                text: f.lines.join(" "),
                words: Vec::new(),
            })
            .collect();

        Ok(fragments)
    }
}

/// Extract audio segment using ffmpeg
fn extract_audio_segment(input: &Path, output: &Path, start: f64, end: f64) -> Result<()> {
    let duration = end - start;

    let status = Command::new("ffmpeg")
        .args([
            "-y", // Overwrite
            "-i",
            input.to_str().unwrap(),
            "-ss",
            &format!("{:.3}", start),
            "-t",
            &format!("{:.3}", duration),
            "-vn",               // No video
            "-acodec",
            "pcm_s16le",         // PCM 16-bit
            "-ar",
            "22050",             // 22.05 kHz (good for speech)
            "-ac",
            "1",                 // Mono
            output.to_str().unwrap(),
        ])
        .output()
        .context("Failed to run ffmpeg")?;

    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        bail!("ffmpeg segment extraction failed: {}", stderr);
    }

    Ok(())
}

/// Convert audio file to WAV format (required by some Aeneas configurations)
pub fn convert_to_wav(input: &Path, output_dir: &Path) -> Result<std::path::PathBuf> {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");

    let output = output_dir.join(format!("{}.wav", stem));

    // Skip if already WAV
    if input
        .extension()
        .map(|e| e.to_ascii_lowercase() == "wav")
        .unwrap_or(false)
    {
        std::fs::copy(input, &output)?;
        return Ok(output);
    }

    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-i",
            input.to_str().unwrap(),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "22050",
            "-ac",
            "1",
            output.to_str().unwrap(),
        ])
        .output()
        .context("Failed to run ffmpeg for WAV conversion")?;

    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        bail!("ffmpeg WAV conversion failed: {}", stderr);
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aeneas_available() {
        // Just check if the function runs without panic
        let _ = AeneasAligner::is_available();
    }
}
