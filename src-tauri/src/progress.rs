use std::sync::{Arc, Mutex};
use std::time::Instant;
use lazy_static::lazy_static;

#[derive(Debug, Clone)]
pub struct ScanProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
}

impl ScanProgress {
    pub fn new(total: usize) -> Self {
        ScanProgress {
            current: 0,
            total,
            current_file: String::new(),
        }
    }
    
    pub fn update(&mut self, processed: usize, current_file: &str, _start_time: Instant, _completed: bool) {
        self.current = processed;
        self.current_file = current_file.to_string();
        
        // Update the global progress state too
        if let Ok(mut progress) = PROGRESS.lock() {
            progress.current = processed;
            progress.current_file = current_file.to_string();
        }
    }
}

lazy_static! {
    static ref PROGRESS: Arc<Mutex<ScanProgress>> = Arc::new(Mutex::new(ScanProgress {
        current: 0,
        total: 0,
        current_file: String::new(),
    }));
}

pub fn set_total_files(total: usize) {
    if let Ok(mut progress) = PROGRESS.lock() {
        progress.total = total;
        progress.current = 0;
    }
}

pub fn increment_progress(current_file: &str) {
    if let Ok(mut progress) = PROGRESS.lock() {
        progress.current += 1;
        progress.current_file = current_file.to_string();
    }
}

pub fn get_current_progress() -> usize {
    PROGRESS.lock().map(|p| p.current).unwrap_or(0)
}

pub fn get_total_files() -> usize {
    PROGRESS.lock().map(|p| p.total).unwrap_or(0)
}

pub fn get_current_file() -> String {
    PROGRESS.lock().map(|p| p.current_file.clone()).unwrap_or_default()
}

pub fn reset_progress() {
    if let Ok(mut progress) = PROGRESS.lock() {
        progress.current = 0;
        progress.total = 0;
        progress.current_file.clear();
    }
}