// src-tauri/src/progress.rs
// WITH cover tracking

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
    pub covers_found: usize,
    pub phase: String,
}

impl Default for ScanProgress {
    fn default() -> Self {
        Self {
            current: 0,
            total: 0,
            current_file: String::new(),
            covers_found: 0,
            phase: "idle".to_string(),
        }
    }
}

static SCAN_PROGRESS: Lazy<Mutex<ScanProgress>> = Lazy::new(|| {
    Mutex::new(ScanProgress::default())
});

pub fn update_progress(current: usize, total: usize, current_file: &str) {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.current = current;
    progress.total = total;
    progress.current_file = current_file.to_string();
    progress.phase = "processing".to_string();
}

pub fn update_progress_with_covers(current: usize, total: usize, current_file: &str, covers: usize) {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.current = current;
    progress.total = total;
    progress.current_file = current_file.to_string();
    progress.covers_found = covers;
    progress.phase = "processing".to_string();
}

pub fn set_phase(phase: &str) {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.phase = phase.to_string();
}

pub fn set_total(total: usize) {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.total = total;
    progress.current = 0;
    progress.current_file = String::new();
    progress.covers_found = 0;
    progress.phase = "processing".to_string();
}

pub fn increment() {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.current += 1;
}

pub fn increment_covers() {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.covers_found += 1;
}

pub fn get_progress() -> ScanProgress {
    SCAN_PROGRESS.lock().unwrap().clone()
}

pub fn reset_progress() {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    *progress = ScanProgress::default();
}