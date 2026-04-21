// src-tauri/src/whisper_local.rs
// Local whisper.cpp manager - download binary + models, transcribe locally
// Follows the same pattern as ollama.rs

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const WHISPER_VERSION: &str = "1.8.4";

#[derive(Debug, Clone, Serialize)]
pub struct WhisperModelPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub filename: &'static str,
    pub size_mb: u32,
    pub description: &'static str,
}

pub const WHISPER_MODEL_PRESETS: &[WhisperModelPreset] = &[
    WhisperModelPreset { id: "base",     label: "Base (Recommended)",  filename: "ggml-base.bin",     size_mb: 148,  description: "Good accuracy, fast. Best for most audiobooks." },
    WhisperModelPreset { id: "small",    label: "Small (Better)",      filename: "ggml-small.bin",    size_mb: 488,  description: "Better accuracy, slower. Good for unclear audio." },
    WhisperModelPreset { id: "base.en",  label: "Base English-only",   filename: "ggml-base.en.bin",  size_mb: 148,  description: "English-only, slightly better for English content." },
    WhisperModelPreset { id: "tiny",     label: "Tiny (Fastest)",      filename: "ggml-tiny.bin",     size_mb: 78,   description: "Fastest, lower accuracy. Quick checks." },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperLocalStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub models: Vec<WhisperLocalModel>,
    pub active_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperLocalModel {
    pub id: String,
    pub filename: String,
    pub size_bytes: u64,
}

// ---- Paths ----

fn whisper_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot find app data directory")?;
    Ok(base.join("Audiobook Tagger").join("whisper"))
}

fn whisper_models_dir() -> Result<PathBuf, String> {
    Ok(whisper_dir()?.join("models"))
}

fn bundled_binary_path() -> Result<PathBuf, String> {
    let dir = whisper_dir()?;
    #[cfg(target_os = "windows")]
    { Ok(dir.join("whisper-cpp.exe")) }
    #[cfg(not(target_os = "windows"))]
    { Ok(dir.join("whisper-cpp")) }
}

fn bundled_ffmpeg_path() -> Result<PathBuf, String> {
    let dir = whisper_dir()?;
    #[cfg(target_os = "windows")]
    { Ok(dir.join("ffmpeg.exe")) }
    #[cfg(not(target_os = "windows"))]
    { Ok(dir.join("ffmpeg")) }
}

/// Find ffmpeg: bundled first, then common system paths, then PATH.
/// GUI apps on macOS don't inherit shell PATH, so /opt/homebrew/bin isn't visible.
pub fn find_ffmpeg_binary() -> Option<PathBuf> {
    if let Ok(bundled) = bundled_ffmpeg_path() {
        if bundled.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&bundled) {
                    if meta.permissions().mode() & 0o111 != 0 && meta.len() > 1000 {
                        return Some(bundled);
                    }
                }
            }
            #[cfg(windows)]
            return Some(bundled);
        }
    }

    #[cfg(target_os = "macos")]
    for name in &[
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ] {
        let p = PathBuf::from(name);
        if p.exists() { return Some(p); }
    }

    #[cfg(target_os = "linux")]
    for name in &["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        let p = PathBuf::from(name);
        if p.exists() { return Some(p); }
    }

    #[cfg(unix)]
    {
        if let Ok(output) = std::process::Command::new("which").arg("ffmpeg").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() { return Some(PathBuf::from(path)); }
            }
        }
    }

    #[cfg(windows)]
    {
        if let Ok(output) = std::process::Command::new("where").arg("ffmpeg").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("").trim().to_string();
                if !path.is_empty() { return Some(PathBuf::from(path)); }
            }
        }
    }

    None
}

/// Find whisper binary: bundled first, then system PATH
/// Brew installs it as "whisper-cli", older versions as "whisper-cpp"
fn find_whisper_binary() -> Option<PathBuf> {
    // Check bundled location first
    if let Ok(bundled) = bundled_binary_path() {
        if bundled.exists() {
            // Verify it's actually an executable, not a corrupt file
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&bundled) {
                    if meta.permissions().mode() & 0o111 != 0 && meta.len() > 1000 {
                        return Some(bundled);
                    }
                }
            }
            #[cfg(windows)]
            return Some(bundled);
        }
    }

    // Check common system paths (brew installs as whisper-cli)
    #[cfg(target_os = "macos")]
    for name in &[
        "/opt/homebrew/bin/whisper-cli",
        "/opt/homebrew/bin/whisper-cpp",
        "/usr/local/bin/whisper-cli",
        "/usr/local/bin/whisper-cpp",
    ] {
        let p = PathBuf::from(name);
        if p.exists() { return Some(p); }
    }

    // Check PATH for both names
    #[cfg(unix)]
    for name in &["whisper-cli", "whisper-cpp"] {
        if let Ok(output) = std::process::Command::new("which").arg(name).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() { return Some(PathBuf::from(path)); }
            }
        }
    }

    #[cfg(windows)]
    for name in &["whisper-cli", "whisper-cpp", "whisper-cli.exe", "whisper-cpp.exe"] {
        if let Ok(output) = std::process::Command::new("where").arg(name).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("").trim().to_string();
                if !path.is_empty() { return Some(PathBuf::from(path)); }
            }
        }
    }

    None
}

/// List downloaded models
fn list_models() -> Vec<WhisperLocalModel> {
    let dir = match whisper_models_dir() {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    if !dir.exists() { return vec![]; }

    let mut models = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("ggml-") && name.ends_with(".bin") {
                    let id = name.trim_start_matches("ggml-").trim_end_matches(".bin").to_string();
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    models.push(WhisperLocalModel { id, filename: name.to_string(), size_bytes: size });
                }
            }
        }
    }
    models
}

/// Get the download URL for whisper-cpp binary for this platform
fn get_binary_download_url() -> Result<(&'static str, &'static str), String> {
    // Returns (url, archive_type)
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Ok(("https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-v1.8.4-xcframework.zip", "xcframework"));

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Ok(("https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip", "zip"));

    #[cfg(all(target_os = "windows", target_arch = "x86"))]
    return Ok(("https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-Win32.zip", "zip"));

    // For macOS Intel and Linux, try brew or build from source
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Ok(("brew", "brew"));

    #[cfg(target_os = "linux")]
    return Ok(("brew", "brew")); // Placeholder - will try system package manager

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

// ---- Tauri commands ----

#[tauri::command]
pub async fn whisper_local_get_status() -> Result<WhisperLocalStatus, String> {
    let binary = find_whisper_binary();
    let models = list_models();
    Ok(WhisperLocalStatus {
        installed: binary.is_some(),
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        models,
        active_model: None,
    })
}

#[tauri::command]
pub fn whisper_local_get_model_presets() -> Vec<WhisperModelPreset> {
    WHISPER_MODEL_PRESETS.to_vec()
}

#[tauri::command]
pub async fn whisper_local_install(window: tauri::Window) -> Result<String, String> {
    use tauri::Emitter;

    // Ensure ffmpeg is available (bundled or system). Download if missing.
    if find_ffmpeg_binary().is_none() {
        let _ = window.emit("whisper_install_progress", serde_json::json!({
            "stage": "downloading", "status": "Downloading FFmpeg...",
        }));
        if let Err(e) = install_ffmpeg(&window).await {
            return Err(format!("FFmpeg install failed: {}. Install manually with 'brew install ffmpeg' (macOS) or download from ffmpeg.org.", e));
        }
    }

    if find_whisper_binary().is_some() {
        return Ok("whisper-cpp is already installed".to_string());
    }

    let dir = whisper_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Dir error: {}", e))?;

    let (url, archive_type) = get_binary_download_url()?;

    // macOS/Linux: try brew first (handles Metal acceleration, easy updates)
    if archive_type == "brew" {
        let _ = window.emit("whisper_install_progress", serde_json::json!({
            "stage": "installing", "status": "Installing whisper-cpp via Homebrew...",
        }));

        // Try brew
        if let Ok(output) = std::process::Command::new("brew").args(["install", "whisper-cpp"]).output() {
            if output.status.success() {
                let _ = window.emit("whisper_install_progress", serde_json::json!({
                    "stage": "complete", "status": "whisper-cpp installed via Homebrew",
                }));
                return Ok("whisper-cpp installed via Homebrew".to_string());
            }
        }

        // Brew failed - try downloading prebuilt for macOS ARM
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            let _ = window.emit("whisper_install_progress", serde_json::json!({
                "stage": "downloading", "status": "Homebrew not available, downloading binary...",
            }));
            return download_and_install_binary(
                "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-v1.8.4-xcframework.zip",
                &window,
            ).await;
        }

        return Err("Could not install whisper-cpp. Install Homebrew (https://brew.sh) and try again, or install manually.".to_string());
    }

    // Windows: download prebuilt binary
    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "downloading", "status": "Downloading whisper-cpp...",
    }));

    download_and_install_binary(url, &window).await
}

/// Download and install a static ffmpeg binary into `whisper_dir()`.
/// macOS: evermeet.cx (universal). Windows: gyan.dev essentials build.
async fn install_ffmpeg(window: &tauri::Window) -> Result<String, String> {
    use tauri::Emitter;

    let dir = whisper_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Dir error: {}", e))?;

    #[cfg(target_os = "macos")]
    let url = "https://evermeet.cx/ffmpeg/getrelease/zip";
    #[cfg(target_os = "windows")]
    let url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
    #[cfg(target_os = "linux")]
    let url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build().map_err(|e| format!("HTTP error: {}", e))?;

    let resp = client.get(url).send().await.map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("Read error: {}", e))?;

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "extracting", "status": "Extracting FFmpeg...",
    }));

    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp error: {}", e))?;
    let target_path = bundled_ffmpeg_path()?;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let archive_path = temp_dir.path().join("ffmpeg.zip");
        std::fs::write(&archive_path, &bytes).map_err(|e| format!("Write error: {}", e))?;

        let output = std::process::Command::new("unzip")
            .args(["-q", "-o"])
            .arg(archive_path.to_str().unwrap_or_default())
            .arg("-d")
            .arg(temp_dir.path().to_str().unwrap_or_default())
            .output()
            .map_err(|e| format!("Unzip error: {}. On Windows, ensure 'unzip' is available or use 7-Zip.", e))?;

        if !output.status.success() {
            return Err(format!("Unzip failed: {}", String::from_utf8_lossy(&output.stderr)));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let archive_path = temp_dir.path().join("ffmpeg.tar.xz");
        std::fs::write(&archive_path, &bytes).map_err(|e| format!("Write error: {}", e))?;
        let output = std::process::Command::new("tar")
            .args(["-xJf"])
            .arg(archive_path.to_str().unwrap_or_default())
            .arg("-C")
            .arg(temp_dir.path().to_str().unwrap_or_default())
            .output()
            .map_err(|e| format!("Tar error: {}", e))?;
        if !output.status.success() {
            return Err(format!("Tar failed: {}", String::from_utf8_lossy(&output.stderr)));
        }
    }

    // Walk the extracted tree to find the ffmpeg binary
    let mut found: Option<PathBuf> = None;
    for entry in walkdir::WalkDir::new(temp_dir.path()).max_depth(5) {
        if let Ok(e) = entry {
            if let Some(name) = e.file_name().to_str() {
                let is_ffmpeg = name == "ffmpeg" || name == "ffmpeg.exe";
                if is_ffmpeg && e.file_type().is_file() {
                    found = Some(e.path().to_path_buf());
                    break;
                }
            }
        }
    }

    let source = found.ok_or("Could not find ffmpeg binary in downloaded archive")?;
    std::fs::copy(&source, &target_path).map_err(|e| format!("Copy error: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Permission error: {}", e))?;
    }

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "ffmpeg_done", "status": "FFmpeg installed",
    }));

    Ok("FFmpeg installed".to_string())
}

async fn download_and_install_binary(url: &str, window: &tauri::Window) -> Result<String, String> {
    use tauri::Emitter;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build().map_err(|e| format!("HTTP error: {}", e))?;

    let resp = client.get(url).send().await.map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("Read error: {}", e))?;

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "extracting", "status": "Extracting binary...",
    }));

    let dir = whisper_dir()?;
    let binary_path = bundled_binary_path()?;

    // Extract from zip
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp error: {}", e))?;
    let zip_path = temp_dir.path().join("whisper.zip");
    std::fs::write(&zip_path, &bytes).map_err(|e| format!("Write error: {}", e))?;

    let output = std::process::Command::new("unzip")
        .args(["-q", "-o"])
        .arg(zip_path.to_str().unwrap_or_default())
        .arg("-d")
        .arg(temp_dir.path().to_str().unwrap_or_default())
        .output()
        .map_err(|e| format!("Unzip error: {}", e))?;

    if !output.status.success() {
        return Err(format!("Unzip failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    // Find the whisper-cli or whisper-cpp binary in the extracted files
    let mut found_binary = None;
    for name in &["whisper-cli", "whisper-cpp", "whisper", "main"] {
        let candidates = [
            temp_dir.path().join(name),
            temp_dir.path().join(format!("{}.exe", name)),
            temp_dir.path().join("build").join("bin").join(name),
        ];
        for candidate in &candidates {
            if candidate.exists() {
                found_binary = Some(candidate.clone());
                break;
            }
        }
        if found_binary.is_some() { break; }
    }

    // Walk the extracted directory to find any executable named whisper*
    if found_binary.is_none() {
        for entry in walkdir::WalkDir::new(temp_dir.path()).max_depth(4) {
            if let Ok(e) = entry {
                if let Some(name) = e.file_name().to_str() {
                    if (name.starts_with("whisper") || name == "main" || name == "main.exe")
                        && e.file_type().is_file()
                    {
                        found_binary = Some(e.path().to_path_buf());
                        break;
                    }
                }
            }
        }
    }

    let source = found_binary.ok_or("Could not find whisper binary in downloaded archive")?;
    std::fs::copy(&source, &binary_path).map_err(|e| format!("Copy error: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Permission error: {}", e))?;
    }

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "complete", "status": "whisper-cpp installed",
    }));

    Ok("whisper-cpp installed successfully".to_string())
}

#[tauri::command]
pub async fn whisper_local_download_model(
    model_id: String,
    window: tauri::Window,
) -> Result<String, String> {
    use tauri::Emitter;

    let preset = WHISPER_MODEL_PRESETS.iter()
        .find(|p| p.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let models_dir = whisper_models_dir()?;
    std::fs::create_dir_all(&models_dir).map_err(|e| format!("Dir error: {}", e))?;

    let model_path = models_dir.join(preset.filename);
    if model_path.exists() {
        return Ok(format!("Model {} already downloaded", model_id));
    }

    let url = format!("{}/{}", MODEL_BASE_URL, preset.filename);
    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "downloading",
        "status": format!("Downloading {} ({}MB)...", preset.label, preset.size_mb),
    }));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build().map_err(|e| format!("HTTP error: {}", e))?;

    let resp = client.get(&url).send().await.map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = std::fs::File::create(&model_path).map_err(|e| format!("File error: {}", e))?;

    use futures::StreamExt;
    use std::io::Write;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        file.write_all(&chunk).map_err(|e| format!("Write error: {}", e))?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let pct = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            let _ = window.emit("whisper_install_progress", serde_json::json!({
                "stage": "downloading",
                "status": format!("Downloading {}: {}%", preset.label, pct),
                "percent": pct,
                "downloaded": downloaded,
                "total": total_size,
            }));
        }
    }

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "complete",
        "status": format!("{} model downloaded", preset.label),
    }));

    Ok(format!("Model {} downloaded ({} MB)", model_id, preset.size_mb))
}

#[tauri::command]
pub async fn whisper_local_delete_model(model_id: String) -> Result<String, String> {
    let models_dir = whisper_models_dir()?;
    let filename = format!("ggml-{}.bin", model_id);
    let path = models_dir.join(&filename);

    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Delete error: {}", e))?;
        Ok(format!("Deleted model {}", model_id))
    } else {
        Err(format!("Model file not found: {}", filename))
    }
}

/// Uninstall whisper-cpp: remove bundled binary and all downloaded models
#[tauri::command]
pub async fn whisper_local_uninstall() -> Result<String, String> {
    let dir = whisper_dir()?;

    // Remove bundled binary
    if let Ok(binary) = bundled_binary_path() {
        if binary.exists() {
            let _ = std::fs::remove_file(&binary);
        }
    }

    // Remove all models
    if let Ok(models_dir) = whisper_models_dir() {
        if models_dir.exists() {
            let _ = std::fs::remove_dir_all(&models_dir);
        }
    }

    // Remove the whisper directory itself if empty
    if dir.exists() {
        let _ = std::fs::remove_dir(&dir);
    }

    Ok("Local Whisper removed".to_string())
}

#[tauri::command]
pub fn whisper_local_get_disk_usage() -> Result<u64, String> {
    let dir = whisper_dir()?;
    if !dir.exists() { return Ok(0); }

    let mut total = 0u64;
    for entry in walkdir::WalkDir::new(&dir) {
        if let Ok(e) = entry {
            if e.file_type().is_file() {
                total += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok(total)
}

// ---- Transcription ----

/// Run whisper-cpp locally on an audio file. Returns transcript text and detected language.
pub fn transcribe_local(
    audio_path: &str,
    model_id: &str,
) -> Result<(String, Option<String>), String> {
    let binary = find_whisper_binary()
        .ok_or("whisper-cpp not installed. Install it from Settings.")?;

    let models_dir = whisper_models_dir()?;
    let model_filename = format!("ggml-{}.bin", model_id);
    let model_path = models_dir.join(&model_filename);

    if !model_path.exists() {
        return Err(format!("Whisper model '{}' not downloaded. Download it from Settings.", model_id));
    }

    let mut cmd = std::process::Command::new(&binary);
    cmd.args([
        "-m", model_path.to_str().unwrap_or_default(),
        "-f", audio_path,
        "--no-timestamps",
        "-l", "auto",
    ]);

    // Set Metal resources path on macOS for GPU acceleration
    #[cfg(target_os = "macos")]
    {
        let brew_share = PathBuf::from("/opt/homebrew/share/whisper-cpp");
        if brew_share.exists() {
            cmd.env("GGML_METAL_PATH_RESOURCES", brew_share.to_str().unwrap_or_default());
        }
    }

    let output = cmd.output().map_err(|e| format!("whisper-cpp failed to run: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("whisper-cpp error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Extract language from stderr (whisper-cpp prints "auto-detected language: en")
    let language = stderr.lines()
        .find(|l| l.contains("auto-detected language:"))
        .and_then(|l| l.split(':').last())
        .map(|s| s.trim().to_string());

    // Transcript from stdout, or from .txt file whisper-cpp may create
    let transcript = if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        let txt_path = format!("{}.txt", audio_path);
        std::fs::read_to_string(&txt_path)
            .map(|s| { let _ = std::fs::remove_file(&txt_path); s.trim().to_string() })
            .unwrap_or_default()
    };

    if transcript.is_empty() {
        return Err("whisper-cpp produced no output".to_string());
    }

    Ok((transcript, language))
}
