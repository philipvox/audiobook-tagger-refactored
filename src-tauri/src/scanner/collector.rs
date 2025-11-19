// src-tauri/src/scanner/collector.rs
use super::types::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::path::Path;
use walkdir::WalkDir;
use std::collections::HashMap;

const AUDIO_EXTENSIONS: &[&str] = &["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"];

pub async fn collect_and_group_files(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    
    let mut all_files = Vec::new();
    
    for path in paths {
        if let Some(ref flag) = cancel_flag {
            if flag.load(Ordering::SeqCst) {
                println!("Collection cancelled");
                return Ok(vec![]);
            }
        }
        
        let files = collect_audio_files_from_path(path)?;
        all_files.extend(files);
    }
    
    println!("📁 Collected {} audio files", all_files.len());
    
    let groups = group_files_by_book(all_files);
    
    Ok(groups)
}

fn collect_audio_files_from_path(path: &str) -> Result<Vec<RawFileData>, Box<dyn std::error::Error + Send + Sync>> {
    let mut files = Vec::new();
    
    for entry in WalkDir::new(path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        
        let path = entry.path();
        if let Some(ext) = path.extension() {
            if AUDIO_EXTENSIONS.contains(&ext.to_string_lossy().to_lowercase().as_str()) {
                let parent = path.parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
                    .to_string();
                
                files.push(RawFileData {
                    path: path.to_string_lossy().to_string(),
                    filename: path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    parent_dir: parent,
                });
            }
        }
    }
    
    Ok(files)
}

fn group_files_by_book(files: Vec<RawFileData>) -> Vec<BookGroup> {
    let mut groups: HashMap<String, Vec<RawFileData>> = HashMap::new();
    
    for file in files {
        groups.entry(file.parent_dir.clone())
            .or_insert_with(Vec::new)
            .push(file);
    }
    
    groups.into_iter()
        .map(|(parent_dir, mut files)| {
            files.sort_by(|a, b| a.filename.cmp(&b.filename));
            
            let group_name = Path::new(&parent_dir)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            
            let group_type = detect_group_type(&files);
            
            let audio_files: Vec<AudioFile> = files.iter()
                .map(|f| AudioFile {
                    id: uuid::Uuid::new_v4().to_string(),
                    path: f.path.clone(),
                    filename: f.filename.clone(),
                    changes: HashMap::new(),
                    status: "unchanged".to_string(),
                })
                .collect();
            
            BookGroup {
                id: uuid::Uuid::new_v4().to_string(),
                group_name: group_name.clone(),
                group_type,
                metadata: BookMetadata {
                    title: group_name,
                    author: "Unknown".to_string(),
                    subtitle: None,
                    narrator: None,
                    series: None,
                    sequence: None,
                    genres: vec![],
                    description: None,
                    publisher: None,
                    year: None,
                    isbn: None,
                },
                files: audio_files,
                total_changes: 0,
            }
        })
        .collect()
}

fn detect_group_type(files: &[RawFileData]) -> GroupType {
    if files.len() == 1 {
        GroupType::Single
    } else if files.iter().any(|f| {
        let lower = f.filename.to_lowercase();
        lower.contains("part") || lower.contains("disk") || lower.contains("cd")
    }) {
        GroupType::MultiPart
    } else {
        GroupType::Chapters
    }
}