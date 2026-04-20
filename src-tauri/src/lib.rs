mod scanner;
mod ollama;
mod whisper;
mod whisper_local;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            scanner::scan_library,
            ollama::ollama_get_status,
            ollama::ollama_get_model_presets,
            ollama::ollama_get_disk_usage,
            ollama::ollama_start,
            ollama::ollama_stop,
            ollama::ollama_install,
            ollama::ollama_uninstall,
            ollama::ollama_pull_model,
            ollama::ollama_delete_model,
            whisper::extract_audio_intro,
            whisper::batch_extract_audio_intros,
            whisper::cancel_audio_extraction,
            whisper_local::whisper_local_get_status,
            whisper_local::whisper_local_get_model_presets,
            whisper_local::whisper_local_install,
            whisper_local::whisper_local_download_model,
            whisper_local::whisper_local_delete_model,
            whisper_local::whisper_local_get_disk_usage,
            whisper_local::whisper_local_uninstall,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Ok(rt) = tokio::runtime::Runtime::new() {
                    let _ = rt.block_on(ollama::ollama_stop());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Audiobook Tagger");
}
