// src-tauri/src/ollama_manager.rs
//
// Manages a bundled Ollama installation for local AI.
// Handles: download, install, start/stop, model pull/delete, status checks.
// Users get a one-click "Install Local AI" experience with no terminal required.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use futures::StreamExt;

// ─── Constants ───────────────────────────────────────────────────────────────

const OLLAMA_PORT: u16 = 11434;
const OLLAMA_BASE: &str = "http://127.0.0.1:11434";

/// Model presets offered in the UI
pub const MODEL_PRESETS: &[ModelPreset] = &[
    ModelPreset {
        id: "qwen3:1.7b",
        label: "Fast & Small (1.7B)",
        size_gb: 1.1,
        ram_gb: 4,
        description: "Fastest option. Good for basic metadata extraction.",
    },
    ModelPreset {
        id: "qwen3:4b",
        label: "Balanced (4B)",
        size_gb: 2.6,
        ram_gb: 8,
        description: "Best balance of speed and quality. Recommended for most users.",
    },
    ModelPreset {
        id: "gemma3:4b",
        label: "Gemma 3 (4B)",
        size_gb: 3.3,
        ram_gb: 8,
        description: "Google's model. Strong at structured output.",
    },
    ModelPreset {
        id: "phi4-mini",
        label: "Phi-4 Mini (3.8B)",
        size_gb: 2.5,
        ram_gb: 8,
        description: "Microsoft's model. Strong reasoning for its size.",
    },
    ModelPreset {
        id: "llama3.2:3b",
        label: "Llama 3.2 (3B)",
        size_gb: 2.0,
        ram_gb: 6,
        description: "Meta's compact model. Good general quality.",
    },
];

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ModelPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub size_gb: f64,
    pub ram_gb: u32,
    pub description: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub binary_path: Option<String>,
    pub models: Vec<InstalledModel>,
    pub active_model: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledModel {
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullProgress {
    pub status: String,
    pub total: Option<u64>,
    pub completed: Option<u64>,
    pub percent: Option<f64>,
}

// ─── Global state ────────────────────────────────────────────────────────────

static OLLAMA_PROCESS: Mutex<Option<u32>> = Mutex::new(None); // PID
static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

// ─── Path helpers ────────────────────────────────────────────────────────────

/// Where we store the bundled Ollama binary + models
fn ollama_data_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;

    #[cfg(target_os = "macos")]
    let dir = home.join("Library/Application Support/Audiobook Tagger/ollama");

    #[cfg(target_os = "windows")]
    let dir = home.join("AppData/Local/Audiobook Tagger/ollama");

    #[cfg(target_os = "linux")]
    let dir = home.join(".local/share/audiobook-tagger/ollama");

    Ok(dir)
}

fn ollama_binary_path() -> Result<PathBuf, String> {
    let dir = ollama_data_dir()?;

    #[cfg(target_os = "windows")]
    return Ok(dir.join("ollama.exe"));

    #[cfg(not(target_os = "windows"))]
    Ok(dir.join("ollama"))
}

fn ollama_models_dir() -> Result<PathBuf, String> {
    Ok(ollama_data_dir()?.join("models"))
}

// ─── Status check ────────────────────────────────────────────────────────────

/// Check if Ollama is installed (binary exists) and running
pub async fn get_status() -> OllamaStatus {
    let binary = ollama_binary_path().ok();
    let installed = binary.as_ref().map(|p| p.exists()).unwrap_or(false);
    let running = is_running().await;
    let models = if running { list_models().await.unwrap_or_default() } else { vec![] };
    let version = if installed {
        get_version(binary.as_ref().unwrap()).await.ok()
    } else {
        None
    };

    // Read active model from config
    let active_model = crate::config::load_config()
        .ok()
        .and_then(|c| c.ollama_model);

    OllamaStatus {
        installed,
        running,
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        models,
        active_model,
        version,
    }
}

/// Quick health check — is something responding on port 11434?
pub async fn is_running() -> bool {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    client.get(OLLAMA_BASE).send().await.is_ok()
}

async fn get_version(binary: &PathBuf) -> Result<String, String> {
    let output = tokio::process::Command::new(binary)
        .arg("--version")
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // Output is like "ollama version is 0.6.2"
    Ok(stdout.replace("ollama version is ", "").trim().to_string())
}

// ─── Install / Uninstall ─────────────────────────────────────────────────────

/// Download and install Ollama binary into the app data directory.
/// Returns progress updates via the Tauri event system.
pub async fn install(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;

    DOWNLOAD_CANCEL.store(false, Ordering::Relaxed);

    let data_dir = ollama_data_dir()?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create directory: {}", e))?;

    let binary_path = ollama_binary_path()?;

    if binary_path.exists() {
        return Ok("Ollama is already installed".to_string());
    }

    // Determine download URL based on platform
    let download_url = get_download_url()?;

    let _ = app_handle.emit("ollama-install-progress", PullProgress {
        status: "Downloading Ollama...".to_string(),
        total: None,
        completed: None,
        percent: Some(0.0),
    });

    // Download
    let client = reqwest::Client::new();
    let response = client.get(&download_url).send().await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total_size = response.content_length();
    let mut downloaded: u64 = 0;
    let mut bytes = Vec::new();

    let mut stream = response.bytes_stream();
    use futures::StreamExt;

    while let Some(chunk) = stream.next().await {
        if DOWNLOAD_CANCEL.load(Ordering::Relaxed) {
            return Err("Download cancelled".to_string());
        }

        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);

        let percent = total_size.map(|t| (downloaded as f64 / t as f64) * 100.0);
        let _ = app_handle.emit("ollama-install-progress", PullProgress {
            status: "Downloading Ollama...".to_string(),
            total: total_size,
            completed: Some(downloaded),
            percent,
        });
    }

    let _ = app_handle.emit("ollama-install-progress", PullProgress {
        status: "Installing...".to_string(),
        total: None,
        completed: None,
        percent: Some(95.0),
    });

    // Extract / install based on platform
    install_from_bytes(&bytes, &binary_path, &data_dir)?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set permissions: {}", e))?;
    }

    let _ = app_handle.emit("ollama-install-progress", PullProgress {
        status: "Installed!".to_string(),
        total: None,
        completed: None,
        percent: Some(100.0),
    });

    Ok("Ollama installed successfully".to_string())
}

/// Get the right download URL for this platform
fn get_download_url() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return Ok("https://ollama.com/download/Ollama-darwin.zip".to_string());

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Ok("https://ollama.com/download/ollama-linux-amd64.tgz".to_string());

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return Ok("https://ollama.com/download/ollama-linux-arm64.tgz".to_string());

    #[cfg(target_os = "windows")]
    return Err("Windows: Please download Ollama from https://ollama.com/download and install it manually. Then enable 'Use system Ollama' in settings.".to_string());

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return Err("Unsupported platform".to_string());
}

/// Extract the binary from downloaded archive
fn install_from_bytes(bytes: &[u8], binary_path: &PathBuf, _data_dir: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // macOS: ZIP containing Ollama.app bundle
        // We need to extract the CLI binary from inside the app bundle
        let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp dir error: {}", e))?;
        let zip_path = temp_dir.path().join("ollama.zip");
        std::fs::write(&zip_path, bytes).map_err(|e| format!("Write error: {}", e))?;

        // Unzip
        let output = std::process::Command::new("unzip")
            .args(["-q", "-o"])
            .arg(zip_path.to_str().unwrap())
            .arg("-d")
            .arg(temp_dir.path().to_str().unwrap())
            .output()
            .map_err(|e| format!("Unzip error: {}", e))?;

        if !output.status.success() {
            return Err(format!("Unzip failed: {}", String::from_utf8_lossy(&output.stderr)));
        }

        // The CLI binary is inside: Ollama.app/Contents/Resources/ollama
        let app_binary = temp_dir.path().join("Ollama.app/Contents/Resources/ollama");
        if app_binary.exists() {
            std::fs::copy(&app_binary, binary_path)
                .map_err(|e| format!("Copy binary error: {}", e))?;
        } else {
            // Fallback: try to find any ollama binary in the extracted contents
            let fallback = find_ollama_binary(temp_dir.path());
            if let Some(found) = fallback {
                std::fs::copy(&found, binary_path)
                    .map_err(|e| format!("Copy binary error: {}", e))?;
            } else {
                return Err("Could not find ollama binary in downloaded archive".to_string());
            }
        }

        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: tgz containing the binary
        let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp dir error: {}", e))?;
        let tgz_path = temp_dir.path().join("ollama.tgz");
        std::fs::write(&tgz_path, bytes).map_err(|e| format!("Write error: {}", e))?;

        let output = std::process::Command::new("tar")
            .args(["xzf"])
            .arg(tgz_path.to_str().unwrap())
            .arg("-C")
            .arg(temp_dir.path().to_str().unwrap())
            .output()
            .map_err(|e| format!("Tar error: {}", e))?;

        if !output.status.success() {
            return Err(format!("Tar extraction failed: {}", String::from_utf8_lossy(&output.stderr)));
        }

        // Binary is usually at bin/ollama in the tarball
        let extracted = temp_dir.path().join("bin/ollama");
        if extracted.exists() {
            std::fs::copy(&extracted, binary_path)
                .map_err(|e| format!("Copy binary error: {}", e))?;
        } else {
            // Fallback: look for the binary directly
            let direct = temp_dir.path().join("ollama");
            if direct.exists() {
                std::fs::copy(&direct, binary_path)
                    .map_err(|e| format!("Copy binary error: {}", e))?;
            } else {
                return Err("Could not find ollama binary in tarball".to_string());
            }
        }

        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        // Windows isn't supported for bundled install (uses system Ollama)
        Err("Windows bundled install not supported".to_string())
    }
}

/// Recursively find an 'ollama' binary in a directory
fn find_ollama_binary(dir: &std::path::Path) -> Option<PathBuf> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.file_name().map(|n| n == "ollama").unwrap_or(false) {
                return Some(path);
            }
            if path.is_dir() {
                if let Some(found) = find_ollama_binary(&path) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// Cancel an in-progress download
pub fn cancel_install() {
    DOWNLOAD_CANCEL.store(true, Ordering::Relaxed);
}

/// Uninstall: stop process, delete binary and models
pub async fn uninstall() -> Result<String, String> {
    // Stop if running
    let _ = stop().await;

    let data_dir = ollama_data_dir()?;
    if data_dir.exists() {
        std::fs::remove_dir_all(&data_dir)
            .map_err(|e| format!("Failed to remove Ollama data: {}", e))?;
    }

    Ok("Ollama uninstalled. Reclaimed disk space.".to_string())
}

/// Get total disk usage of the Ollama data directory (binary + models)
pub fn get_disk_usage() -> Result<u64, String> {
    let data_dir = ollama_data_dir()?;
    if !data_dir.exists() {
        return Ok(0);
    }
    dir_size(&data_dir).map_err(|e| format!("Failed to calculate size: {}", e))
}

fn dir_size(path: &PathBuf) -> Result<u64, std::io::Error> {
    let mut total: u64 = 0;
    if path.is_file() {
        return Ok(std::fs::metadata(path)?.len());
    }
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_file() {
            total += std::fs::metadata(&p)?.len();
        } else if p.is_dir() {
            total += dir_size(&p)?;
        }
    }
    Ok(total)
}

// ─── Start / Stop ────────────────────────────────────────────────────────────

/// Start the bundled Ollama server process
pub async fn start() -> Result<String, String> {
    // Already running?
    if is_running().await {
        return Ok("Ollama is already running".to_string());
    }

    let binary = ollama_binary_path()?;
    if !binary.exists() {
        return Err("Ollama is not installed. Install it first.".to_string());
    }

    let models_dir = ollama_models_dir()?;
    std::fs::create_dir_all(&models_dir).map_err(|e| format!("Failed to create models dir: {}", e))?;

    // Start 'ollama serve' as a background process
    let child = tokio::process::Command::new(&binary)
        .arg("serve")
        .env("OLLAMA_MODELS", models_dir.to_str().unwrap_or(""))
        .env("OLLAMA_HOST", format!("127.0.0.1:{}", OLLAMA_PORT))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start Ollama: {}", e))?;

    let pid = child.id().unwrap_or(0);
    *OLLAMA_PROCESS.lock().unwrap() = Some(pid);

    // Wait for it to become responsive (up to 15 seconds)
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if is_running().await {
            return Ok(format!("Ollama started (PID {})", pid));
        }
    }

    Err("Ollama started but didn't become responsive within 15 seconds".to_string())
}

/// Stop the bundled Ollama server process
pub async fn stop() -> Result<String, String> {
    // Try graceful shutdown via PID
    let pid = OLLAMA_PROCESS.lock().unwrap().take();

    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
        }

        #[cfg(windows)]
        {
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output()
                .await;
        }
    }

    // Also try to kill any ollama serve process we might have started
    #[cfg(unix)]
    {
        let _ = tokio::process::Command::new("pkill")
            .args(["-f", "ollama serve"])
            .output()
            .await;
    }

    // Wait for it to actually stop
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if !is_running().await {
            return Ok("Ollama stopped".to_string());
        }
    }

    Ok("Ollama stop signal sent".to_string())
}

// ─── Model management ────────────────────────────────────────────────────────

/// List installed models
pub async fn list_models() -> Result<Vec<InstalledModel>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(format!("{}/api/tags", OLLAMA_BASE))
        .send()
        .await
        .map_err(|e| format!("Failed to list models: {}", e))?;

    #[derive(Deserialize)]
    struct TagsResponse {
        models: Option<Vec<ModelInfo>>,
    }

    #[derive(Deserialize)]
    struct ModelInfo {
        name: String,
        size: Option<u64>,
        modified_at: Option<String>,
    }

    let tags: TagsResponse = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    Ok(tags.models.unwrap_or_default().into_iter().map(|m| InstalledModel {
        name: m.name,
        size_bytes: m.size.unwrap_or(0),
        modified_at: m.modified_at,
    }).collect())
}

/// Pull (download) a model, emitting progress events
pub async fn pull_model(app_handle: tauri::AppHandle, model_name: &str) -> Result<String, String> {
    use tauri::Emitter;

    // Ensure Ollama is running
    if !is_running().await {
        start().await?;
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600)) // Models can be large
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.post(format!("{}/api/pull", OLLAMA_BASE))
        .json(&serde_json::json!({ "name": model_name, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("Pull request failed: {}", e))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(format!("Pull failed: {}", err));
    }

    // Stream progress from the response (NDJSON — one JSON object per line)
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete lines
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() { continue; }

            if let Ok(progress) = serde_json::from_str::<serde_json::Value>(&line) {
                let status = progress.get("status").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let total = progress.get("total").and_then(|v| v.as_u64());
                let completed = progress.get("completed").and_then(|v| v.as_u64());
                let percent = match (total, completed) {
                    (Some(t), Some(c)) if t > 0 => Some((c as f64 / t as f64) * 100.0),
                    _ => None,
                };

                let _ = app_handle.emit("ollama-pull-progress", PullProgress {
                    status: status.clone(),
                    total,
                    completed,
                    percent,
                });

                if status == "success" {
                    return Ok(format!("Model '{}' pulled successfully", model_name));
                }
            }
        }
    }

    Ok(format!("Model '{}' pulled successfully", model_name))
}

/// Delete a model
pub async fn delete_model(model_name: &str) -> Result<String, String> {
    if !is_running().await {
        return Err("Ollama is not running".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.delete(format!("{}/api/delete", OLLAMA_BASE))
        .json(&serde_json::json!({ "name": model_name }))
        .send()
        .await
        .map_err(|e| format!("Delete failed: {}", e))?;

    if resp.status().is_success() {
        Ok(format!("Model '{}' deleted", model_name))
    } else {
        let err = resp.text().await.unwrap_or_default();
        Err(format!("Delete failed: {}", err))
    }
}

// ─── Auto-config helper ──────────────────────────────────────────────────────

/// When a user enables local AI, update the config to point at the local Ollama instance
pub fn configure_for_local(config: &mut crate::config::Config, model: &str) {
    config.use_local_ai = true;
    config.ai_base_url = format!("http://127.0.0.1:{}", OLLAMA_PORT);
    config.ollama_model = Some(model.to_string());
    config.ai_model = model.to_string();
    // Local Ollama doesn't need an API key, but the chat completions endpoint
    // needs something in the header — "ollama" is conventional
    if config.openai_api_key.is_none() || config.openai_api_key.as_deref() == Some("") {
        config.openai_api_key = Some("ollama".to_string());
    }
}

/// Revert config back to OpenAI / manual configuration
pub fn configure_for_remote(config: &mut crate::config::Config) {
    config.use_local_ai = false;
    config.ai_base_url = "https://api.openai.com".to_string();
    config.ai_model = "gpt-5.4-nano".to_string();
    config.ollama_model = None;
}
