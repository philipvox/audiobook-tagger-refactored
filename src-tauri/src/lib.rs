mod scanner;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            scanner::scan_library,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Audiobook Tagger");
}
