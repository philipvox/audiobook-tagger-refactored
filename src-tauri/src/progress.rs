// src-tauri/src/progress.rs - Complete replacement
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
}

impl ScanProgress {
    pub fn new(total: usize) -> Self {
        Self {
            current: 0,
            total,
            current_file: String::new(),
        }
    }

    pub fn update(&mut self, processed: usize, current_file: &str, _start_time: Instant, _completed: bool) {
        self.current = processed;
        self.current_file = current_file.to_string();
    }
}

static SCAN_PROGRESS: Lazy<Mutex<ScanProgress>> = Lazy::new(|| {
    Mutex::new(ScanProgress {
        current: 0,
        total: 0,
        current_file: String::new(),
    })
});

pub fn update_progress(current: usize, total: usize, current_file: &str) {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.current = current;
    progress.total = total;
    progress.current_file = current_file.to_string();
}

pub fn set_total(total: usize) {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.total = total;
    progress.current = 0;
    progress.current_file = String::new();
}

pub fn increment() {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.current += 1;
}

pub fn get_progress() -> ScanProgress {
    SCAN_PROGRESS.lock().unwrap().clone()
}

pub fn reset_progress() {
    let mut progress = SCAN_PROGRESS.lock().unwrap();
    progress.current = 0;
    progress.total = 0;
    progress.current_file = String::new();
}