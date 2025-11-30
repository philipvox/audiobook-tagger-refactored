#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod cache;
mod progress;
mod scanner;
mod tags;
mod metadata;
mod audible;
mod audible_auth;
mod genres;
mod genre_cache;
// mod processor;
mod file_rename;
mod tag_inspector;
mod commands;
mod cover_art;
mod normalize;  // Text normalization utilities
mod chapters;   // Chapter detection and splitting

// use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // #[cfg(debug_assertions)]
            // _app.get_webview_window("main").unwrap().open_devtools();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::save_config,
            commands::scan::scan_library,
            commands::scan::cancel_scan,
            commands::scan::get_scan_progress,
            commands::tags::write_tags,
            commands::tags::inspect_file_tags,
            commands::rename::preview_rename,
            commands::rename::rename_files,
            commands::rename::get_rename_templates,
            commands::abs::test_abs_connection,
            commands::abs::push_abs_updates,
            commands::abs::force_abs_rescan,
            commands::abs::restart_abs_docker,
            commands::abs::clear_abs_cache,
            commands::maintenance::clear_cache,
            commands::maintenance::normalize_genres,
            commands::maintenance::clear_all_genres,
            commands::audible::login_to_audible,
            commands::audible::check_audible_installed,
            commands::covers::get_cover_for_group,
            commands::covers::search_cover_options,
            commands::covers::search_covers_multi_source,
            commands::covers::download_cover_from_url,
            commands::covers::set_cover_from_file,
            commands::abs::clear_abs_library_cache,
            commands::export::export_to_csv,
            commands::export::export_to_json,
            commands::export::import_from_csv,
            commands::export::import_from_json,
            // Chapter commands
            commands::chapters::check_ffmpeg,
            commands::chapters::get_chapters,
            commands::chapters::detect_chapters_silence,
            commands::chapters::get_or_detect_chapters,
            commands::chapters::split_audiobook_chapters,
            commands::chapters::update_chapter_titles,
            commands::chapters::get_audio_duration,
            commands::chapters::create_chapters_from_files,
            commands::chapters::merge_chapters,
            commands::chapters::adjust_chapter_boundary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}