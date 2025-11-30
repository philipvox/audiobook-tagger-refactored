// commands/rename.rs
// File renaming and preview commands

use crate::{file_rename, scanner};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct RenamePreview {
    old_path: String,
    new_path: String,
    changed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RenameTemplate {
    pub id: String,
    pub name: String,
    pub file_template: String,
    pub folder_template: Option<String>,
}

/// Get available rename templates
#[tauri::command]
pub async fn get_rename_templates() -> Vec<RenameTemplate> {
    vec![
        RenameTemplate {
            id: "default".to_string(),
            name: "Standard".to_string(),
            file_template: "{author} - {[series #sequence] }{title}{ (year)}".to_string(),
            folder_template: None,
        },
        RenameTemplate {
            id: "simple".to_string(),
            name: "Simple".to_string(),
            file_template: "{author} - {title}".to_string(),
            folder_template: None,
        },
        RenameTemplate {
            id: "series-first".to_string(),
            name: "Series First".to_string(),
            file_template: "{[series #sequence] }{title} - {author}".to_string(),
            folder_template: None,
        },
        RenameTemplate {
            id: "audiobookshelf".to_string(),
            name: "AudiobookShelf".to_string(),
            file_template: "{author} - {series|title}{ #sequence}".to_string(),
            folder_template: Some("{author}/{series|title}".to_string()),
        },
        RenameTemplate {
            id: "plex".to_string(),
            name: "Plex Audiobooks".to_string(),
            file_template: "{title}{ - Part sequence}".to_string(),
            folder_template: Some("{author}/{title}{ (year)}".to_string()),
        },
    ]
}

#[tauri::command]
pub async fn preview_rename(
    file_path: String,
    metadata: scanner::BookMetadata,
    template: Option<String>,
) -> Result<RenamePreview, String> {
    use std::path::Path;

    let path = Path::new(&file_path);
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("m4b");

    let file_metadata = file_rename::BookMetadata {
        title: metadata.title.clone(),
        author: metadata.author.clone(),
        series: metadata.series.clone(),
        sequence: metadata.sequence.clone(),
        year: metadata.year.clone(),
        narrator: metadata.narrator.clone(),
    };

    let new_filename = match template {
        Some(t) => file_rename::generate_filename_with_template(&file_metadata, ext, &t),
        None => file_rename::generate_filename(&file_metadata, ext),
    };

    let new_path = path.with_file_name(&new_filename);

    Ok(RenamePreview {
        old_path: file_path.clone(),
        new_path: new_path.to_string_lossy().to_string(),
        changed: file_path != new_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn rename_files(
    files: Vec<(String, scanner::BookMetadata)>,
    template: Option<String>,
) -> Result<Vec<RenamePreview>, String> {
    let mut results = Vec::new();

    for (file_path, metadata) in files {
        let rename_meta = file_rename::BookMetadata {
            title: metadata.title.clone(),
            author: metadata.author.clone(),
            series: metadata.series.clone(),
            sequence: metadata.sequence.clone(),
            year: metadata.year.clone(),
            narrator: metadata.narrator.clone(),
        };

        match file_rename::rename_and_reorganize_file(
            &file_path,
            &rename_meta,
            false,
            None,
            template.as_deref(),
        ).await {
            Ok(result) => {
                results.push(RenamePreview {
                    old_path: result.old_path,
                    new_path: result.new_path,
                    changed: result.success,
                });
            }
            Err(e) => {
                return Err(format!("Failed to rename {}: {}", file_path, e));
            }
        }
    }

    Ok(results)
}
