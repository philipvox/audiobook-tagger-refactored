use notify_debouncer_full::{new_debouncer, notify::*};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tokio::sync::broadcast;
use std::collections::HashMap;

pub struct FolderWatcher {
    pub event_sender: broadcast::Sender<String>,
}

impl FolderWatcher {
    pub fn new() -> Self {
        let (event_sender, _) = broadcast::channel(100);
        Self { event_sender }
    }
    
    pub async fn start_watching(&self, folder_path: String) -> std::result::Result<(), String> {
        let event_sender = self.event_sender.clone();
        
        // Check if folder exists
        if !std::path::Path::new(&folder_path).exists() {
            return Err(format!("Watch folder does not exist: {}", folder_path));
        }
        
        println!("🔧 Starting folder watcher for: {}", folder_path);
        
        tokio::spawn(async move {
            if let Err(e) = Self::watch_folder(folder_path, event_sender).await {
                println!("❌ Folder watcher error: {}", e);
            }
        });
        
        Ok(())
    }
    
    async fn watch_folder(
        folder_path: String, 
        event_sender: broadcast::Sender<String>
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (tx, rx) = mpsc::channel();
        
        let mut debouncer = new_debouncer(
            Duration::from_secs(3),
            None,
            tx,
        )?;
        
        debouncer.watcher().watch(
            Path::new(&folder_path),
            RecursiveMode::Recursive,
        )?;
        
        println!("📁 Started watching folder: {}", folder_path);
        println!("🎯 Watching for new audiobook folders and files");
        
        // Track pending folders that might get audio files
        let mut pending_folders: HashMap<String, tokio::time::Instant> = HashMap::new();
        let base_path = Path::new(&folder_path);
        
        for result in rx {
            match result {
                Ok(events) => {
                    println!("📝 Received {} events", events.len());
                    
                    let mut immediate_folders = std::collections::HashSet::new();
                    
                    for event in events {
                        println!("🔍 Event kind: {:?}", event.kind);
                        
                        for path in &event.paths {
                            println!("   📂 Path: {}", path.display());
                            
                            // Skip events outside our watch folder
                            if !path.starts_with(&base_path) {
                                continue;
                            }
                            
                            if path.is_dir() {
                                println!("   📁 Folder detected");
                                
                                // Check if this is a direct subfolder of our watch directory
                                if let Ok(relative) = path.strip_prefix(&base_path) {
                                    let depth = relative.components().count();
                                    if depth == 1 {
                                        println!("   🆕 New top-level folder: {}", path.display());
                                        
                                        // Check immediately if it has audio files
                                        if has_audio_files(&path) {
                                            println!("   🎵 Already contains audio files!");
                                            immediate_folders.insert(path.to_string_lossy().to_string());
                                        } else {
                                            println!("   ⏳ Empty folder, adding to pending list");
                                            pending_folders.insert(
                                                path.to_string_lossy().to_string(), 
                                                tokio::time::Instant::now()
                                            );
                                        }
                                    }
                                }
                            } else if path.is_file() {
                                // Audio file added
                                if let Some(extension) = path.extension() {
                                    if let Some(ext_str) = extension.to_str() {
                                        let ext_lower = ext_str.to_lowercase();
                                        if ["m4b", "m4a", "mp3", "flac"].contains(&ext_lower.as_str()) {
                                            println!("   ✅ Audio file added: {}", ext_lower);
                                            
                                            if let Some(parent) = path.parent() {
                                                let folder_str = parent.to_string_lossy().to_string();
                                                
                                                // Remove from pending if it was there
                                                pending_folders.remove(&folder_str);
                                                immediate_folders.insert(folder_str);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    // Process immediate folders
                    for folder in immediate_folders {
                        println!("   📖 Triggering immediate scan for: {}", folder);
                        let _ = event_sender.send(folder);
                    }
                    
                    // Check pending folders (in case copy operation is slow)
                    let mut completed_folders = Vec::new();
                    let mut expired_folders = Vec::new();
                    
                    for (folder, added_time) in &pending_folders {
                        let elapsed = added_time.elapsed();
                        
                        if elapsed > Duration::from_secs(30) {
                            // Give up after 30 seconds
                            expired_folders.push(folder.clone());
                        } else if elapsed > Duration::from_secs(5) && has_audio_files(Path::new(folder)) {
                            // Check after 5 seconds if files appeared
                            println!("   ⏰ Pending folder now has audio files: {}", folder);
                            completed_folders.push(folder.clone());
                        }
                    }
                    
                    // Process completed folders
                    for folder in completed_folders {
                        pending_folders.remove(&folder);
                        println!("   📖 Triggering delayed scan for: {}", folder);
                        let _ = event_sender.send(folder);
                    }
                    
                    // Clean up expired folders
                    for folder in expired_folders {
                        pending_folders.remove(&folder);
                        println!("   ⌛ Folder expired without audio files: {}", folder);
                    }
                }
                Err(e) => println!("❌ Watch error: {:?}", e),
            }
        }
        
        Ok(())
    }
}

// Helper function to check if a folder contains audio files
fn has_audio_files(dir_path: &Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if let Some(ext_str) = ext.to_str() {
                        let ext_lower = ext_str.to_lowercase();
                        if ["m4b", "m4a", "mp3", "flac"].contains(&ext_lower.as_str()) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}