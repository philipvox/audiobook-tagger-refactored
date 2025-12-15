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
mod folder_fixer;  // AI-powered folder organization
mod smart_rename;  // AI-powered smart rename
mod abs_search;  // AudiobookShelf search API client
mod custom_providers;  // Custom metadata providers (abs-agg: Goodreads, Hardcover, etc.)
mod whisper;     // OpenAI Whisper audio transcription
mod duplicate_finder;  // Find duplicate audiobooks in library
mod converter;         // MP3 to M4B conversion
mod series;            // Centralized series processing
mod pipeline;          // Metadata pipeline (Gather → Context → Decide → Validate)

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
            commands::scan::import_folders,
            commands::scan::cancel_scan,
            commands::scan::get_scan_progress,
            commands::scan::rescan_fields,
            commands::tags::write_tags,
            commands::tags::inspect_file_tags,
            commands::tags::get_undo_status,
            commands::tags::undo_last_write,
            commands::tags::clear_undo_state,
            commands::rename::preview_rename,
            commands::rename::rename_files,
            commands::rename::get_rename_templates,
            commands::abs::test_abs_connection,
            commands::abs::push_abs_updates,
            commands::abs::force_abs_rescan,
            commands::abs::restart_abs_docker,
            commands::abs::clear_abs_cache,
            commands::abs::import_from_abs,
            commands::abs::rescan_abs_imports,
            commands::abs::push_abs_imports,
            commands::maintenance::clear_cache,
            commands::maintenance::get_cache_stats,
            commands::maintenance::normalize_genres,
            commands::maintenance::clear_all_genres,
            commands::maintenance::get_genre_stats,
            commands::maintenance::get_author_stats,
            commands::maintenance::fix_author_mismatches,
            commands::audible::login_to_audible,
            commands::audible::check_audible_installed,
            commands::covers::get_cover_for_group,
            commands::covers::search_cover_options,
            commands::covers::search_covers_multi_source,
            commands::covers::download_cover_from_url,
            commands::covers::set_cover_from_file,
            commands::covers::read_image_file,
            commands::covers::set_cover_from_data,
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
            commands::chapters::restore_original_file,
            // Folder Fixer commands
            commands::folder_fixer::analyze_folders,
            commands::folder_fixer::apply_fixes,
            commands::folder_fixer::detect_chapter_folders,
            commands::folder_fixer::merge_chapter_folders,
            commands::folder_fixer::preview_organization,
            commands::folder_fixer::reorganize_to_abs_structure,
            commands::folder_fixer::restructure_library,
            // Smart Rename commands
            commands::smart_rename::analyze_smart_rename,
            commands::smart_rename::apply_smart_renames,
            // Duplicate Finder commands
            commands::duplicates::scan_for_duplicates,
            commands::duplicates::get_duplicate_details,
            commands::duplicates::delete_duplicate,
            commands::duplicates::move_duplicate_to_trash,
            // Genre cleanup commands
            commands::genres::cleanup_genres,
            commands::genres::normalize_genres_local,
            commands::genres::get_approved_genres,
            // Converter commands (MP3 to M4B)
            commands::converter::check_ffmpeg_available,
            commands::converter::analyze_for_conversion,
            commands::converter::estimate_output_size,
            commands::converter::convert_to_m4b,
            commands::converter::cancel_conversion,
            commands::converter::delete_source_files_after_conversion,
            commands::converter::get_quality_presets,
            commands::converter::get_speed_presets,
            // Custom Provider commands (abs-agg: Goodreads, Hardcover, etc.)
            commands::custom_providers::get_available_providers,
            commands::custom_providers::get_custom_providers,
            commands::custom_providers::set_custom_providers,
            commands::custom_providers::add_custom_provider,
            commands::custom_providers::remove_custom_provider,
            commands::custom_providers::toggle_provider,
            commands::custom_providers::test_provider,
            commands::custom_providers::search_all_custom_providers,
            commands::custom_providers::add_abs_agg_provider,
            commands::custom_providers::reset_providers_to_defaults,
            // Pipeline commands (new metadata processing architecture)
            commands::pipeline::process_with_pipeline,
            commands::pipeline::process_abs_item,
            commands::pipeline::preview_pipeline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}