use serde::{Deserialize, Serialize};
use crate::whisper::{run_child, stderr_tail, tokio_command, StepError};
use crate::whisper_local::{download_client, finalize_model_download, hex_digest};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

const OLLAMA_PORT: u16 = 11434;
const OLLAMA_DEFAULT_BASE: &str = "http://127.0.0.1:11434";

// Returns the effective Ollama base URL. Empty input = localhost default.
// Trims any trailing slashes so callers can safely do format!("{}/api/...", base).
pub fn effective_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() { OLLAMA_DEFAULT_BASE.to_string() } else { trimmed.to_string() }
}

/// Whether an (already effective) base URL points at the local machine. Only a
/// local Ollama can be started/stopped by this app; remote ones must be managed
/// on their own host.
///
/// The URL's HOST is parsed and compared - a substring check accepted
/// "http://localhost.evil.com" and "http://evil.com/?h=127.0.0.1".
fn is_localhost(base: &str) -> bool {
    use reqwest::Url;
    let trimmed = base.trim();
    let parsed = Url::parse(trimmed)
        .ok()
        .filter(|u| u.host().is_some())
        .or_else(|| Url::parse(&format!("http://{trimmed}")).ok());
    let host = match parsed.as_ref().and_then(|u| u.host_str()) {
        Some(h) => h.trim_start_matches('[').trim_end_matches(']').to_string(),
        None => return false,
    };
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback() || ip.is_unspecified(),
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

/// Browser origins allowed to call the Ollama server this app spawns: only the
/// app's own webview (macOS/Linux `tauri://localhost`, Windows
/// `http(s)://tauri.localhost`). Ollama adds its built-in localhost defaults.
/// Was "*", which let ANY website the user visited drive the local Ollama.
const OLLAMA_APP_ORIGINS: &str = "tauri://localhost,http://tauri.localhost,https://tauri.localhost";

/// Forget the stored PID once that process has exited, so a later stop can never
/// signal an unrelated process that reused the PID.
fn clear_pid_if(pid: u32) {
    if let Ok(mut guard) = OLLAMA_PID.lock() {
        if *guard == Some(pid) {
            *guard = None;
        }
    }
}

/// Validate an Ollama model name. Allows alphanumerics plus / . : - _ (registry
/// namespaces, tags, versions); rejects whitespace, shell metacharacters, empty,
/// over-long, and ".." path traversal.
fn is_valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | ':' | '-' | '_'))
}

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

/// The installed Ollama runtime: on macOS the whole `Ollama.app/Contents/Resources`
/// directory, on Linux the tarball's `bin/` and `lib/` tree.
fn ollama_runtime_dir() -> Result<PathBuf, String> {
    Ok(ollama_dir()?.join("runtime"))
}

/// The `ollama` executable inside an installed (or staged) runtime tree.
fn runtime_binary(runtime: &Path) -> PathBuf {
    #[cfg(target_os = "linux")]
    { runtime.join("bin").join("ollama") }
    #[cfg(target_os = "windows")]
    { runtime.join("ollama.exe") }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    { runtime.join("ollama") }
}

fn ollama_binary_path() -> Result<PathBuf, String> {
    Ok(runtime_binary(&ollama_runtime_dir()?))
}

/// Where versions before the pinned install put a lone `ollama` binary, copied
/// out of the archive without the runtime it needs. Ignored, and removed by the
/// next install.
#[cfg_attr(windows, allow(dead_code))]
fn legacy_binary_path() -> Result<PathBuf, String> {
    Ok(ollama_dir()?.join(if cfg!(windows) { "ollama.exe" } else { "ollama" }))
}

fn ollama_models_dir() -> Result<PathBuf, String> {
    Ok(ollama_dir()?.join("models"))
}

/// Status probes must answer quickly even when a remote `ollama_base_url` is
/// unreachable, or the Settings page hangs.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

fn probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn is_running(base: &str) -> bool {
    let base = effective_base(base);
    probe_client()
        .get(format!("{}/api/tags", base))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Find system-installed Ollama binary via PATH lookup and common install locations
fn find_system_ollama() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        // Check common install paths first (GUI apps / AppImage / Flatpak may have
        // a limited PATH that omits Homebrew and other install locations).
        for path in &[
            "/opt/homebrew/bin/ollama",
            "/usr/local/bin/ollama",
            "/usr/bin/ollama",
            "/snap/bin/ollama",
        ] {
            let p = PathBuf::from(path);
            if p.exists() {
                return Some(p);
            }
        }
        // Fall back to PATH lookup
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
        #[cfg(windows)]
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("where")
            .arg("ollama")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
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
pub async fn ollama_get_status(base_url: Option<String>) -> Result<OllamaStatus, String> {
    let base = effective_base(base_url.as_deref().unwrap_or(""));
    let installed = find_best_binary().is_some();
    let running = is_running(&base).await;
    let mut models = Vec::new();
    let mut version = None;

    if running {
        let client = probe_client();
        if let Ok(resp) = client.get(format!("{}/api/tags", base)).send().await {
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
        if let Ok(resp) = client.get(format!("{}/api/version", base)).send().await {
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
pub async fn ollama_start(base_url: Option<String>) -> Result<String, String> {
    let base = effective_base(base_url.as_deref().unwrap_or(""));
    if is_running(&base).await {
        return Ok("Ollama is already running".to_string());
    }
    // Never spawn a local server for a remotely-configured Ollama.
    if !is_localhost(&base) {
        return Err(
            "Configured Ollama is remote; start it on the remote host instead.".to_string(),
        );
    }
    let binary = find_best_binary()
        .ok_or_else(|| "Ollama is not installed. Install it via the button above, or install Ollama system-wide from https://ollama.com/download".to_string())?;
    let models_dir = ollama_models_dir()?;
    std::fs::create_dir_all(&models_dir).map_err(|e| format!("Failed to create models dir: {}", e))?;

    let mut cmd = tokio_command(&binary);
    cmd.arg("serve")
        .env("OLLAMA_MODELS", models_dir.to_str().unwrap_or(""))
        .env("OLLAMA_HOST", format!("127.0.0.1:{}", OLLAMA_PORT))
        .env("OLLAMA_ORIGINS", OLLAMA_APP_ORIGINS)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start Ollama: {}", e))?;

    let pid = child.id().unwrap_or(0);
    if pid > 0 {
        if let Ok(mut guard) = OLLAMA_PID.lock() {
            *guard = Some(pid);
        }
        ADOPTED.store(false, Ordering::SeqCst);
        if let Ok(pid_file) = pid_file_path() {
            // Best effort: without the file a crash orphans this Ollama, as before.
            let _ = std::fs::write(&pid_file, pid.to_string());
        }
    }

    // Spawn a background task to reap the child process and avoid zombies
    tokio::spawn(async move {
        let _ = child.wait().await;
        clear_pid_if(pid);
        if let Ok(pid_file) = pid_file_path() {
            remove_pid_file_if(&pid_file, pid);
        }
    });

    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if is_running(&base).await {
            return Ok(format!("Ollama started (PID {})", pid));
        }
    }
    Err("Ollama started but didn't become responsive within 15 seconds".to_string())
}

/// Set when OLLAMA_PID came from a previous run's PID file rather than a child
/// this run spawned. No reaper watches such a process, so its identity is
/// checked again right before it is signalled.
static ADOPTED: AtomicBool = AtomicBool::new(false);

/// Records the PID of the Ollama this app started, so a later run can stop it
/// after a crash.
fn pid_file_path() -> Result<PathBuf, String> {
    Ok(ollama_dir()?.join("ollama.pid"))
}

fn read_pid_file(pid_file: &Path) -> Option<u32> {
    std::fs::read_to_string(pid_file).ok()?.trim().parse().ok()
}

/// Remove the PID file only if it still names `pid`.
fn remove_pid_file_if(pid_file: &Path, pid: u32) {
    if read_pid_file(pid_file) == Some(pid) {
        let _ = std::fs::remove_file(pid_file);
    }
}

/// Executable path of a running process, or None if it is gone or unknown.
#[cfg(target_os = "macos")]
fn process_exe(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let pid = i32::try_from(pid).ok().filter(|p| *p > 0)?;
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is valid for buf.len() bytes and proc_pidpath writes at most that.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..n as usize])))
}

#[cfg(target_os = "linux")]
fn process_exe(pid: u32) -> Option<PathBuf> {
    if pid == 0 {
        return None;
    }
    std::fs::read_link(format!("/proc/{}/exe", pid)).ok()
}

/// Windows does not bundle Ollama, so there is never an installed binary to match.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_exe(_pid: u32) -> Option<PathBuf> {
    None
}

/// True only if `pid` is a live process running exactly `installed_binary`.
/// A user's own Ollama (Homebrew, Ollama.app, a system package) runs from a
/// different path and is never matched.
fn is_app_ollama(pid: u32, installed_binary: &Path) -> bool {
    let (Some(exe), Ok(installed)) = (process_exe(pid), std::fs::canonicalize(installed_binary)) else {
        return false;
    };
    std::fs::canonicalize(&exe).map(|e| e == installed).unwrap_or(false)
}

/// Read a previous run's PID file. Returns the PID if it names a live Ollama
/// running from `installed_binary`; otherwise deletes the stale file.
fn adopt_from_pid_file(pid_file: &Path, installed_binary: &Path) -> Option<u32> {
    if !pid_file.exists() {
        return None;
    }
    match read_pid_file(pid_file) {
        Some(pid) if is_app_ollama(pid, installed_binary) => Some(pid),
        _ => {
            let _ = std::fs::remove_file(pid_file);
            None
        }
    }
}

/// At startup: if an Ollama this app started survived a crash, take it back
/// so Stop (and the window-close handler) can end it.
pub fn adopt_orphaned_ollama() {
    let (Ok(pid_file), Ok(binary)) = (pid_file_path(), ollama_binary_path()) else {
        return;
    };
    if let Some(pid) = adopt_from_pid_file(&pid_file, &binary) {
        if let Ok(mut guard) = OLLAMA_PID.lock() {
            if guard.is_none() {
                *guard = Some(pid);
                ADOPTED.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// Kill ONLY the Ollama process this app spawned (or adopted from its own PID
/// file), if any. Takes the stored PID so it runs at most once. Never touches an
/// Ollama the user started themselves (no pkill "ollama serve"). Returns true if
/// a process was signalled.
pub fn kill_spawned_ollama() -> bool {
    let pid = OLLAMA_PID.lock().ok().and_then(|mut guard| guard.take());
    let adopted = ADOPTED.swap(false, Ordering::SeqCst);
    let pid_file = pid_file_path().ok();
    match pid {
        Some(pid) => {
            if adopted {
                // Nothing reaps an adopted process, so its PID may have been reused.
                let still_ours = ollama_binary_path()
                    .map(|bin| is_app_ollama(pid, &bin))
                    .unwrap_or(false);
                if !still_ours {
                    if let Some(f) = &pid_file {
                        remove_pid_file_if(f, pid);
                    }
                    return false;
                }
            }
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = crate::whisper::std_command("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
            if let Some(f) = &pid_file {
                remove_pid_file_if(f, pid);
            }
            true
        }
        None => false,
    }
}

#[tauri::command]
pub async fn ollama_stop() -> Result<String, String> {
    if !kill_spawned_ollama() {
        return Ok("Ollama was not started by this app; leaving it running".to_string());
    }
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if !is_running(OLLAMA_DEFAULT_BASE).await {
            return Ok("Ollama stopped".to_string());
        }
    }
    Ok("Ollama stop signal sent".to_string())
}

// ---- Pinned install ----

/// Ollama release the app installs: v0.40.16, published 2026-11-09, pinned
/// 2026-11-12. Sizes and SHA-256 digests are the `size` and `digest` fields of
/// `https://api.github.com/repos/ollama/ollama/releases/tags/v0.40.16`. The
/// macOS zip was also downloaded and checked with `shasum -a 256`; the Linux
/// tarballs (over 1.5 GB each) were not downloaded, their digests are the API's.
/// Bump the version, URLs, sizes and digests together.
#[cfg_attr(windows, allow(dead_code))]
const OLLAMA_VERSION: &str = "v0.40.16";

#[cfg_attr(windows, allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
enum OllamaArchive {
    /// `Ollama-darwin.zip`: the runtime is `Ollama.app/Contents/Resources/`.
    MacAppZip,
    /// `ollama-linux-*.tar.zst`: the runtime is the `bin/` and `lib/` tree.
    LinuxTarZst,
}

#[cfg_attr(windows, allow(dead_code))]
#[derive(Debug)]
struct OllamaAsset {
    os: &'static str,
    arch: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
    archive: OllamaArchive,
}

/// Downloads by (std::env::consts::OS, ARCH). The macOS zip holds a universal
/// (x86_64 + arm64) binary. Windows is absent: the app asks Windows users to
/// install Ollama themselves.
#[cfg_attr(windows, allow(dead_code))]
const OLLAMA_ASSETS: &[OllamaAsset] = &[
    OllamaAsset {
        os: "macos", arch: "aarch64",
        url: "https://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip",
        size: 229_245_253,
        sha256: "4715531bc49d21337381b193765041e535a9fb4716f84e5d6eccc3a9af1b5303",
        archive: OllamaArchive::MacAppZip,
    },
    OllamaAsset {
        os: "macos", arch: "x86_64",
        url: "https://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip",
        size: 229_245_253,
        sha256: "4715531bc49d21337381b193765041e535a9fb4716f84e5d6eccc3a9af1b5303",
        archive: OllamaArchive::MacAppZip,
    },
    OllamaAsset {
        os: "linux", arch: "x86_64",
        url: "https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-linux-amd64.tar.zst",
        size: 1_545_767_640,
        sha256: "87bfafb2acbc89b2e6a1be0a9043de6aa75fb450696f86bc426e65fc448f788d",
        archive: OllamaArchive::LinuxTarZst,
    },
    OllamaAsset {
        os: "linux", arch: "aarch64",
        url: "https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-linux-arm64.tar.zst",
        size: 1_600_610_073,
        sha256: "e45b8e6dcb86cb9f3057396351655079c9a4879b4ced2678c9350d375dcbc224",
        archive: OllamaArchive::LinuxTarZst,
    },
];

#[cfg_attr(windows, allow(dead_code))]
fn ollama_asset_for(os: &str, arch: &str) -> Option<&'static OllamaAsset> {
    OLLAMA_ASSETS.iter().find(|a| a.os == os && a.arch == arch)
}

/// Longest wait for the next chunk of any download or of the model pull
/// stream. There is no overall deadline: a 9.6 GB model on a slow line is fine
/// as long as bytes keep arriving. (The shared download client also sets a
/// 30 s connect timeout and the same per-read timeout.)
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// An error and its sources, so "error decoding response body" also says why
/// (for example "operation timed out").
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        source = s.source();
    }
    msg
}

/// The next item of `stream`, failing if nothing arrives within `idle`.
async fn next_chunk<S, B, E>(stream: &mut S, idle: Duration) -> Result<Option<B>, String>
where
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    E: std::error::Error,
{
    use futures::StreamExt;
    match tokio::time::timeout(idle, stream.next()).await {
        Err(_) => Err(format!("No data received for {} seconds; the connection stalled", idle.as_secs())),
        Ok(None) => Ok(None),
        Ok(Some(Err(e))) => Err(format!("Stream error: {}", error_chain(&e))),
        Ok(Some(Ok(chunk))) => Ok(Some(chunk)),
    }
}

/// Stream `stream` into `<dest>.partial` while hashing it, then rename it to
/// `dest` only if the size and SHA-256 match. Nothing is kept on failure.
#[cfg_attr(windows, allow(dead_code))]
async fn stream_to_verified_file<S, B, E>(
    mut stream: S,
    dest: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String>
where
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::error::Error,
{
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let partial = dest.with_extension("partial");
    let result = async {
        let mut file = std::fs::File::create(&partial).map_err(|e| format!("File error: {}", e))?;
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        while let Some(chunk) = next_chunk(&mut stream, IDLE_TIMEOUT).await? {
            let chunk = chunk.as_ref();
            file.write_all(chunk).map_err(|e| format!("Write error: {}", e))?;
            hasher.update(chunk);
            written += chunk.len() as u64;
            if written > expected_size {
                return Err(format!("Download is larger than the expected {} bytes", expected_size));
            }
        }
        file.flush().map_err(|e| format!("Write error: {}", e))?;
        if written != expected_size {
            return Err(format!(
                "Download ended early: got {} of {} bytes",
                written, expected_size
            ));
        }
        Ok(hex_digest(&hasher.finalize()))
    }
    .await;
    match result {
        Ok(actual_hex) => finalize_model_download(&partial, dest, &actual_hex, expected_sha256),
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(e)
        }
    }
}

/// True if a symlink at `link` (relative to the extraction root, plain
/// components only) pointing at `target` resolves inside the root.
#[cfg_attr(windows, allow(dead_code))]
fn symlink_stays_inside(link: &Path, target: &Path) -> bool {
    use std::path::Component;
    let mut depth = match link.parent() {
        Some(parent) => parent.components().count() as i64,
        None => 0,
    };
    for c in target.components() {
        match c {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    true
}

/// Extract the macOS app zip into `dest`. The zip extraction itself is the
/// shared `extract_zip` (zip-slip guarded); it writes symlink entries as small
/// files holding the link text, so each symlink entry is then recreated as a
/// real symlink. The runtime needs them: `llama-server` loads its libraries
/// through names like `libllama.0.dylib -> libllama.0.9.0.dylib`.
#[cfg_attr(not(unix), allow(dead_code))]
fn extract_app_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    crate::whisper_local::extract_zip(archive, dest)?;
    #[cfg(unix)]
    {
        use std::io::Read;
        let file = std::fs::File::open(archive).map_err(|e| format!("Zip open error: {}", e))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Zip read error: {}", e))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| format!("Zip entry error: {}", e))?;
            if !entry.is_symlink() {
                continue;
            }
            let rel = entry
                .enclosed_name()
                .ok_or_else(|| format!("Zip entry has unsafe path: {}", entry.name()))?;
            let mut target = String::new();
            entry
                .read_to_string(&mut target)
                .map_err(|e| format!("Zip symlink read error: {}", e))?;
            let target = PathBuf::from(target);
            if !symlink_stays_inside(&rel, &target) {
                return Err(format!("Zip symlink points outside the archive: {}", entry.name()));
            }
            let link = dest.join(&rel);
            std::fs::remove_file(&link).map_err(|e| format!("Symlink error: {}", e))?;
            std::os::unix::fs::symlink(&target, &link).map_err(|e| format!("Symlink error: {}", e))?;
        }
    }
    Ok(())
}

/// Reads every zstd frame of `src` in turn (ruzstd's decoder stops after one).
#[cfg_attr(windows, allow(dead_code))]
struct ZstdFrames<R: std::io::BufRead> {
    decoder: Option<ruzstd::decoding::StreamingDecoder<R, ruzstd::decoding::FrameDecoder>>,
}

impl<R: std::io::BufRead> ZstdFrames<R> {
    #[cfg_attr(windows, allow(dead_code))]
    fn new(src: R) -> std::io::Result<Self> {
        let decoder = ruzstd::decoding::StreamingDecoder::new(src)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        Ok(Self { decoder: Some(decoder) })
    }
}

impl<R: std::io::BufRead> std::io::Read for ZstdFrames<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let Some(decoder) = self.decoder.as_mut() else { return Ok(0) };
            let n = decoder.read(buf)?;
            if n > 0 || buf.is_empty() {
                return Ok(n);
            }
            let mut src = self.decoder.take().expect("decoder present").into_inner();
            if src.fill_buf()?.is_empty() {
                return Ok(0);
            }
            self.decoder = Some(
                ruzstd::decoding::StreamingDecoder::new(src)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?,
            );
        }
    }
}

/// Extract the `bin/` and `lib/` tree of a Linux `.tar.zst` into `dest`,
/// in-process (no system `zstd` or `tar`). Fails closed on any entry whose
/// path is not plain relative components, on a symlink that leaves the tree,
/// and on entry types other than files, directories, symlinks and hard links.
#[cfg_attr(windows, allow(dead_code))]
fn extract_linux_runtime(archive: &Path, dest: &Path) -> Result<(), String> {
    use std::path::Component;
    use tar::EntryType;
    let file = std::fs::File::open(archive).map_err(|e| format!("Archive open error: {}", e))?;
    let zst = ZstdFrames::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Not a zstd archive: {}", e))?;
    let mut tar = tar::Archive::new(zst);
    tar.set_preserve_permissions(false);
    tar.set_unpack_xattrs(false);
    std::fs::create_dir_all(dest).map_err(|e| format!("Mkdir error: {}", e))?;
    for entry in tar.entries().map_err(|e| format!("Archive read error: {}", e))? {
        let mut entry = entry.map_err(|e| format!("Archive read error: {}", e))?;
        let path = entry.path().map_err(|e| format!("Archive path error: {}", e))?.into_owned();
        let parts: Vec<Component> = path.components().filter(|c| *c != Component::CurDir).collect();
        if parts.iter().any(|c| !matches!(c, Component::Normal(_))) {
            return Err(format!("Archive entry has unsafe path, aborting: {}", path.display()));
        }
        let rel: PathBuf = parts.iter().collect();
        let top = rel.components().next().and_then(|c| c.as_os_str().to_str()).unwrap_or("");
        if top != "bin" && top != "lib" {
            continue;
        }
        match entry.header().entry_type() {
            EntryType::Regular | EntryType::Directory => {}
            EntryType::Symlink => {
                let target = entry
                    .link_name()
                    .map_err(|e| format!("Archive link error: {}", e))?
                    .ok_or_else(|| format!("Symlink without target: {}", rel.display()))?
                    .into_owned();
                if !symlink_stays_inside(&rel, &target) {
                    return Err(format!("Archive symlink points outside the runtime: {}", rel.display()));
                }
            }
            EntryType::Link => {
                // A hard link names another archive entry, relative to the root.
                let target = entry
                    .link_name()
                    .map_err(|e| format!("Archive link error: {}", e))?
                    .ok_or_else(|| format!("Hard link without target: {}", rel.display()))?
                    .into_owned();
                let plain = target.components().all(|c| matches!(c, Component::Normal(_)));
                let target_top = target.components().next().and_then(|c| c.as_os_str().to_str());
                if !plain || !matches!(target_top, Some("bin") | Some("lib")) {
                    return Err(format!("Archive hard link points outside the runtime: {}", rel.display()));
                }
            }
            other => {
                return Err(format!("Archive entry {} has unsupported type {:?}", rel.display(), other));
            }
        }
        let unpacked = entry
            .unpack_in(dest)
            .map_err(|e| format!("Extract error for {}: {}", rel.display(), e))?;
        if !unpacked {
            return Err(format!("Archive entry escapes the install directory: {}", rel.display()));
        }
    }
    Ok(())
}

/// Check a staged runtime works: the binary runs (`ollama --version`) and, on
/// macOS, its code signature verifies.
#[cfg_attr(windows, allow(dead_code))]
async fn verify_runtime_binary(binary: &Path) -> Result<(), String> {
    let never_cancelled = AtomicBool::new(false);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let step = |e: StepError| match e {
        StepError::Failed(msg) => msg,
        StepError::TimedOut => "timed out".to_string(),
        StepError::Cancelled => "cancelled".to_string(),
    };

    let mut version = tokio_command(binary);
    version.arg("--version");
    // Point the client half at a closed port so it never talks to a user's server.
    version.env("OLLAMA_HOST", "127.0.0.1:9");
    let out = run_child(version, deadline, &never_cancelled)
        .await
        .map_err(|e| format!("Installed Ollama did not run: {}", step(e)))?;
    if !out.status.success() {
        return Err(format!(
            "Installed Ollama did not run ({}): {}",
            out.status,
            stderr_tail(&out.stderr, 1000)
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let codesign = Path::new("/usr/bin/codesign");
        if codesign.exists() {
            let mut verify = tokio_command(codesign);
            verify.arg("--verify").arg(binary);
            let out = run_child(verify, deadline, &never_cancelled)
                .await
                .map_err(|e| format!("codesign --verify failed: {}", step(e)))?;
            if !out.status.success() {
                return Err(format!(
                    "Installed Ollama failed its code signature check: {}",
                    stderr_tail(&out.stderr, 1000)
                ));
            }
        }
    }
    Ok(())
}

/// Replace `dest` with `staged` (both in the same directory). The old runtime
/// is kept aside until the new one is in place, and restored if that fails.
#[cfg_attr(windows, allow(dead_code))]
fn swap_into_place(staged: &Path, dest: &Path) -> Result<(), String> {
    let old = dest.with_extension("old");
    if old.exists() {
        std::fs::remove_dir_all(&old).map_err(|e| format!("Cleanup error: {}", e))?;
    }
    let had_old = dest.exists();
    if had_old {
        std::fs::rename(dest, &old).map_err(|e| format!("Could not replace {}: {}", dest.display(), e))?;
    }
    if let Err(e) = std::fs::rename(staged, dest) {
        if had_old {
            let _ = std::fs::rename(&old, dest);
        }
        return Err(format!("Finalize error: {}", e));
    }
    if had_old {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(())
}

/// Download, verify, extract and check the pinned runtime in a temp directory
/// inside `dir`, then move it to `runtime`. A failure at any step leaves the
/// existing runtime (if any) untouched and removes the temp directory.
#[cfg_attr(windows, allow(dead_code))]
async fn install_runtime(asset: &OllamaAsset, dir: &Path, runtime: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create ollama dir: {}", e))?;
    let work = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(dir)
        .map_err(|e| format!("Temp dir error: {}", e))?;

    let client = download_client()?;
    let resp = client.get(asset.url).send().await.map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed with status {}", resp.status()));
    }
    let archive = work.path().join("ollama-archive");
    stream_to_verified_file(resp.bytes_stream(), &archive, asset.size, asset.sha256).await?;
    install_from_verified_archive(asset.archive, &archive, work.path(), runtime).await
}

/// Extract an archive whose hash has already been checked into `work`,
/// check the binary runs, then move the runtime to `runtime`.
#[cfg_attr(windows, allow(dead_code))]
async fn install_from_verified_archive(
    kind: OllamaArchive,
    archive: &Path,
    work: &Path,
    runtime: &Path,
) -> Result<(), String> {
    let staged = work.join("runtime");
    let (archive_c, work_c, staged_c) = (archive.to_path_buf(), work.to_path_buf(), staged.clone());
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        match kind {
            OllamaArchive::MacAppZip => {
                let extracted = work_c.join("extracted");
                extract_app_zip(&archive_c, &extracted)?;
                let resources = extracted.join("Ollama.app").join("Contents").join("Resources");
                if !resources.join("ollama").is_file() {
                    return Err("Could not find Ollama.app/Contents/Resources/ollama in the download".to_string());
                }
                std::fs::rename(&resources, &staged_c).map_err(|e| format!("Stage error: {}", e))
            }
            OllamaArchive::LinuxTarZst => {
                extract_linux_runtime(&archive_c, &staged_c)?;
                if !staged_c.join("bin").join("ollama").is_file() {
                    return Err("Could not find bin/ollama in the download".to_string());
                }
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| format!("Extract task failed: {}", e))??;
    let _ = std::fs::remove_file(archive);

    let binary = runtime_binary(&staged);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set permissions: {}", e))?;
    }
    verify_runtime_binary(&binary).await?;

    swap_into_place(&staged, runtime)
}

#[tauri::command]
pub async fn ollama_install() -> Result<String, String> {
    // Windows: bundled install not supported, tell user to install manually
    #[cfg(target_os = "windows")]
    return Err("Windows: Please download Ollama from https://ollama.com/download and install manually.".to_string());

    #[cfg(not(target_os = "windows"))]
    {
        let asset = ollama_asset_for(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| {
            format!(
                "No Ollama download for {} {}. Install Ollama from https://ollama.com/download",
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        })?;
        let dir = ollama_dir()?;
        install_runtime(asset, &dir, &ollama_runtime_dir()?).await?;
        if let Ok(legacy) = legacy_binary_path() {
            let _ = std::fs::remove_file(legacy);
        }
        std::fs::create_dir_all(ollama_models_dir()?).map_err(|e| format!("Failed to create models dir: {}", e))?;
        Ok(format!("Ollama {} installed successfully", OLLAMA_VERSION))
    }
}

#[tauri::command]
pub async fn ollama_uninstall() -> Result<String, String> {
    ollama_stop().await?;
    let dir = ollama_dir()?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove ollama directory: {}", e))?;
    }
    Ok("Ollama uninstalled".to_string())
}

// ---- Model pull ----

/// One parsed line of Ollama's `/api/pull` stream.
#[derive(Debug, PartialEq)]
enum PullLine {
    Progress { completed: u64, total: u64, status: String },
    Error(String),
}

fn parse_pull_line(line: &str) -> Option<PullLine> {
    let json = serde_json::from_str::<serde_json::Value>(line).ok()?;
    if let Some(err) = json.get("error") {
        let msg = err.as_str().map(|s| s.to_string()).unwrap_or_else(|| err.to_string());
        return Some(PullLine::Error(msg));
    }
    Some(PullLine::Progress {
        completed: json["completed"].as_u64().unwrap_or(0),
        total: json["total"].as_u64().unwrap_or(0),
        status: json["status"].as_str().unwrap_or("").to_string(),
    })
}

/// Read Ollama's pull stream (HTTP 200 and JSON lines either way), reporting
/// each progress line. Ok only if the stream ends with `{"status":"success"}`;
/// an `error` line, a stall, or an early end is an Err.
async fn consume_pull_stream<S, B, E>(
    mut stream: S,
    idle: Duration,
    mut on_progress: impl FnMut(u64, u64, &str),
) -> Result<(), String>
where
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::error::Error,
{
    let mut buffer: Vec<u8> = Vec::new();
    let mut succeeded = false;
    let mut handle = |raw: &[u8], succeeded: &mut bool| -> Result<(), String> {
        let line = String::from_utf8_lossy(raw);
        let line = line.trim();
        if line.is_empty() {
            return Ok(());
        }
        match parse_pull_line(line) {
            Some(PullLine::Error(msg)) => Err(format!("Pull failed: {}", msg)),
            Some(PullLine::Progress { completed, total, status }) => {
                on_progress(completed, total, &status);
                *succeeded = status == "success";
                Ok(())
            }
            None => Ok(()),
        }
    };

    loop {
        let chunk = next_chunk(&mut stream, idle)
            .await
            .map_err(|e| format!("Pull failed: {}", e))?;
        let Some(chunk) = chunk else { break };
        buffer.extend_from_slice(chunk.as_ref());
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            handle(&line, &mut succeeded)?;
        }
        // Only a partial line remains; guard against unbounded growth from a
        // pathological newline-less line.
        if buffer.len() > 1_000_000 {
            buffer.clear();
        }
    }
    // The last line may arrive without a trailing newline.
    handle(&buffer, &mut succeeded)?;

    if succeeded {
        Ok(())
    } else {
        Err("Pull failed: Ollama ended the download without confirming it finished. The model may be incomplete; try again.".to_string())
    }
}

#[tauri::command]
pub async fn ollama_pull_model(app_handle: tauri::AppHandle, model_name: String, base_url: Option<String>) -> Result<String, String> {
    let base = effective_base(base_url.as_deref().unwrap_or(""));
    let model_name = model_name.trim().to_string();
    if !is_valid_model_name(&model_name) {
        return Err("Invalid model name".to_string());
    }
    if !is_running(&base).await {
        return Err("Ollama is not running. Start it first.".to_string());
    }
    // Connect and idle timeouts only: a 9.6 GB model on a slow line is fine.
    let client = download_client()?;
    let resp = client
        .post(format!("{}/api/pull", base))
        .json(&serde_json::json!({ "name": model_name, "stream": true }))
        .send().await
        .map_err(|e| format!("Pull failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        let msg = match parse_pull_line(text.trim()) {
            Some(PullLine::Error(msg)) => msg,
            _ => text,
        };
        return Err(format!("Pull failed: {}", msg));
    }

    consume_pull_stream(resp.bytes_stream(), IDLE_TIMEOUT, |completed, total, status| {
        let _ = app_handle.emit("ollama-pull-progress", serde_json::json!({
            "completed": completed,
            "total": total,
            "status": status,
            "model": model_name,
        }));
    })
    .await?;

    Ok(format!("Model '{}' pulled successfully", model_name))
}

#[tauri::command]
pub async fn ollama_delete_model(model_name: String, base_url: Option<String>) -> Result<String, String> {
    let base = effective_base(base_url.as_deref().unwrap_or(""));
    if !is_running(&base).await {
        return Err("Ollama is not running".to_string());
    }
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{}/api/delete", base))
        .json(&serde_json::json!({ "name": model_name }))
        .send().await
        .map_err(|e| format!("Delete failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Delete failed: {}", text));
    }
    Ok(format!("Model '{}' deleted", model_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_model_names_accept_real_forms() {
        assert!(is_valid_model_name("qwen3:4b"));
        assert!(is_valid_model_name("gemma4:e2b"));
        assert!(is_valid_model_name("llama3.2:3b"));
        assert!(is_valid_model_name("hf.co/user/model-name:Q4_K_M"));
        assert!(is_valid_model_name("library/phi4-mini"));
    }

    #[test]
    fn invalid_model_names_rejected() {
        assert!(!is_valid_model_name(""));
        assert!(!is_valid_model_name("model; rm -rf /"));
        assert!(!is_valid_model_name("model name")); // whitespace
        assert!(!is_valid_model_name("bad$(whoami)"));
        assert!(!is_valid_model_name("../etc/passwd"));
        assert!(!is_valid_model_name("model|pipe"));
    }

    #[test]
    fn localhost_detection_parses_the_host() {
        assert!(is_localhost("http://[::1]:11434"));
        assert!(is_localhost("http://127.0.0.2:11434"));
        assert!(is_localhost("127.0.0.1:11434"), "scheme-less local base");
        assert!(!is_localhost("http://localhost.evil.com:11434"));
        assert!(!is_localhost("http://evil.com/?h=127.0.0.1"));
        assert!(!is_localhost("http://127.0.0.1.nip.io"));
        assert!(!is_localhost("http://user@evil.com#localhost"));
    }

    #[test]
    fn spawned_ollama_only_allows_app_origins() {
        assert!(!OLLAMA_APP_ORIGINS.contains('*'));
        for o in OLLAMA_APP_ORIGINS.split(',') {
            assert!(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].contains(&o), "{o}");
        }
    }

    #[test]
    fn reaped_pid_is_cleared_only_if_still_ours() {
        *OLLAMA_PID.lock().unwrap() = Some(4242);
        clear_pid_if(1111);
        assert_eq!(*OLLAMA_PID.lock().unwrap(), Some(4242));
        clear_pid_if(4242);
        assert_eq!(*OLLAMA_PID.lock().unwrap(), None);
    }

    #[test]
    fn localhost_detection() {
        assert!(is_localhost("http://127.0.0.1:11434"));
        assert!(is_localhost("http://localhost:11434"));
        assert!(!is_localhost("http://192.168.1.50:11434"));
        assert!(!is_localhost("https://ollama.example.com"));
    }

    // ---- Model pull ----

    fn chunks(parts: &[&str]) -> impl futures::Stream<Item = Result<Vec<u8>, std::io::Error>> + Unpin {
        futures::stream::iter(parts.iter().map(|p| Ok(p.as_bytes().to_vec())).collect::<Vec<_>>())
    }

    async fn pull(parts: &[&str]) -> (Result<(), String>, Vec<String>) {
        let mut statuses = Vec::new();
        let result = consume_pull_stream(chunks(parts), IDLE_TIMEOUT, |_, _, s| statuses.push(s.to_string())).await;
        (result, statuses)
    }

    #[tokio::test]
    async fn pull_error_line_is_an_error() {
        let (result, _) = pull(&["{\"status\":\"pulling manifest\"}\n", "{\"error\":\"model not found\"}\n"]).await;
        let err = result.expect_err("an error line must fail the pull");
        assert!(err.contains("model not found"), "{err}");

        let (result, statuses) = pull(&[
            "{\"status\":\"pulling manifest\"}\n",
            "{\"status\":\"downloading\",\"completed\":10,\"total\":100}\n",
        ])
        .await;
        assert!(result.is_err(), "a stream that ends without success must fail");
        assert_eq!(statuses, vec!["pulling manifest", "downloading"], "progress events still flow");
    }

    #[tokio::test]
    async fn pull_success_line_is_ok_even_split_and_without_newline() {
        let (result, statuses) = pull(&["{\"status\":\"verifying sha", "256 digest\"}\n{\"status\":\"succ", "ess\"}"]).await;
        assert_eq!(result, Ok(()));
        assert_eq!(statuses, vec!["verifying sha256 digest", "success"]);
    }

    #[tokio::test]
    async fn pull_stream_that_stalls_fails() {
        use futures::StreamExt;
        let stalled = chunks(&["{\"status\":\"downloading\"}\n"]).chain(futures::stream::pending());
        let result = consume_pull_stream(Box::pin(stalled), Duration::from_millis(50), |_, _, _| {}).await;
        assert!(result.unwrap_err().contains("No data received"));
    }

    // ---- Pinned install ----

    #[test]
    fn ollama_assets_are_pinned_to_one_release() {
        for a in OLLAMA_ASSETS {
            assert!(a.url.starts_with("https://github.com/ollama/ollama/releases/download/"), "{}", a.url);
            assert!(a.url.contains(&format!("/{}/", OLLAMA_VERSION)), "{}", a.url);
            assert!(!a.url.contains("latest"), "{}", a.url);
            assert_eq!(a.sha256.len(), 64);
            assert!(a.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(a.size > 100_000_000);
        }
        for (os, arch) in [("macos", "aarch64"), ("macos", "x86_64"), ("linux", "x86_64"), ("linux", "aarch64")] {
            assert!(ollama_asset_for(os, arch).is_some(), "{os} {arch}");
        }
        assert!(ollama_asset_for("windows", "x86_64").is_none(), "Windows does not bundle Ollama");
    }

    fn one_chunk(bytes: &[u8]) -> impl futures::Stream<Item = Result<Vec<u8>, std::io::Error>> + Unpin {
        futures::stream::iter(vec![Ok(bytes.to_vec())])
    }

    fn sha_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        hex_digest(&Sha256::digest(bytes))
    }

    #[tokio::test]
    async fn download_is_kept_only_when_size_and_hash_match() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("archive");
        let body = b"ollama runtime bytes";

        let err = stream_to_verified_file(one_chunk(body), &dest, body.len() as u64, &"0".repeat(64)).await;
        assert!(err.unwrap_err().contains("Checksum mismatch"));
        assert!(!dest.exists() && !dest.with_extension("partial").exists());

        let err = stream_to_verified_file(one_chunk(body), &dest, body.len() as u64 + 1, &sha_hex(body)).await;
        assert!(err.unwrap_err().contains("ended early"));
        assert!(!dest.exists() && !dest.with_extension("partial").exists());

        stream_to_verified_file(one_chunk(body), &dest, body.len() as u64, &sha_hex(body)).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!dest.with_extension("partial").exists());
    }

    #[test]
    fn symlinks_must_stay_inside_the_runtime() {
        assert!(symlink_stays_inside(Path::new("lib/ollama/libcudart.so.12"), Path::new("libcudart.so.12.8.90")));
        assert!(symlink_stays_inside(Path::new("bin/x"), Path::new("../lib/ollama/x")));
        assert!(!symlink_stays_inside(Path::new("bin/x"), Path::new("../../etc/passwd")));
        assert!(!symlink_stays_inside(Path::new("x"), Path::new("/etc/passwd")));
        assert!(!symlink_stays_inside(Path::new("libx.dylib"), Path::new("../outside")));
    }

    fn tar_bytes(build: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        build(&mut b);
        b.into_inner().unwrap()
    }

    fn add_file(b: &mut tar::Builder<Vec<u8>>, path: &str, data: &[u8], mode: u32) {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(mode);
        h.set_entry_type(tar::EntryType::Regular);
        b.append_data(&mut h, path, data).unwrap();
    }

    fn add_symlink(b: &mut tar::Builder<Vec<u8>>, path: &str, target: &str) {
        let mut h = tar::Header::new_gnu();
        h.set_size(0);
        h.set_mode(0o777);
        h.set_entry_type(tar::EntryType::Symlink);
        b.append_link(&mut h, path, target).unwrap();
    }

    fn zst(data: &[u8]) -> Vec<u8> {
        ruzstd::encoding::compress_to_vec(data, ruzstd::encoding::CompressionLevel::Fastest)
    }

    #[test]
    fn linux_runtime_extracts_bin_and_lib_with_symlinks() {
        let tar = tar_bytes(|b| {
            add_file(b, "bin/ollama", b"\x7FELF fake", 0o755);
            add_file(b, "lib/ollama/libggml.so.1", b"lib", 0o644);
            add_symlink(b, "lib/ollama/libggml.so", "libggml.so.1");
            add_file(b, "README.md", b"not part of the runtime", 0o644);
        });
        // Two zstd frames back to back, split mid-archive: both must be read.
        let (a, b) = tar.split_at(tar.len() / 2);
        let mut archive_bytes = zst(a);
        archive_bytes.extend(zst(b));

        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.tar.zst");
        std::fs::write(&archive, archive_bytes).unwrap();
        let dest = dir.path().join("runtime");
        extract_linux_runtime(&archive, &dest).unwrap();

        assert_eq!(std::fs::read(dest.join("bin/ollama")).unwrap(), b"\x7FELF fake");
        assert_eq!(std::fs::read(dest.join("lib/ollama/libggml.so")).unwrap(), b"lib");
        assert!(std::fs::symlink_metadata(dest.join("lib/ollama/libggml.so")).unwrap().file_type().is_symlink());
        assert!(!dest.join("README.md").exists());
    }

    #[test]
    fn linux_runtime_rejects_escaping_symlink() {
        let tar = tar_bytes(|b| {
            add_file(b, "bin/ollama", b"x", 0o755);
            add_symlink(b, "lib/ollama/evil", "../../../etc/passwd");
        });
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.tar.zst");
        std::fs::write(&archive, zst(&tar)).unwrap();
        let err = extract_linux_runtime(&archive, &dir.path().join("runtime")).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn app_zip_keeps_symlinks_as_symlinks() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("Ollama-darwin.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(0o755);
            z.start_file("Ollama.app/Contents/Resources/libllama.0.9.0.dylib", opts).unwrap();
            z.write_all(b"dylib").unwrap();
            z.add_symlink("Ollama.app/Contents/Resources/libllama.0.dylib", "libllama.0.9.0.dylib", opts).unwrap();
            z.finish().unwrap();
        }
        let dest = dir.path().join("x");
        extract_app_zip(&archive, &dest).unwrap();
        let link = dest.join("Ollama.app/Contents/Resources/libllama.0.dylib");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&link).unwrap(), b"dylib");
    }

    #[test]
    fn swap_replaces_the_runtime_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (staged, dest) = (dir.path().join("staged"), dir.path().join("runtime"));
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("new"), b"n").unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("old"), b"o").unwrap();
        swap_into_place(&staged, &dest).unwrap();
        assert!(dest.join("new").exists() && !dest.join("old").exists());
        assert!(!staged.exists() && !dest.with_extension("old").exists());
    }

    // ---- Orphan adoption ----

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn pid_file_for_our_installed_binary_is_adopted() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("ollama.pid");
        std::fs::write(&pid_file, std::process::id().to_string()).unwrap();
        // This test process plays the part of the app's installed Ollama.
        let me = std::env::current_exe().unwrap();
        assert_eq!(adopt_from_pid_file(&pid_file, &me), Some(std::process::id()));
        assert!(pid_file.exists());
    }

    #[test]
    fn user_ollama_is_never_adopted() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("ollama.pid");
        // A live process running a different executable (the user's own Ollama).
        let installed = dir.path().join("runtime").join("ollama");
        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::write(&installed, b"x").unwrap();
        std::fs::write(&pid_file, std::process::id().to_string()).unwrap();
        assert_eq!(adopt_from_pid_file(&pid_file, &installed), None);
        assert!(!pid_file.exists(), "a stale PID file is deleted");

        // Garbage and dead PIDs are stale too.
        std::fs::write(&pid_file, "not a pid").unwrap();
        assert_eq!(adopt_from_pid_file(&pid_file, &installed), None);
        assert!(!pid_file.exists());
        std::fs::write(&pid_file, "0").unwrap();
        assert_eq!(adopt_from_pid_file(&pid_file, &installed), None);
        assert!(!pid_file.exists());
    }

    #[test]
    fn pid_file_is_removed_only_for_its_own_pid() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("ollama.pid");
        std::fs::write(&pid_file, "4242").unwrap();
        remove_pid_file_if(&pid_file, 1111);
        assert!(pid_file.exists());
        remove_pid_file_if(&pid_file, 4242);
        assert!(!pid_file.exists());
    }

    /// Real end-to-end install of the pinned release for this platform into a
    /// temp dir (downloads hundreds of MB from GitHub, or set OLLAMA_TEST_ARCHIVE
    /// to a local copy of the asset). Run with
    /// `cargo test real_pinned_install -- --ignored`.
    #[cfg(not(windows))]
    #[tokio::test]
    #[ignore]
    async fn real_pinned_install() {
        let asset = ollama_asset_for(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        match std::env::var("OLLAMA_TEST_ARCHIVE") {
            // A copy of the pinned asset fetched earlier: same hash check, no download.
            Ok(local) => {
                let work = tempfile::Builder::new().prefix(".install-").tempdir_in(dir.path()).unwrap();
                let bytes = std::fs::read(local).unwrap();
                let parts: Vec<Result<Vec<u8>, std::io::Error>> =
                    bytes.chunks(1 << 20).map(|c| Ok(c.to_vec())).collect();
                let archive = work.path().join("ollama-archive");
                stream_to_verified_file(futures::stream::iter(parts), &archive, asset.size, asset.sha256)
                    .await
                    .unwrap();
                install_from_verified_archive(asset.archive, &archive, work.path(), &runtime).await.unwrap();
            }
            Err(_) => install_runtime(asset, dir.path(), &runtime).await.unwrap(),
        }
        assert!(runtime_binary(&runtime).is_file());
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("runtime")], "no staging left behind");
        if let Ok(keep) = std::env::var("OLLAMA_TEST_KEEP") {
            let _ = std::fs::rename(&runtime, keep);
        }
    }

    /// Real pull against a running Ollama at OLLAMA_TEST_BASE (pulls a ~46 MB
    /// model). Run with `cargo test real_pull_result -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_pull_result() {
        let base = std::env::var("OLLAMA_TEST_BASE").expect("set OLLAMA_TEST_BASE");
        let client = download_client().unwrap();
        for (model, should_succeed) in [("no-such-model-xyz:latest", false), ("all-minilm:22m", true)] {
            let resp = client
                .post(format!("{}/api/pull", base))
                .json(&serde_json::json!({ "name": model, "stream": true }))
                .send()
                .await
                .unwrap();
            assert!(resp.status().is_success(), "Ollama answers 200 even for a failed pull");
            let result = consume_pull_stream(resp.bytes_stream(), IDLE_TIMEOUT, |_, _, _| {}).await;
            eprintln!("{model}: {result:?}");
            assert_eq!(result.is_ok(), should_succeed, "{model}: {result:?}");
        }
    }
}
