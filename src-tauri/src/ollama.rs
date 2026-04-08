use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Emitter;

const OLLAMA_PORT: u16 = 11434;
const OLLAMA_BASE: &str = "http://127.0.0.1:11434";

static OLLAMA_PID: Mutex<Option<u32>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
pub struct ModelPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub size_gb: f64,
    pub ram_gb: u32,
    pub description: &'static str,
}

pub const MODEL_PRESETS: &[ModelPreset] = &[
    ModelPreset { id: "gemma4",      label: "Gemma 4 E4B (Recommended)",     size_gb: 9.6, ram_gb: 12, description: "Best for structured JSON. Native function calling. Great quality/speed." },
    ModelPreset { id: "gemma4:e2b",  label: "Gemma 4 E2B (Small & Fast)",    size_gb: 7.2, ram_gb: 8,  description: "Lightweight Gemma 4. Good quality, fits 8GB RAM." },
    ModelPreset { id: "gemma4:26b",  label: "Gemma 4 26B (Best Quality)",    size_gb: 18.0, ram_gb: 20, description: "Closest to GPT-5 quality. Full DNA support. Needs 20GB+ RAM." },
    ModelPreset { id: "qwen3:4b",    label: "Qwen 3 4B (Fast)",     size_gb: 2.6, ram_gb: 8, description: "Fast and small. Good for basic classification." },
    ModelPreset { id: "gemma3:4b",   label: "Gemma 3 4B",            size_gb: 3.3, ram_gb: 8, description: "Google's older model. Decent at structured output." },
    ModelPreset { id: "qwen3:1.7b",  label: "Qwen 3 1.7B (Tiny)",   size_gb: 1.1, ram_gb: 4, description: "Fastest/smallest. Basic metadata only." },
    ModelPreset { id: "phi4-mini",   label: "Phi-4 Mini (3.8B)",     size_gb: 2.5, ram_gb: 8, description: "Microsoft's model. Strong reasoning for its size." },
    ModelPreset { id: "llama3.2:3b", label: "Llama 3.2 (3B)",        size_gb: 2.0, ram_gb: 6, description: "Meta's compact model. Good general quality." },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub models: Vec<OllamaModel>,
    pub version: Option<String>,
}

fn ollama_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot find app data directory")?;
    Ok(base.join("Audiobook Tagger").join("ollama"))
}

fn ollama_binary_path() -> Result<PathBuf, String> {
    let dir = ollama_dir()?;
    #[cfg(target_os = "windows")]
    { Ok(dir.join("ollama.exe")) }
    #[cfg(not(target_os = "windows"))]
    { Ok(dir.join("ollama")) }
}

fn ollama_models_dir() -> Result<PathBuf, String> {
    Ok(ollama_dir()?.join("models"))
}

async fn is_running() -> bool {
    reqwest::get(format!("{}/api/tags", OLLAMA_BASE))
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Find system-installed Ollama binary via PATH lookup
fn find_system_ollama() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("which")
            .arg("ollama")
            .output()
            .ok()?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("where")
            .arg("ollama")
            .output()
            .ok()?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).lines().next()?.trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// Find the best available Ollama binary: bundled first, then system PATH
fn find_best_binary() -> Option<PathBuf> {
    if let Ok(bundled) = ollama_binary_path() {
        if bundled.exists() {
            return Some(bundled);
        }
    }
    find_system_ollama()
}

#[tauri::command]
pub async fn ollama_get_status() -> Result<OllamaStatus, String> {
    let installed = find_best_binary().is_some();
    let running = is_running().await;
    let mut models = Vec::new();
    let mut version = None;

    if running {
        if let Ok(resp) = reqwest::get(format!("{}/api/tags", OLLAMA_BASE)).await {
            if let Ok(data) = resp.json::<serde_json::Value>().await {
                if let Some(model_list) = data["models"].as_array() {
                    for m in model_list {
                        if let (Some(name), Some(size)) = (m["name"].as_str(), m["size"].as_u64()) {
                            models.push(OllamaModel { name: name.to_string(), size_bytes: size });
                        }
                    }
                }
            }
        }
        if let Ok(resp) = reqwest::get(format!("{}/api/version", OLLAMA_BASE)).await {
            if let Ok(data) = resp.json::<serde_json::Value>().await {
                version = data["version"].as_str().map(|s| s.to_string());
            }
        }
    }

    Ok(OllamaStatus { installed: installed || running, running, models, version })
}

#[tauri::command]
pub fn ollama_get_model_presets() -> Vec<ModelPreset> {
    MODEL_PRESETS.to_vec()
}

#[tauri::command]
pub async fn ollama_get_disk_usage() -> Result<u64, String> {
    let models_dir = ollama_models_dir()?;
    if !models_dir.exists() { return Ok(0); }
    let mut total: u64 = 0;
    for entry in walkdir::WalkDir::new(&models_dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(total)
}

#[tauri::command]
pub async fn ollama_start() -> Result<String, String> {
    if is_running().await {
        return Ok("Ollama is already running".to_string());
    }
    let binary = find_best_binary()
        .ok_or_else(|| "Ollama is not installed. Install it via the button above, or install Ollama system-wide from https://ollama.com/download".to_string())?;
    let models_dir = ollama_models_dir()?;
    std::fs::create_dir_all(&models_dir).map_err(|e| format!("Failed to create models dir: {}", e))?;

    let child = tokio::process::Command::new(&binary)
        .arg("serve")
        .env("OLLAMA_MODELS", models_dir.to_str().unwrap_or(""))
        .env("OLLAMA_HOST", format!("127.0.0.1:{}", OLLAMA_PORT))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start Ollama: {}", e))?;

    let pid = child.id().unwrap_or(0);
    *OLLAMA_PID.lock().unwrap() = Some(pid);

    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if is_running().await {
            return Ok(format!("Ollama started (PID {})", pid));
        }
    }
    Err("Ollama started but didn't become responsive within 15 seconds".to_string())
}

#[tauri::command]
pub async fn ollama_stop() -> Result<String, String> {
    let pid = OLLAMA_PID.lock().unwrap().take();
    if let Some(pid) = pid {
        #[cfg(unix)]
        unsafe { libc::kill(pid as i32, libc::SIGTERM); }
        #[cfg(windows)]
        {
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output().await;
        }
    }
    #[cfg(unix)]
    {
        let _ = tokio::process::Command::new("pkill")
            .args(["-f", "ollama serve"])
            .output().await;
    }
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if !is_running().await {
            return Ok("Ollama stopped".to_string());
        }
    }
    Ok("Ollama stop signal sent".to_string())
}

#[tauri::command]
pub async fn ollama_install() -> Result<String, String> {
    let dir = ollama_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ollama dir: {}", e))?;
    let binary_path = ollama_binary_path()?;

    #[cfg(target_os = "macos")]
    let url = "https://ollama.com/download/Ollama-darwin.zip";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let url = "https://ollama.com/download/ollama-linux-amd64.tar.zst";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let url = "https://ollama.com/download/ollama-linux-arm64.tar.zst";
    #[cfg(target_os = "windows")]
    return Err("Windows: Please download Ollama from https://ollama.com/download and install manually.".to_string());

    let resp = reqwest::get(url).await.map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed with status {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("Failed to read download: {}", e))?;

    install_from_bytes(&bytes, &binary_path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set permissions: {}", e))?;
    }

    std::fs::create_dir_all(ollama_models_dir()?).map_err(|e| format!("Failed to create models dir: {}", e))?;
    Ok("Ollama installed successfully".to_string())
}

#[cfg(target_os = "macos")]
fn install_from_bytes(bytes: &[u8], binary_path: &PathBuf) -> Result<(), String> {
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp dir error: {}", e))?;
    let zip_path = temp_dir.path().join("ollama.zip");
    std::fs::write(&zip_path, bytes).map_err(|e| format!("Write error: {}", e))?;

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

    let app_binary = temp_dir.path().join("Ollama.app/Contents/Resources/ollama");
    if app_binary.exists() {
        std::fs::copy(&app_binary, binary_path).map_err(|e| format!("Copy binary error: {}", e))?;
    } else {
        return Err("Could not find ollama binary in downloaded archive".to_string());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_from_bytes(bytes: &[u8], binary_path: &PathBuf) -> Result<(), String> {
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp dir error: {}", e))?;
    let archive_path = temp_dir.path().join("ollama.tar.zst");
    std::fs::write(&archive_path, bytes).map_err(|e| format!("Write error: {}", e))?;

    let output = std::process::Command::new("tar")
        .args(["xf"])
        .arg(archive_path.to_str().unwrap())
        .arg("-C")
        .arg(temp_dir.path().to_str().unwrap())
        .output()
        .map_err(|e| format!("Tar error: {}", e))?;

    if !output.status.success() {
        return Err(format!("Tar extraction failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let extracted = temp_dir.path().join("bin/ollama");
    if extracted.exists() {
        std::fs::copy(&extracted, binary_path).map_err(|e| format!("Copy binary error: {}", e))?;
    } else {
        let direct = temp_dir.path().join("ollama");
        if direct.exists() {
            std::fs::copy(&direct, binary_path).map_err(|e| format!("Copy binary error: {}", e))?;
        } else {
            return Err("Could not find ollama binary in tarball".to_string());
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_from_bytes(_bytes: &[u8], _binary_path: &PathBuf) -> Result<(), String> {
    Err("Windows: Please download Ollama from https://ollama.com/download and install manually.".to_string())
}

#[tauri::command]
pub async fn ollama_uninstall() -> Result<String, String> {
    let _ = ollama_stop().await;
    let dir = ollama_dir()?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove ollama directory: {}", e))?;
    }
    Ok("Ollama uninstalled".to_string())
}

#[tauri::command]
pub async fn ollama_pull_model(app_handle: tauri::AppHandle, model_name: String) -> Result<String, String> {
    if !is_running().await {
        return Err("Ollama is not running. Start it first.".to_string());
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/pull", OLLAMA_BASE))
        .json(&serde_json::json!({ "name": model_name, "stream": true }))
        .timeout(std::time::Duration::from_secs(1200))
        .send().await
        .map_err(|e| format!("Pull failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Pull failed: {}", text));
    }

    // Stream the response line by line, emit progress events
    use tokio::io::AsyncBufReadExt;
    let stream = resp.bytes_stream();
    use futures::StreamExt;
    let mut buffer = String::new();

    tokio::pin!(stream);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete JSON lines
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() { continue; }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                let completed = json["completed"].as_u64().unwrap_or(0);
                let total = json["total"].as_u64().unwrap_or(0);
                let status = json["status"].as_str().unwrap_or("").to_string();

                let _ = app_handle.emit("ollama-pull-progress", serde_json::json!({
                    "completed": completed,
                    "total": total,
                    "status": status,
                    "model": model_name,
                }));
            }
        }
    }

    Ok(format!("Model '{}' pulled successfully", model_name))
}

#[tauri::command]
pub async fn ollama_delete_model(model_name: String) -> Result<String, String> {
    if !is_running().await {
        return Err("Ollama is not running".to_string());
    }
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{}/api/delete", OLLAMA_BASE))
        .json(&serde_json::json!({ "name": model_name }))
        .send().await
        .map_err(|e| format!("Delete failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Delete failed: {}", text));
    }
    Ok(format!("Model '{}' deleted", model_name))
}
