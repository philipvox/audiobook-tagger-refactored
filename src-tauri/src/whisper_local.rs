// src-tauri/src/whisper_local.rs
// Local whisper.cpp manager - download binary + models, transcribe locally
// Follows the same pattern as ollama.rs

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

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

/// Get the download URL for whisper-cpp binary for this platform.
/// macOS and Linux install via Homebrew (see whisper_local_install); only
/// Windows fetches a prebuilt zip. The macOS xcframework download was removed
/// because those archives are static libraries, not a runnable CLI binary.
fn get_binary_download_url() -> Result<(&'static str, &'static str), String> {
    // Returns (url, archive_type)
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Ok(("https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip", "zip"));

    #[cfg(all(target_os = "windows", target_arch = "x86"))]
    return Ok(("https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-Win32.zip", "zip"));

    // macOS (both arches) and Linux go through the package manager path.
    #[cfg(target_os = "macos")]
    return Ok(("brew", "brew"));

    #[cfg(target_os = "linux")]
    return Ok(("brew", "brew"));

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

/// Resolve the Homebrew binary via absolute paths first (GUI apps don't inherit
/// the shell PATH), then fall back to a PATH lookup.
#[cfg(unix)]
fn find_brew() -> Option<PathBuf> {
    for candidate in &["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(output) = std::process::Command::new("which").arg("brew").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// True only if the file begins with a recognized executable magic number
/// (ELF, Mach-O thin/fat either endian, or Windows PE). Rejects headers,
/// dylibs' text stubs, and other non-runnable files picked up by a dir walk.
fn passes_executable_check(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut buf = [0u8; 4];
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    if f.read_exact(&mut buf).is_err() {
        return false;
    }
    if &buf == b"\x7FELF" {
        return true; // ELF (Linux)
    }
    let magic = u32::from_be_bytes(buf);
    // Mach-O thin (32/64) and fat, both byte orders.
    if matches!(
        magic,
        0xFEED_FACE | 0xFEED_FACF | 0xCEFA_EDFE | 0xCFFA_EDFE | 0xCAFE_BABE | 0xBEBA_FECA
    ) {
        return true;
    }
    &buf[..2] == b"MZ" // Windows PE
}

/// Extract a zip archive to `dest`, entirely in-process. Replaces shelling out
/// to `unzip`, which isn't reliably present on Windows and caused local
/// Whisper/FFmpeg installs to fail there (#56).
///
/// Zip-slip guard: each entry's path is resolved via `enclosed_name()`, which
/// returns `None` for absolute paths or paths whose `..` components would
/// resolve outside the archive root. Entries that fail this check are skipped
/// rather than aborting the whole extraction, so one unexpected entry can't
/// prevent installing the rest of an otherwise-trusted download.
///
/// On Unix, the executable bit (and other permission bits) stored in the
/// zip's unix mode is restored on the extracted file.
fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Zip open error: {}", e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Zip read error: {}", e))?;

    // Known limitation: symlink entries are flattened to regular files (copied
    // by content, not relinked); verified absent from the real ffmpeg/whisper
    // archives this app downloads.
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("Zip entry error: {}", e))?;

        let name = entry.name().to_string();
        let Some(rel_path) = entry.enclosed_name() else {
            // Zip-slip guard: unsafe path (absolute or escapes via ".."). These
            // are downloaded third-party archives, so an unsafe entry makes the
            // whole archive untrustworthy: fail closed instead of skipping it.
            return Err(format!("Zip entry has unsafe path, aborting extraction: {}", name));
        };

        let out_path = dest.join(&rel_path);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("Mkdir error: {}", e))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Mkdir error: {}", e))?;
        }

        let mut out_file =
            std::fs::File::create(&out_path).map_err(|e| format!("Extract write error: {}", e))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("Extract copy error: {}", e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                if mode & 0o777 != 0 {
                    // Mask to the rwx bits only; never propagate setuid/setgid/sticky
                    // bits from a downloaded archive.
                    let _ = std::fs::set_permissions(
                        &out_path,
                        std::fs::Permissions::from_mode(mode & 0o777),
                    );
                }
            }
        }
    }

    Ok(())
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

    // macOS/Linux: install via Homebrew (handles Metal acceleration, easy updates).
    if archive_type == "brew" {
        #[cfg(unix)]
        {
            if let Some(brew) = find_brew() {
                let _ = window.emit("whisper_install_progress", serde_json::json!({
                    "stage": "installing", "status": "Installing whisper-cpp via Homebrew...",
                }));
                if let Ok(output) = std::process::Command::new(&brew)
                    .args(["install", "whisper-cpp"])
                    .output()
                {
                    if output.status.success() {
                        let _ = window.emit("whisper_install_progress", serde_json::json!({
                            "stage": "complete", "status": "whisper-cpp installed via Homebrew",
                        }));
                        return Ok("whisper-cpp installed via Homebrew".to_string());
                    }
                }
            }
        }

        // Brew unavailable or the install failed. There is no reliable prebuilt
        // CLI binary to fall back to, so return an actionable message.
        #[cfg(target_os = "macos")]
        return Err("Homebrew is required to install whisper-cpp automatically. Install Homebrew (https://brew.sh) or run 'brew install whisper-cpp' manually, then restart the app.".to_string());

        #[cfg(target_os = "linux")]
        return Err("Install whisper-cpp with your package manager (e.g. 'sudo apt install whisper-cpp', 'sudo dnf install whisper-cpp', or 'sudo pacman -S whisper.cpp') or build it from https://github.com/ggml-org/whisper.cpp, then restart the app.".to_string());

        #[allow(unreachable_code)]
        return Err("Could not install whisper-cpp automatically. Install it manually, then restart the app.".to_string());
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

        extract_zip(&archive_path, temp_dir.path())?;
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

    let binary_path = bundled_binary_path()?;

    // Extract from zip
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp error: {}", e))?;
    let zip_path = temp_dir.path().join("whisper.zip");
    std::fs::write(&zip_path, &bytes).map_err(|e| format!("Write error: {}", e))?;

    extract_zip(&zip_path, temp_dir.path())?;

    // Find the whisper-cli or whisper-cpp binary in the extracted files. Only accept
    // real executables (magic-byte check) so we never copy a header or static lib.
    let mut found_binary = None;
    for name in &["whisper-cli", "whisper-cpp", "whisper", "main"] {
        let candidates = [
            temp_dir.path().join(name),
            temp_dir.path().join(format!("{}.exe", name)),
            temp_dir.path().join("build").join("bin").join(name),
        ];
        for candidate in &candidates {
            if candidate.exists() && passes_executable_check(candidate) {
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
                        && passes_executable_check(e.path())
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
    let partial_path = models_dir.join(format!("{}.partial", preset.filename));

    // Clean up any stale partial from a previous interrupted download.
    if partial_path.exists() {
        let _ = std::fs::remove_file(&partial_path);
    }

    // Treat an existing final file as valid only if it's not absurdly small
    // (a truncated/failed download). Otherwise remove it and re-download.
    if model_path.exists() {
        let size = std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
        if size >= 1_000_000 {
            return Ok(format!("Model {} already downloaded", model_id));
        }
        let _ = std::fs::remove_file(&model_path);
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
    // Download into a .partial file; only rename to the final name once the size
    // is verified, so an interrupted download never masquerades as a valid model.
    let mut file =
        std::fs::File::create(&partial_path).map_err(|e| format!("File error: {}", e))?;

    use futures::StreamExt;
    use std::io::Write;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&partial_path);
                return Err(format!("Stream error: {}", e));
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&partial_path);
            return Err(format!("Write error: {}", e));
        }
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

    drop(file);

    // Verify the downloaded size is within 20% of the expected size when known.
    let expected = (preset.size_mb as u64) * 1_000_000;
    if expected > 0 {
        let low = expected * 8 / 10;
        let high = expected * 12 / 10;
        if downloaded < low || downloaded > high {
            let _ = std::fs::remove_file(&partial_path);
            return Err(format!(
                "Downloaded {} looks wrong: got {} bytes, expected ~{} bytes. Please retry.",
                preset.label, downloaded, expected
            ));
        }
    } else if downloaded < 1_000_000 {
        let _ = std::fs::remove_file(&partial_path);
        return Err(format!(
            "Downloaded {} is too small ({} bytes). Please retry.",
            preset.label, downloaded
        ));
    }

    std::fs::rename(&partial_path, &model_path)
        .map_err(|e| format!("Finalize error: {}", e))?;

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

/// Parse the detected language code from whisper-cpp stderr output.
/// Input line looks like "auto-detected language: en (p = 0.98)"; returns "en".
fn parse_detected_language(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .find(|l| l.contains("auto-detected language:"))
        .and_then(|l| l.split(':').last())
        .map(|s| s.trim().split(" (").next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty())
}

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

    // Extract language from stderr. whisper-cpp prints e.g.
    // "auto-detected language: en (p = 0.98)"; take just the code before " (".
    let language = parse_detected_language(&stderr);

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ---- Item 16: language code parsing ----

    #[test]
    fn parses_language_code_before_paren() {
        let stderr = "whisper_full_with_state: auto-detected language: en (p = 0.98)\nother line";
        assert_eq!(parse_detected_language(stderr).as_deref(), Some("en"));
    }

    #[test]
    fn parses_language_code_without_paren() {
        let stderr = "auto-detected language: fr";
        assert_eq!(parse_detected_language(stderr).as_deref(), Some("fr"));
    }

    #[test]
    fn returns_none_when_absent() {
        assert_eq!(parse_detected_language("no language line here"), None);
    }

    // ---- Item 14: executable magic-byte check ----

    #[test]
    fn executable_check_accepts_elf_and_pe_rejects_text() {
        let tmp = tempfile::tempdir().unwrap();

        let elf = tmp.path().join("elf.bin");
        std::fs::File::create(&elf).unwrap().write_all(b"\x7FELF\x02\x01").unwrap();
        assert!(passes_executable_check(&elf));

        let pe = tmp.path().join("app.exe");
        std::fs::File::create(&pe).unwrap().write_all(b"MZ\x90\x00").unwrap();
        assert!(passes_executable_check(&pe));

        let macho = tmp.path().join("macho.bin");
        std::fs::File::create(&macho).unwrap().write_all(&[0xCF, 0xFA, 0xED, 0xFE]).unwrap();
        assert!(passes_executable_check(&macho));

        // A text header / stub must be rejected.
        let text = tmp.path().join("readme.txt");
        std::fs::File::create(&text).unwrap().write_all(b"#include <stdio.h>\n").unwrap();
        assert!(!passes_executable_check(&text));

        // Too short to have a magic number.
        let tiny = tmp.path().join("tiny");
        std::fs::File::create(&tiny).unwrap().write_all(b"MZ").unwrap();
        assert!(!passes_executable_check(&tiny));
    }

    // ---- #56: in-process zip extraction (no more shelling out to `unzip`) ----

    /// Build a small test zip at `path` with plain entries (no zip-slip, no
    /// custom unix mode). Uses the deflate feature enabled for the `zip` dep.
    fn build_test_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, contents) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn extract_zip_writes_files_and_preserves_structure() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("test.zip");
        build_test_zip(&archive, &[
            ("a.txt", b"hello"),
            ("sub/b.txt", b"nested"),
        ]);

        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        extract_zip(&archive, &dest).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "hello");
        assert_eq!(std::fs::read_to_string(dest.join("sub/b.txt")).unwrap(), "nested");
    }

    #[test]
    fn extract_zip_rejects_zip_slip_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("evil.zip");

        // Build a zip with one legitimate entry and two that try to escape the
        // destination directory: a relative `..` traversal and an absolute
        // path. `start_file` (unlike `start_file_from_path`) does not sanitize
        // the name, so this is the only way to construct zip-slip entries for
        // the test.
        let file = std::fs::File::create(&archive).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("good.txt", options).unwrap();
        writer.write_all(b"safe").unwrap();
        writer.start_file("../evil.txt", options).unwrap();
        writer.write_all(b"malicious").unwrap();
        writer.start_file("/tmp/evil-abs.txt", options).unwrap();
        writer.write_all(b"malicious-abs").unwrap();
        writer.finish().unwrap();

        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let result = extract_zip(&archive, &dest);

        // Fail closed: an archive containing an unsafe entry is untrustworthy,
        // so the whole extraction aborts instead of silently skipping the bad
        // entry and installing a partial result. (Entries ordered before the
        // bad one, like good.txt here, may already be on disk when this
        // returns; both call sites extract into a fresh temp dir, so a failed
        // extraction there is simply discarded rather than promoted.)
        assert!(result.is_err());
        assert!(!dest.join("evil.txt").exists());
        // The relative-escape entry would have landed at tmp/evil.txt if unsanitized.
        assert!(!tmp.path().join("evil.txt").exists());
        // The absolute-path entry must never be written to its literal path.
        assert!(!std::path::Path::new("/tmp/evil-abs.txt").exists());
    }

    #[test]
    #[cfg(unix)]
    fn extract_zip_preserves_unix_executable_bit() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("bin.zip");

        let file = std::fs::File::create(&archive).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        writer.start_file("mybinary", options).unwrap();
        writer.write_all(b"#!/bin/sh\necho hi\n").unwrap();
        writer.finish().unwrap();

        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        extract_zip(&archive, &dest).unwrap();

        let out = dest.join("mybinary");
        assert!(out.exists());
        let mode = std::fs::metadata(&out).unwrap().permissions().mode();
        assert!(mode & 0o111 != 0, "expected executable bit set, got mode {:o}", mode);
    }
}
