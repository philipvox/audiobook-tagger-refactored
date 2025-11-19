// main.rs
// Simplified main entry point using modular command structure

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Core modules
mod config;
mod scanner;
mod tags;
mod genres;
mod genre_cache;
mod metadata;
mod processor;
mod audible;
mod cache;
mod progress;
mod tag_inspector;
mod audible_auth;
mod file_rename;

// Command modules
mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // Config commands
            commands::config::get_config,
            commands::config::save_config,
            
            // Scan commands
            commands::scan::scan_library,
            commands::scan::cancel_scan,
            commands::scan::get_scan_progress,
            
            // Tag commands
            commands::tags::write_tags,
            commands::tags::inspect_file_tags,
            
            // Rename commands
            commands::rename::preview_rename,
            commands::rename::rename_files,
            
            // AudiobookShelf commands
            commands::abs::test_abs_connection,
            commands::abs::push_abs_updates,
            commands::abs::restart_abs_docker,
            commands::abs::force_abs_rescan,
            commands::abs::clear_abs_cache,
            
            // Maintenance commands
            commands::maintenance::clear_cache,
            commands::maintenance::clear_all_genres,
            commands::maintenance::normalize_genres,
            
            // Audible commands
            commands::audible::login_to_audible,
            commands::audible::check_audible_installed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
