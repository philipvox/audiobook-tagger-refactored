// src-tauri/src/progress.rs
// WITH cover tracking and error reporting

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Represents an error encountered during processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingError {
    pub item: String,        // The item that failed (book title or file path)
    pub error: String,       // Error message
    pub error_type: String,  // Error category: "api", "io", "parse", "timeout", "unknown"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
    pub covers_found: usize,
    pub phase: String,
    /// Number of errors encountered during scanning
    pub error_count: usize,
    /// Recent errors (last 10 for display)
    pub recent_errors: Vec<ProcessingError>,
    /// Number of items skipped due to errors
    pub skipped_count: usize,
}

impl Default for ScanProgress {
    fn default() -> Self {
        Self {
            current: 0,
            total: 0,
            current_file: String::new(),
            covers_found: 0,
            phase: "idle".to_string(),
            error_count: 0,
            recent_errors: Vec::new(),
            skipped_count: 0,
        }
    }
}

static SCAN_PROGRESS: Lazy<Mutex<ScanProgress>> = Lazy::new(|| {
    Mutex::new(ScanProgress::default())
});

pub fn update_progress(current: usize, total: usize, current_file: &str) {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        progress.current = current;
        progress.total = total;
        progress.current_file = current_file.to_string();
        progress.phase = "processing".to_string();
    }
}

pub fn update_progress_with_covers(current: usize, total: usize, current_file: &str, covers: usize) {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        progress.current = current;
        progress.total = total;
        progress.current_file = current_file.to_string();
        progress.covers_found = covers;
        progress.phase = "processing".to_string();
    }
}

pub fn set_phase(phase: &str) {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        progress.phase = phase.to_string();
    }
}

pub fn set_total(total: usize) {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        progress.total = total;
        progress.current = 0;
        progress.current_file = String::new();
        progress.covers_found = 0;
        progress.phase = "processing".to_string();
    }
}

pub fn increment() {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        progress.current += 1;
    }
}

pub fn increment_covers() {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        progress.covers_found += 1;
    }
}

pub fn get_progress() -> ScanProgress {
    SCAN_PROGRESS.lock().ok().map(|p| p.clone()).unwrap_or_default()
}

pub fn reset_progress() {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        *progress = ScanProgress::default();
    }
}

/// Record an error during processing
pub fn record_error(item: &str, error: &str, error_type: &str) {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        progress.error_count += 1;

        let err = ProcessingError {
            item: item.to_string(),
            error: error.to_string(),
            error_type: error_type.to_string(),
        };

        // Keep only last 10 errors
        if progress.recent_errors.len() >= 10 {
            progress.recent_errors.remove(0);
        }
        progress.recent_errors.push(err);
    }
}

/// Record a skipped item
pub fn record_skip() {
    if let Ok(mut progress) = SCAN_PROGRESS.lock() {
        progress.skipped_count += 1;
    }
}

/// Get current error count
pub fn get_error_count() -> usize {
    SCAN_PROGRESS.lock().ok().map(|p| p.error_count).unwrap_or(0)
}