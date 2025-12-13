// src-tauri/src/commands/smart_rename.rs
// Tauri commands for AI-powered smart rename

use crate::config::Config;
use crate::smart_rename::{
    SmartRenameAnalysis, SmartRenameResult, FileRenameProposal, FolderRenameProposal,
    AnalysisOptions,
};

/// Analyze a folder for smart renaming
#[tauri::command]
pub async fn analyze_smart_rename(
    path: String,
    include_subfolders: bool,
    enable_transcription: Option<bool>,
    force_analysis: Option<bool>,
) -> Result<SmartRenameAnalysis, String> {
    println!("AI Smart Rename: Starting analysis of {}", path);

    let config = Config::load().map_err(|e| format!("Config error: {}", e))?;
    let api_key = config.openai_api_key
        .ok_or("OpenAI API key not configured. Please add your API key in Settings.")?;

    let options = AnalysisOptions {
        include_subfolders,
        infer_chapters: true,
        target_structure: "audiobookshelf".to_string(),
        enable_transcription: enable_transcription.unwrap_or(false),
        force_analysis: force_analysis.unwrap_or(false),
    };

    crate::smart_rename::analyze_for_smart_rename(&path, &api_key, &options)
        .await
        .map_err(|e| e.to_string())
}

/// Apply selected smart renames
#[tauri::command]
pub async fn apply_smart_renames(
    file_proposals: Vec<FileRenameProposal>,
    folder_proposals: Vec<FolderRenameProposal>,
    create_backup: bool,
) -> Result<SmartRenameResult, String> {
    let selected_files: Vec<_> = file_proposals.into_iter()
        .filter(|p| p.selected)
        .collect();
    let selected_folders: Vec<_> = folder_proposals.into_iter()
        .filter(|p| p.selected)
        .collect();

    println!("AI Smart Rename: Applying {} file renames, {} folder moves",
        selected_files.len(),
        selected_folders.len()
    );

    crate::smart_rename::apply_smart_renames(
        selected_files,
        selected_folders,
        create_backup,
    )
    .await
    .map_err(|e| e.to_string())
}
