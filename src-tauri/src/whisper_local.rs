// src-tauri/src/whisper_local.rs
// Local whisper.cpp manager - download binary + models, transcribe locally
// Follows the same pattern as ollama.rs

use crate::whisper::{run_child, std_command, stderr_tail, tokio_command, StepError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::time::Instant;

/// Models come from this Hugging Face commit of ggerganov/whisper.cpp (the
/// repo head on 2026-11-12, last changed 2024-10-29), never from `main`, so a
/// file can't change under its pinned hash. Bump with the hashes below.
const MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve";

fn model_download_url(filename: &str) -> String {
    format!("{}/{}/{}", MODEL_BASE_URL, MODEL_REVISION, filename)
}

#[derive(Debug, Clone, Serialize)]
pub struct WhisperModelPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub filename: &'static str,
    pub size_mb: u32,
    pub description: &'static str,
    /// SHA-256 of the file at MODEL_REVISION. Not sent to the UI.
    #[serde(skip)]
    pub sha256: &'static str,
}

// Hashes are the `lfs.oid` SHA-256 values from
// https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/<MODEL_REVISION>,
// matched against each file's `x-linked-etag` header and against shasum of the
// downloaded files (2026-11-12).
pub const WHISPER_MODEL_PRESETS: &[WhisperModelPreset] = &[
    WhisperModelPreset { id: "base",     label: "Base (Recommended)",  filename: "ggml-base.bin",     size_mb: 148,  description: "Good accuracy, fast. Best for most audiobooks.",
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
    WhisperModelPreset { id: "small",    label: "Small (Better)",      filename: "ggml-small.bin",    size_mb: 488,  description: "Better accuracy, slower. Good for unclear audio.",
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
    WhisperModelPreset { id: "base.en",  label: "Base English-only",   filename: "ggml-base.en.bin",  size_mb: 148,  description: "English-only, slightly better for English content.",
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" },
    WhisperModelPreset { id: "tiny",     label: "Tiny (Fastest)",      filename: "ggml-tiny.bin",     size_mb: 78,   description: "Fastest, lower accuracy. Quick checks.",
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" },
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

/// Where the app installs whisper.cpp itself (Windows only; macOS and Linux
/// use Homebrew). On Windows this is a directory holding whisper-cli.exe and
/// the DLLs it loads; elsewhere a single legacy binary.
fn bundled_install_path() -> Result<PathBuf, String> {
    let dir = whisper_dir()?;
    #[cfg(target_os = "windows")]
    { Ok(dir.join("bin")) }
    #[cfg(not(target_os = "windows"))]
    { Ok(dir.join("whisper-cpp")) }
}

fn bundled_binary_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    { Ok(bundled_install_path()?.join("whisper-cli.exe")) }
    #[cfg(not(target_os = "windows"))]
    { bundled_install_path() }
}

/// Before 2026-11 Windows installs copied a single exe here (often the
/// deprecated `main.exe` stub, without its DLLs). Never used, only removed.
fn legacy_windows_binary_path() -> Result<PathBuf, String> {
    Ok(whisper_dir()?.join("whisper-cpp.exe"))
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

    // A Homebrew at a non-default prefix: ffmpeg sits next to brew.
    #[cfg(target_os = "macos")]
    if let Some(p) = find_brew().and_then(|brew| brew_sibling(&brew, "ffmpeg")) {
        if p.exists() { return Some(p); }
    }

    #[cfg(target_os = "linux")]
    for name in &["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        let p = PathBuf::from(name);
        if p.exists() { return Some(p); }
    }

    #[cfg(unix)]
    {
        if let Ok(output) = std_command("which").arg("ffmpeg").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() { return Some(PathBuf::from(path)); }
            }
        }
    }

    #[cfg(windows)]
    {
        if let Ok(output) = std_command("where").arg("ffmpeg").output() {
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
        if let Ok(output) = std_command("which").arg(name).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() { return Some(PathBuf::from(path)); }
            }
        }
    }

    #[cfg(windows)]
    for name in &["whisper-cli", "whisper-cpp", "whisper-cli.exe", "whisper-cpp.exe"] {
        if let Ok(output) = std_command("where").arg(name).output() {
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

/// SHA-256 of the pinned whisper.cpp v1.8.4 release assets, as published by
/// GitHub for the release (`gh api repos/ggml-org/whisper.cpp/releases/tags/v1.8.4`).
/// Bump these together with the URLs in get_binary_download_url.
const PINNED_SHA256: &[(&str, &str)] = &[
    (
        "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip",
        "74f973345cb52ef5ba3ec9e7e7af8e48cc8c71722d1528603b80588a11f82e3e",
    ),
    (
        "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-Win32.zip",
        "892596da56c8762bd8a7592d5f42569943985cbd9c7fbad11c679f783f119bab",
    ),
];

fn pinned_sha256_for(url: &str) -> Option<&'static str> {
    PINNED_SHA256.iter().find(|(u, _)| *u == url).map(|(_, h)| *h)
}

/// A download pinned to one exact file: mirrors tried in order, each checked
/// against the same in-source SHA-256.
// macOS installs FFmpeg with Homebrew, so the download table is unused there.
#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Debug)]
struct PinnedDownload {
    urls: &'static [&'static str],
    sha256: &'static str,
    archive: ArchiveKind,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
enum ArchiveKind {
    Zip,
    TarXz,
}

/// FFmpeg builds the app downloads, by (std::env::consts::OS, ARCH). macOS is
/// absent on purpose: it installs FFmpeg with Homebrew.
///
/// Windows: gyan.dev FFmpeg 9.0.2 "essentials" (static ffmpeg.exe, no DLLs),
/// pinned 2026-11-12. SHA-256 from shasum of the download, matching gyan.dev's
/// own .sha256 and the GitHub mirror's release digest (GyanD/codexffmpeg 9.0.2).
/// The x64 build is the only Windows build gyan.dev publishes.
///
/// Linux: johnvansickle.com FFmpeg 7.0.2 static builds, pinned 2026-11-12.
/// SHA-256 from shasum of the downloads; their MD5 matches the site's
/// published .md5. When a newer release replaces 7.0.2 the file moves to
/// /old-releases/, so that is listed as the fallback.
#[cfg_attr(target_os = "macos", allow(dead_code))]
const FFMPEG_DOWNLOADS: &[(&str, &str, PinnedDownload)] = &[
    ("windows", "x86_64", PinnedDownload {
        urls: &[
            "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip",
            "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
        ],
        sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
        archive: ArchiveKind::Zip,
    }),
    ("linux", "x86_64", PinnedDownload {
        urls: &[
            "https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz",
            "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-7.0.2-amd64-static.tar.xz",
        ],
        sha256: "abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67",
        archive: ArchiveKind::TarXz,
    }),
    ("linux", "aarch64", PinnedDownload {
        urls: &[
            "https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-arm64-static.tar.xz",
            "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-7.0.2-arm64-static.tar.xz",
        ],
        sha256: "f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1",
        archive: ArchiveKind::TarXz,
    }),
];

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn ffmpeg_download_for(os: &str, arch: &str) -> Option<&'static PinnedDownload> {
    FFMPEG_DOWNLOADS
        .iter()
        .find(|(o, a, _)| *o == os && *a == arch)
        .map(|(_, _, d)| d)
}

/// Lowercase hex of a finished SHA-256.
fn hex_digest(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Fail unless `actual_hex` equals `expected_hex` (case-insensitive).
fn check_sha256_hex(actual_hex: &str, expected_hex: &str) -> Result<(), String> {
    if actual_hex.eq_ignore_ascii_case(expected_hex.trim()) {
        Ok(())
    } else {
        Err(format!(
            "Checksum mismatch for downloaded file (expected {}, got {}). The download was discarded.",
            expected_hex.trim().to_lowercase(),
            actual_hex
        ))
    }
}

/// Fail unless `bytes` hash to `expected_hex` (case-insensitive).
fn verify_sha256(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    check_sha256_hex(&hex_digest(&Sha256::digest(bytes)), expected_hex)
}

/// HTTP client for large downloads: no total-request timeout (a slow link
/// must not fail a healthy download), but connect and per-read timeouts so a
/// stalled one does fail.
fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP error: {}", e))
}

/// Download one pinned file, trying each mirror, and return its bytes only if
/// they match the pinned SHA-256.
async fn download_pinned(urls: &[&str], sha256: &str) -> Result<Vec<u8>, String> {
    let client = download_client()?;
    let mut errors = Vec::new();
    for url in urls {
        let attempt = async {
            let resp = client.get(*url).send().await.map_err(|e| format!("Download failed: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!("Download failed: HTTP {}", resp.status()));
            }
            let bytes = resp.bytes().await.map_err(|e| format!("Read error: {}", e))?;
            verify_sha256(&bytes, sha256)?;
            Ok(bytes.to_vec())
        };
        match attempt.await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => errors.push(format!("{}: {}", url, e)),
        }
    }
    Err(errors.join("; "))
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
    if let Ok(output) = std_command("which").arg("brew").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// `name` in the same bin directory as `brew` (that is, `<brew prefix>/bin`).
#[cfg(target_os = "macos")]
fn brew_sibling(brew: &Path, name: &str) -> Option<PathBuf> {
    brew.parent().map(|bin| bin.join(name))
}

/// Exact message when FFmpeg is missing and Homebrew is too (macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const BREW_MISSING_FOR_FFMPEG: &str = "Install Homebrew, or install FFmpeg yourself and restart";

/// Longest a `brew install` may run (it can build or pull many dependencies).
#[cfg(unix)]
const BREW_INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// `brew install <formula>`, returning brew's stderr on failure.
#[cfg(unix)]
async fn brew_install(brew: &Path, formula: &str) -> Result<(), String> {
    let mut cmd = tokio_command(brew);
    cmd.args(["install", formula]);
    let never_cancelled = AtomicBool::new(false);
    let output = run_child(cmd, Instant::now() + BREW_INSTALL_TIMEOUT, &never_cancelled)
        .await
        .map_err(|e| match e {
            StepError::Failed(msg) => msg,
            StepError::TimedOut => format!(
                "brew install {} did not finish within {} minutes",
                formula,
                BREW_INSTALL_TIMEOUT.as_secs() / 60
            ),
            StepError::Cancelled => format!("brew install {} was cancelled", formula),
        })?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = stderr_tail(&output.stderr, 2000);
        Err(if stderr.is_empty() {
            format!("brew install {} exited with {}", formula, output.status)
        } else {
            stderr
        })
    }
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
/// resolve outside the archive root. An entry that fails this check aborts the
/// whole extraction with an error naming the entry: a downloaded archive
/// containing such an entry is untrustworthy, and a partial install would be
/// worse than a clear failure. Both call sites extract into fresh temp dirs,
/// so an aborted extraction leaves nothing behind.
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

    // Ensure ffmpeg is available. An existing system or bundled ffmpeg is
    // found first, so most users never reach the install.
    if find_ffmpeg_binary().is_none() {
        let _ = window.emit("whisper_install_progress", serde_json::json!({
            "stage": "downloading", "status": "Installing FFmpeg...",
        }));
        install_ffmpeg(&window).await?;
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
                brew_install(&brew, "whisper-cpp")
                    .await
                    .map_err(|e| format!("brew install whisper-cpp failed: {}", e))?;
                let _ = window.emit("whisper_install_progress", serde_json::json!({
                    "stage": "complete", "status": "whisper-cpp installed via Homebrew",
                }));
                return Ok("whisper-cpp installed via Homebrew".to_string());
            }
        }

        // Brew unavailable. There is no reliable prebuilt CLI binary to fall
        // back to, so return an actionable message.
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

/// macOS: install FFmpeg with Homebrew and locate it at the brew prefix (a
/// Finder-launched app's PATH has no Homebrew directory in it).
#[cfg(target_os = "macos")]
async fn install_ffmpeg(window: &tauri::Window) -> Result<String, String> {
    use tauri::Emitter;

    let brew = find_brew().ok_or_else(|| BREW_MISSING_FOR_FFMPEG.to_string())?;
    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "installing", "status": "Installing FFmpeg via Homebrew...",
    }));
    brew_install(&brew, "ffmpeg")
        .await
        .map_err(|e| format!("FFmpeg install failed: brew install ffmpeg: {}", e))?;

    let ffmpeg = brew_sibling(&brew, "ffmpeg")
        .filter(|p| p.exists())
        .ok_or_else(|| format!(
            "FFmpeg install failed: brew reported success but ffmpeg is not next to {}",
            brew.display()
        ))?;

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "ffmpeg_done", "status": "FFmpeg installed",
    }));
    Ok(format!("FFmpeg installed at {}", ffmpeg.display()))
}

/// Windows and Linux: download a pinned, hashed static FFmpeg build into
/// `whisper_dir()`.
#[cfg(not(target_os = "macos"))]
async fn install_ffmpeg(window: &tauri::Window) -> Result<String, String> {
    download_and_install_ffmpeg(window)
        .await
        .map_err(|e| format!("FFmpeg install failed: {}. Install FFmpeg yourself (ffmpeg.org) and restart.", e))
}

#[cfg(not(target_os = "macos"))]
async fn download_and_install_ffmpeg(window: &tauri::Window) -> Result<String, String> {
    use tauri::Emitter;

    let pinned = ffmpeg_download_for(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| {
        format!("no FFmpeg download for {} {}", std::env::consts::OS, std::env::consts::ARCH)
    })?;

    let dir = whisper_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Dir error: {}", e))?;

    let bytes = download_pinned(pinned.urls, pinned.sha256).await?;

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "extracting", "status": "Extracting FFmpeg...",
    }));

    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp error: {}", e))?;
    let target_path = bundled_ffmpeg_path()?;

    match pinned.archive {
        ArchiveKind::Zip => {
            let archive_path = temp_dir.path().join("ffmpeg.zip");
            std::fs::write(&archive_path, &bytes).map_err(|e| format!("Write error: {}", e))?;
            extract_zip(&archive_path, temp_dir.path())?;
        }
        ArchiveKind::TarXz => {
            let archive_path = temp_dir.path().join("ffmpeg.tar.xz");
            std::fs::write(&archive_path, &bytes).map_err(|e| format!("Write error: {}", e))?;
            let mut cmd = tokio_command("tar");
            cmd.arg("-xJf").arg(&archive_path).arg("-C").arg(temp_dir.path());
            let never_cancelled = AtomicBool::new(false);
            let output = run_child(cmd, Instant::now() + Duration::from_secs(300), &never_cancelled)
                .await
                .map_err(|e| format!("Tar error: {:?}", e))?;
            if !output.status.success() {
                return Err(format!("Tar failed: {}", stderr_tail(&output.stderr, 1000)));
            }
        }
    }

    // Walk the extracted tree to find the ffmpeg binary
    let mut found: Option<PathBuf> = None;
    for e in walkdir::WalkDir::new(temp_dir.path()).max_depth(5).into_iter().flatten() {
        if let Some(name) = e.file_name().to_str() {
            let is_ffmpeg = name == "ffmpeg" || name == "ffmpeg.exe";
            if is_ffmpeg && e.file_type().is_file() && passes_executable_check(e.path()) {
                found = Some(e.path().to_path_buf());
                break;
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

/// Locate whisper-cli in an extracted release archive. The pinned Windows
/// archives keep everything under `Release/` next to `main.exe`, a
/// deprecation stub that only prints a warning, so only `whisper-cli` is
/// accepted, and only if it is a real executable.
fn find_whisper_cli(root: &Path) -> Option<PathBuf> {
    let candidates = [
        root.join("Release").join("whisper-cli.exe"),
        root.join("Release").join("whisper-cli"),
        root.join("whisper-cli.exe"),
        root.join("whisper-cli"),
        root.join("build").join("bin").join("whisper-cli"),
    ];
    candidates
        .into_iter()
        .find(|c| c.is_file() && passes_executable_check(c))
}

/// Install every file of `release_dir` (whisper-cli plus the DLLs it loads:
/// whisper.dll, ggml*.dll) into `dest`, replacing whatever was there. Files
/// are staged in a sibling directory first so a failed copy never leaves a
/// half-installed `dest`.
fn install_release_dir(release_dir: &Path, dest: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or("Install directory has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Dir error: {}", e))?;
    let staging = parent.join(format!(
        "{}.partial",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("bin")
    ));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| format!("Cleanup error: {}", e))?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| format!("Dir error: {}", e))?;

    let copy_all = || -> Result<(), String> {
        for entry in std::fs::read_dir(release_dir).map_err(|e| format!("Read error: {}", e))? {
            let entry = entry.map_err(|e| format!("Read error: {}", e))?;
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                std::fs::copy(entry.path(), staging.join(entry.file_name()))
                    .map_err(|e| format!("Copy error: {}", e))?;
            }
        }
        Ok(())
    };
    if let Err(e) = copy_all() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| format!("Could not replace {}: {}", dest.display(), e))?;
    }
    std::fs::rename(&staging, dest).map_err(|e| format!("Finalize error: {}", e))
}

async fn download_and_install_binary(url: &str, window: &tauri::Window) -> Result<String, String> {
    use tauri::Emitter;

    let expected = pinned_sha256_for(url).ok_or_else(|| format!("No pinned checksum for {}", url))?;
    let bytes = download_pinned(&[url], expected).await?;

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "extracting", "status": "Extracting binary...",
    }));

    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp error: {}", e))?;
    let zip_path = temp_dir.path().join("whisper.zip");
    std::fs::write(&zip_path, &bytes).map_err(|e| format!("Write error: {}", e))?;
    let extracted = temp_dir.path().join("extracted");
    extract_zip(&zip_path, &extracted)?;

    let cli = find_whisper_cli(&extracted).ok_or("Could not find whisper-cli in downloaded archive")?;
    let release_dir = cli.parent().ok_or("whisper-cli has no parent directory")?;
    install_release_dir(release_dir, &bundled_install_path()?)?;

    let binary_path = bundled_binary_path()?;
    if !binary_path.is_file() {
        return Err(format!("whisper-cli was not installed at {}", binary_path.display()));
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

    let url = model_download_url(preset.filename);
    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "downloading",
        "status": format!("Downloading {} ({}MB)...", preset.label, preset.size_mb),
    }));

    let client = download_client()?;

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
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let mut stream = resp.bytes_stream();
    let mut hasher = Sha256::new();

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
        hasher.update(&chunk);
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

    finalize_model_download(&partial_path, &model_path, &hex_digest(&hasher.finalize()), preset.sha256)?;

    let _ = window.emit("whisper_install_progress", serde_json::json!({
        "stage": "complete",
        "status": format!("{} model downloaded", preset.label),
    }));

    Ok(format!("Model {} downloaded ({} MB)", model_id, preset.size_mb))
}

/// Promote a downloaded model from `partial` to `dest` only if its SHA-256
/// (`actual_hex`) matches the pinned one; otherwise delete it.
fn finalize_model_download(partial: &Path, dest: &Path, actual_hex: &str, expected_hex: &str) -> Result<(), String> {
    if let Err(e) = check_sha256_hex(actual_hex, expected_hex) {
        let _ = std::fs::remove_file(partial);
        return Err(e);
    }
    std::fs::rename(partial, dest).map_err(|e| format!("Finalize error: {}", e))
}

/// A model id becomes part of a filename (`ggml-<id>.bin`). Only plain
/// alphanumerics plus `.`, `-`, `_` are allowed, and never "..": an id like
/// `..\\..\\x` would otherwise escape the models dir on Windows.
fn is_valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

#[tauri::command]
pub async fn whisper_local_delete_model(model_id: String) -> Result<String, String> {
    if !is_valid_model_id(&model_id) {
        return Err(format!("Invalid model id: {}", model_id));
    }
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

/// Remove the bundled whisper install (files, or directories such as the
/// Windows bin dir) and every downloaded model. Any failure is reported (it
/// used to be ignored and the UI said "removed" while the files stayed). The
/// directory itself is removed only if empty - a bundled ffmpeg living there
/// is intentionally kept.
fn remove_whisper_install(dir: &Path, installed: &[PathBuf], models_dir: &Path) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    for path in installed {
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else if path.exists() {
            std::fs::remove_file(path)
        } else {
            Ok(())
        };
        if let Err(e) = removed {
            errors.push(format!("could not remove {}: {}", path.display(), e));
        }
    }
    if models_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(models_dir) {
            errors.push(format!("could not remove {}: {}", models_dir.display(), e));
        }
    }
    if dir.exists() {
        let empty = std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false);
        if empty {
            if let Err(e) = std::fs::remove_dir(dir) {
                errors.push(format!("could not remove {}: {}", dir.display(), e));
            }
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

/// Uninstall whisper-cpp: remove bundled binary and all downloaded models
#[tauri::command]
pub async fn whisper_local_uninstall() -> Result<String, String> {
    let dir = whisper_dir()?;
    let installed = [bundled_install_path()?, legacy_windows_binary_path()?];
    remove_whisper_install(&dir, &installed, &whisper_models_dir()?)
        .map_err(|e| format!("Local Whisper was not fully removed: {}", e))?;
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

/// Run whisper-cpp locally on an audio file. Returns transcript text and
/// detected language. The child is killed if `deadline` passes or `cancel` is
/// set while it runs.
pub async fn transcribe_local(
    audio_path: &str,
    model_id: &str,
    deadline: Instant,
    cancel: &AtomicBool,
) -> Result<(String, Option<String>), StepError> {
    let binary = find_whisper_binary()
        .ok_or_else(|| StepError::Failed("whisper-cpp not installed. Install it from Settings.".to_string()))?;

    let models_dir = whisper_models_dir().map_err(StepError::Failed)?;
    let model_filename = format!("ggml-{}.bin", model_id);
    let model_path = models_dir.join(&model_filename);

    if !model_path.exists() {
        return Err(StepError::Failed(format!(
            "Whisper model '{}' not downloaded. Download it from Settings.",
            model_id
        )));
    }

    let mut cmd = tokio_command(&binary);
    cmd.arg("-m").arg(&model_path).args(["-f", audio_path, "--no-timestamps", "-l", "auto"]);

    // Set Metal resources path on macOS for GPU acceleration
    #[cfg(target_os = "macos")]
    {
        let brew_share = PathBuf::from("/opt/homebrew/share/whisper-cpp");
        if brew_share.exists() {
            cmd.env("GGML_METAL_PATH_RESOURCES", &brew_share);
        }
    }

    let output = run_child(cmd, deadline, cancel).await?;

    if !output.status.success() {
        return Err(StepError::Failed(format!("whisper-cpp error: {}", stderr_tail(&output.stderr, 2000))));
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
        return Err(StepError::Failed("whisper-cpp produced no output".to_string()));
    }

    Ok((transcript, language))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn sha256_verification() {
        // sha256("abc")
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify_sha256(b"abc", abc).is_ok());
        assert!(verify_sha256(b"abc", &abc.to_uppercase()).is_ok());
        assert!(verify_sha256(b"abd", abc).is_err());
    }

    #[test]
    fn pinned_whisper_downloads_have_checksums() {
        for url in [
            "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip",
            "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-Win32.zip",
        ] {
            assert_eq!(pinned_sha256_for(url).map(|h| h.len()), Some(64), "{url}");
        }
        assert_eq!(pinned_sha256_for("https://example.com/x.zip"), None);
    }

    #[test]
    fn ffmpeg_downloads_are_versioned_and_hashed() {
        for (os, arch) in [("windows", "x86_64"), ("linux", "x86_64"), ("linux", "aarch64")] {
            let d = ffmpeg_download_for(os, arch).unwrap_or_else(|| panic!("{os} {arch}"));
            assert_eq!(d.sha256.len(), 64, "{os} {arch}");
            assert!(d.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            for url in d.urls {
                assert!(url.starts_with("https://"), "{url}");
                assert!(!url.contains("release-"), "floating 'latest' URL: {url}");
                assert!(url.contains("9.0.2") || url.contains("7.0.2"), "unversioned URL: {url}");
            }
        }
        // macOS installs FFmpeg with Homebrew and has no download.
        assert!(ffmpeg_download_for("macos", "aarch64").is_none());
    }

    #[test]
    fn model_downloads_are_pinned_and_hashed() {
        assert_eq!(MODEL_REVISION.len(), 40);
        for p in WHISPER_MODEL_PRESETS {
            assert_eq!(p.sha256.len(), 64, "{}", p.id);
            let url = model_download_url(p.filename);
            assert!(url.contains(MODEL_REVISION) && !url.contains("/main/"), "{url}");
        }
        // The hash is internal; the UI's preset shape is unchanged.
        let json = serde_json::to_value(&WHISPER_MODEL_PRESETS[0]).unwrap();
        assert!(json.get("sha256").is_none());
    }

    #[test]
    fn model_hash_mismatch_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let partial = tmp.path().join("ggml-tiny.bin.partial");
        let dest = tmp.path().join("ggml-tiny.bin");
        std::fs::write(&partial, b"not the model").unwrap();

        let good = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";
        let actual = {
            use sha2::{Digest, Sha256};
            hex_digest(&Sha256::digest(b"not the model"))
        };
        let err = finalize_model_download(&partial, &dest, &actual, good).unwrap_err();
        assert!(err.contains("Checksum mismatch"), "{err}");
        assert!(!dest.exists(), "a mismatched model must never be installed");
        assert!(!partial.exists(), "a mismatched download is deleted");

        // A matching hash is promoted.
        std::fs::write(&partial, b"not the model").unwrap();
        finalize_model_download(&partial, &dest, &actual, &actual.to_uppercase()).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"not the model");
        assert!(!partial.exists());
    }

    /// The layout of the pinned whisper-bin-x64.zip (v1.8.4), trimmed.
    fn fake_windows_release(root: &Path) -> PathBuf {
        let release = root.join("Release");
        std::fs::create_dir_all(&release).unwrap();
        for exe in ["main.exe", "whisper-bench.exe", "whisper-cli.exe", "whisper-server.exe"] {
            std::fs::write(release.join(exe), [b"MZ\x90\x00".as_slice(), exe.as_bytes()].concat()).unwrap();
        }
        for dll in ["whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu.dll", "SDL2.dll"] {
            std::fs::write(release.join(dll), format!("MZdll {dll}")).unwrap();
        }
        release
    }

    #[test]
    fn finds_whisper_cli_in_release_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let release = fake_windows_release(tmp.path());
        assert_eq!(find_whisper_cli(tmp.path()), Some(release.join("whisper-cli.exe")));

        // main / main.exe (the deprecation stub) and other whisper-* tools are
        // never picked, even when whisper-cli is missing.
        std::fs::remove_file(release.join("whisper-cli.exe")).unwrap();
        std::fs::write(tmp.path().join("main"), b"\x7FELFmain").unwrap();
        assert_eq!(find_whisper_cli(tmp.path()), None);

        // A whisper-cli that is not an executable is rejected.
        std::fs::write(release.join("whisper-cli.exe"), b"<html>404</html>").unwrap();
        assert_eq!(find_whisper_cli(tmp.path()), None);
    }

    #[test]
    fn install_release_dir_copies_every_file_beside_whisper_cli() {
        let tmp = tempfile::tempdir().unwrap();
        let release = fake_windows_release(&tmp.path().join("extracted"));
        let dest = tmp.path().join("whisper").join("bin");

        // An older install is replaced, not merged.
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("stale.dll"), b"old").unwrap();

        install_release_dir(&release, &dest).unwrap();

        let mut want: Vec<String> = std::fs::read_dir(&release).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        let mut got: Vec<String> = std::fs::read_dir(&dest).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        want.sort();
        got.sort();
        assert_eq!(got, want);
        assert_eq!(
            std::fs::read(dest.join("whisper.dll")).unwrap(),
            std::fs::read(release.join("whisper.dll")).unwrap()
        );
        assert!(!tmp.path().join("whisper").join("bin.partial").exists());
    }

    #[test]
    fn model_ids_cannot_traverse_paths() {
        assert!(is_valid_model_id("base.en"));
        assert!(is_valid_model_id("large-v3-turbo"));
        assert!(is_valid_model_id("small_q5"));
        assert!(!is_valid_model_id(""));
        assert!(!is_valid_model_id("..\\..\\Windows\\x"));
        assert!(!is_valid_model_id("../../etc/passwd"));
        assert!(!is_valid_model_id("a/b"));
        assert!(!is_valid_model_id("a\\b"));
        assert!(!is_valid_model_id(".."));
        assert!(!is_valid_model_id("C:evil"));
    }

    #[cfg(unix)]
    #[test]
    fn uninstall_reports_failed_removal() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("whisper");
        let models = dir.join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join("ggml-base.bin"), b"x").unwrap();
        let binary = dir.join("whisper-cpp");
        std::fs::write(&binary, b"bin").unwrap();
        // Read-only parent: nothing inside it can be unlinked.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let res = remove_whisper_install(&dir, &[binary.clone()], &models);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(res.is_err(), "uninstall must not report success when files remain");

        // And succeeds (tolerating a leftover bundled ffmpeg) when removal works.
        std::fs::write(dir.join("ffmpeg"), b"ff").unwrap();
        assert!(remove_whisper_install(&dir, &[binary.clone()], &models).is_ok());
        assert!(!binary.exists() && !models.exists());
    }

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
