// src-tauri/src/progress.rs
// WITH cover tracking, error reporting, and ETA calculation

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Instant;

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
    /// Processing rate (items per second)
    pub rate: f64,
    /// Elapsed time in seconds
    pub elapsed_secs: f64,
    /// Estimated time remaining in seconds
    pub eta_secs: f64,
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
            rate: 0.0,
            elapsed_secs: 0.0,
            eta_secs: 0.0,
        }
    }
}

/// Internal state that includes non-serializable start time
struct ProgressState {
    progress: ScanProgress,
    start_time: Option<Instant>,
}

static PROGRESS_STATE: Lazy<Mutex<ProgressState>> = Lazy::new(|| {
    Mutex::new(ProgressState {
        progress: ScanProgress::default(),
        start_time: None,
    })
});

/// Start the scan timer - call this at the beginning of a scan
pub fn start_scan(total: usize) {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.start_time = Some(Instant::now());
        state.progress = ScanProgress::default();
        state.progress.total = total;
        state.progress.phase = "processing".to_string();
    }
}

/// Update progress with automatic ETA calculation
pub fn update_progress(current: usize, total: usize, current_file: &str) {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.progress.current = current;
        state.progress.total = total;
        state.progress.current_file = current_file.to_string();
        state.progress.phase = "processing".to_string();

        // Calculate rate and ETA from start time
        if let Some(start) = state.start_time {
            let elapsed = start.elapsed().as_secs_f64();
            state.progress.elapsed_secs = elapsed;

            if current > 0 && elapsed > 0.0 {
                let rate = current as f64 / elapsed;
                state.progress.rate = rate;

                let remaining = total.saturating_sub(current);
                if rate > 0.0 {
                    state.progress.eta_secs = remaining as f64 / rate;
                }
            }
        }
    }
}

/// Update progress with covers count
pub fn update_progress_with_covers(current: usize, total: usize, current_file: &str, covers: usize) {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.progress.current = current;
        state.progress.total = total;
        state.progress.current_file = current_file.to_string();
        state.progress.covers_found = covers;
        state.progress.phase = "processing".to_string();

        // Calculate rate and ETA from start time
        if let Some(start) = state.start_time {
            let elapsed = start.elapsed().as_secs_f64();
            state.progress.elapsed_secs = elapsed;

            if current > 0 && elapsed > 0.0 {
                let rate = current as f64 / elapsed;
                state.progress.rate = rate;

                let remaining = total.saturating_sub(current);
                if rate > 0.0 {
                    state.progress.eta_secs = remaining as f64 / rate;
                }
            }
        }
    }
}

pub fn set_phase(phase: &str) {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.progress.phase = phase.to_string();
    }
}

pub fn set_total(total: usize) {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        // Start timer when setting total (for backwards compatibility)
        if state.start_time.is_none() {
            state.start_time = Some(Instant::now());
        }
        state.progress.total = total;
        state.progress.current = 0;
        state.progress.current_file = String::new();
        state.progress.covers_found = 0;
        state.progress.phase = "processing".to_string();
    }
}

pub fn increment() {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.progress.current += 1;
    }
}

pub fn increment_covers() {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.progress.covers_found += 1;
    }
}

pub fn get_progress() -> ScanProgress {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        // Update elapsed time on every get
        if let Some(start) = state.start_time {
            state.progress.elapsed_secs = start.elapsed().as_secs_f64();
        }
        state.progress.clone()
    } else {
        ScanProgress::default()
    }
}

pub fn reset_progress() {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.progress = ScanProgress::default();
        state.start_time = None;
    }
}

/// Record an error during processing
pub fn record_error(item: &str, error: &str, error_type: &str) {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.progress.error_count += 1;

        let err = ProcessingError {
            item: item.to_string(),
            error: error.to_string(),
            error_type: error_type.to_string(),
        };

        // Keep only last 10 errors
        if state.progress.recent_errors.len() >= 10 {
            state.progress.recent_errors.remove(0);
        }
        state.progress.recent_errors.push(err);
    }
}

/// Record a skipped item
pub fn record_skip() {
    if let Ok(mut state) = PROGRESS_STATE.lock() {
        state.progress.skipped_count += 1;
    }
}

/// Get current error count
pub fn get_error_count() -> usize {
    PROGRESS_STATE.lock().ok().map(|s| s.progress.error_count).unwrap_or(0)
}