// src-tauri/src/commands/folder_fixer.rs
// Tauri commands for folder organization

use crate::config::Config;
use crate::folder_fixer::{
    self, FolderAnalysis, ProposedMove, FixResult, DetectedBook,
};

/// Analyze folder structure and detect issues
#[tauri::command]
pub async fn analyze_folders(path: String) -> Result<FolderAnalysis, String> {
    println!("🔍 Folder Fixer: Analyzing {}", path);

    // Load config for API key
    let config = Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    folder_fixer::analyze_folder_structure(&path, config.openai_api_key.as_deref())
        .await
        .map_err(|e| format!("Analysis failed: {}", e))
}

/// Apply selected folder fixes
#[tauri::command]
pub async fn apply_fixes(
    changes: Vec<ProposedMove>,
    root_path: String,
    create_backup: bool,
) -> Result<FixResult, String> {
    println!("🔧 Folder Fixer: Applying {} changes", changes.len());

    folder_fixer::apply_folder_fixes(changes, &root_path, create_backup)
        .await
        .map_err(|e| format!("Fix failed: {}", e))
}

/// Quick analysis - just detect chapter subfolders without GPT
#[tauri::command]
pub async fn detect_chapter_folders(path: String) -> Result<Vec<String>, String> {
    use std::path::Path;
    use walkdir::WalkDir;
    use crate::scanner::collector::is_chapter_folder;

    let mut chapter_folders = Vec::new();

    for entry in WalkDir::new(&path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_dir())
    {
        let folder_name = entry.file_name().to_string_lossy().to_string();

        if is_chapter_folder(&folder_name) {
            chapter_folders.push(entry.path().to_string_lossy().to_string());
        }
    }

    println!("   Found {} chapter folders", chapter_folders.len());
    Ok(chapter_folders)
}

/// Merge all files from chapter subfolders into parent folders
#[tauri::command]
pub async fn merge_chapter_folders(paths: Vec<String>) -> Result<MergeResult, String> {
    use std::fs;
    use std::path::Path;

    let mut result = MergeResult {
        merged_count: 0,
        files_moved: 0,
        errors: Vec::new(),
    };

    for folder_path in paths {
        let path = Path::new(&folder_path);

        if let Some(parent) = path.parent() {
            // Move all files to parent
            match fs::read_dir(&folder_path) {
                Ok(entries) => {
                    for entry in entries.filter_map(|e| e.ok()) {
                        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                            let dest = parent.join(entry.file_name());

                            if !dest.exists() {
                                // Try rename first, fall back to copy+delete for cross-device
                                let move_result = fs::rename(entry.path(), &dest)
                                    .or_else(|_| {
                                        fs::copy(entry.path(), &dest)?;
                                        fs::remove_file(entry.path())
                                    });

                                match move_result {
                                    Ok(_) => result.files_moved += 1,
                                    Err(e) => result.errors.push(format!(
                                        "Failed to move {:?}: {}",
                                        entry.file_name(),
                                        e
                                    )),
                                }
                            }
                        }
                    }

                    // Remove empty folder
                    if fs::read_dir(&folder_path)
                        .map(|mut e| e.next().is_none())
                        .unwrap_or(false)
                    {
                        let _ = fs::remove_dir(&folder_path);
                        result.merged_count += 1;
                    }
                }
                Err(e) => {
                    result.errors.push(format!("Failed to read {}: {}", folder_path, e));
                }
            }
        }
    }

    println!(
        "   ✅ Merged {} folders, moved {} files",
        result.merged_count, result.files_moved
    );

    Ok(result)
}

#[derive(serde::Serialize)]
pub struct MergeResult {
    pub merged_count: usize,
    pub files_moved: usize,
    pub errors: Vec<String>,
}

/// Preview what the organized structure would look like
#[tauri::command]
pub async fn preview_organization(
    path: String,
    detected_books: Vec<DetectedBook>,
) -> Result<Vec<OrganizationPreview>, String> {
    let mut previews = Vec::new();

    for book in detected_books {
        let dest_path = if let Some(ref series) = book.series {
            if let Some(ref seq) = book.sequence {
                format!("{}/{}/{} #{}", book.author, series, book.title, seq)
            } else {
                format!("{}/{}/{}", book.author, series, book.title)
            }
        } else {
            format!("{}/{}", book.author, book.title)
        };

        previews.push(OrganizationPreview {
            source: book.source_folder,
            destination: dest_path,
            title: book.title,
            author: book.author,
            series: book.series,
            file_count: book.files.len(),
        });
    }

    Ok(previews)
}

#[derive(serde::Serialize)]
pub struct OrganizationPreview {
    pub source: String,
    pub destination: String,
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub file_count: usize,
}

/// Reorganize books into proper ABS structure
#[tauri::command]
pub async fn reorganize_to_abs_structure(
    root_path: String,
    books: Vec<DetectedBook>,
    _create_backup: bool,
) -> Result<FixResult, String> {
    use std::fs;
    use std::path::Path;

    let mut result = FixResult {
        success: true,
        moves_completed: 0,
        moves_failed: 0,
        errors: Vec::new(),
        backup_path: None,
    };

    let root = Path::new(&root_path);

    for book in books {
        // Build destination path
        let dest_folder = if let Some(ref series) = book.series {
            root.join(&book.author).join(series).join(&book.title)
        } else {
            root.join(&book.author).join(&book.title)
        };

        // Create destination
        if let Err(e) = fs::create_dir_all(&dest_folder) {
            result.errors.push(format!("Failed to create {}: {}", dest_folder.display(), e));
            result.moves_failed += 1;
            continue;
        }

        // Move each file
        for file_path in &book.files {
            let source = Path::new(file_path);
            if let Some(file_name) = source.file_name() {
                let dest = dest_folder.join(file_name);

                if !dest.exists() {
                    // Try rename first, fall back to copy+delete for cross-device
                    let move_result = fs::rename(source, &dest)
                        .or_else(|_| {
                            fs::copy(source, &dest)?;
                            fs::remove_file(source)
                        });

                    match move_result {
                        Ok(_) => result.moves_completed += 1,
                        Err(e) => {
                            result.errors.push(format!("Failed to move {:?}: {}", file_name, e));
                            result.moves_failed += 1;
                        }
                    }
                }
            }
        }
    }

    // Clean up empty directories
    cleanup_empty_dirs(&root_path);

    result.success = result.moves_failed == 0;

    Ok(result)
}

fn cleanup_empty_dirs(root: &str) {
    use std::fs;
    use walkdir::WalkDir;

    let mut removed = true;
    while removed {
        removed = false;

        let dirs: Vec<_> = WalkDir::new(root)
            .min_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_dir())
            .map(|e| e.path().to_path_buf())
            .collect();

        for path in dirs {
            if let Ok(mut entries) = fs::read_dir(&path) {
                if entries.next().is_none() {
                    if fs::remove_dir(&path).is_ok() {
                        removed = true;
                    }
                }
            }
        }
    }
}

/// Analyze entire library for restructuring to Author/Series/Title format (FAST - parallel)
#[tauri::command]
pub async fn restructure_library(path: String) -> Result<FolderAnalysis, String> {
    println!("📚 Library Restructure: Analyzing {} (parallel mode)", path);

    // Load config for API key
    let config = Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    let api_key = config.openai_api_key
        .ok_or_else(|| "OpenAI API key not configured".to_string())?;

    folder_fixer::restructure_library(&path, &api_key)
        .await
        .map_err(|e| format!("Restructure analysis failed: {}", e))
}
