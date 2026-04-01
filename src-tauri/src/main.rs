#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// =============================================================================
// Genre & Tag Manager - Simplified AudiobookShelf Metadata Tool
// =============================================================================

// Core modules (required)
mod config;
mod cache;
mod progress;
mod scanner;
mod tags;
mod metadata;
mod genres;
mod genre_cache;
mod commands;
mod normalize;
mod abs_search;
mod abs_cache;
mod custom_providers;
mod series;
mod pipeline;
mod validation;
mod title_resolver;
mod series_resolver;
mod age_rating_resolver;
mod book_dna;
mod gpt_consolidated;
mod ollama_manager;

// Immersion Sync / Alignment
mod epub;
mod alignment;

// Kept for compatibility but may be removed later
mod audible;
mod audible_auth;
mod file_rename;
mod tag_inspector;
mod cover_art;
mod chapters;
mod folder_fixer;
mod smart_rename;
mod whisper;
mod duplicate_finder;
mod converter;

fn main() {
    // Initialize state for alignment
    let alignment_state = commands::alignment::AlignmentState::new();

    // Initialize scan cancellation state
    let scan_cancellation = std::sync::Arc::new(commands::series_analysis::ScanCancellation::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(alignment_state)
        .manage(scan_cancellation)
        .setup(|_app| {
            // #[cfg(debug_assertions)]
            // _app.get_webview_window("main").unwrap().open_devtools();

            // Auto-start bundled Ollama if local AI is enabled
            if let Ok(config) = crate::config::load_config() {
                if config.use_local_ai {
                    std::thread::spawn(|| {
                        let rt = tokio::runtime::Runtime::new().unwrap();
                        rt.block_on(async {
                            if let Err(e) = ollama_manager::start().await {
                                eprintln!("Failed to auto-start Ollama: {}", e);
                            }
                        });
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // =====================================================
            // CORE: Configuration
            // =====================================================
            commands::config::get_config,
            commands::config::save_config,

            // =====================================================
            // CORE: ABS Integration (import, push, maintenance)
            // =====================================================
            commands::abs::test_abs_connection,
            commands::abs::import_from_abs,
            commands::abs::rescan_abs_imports,
            commands::abs::push_abs_imports,
            commands::abs::push_abs_updates,
            commands::abs::force_abs_rescan,
            commands::abs::restart_abs_docker,
            commands::abs::clear_abs_cache,
            commands::abs::clear_abs_library_cache,
            commands::abs::get_abs_chapters,

            // =====================================================
            // CORE: Genre & Tag Management
            // =====================================================
            commands::genres::cleanup_genres,
            commands::genres::normalize_genres_local,
            commands::genres::normalize_tags_local,
            commands::genres::get_approved_genres,
            commands::genres::get_approved_tags,
            commands::genres::map_single_tag,
            commands::genres::get_tags_by_category,
            commands::genres::cleanup_genres_with_gpt,
            commands::genres::assign_tags_with_gpt,
            commands::genres::assign_tags_single,
            commands::genres::fix_descriptions_with_gpt,
            commands::genres::fix_subtitles_batch,
            commands::genres::fix_authors_batch,
            commands::genres::fix_years_batch,

            // =====================================================
            // CORE: Maintenance (ABS-level genre operations)
            // =====================================================
            commands::maintenance::clear_cache,
            commands::maintenance::get_cache_stats,
            commands::maintenance::normalize_genres,
            commands::maintenance::clear_all_genres,
            commands::maintenance::get_genre_stats,
            commands::maintenance::get_author_stats,
            commands::maintenance::fix_author_mismatches,

            // =====================================================
            // CORE: Validation (error scanning, author matching)
            // =====================================================
            commands::validation::scan_metadata_errors,
            commands::validation::analyze_authors,
            // Series analysis (comprehensive with API + GPT)
            commands::series_analysis::analyze_series_comprehensive,
            commands::series_analysis::apply_series_fixes,
            commands::series_analysis::cancel_series_scan,
            commands::series_analysis::reset_scan_cancellation,

            // =====================================================
            // CORE: ABS Cache (centralized library data)
            // =====================================================
            commands::abs_cache::refresh_abs_cache,
            commands::abs_cache::get_abs_cache_status,
            commands::abs_cache::get_cached_items,
            commands::abs_cache::get_cached_item,
            commands::abs_cache::get_cached_item_files,
            commands::abs_cache::get_cached_item_chapters,
            commands::abs_cache::clear_abs_full_cache,
            commands::abs_cache::invalidate_abs_cache,
            commands::abs_cache::search_cached_items,
            commands::abs_cache::get_unprocessed_abs_items,

            // =====================================================
            // CORE: Pipeline (metadata processing)
            // =====================================================
            commands::pipeline::process_with_pipeline,
            commands::pipeline::process_abs_item,
            commands::pipeline::preview_pipeline,
            commands::pipeline::run_all_enrichment,

            // =====================================================
            // CORE: Title Resolution (GPT-based cleanup)
            // =====================================================
            commands::title_resolver::resolve_title,
            commands::title_resolver::resolve_titles_batch_cmd,
            commands::title_resolver::quick_title_cleanup,
            commands::title_resolver::resolve_series,

            // =====================================================
            // CORE: Age Rating (GPT with web search)
            // =====================================================
            commands::age_rating::resolve_book_age_rating,
            commands::age_rating::resolve_age_ratings_batch,

            // =====================================================
            // CORE: ISBN/ASIN Lookup
            // =====================================================
            commands::isbn::lookup_book_isbn,
            commands::isbn::lookup_isbn_batch,

            // =====================================================
            // CORE: BookDNA (structured fingerprints)
            // =====================================================
            commands::gather::gather_external_data,
            commands::classify::classify_books_batch,
            commands::classify::resolve_metadata_batch,
            commands::classify::process_descriptions_batch,
            commands::book_dna::generate_book_dna,
            commands::book_dna::generate_book_dna_batch,
            commands::book_dna::get_dna_tags_from_tags,
            commands::book_dna::remove_dna_tags,
            commands::book_dna::migrate_dna_cache,

            // =====================================================
            // CORE: Custom Providers (Goodreads, Hardcover, etc.)
            // =====================================================
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

            // =====================================================
            // SCANNING: File/folder scanning
            // =====================================================
            commands::scan::scan_library,
            commands::scan::import_folders,
            commands::scan::cancel_scan,
            commands::scan::get_scan_progress,
            commands::scan::rescan_fields,

            // =====================================================
            // TAGS: File tag operations (for local files)
            // =====================================================
            commands::tags::write_tags,
            commands::tags::inspect_file_tags,
            commands::tags::get_undo_status,
            commands::tags::undo_last_write,
            commands::tags::clear_undo_state,

            // =====================================================
            // EXPORT/IMPORT: CSV/JSON operations
            // =====================================================
            commands::export::export_to_csv,
            commands::export::export_to_json,
            commands::export::import_from_csv,
            commands::export::import_from_json,

            // =====================================================
            // KEPT FOR COMPATIBILITY (may be removed)
            // =====================================================
            commands::rename::preview_rename,
            commands::rename::rename_files,
            commands::rename::get_rename_templates,
            commands::audible::login_to_audible,
            commands::audible::check_audible_installed,
            commands::covers::get_cover_for_group,
            commands::covers::search_cover_options,
            commands::covers::search_covers_multi_source,
            commands::covers::download_cover_from_url,
            commands::covers::set_cover_from_file,
            commands::covers::read_image_file,
            commands::covers::set_cover_from_data,
            commands::covers::proxy_image,
            commands::bulk_covers::bulk_search_covers,
            commands::bulk_covers::bulk_download_selected_covers,
            commands::bulk_covers::bulk_download_covers,
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
            commands::folder_fixer::analyze_folders,
            commands::folder_fixer::apply_fixes,
            commands::folder_fixer::detect_chapter_folders,
            commands::folder_fixer::merge_chapter_folders,
            commands::folder_fixer::preview_organization,
            commands::folder_fixer::reorganize_to_abs_structure,
            commands::folder_fixer::restructure_library,
            commands::smart_rename::analyze_smart_rename,
            commands::smart_rename::apply_smart_renames,
            commands::duplicates::scan_for_duplicates,
            commands::duplicates::get_duplicate_details,
            commands::duplicates::delete_duplicate,
            commands::duplicates::move_duplicate_to_trash,
            commands::converter::check_ffmpeg_available,
            commands::converter::analyze_for_conversion,
            commands::converter::estimate_output_size,
            commands::converter::convert_to_m4b,
            commands::converter::cancel_conversion,
            commands::converter::delete_source_files_after_conversion,
            commands::converter::get_quality_presets,
            commands::converter::get_speed_presets,

            // =====================================================
            // IMMERSION SYNC: Audio-Text Alignment
            // =====================================================
            commands::alignment::preview_epub_file,
            commands::alignment::parse_epub_file,
            commands::alignment::check_aeneas_available,
            commands::alignment::get_alignment_status,
            commands::alignment::queue_alignment,
            commands::alignment::queue_alignment_batch,
            commands::alignment::get_alignment_jobs,
            commands::alignment::get_alignment_job,
            commands::alignment::cancel_alignment_job,
            commands::alignment::retry_alignment_job,
            commands::alignment::clear_completed_jobs,
            commands::alignment::get_book_alignment,
            commands::alignment::has_alignment,
            commands::alignment::export_alignment_vtt,
            commands::alignment::export_alignment_srt,
            commands::alignment::delete_book_alignment,
            commands::alignment::align_local_files,
            commands::alignment::scan_library_for_alignment,

            // =====================================================
            // AUTHORS: Author-focused ABS operations
            // =====================================================
            commands::authors::get_abs_authors,
            commands::authors::get_abs_author_detail,
            commands::authors::analyze_authors_from_abs,
            commands::authors::rename_abs_author,
            commands::authors::merge_abs_authors,
            commands::authors::get_abs_author_image,
            commands::authors::fix_author_descriptions_gpt,
            commands::authors::push_author_changes_to_abs,

            // =====================================================
            // LOCAL AI: Bundled Ollama Management
            // =====================================================
            commands::ollama::ollama_get_status,
            commands::ollama::ollama_get_model_presets,
            commands::ollama::ollama_install,
            commands::ollama::ollama_cancel_install,
            commands::ollama::ollama_uninstall,
            commands::ollama::ollama_start,
            commands::ollama::ollama_stop,
            commands::ollama::ollama_pull_model,
            commands::ollama::ollama_delete_model,
            commands::ollama::ollama_get_disk_usage,
            commands::ollama::ollama_enable,
            commands::ollama::ollama_disable,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}