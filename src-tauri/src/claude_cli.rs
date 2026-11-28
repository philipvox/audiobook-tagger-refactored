// src-tauri/src/claude_cli.rs
//
// "Claude Code" AI provider: runs the user's own installed `claude` CLI in
// print mode, so AI calls use their Claude subscription login instead of an
// API key. No tools, no MCP servers, no user/project settings, no session
// files: the CLI is used as a plain prompt -> text function.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// One AI call. Generous: Sonnet on a long DNA prompt can take a while.
const CALL_TIMEOUT: Duration = Duration::from_secs(180);
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);

/// Aliases the app sends. Anything else is rejected, so a config value can
/// never smuggle extra CLI flags.
const ALLOWED_MODELS: &[&str] = &["haiku", "sonnet", "opus"];

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ClaudeCliStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
    /// "claude.ai" for a subscription login, "console" etc. for API billing.
    pub auth_method: Option<String>,
    pub subscription_type: Option<String>,
    pub error: Option<String>,
}

fn exe_name() -> &'static str {
    if cfg!(windows) { "claude.exe" } else { "claude" }
}

/// Places the official installers and npm put `claude`. Apps started from
/// the Finder/Start menu don't get the shell PATH, so look explicitly.
fn candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".local/bin").join(exe_name()));
        out.push(home.join(".claude/local").join(exe_name()));
        out.push(home.join(".npm-global/bin").join(exe_name()));
        out.push(home.join(".bun/bin").join(exe_name()));
        out.push(home.join(".volta/bin").join(exe_name()));
    }
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            out.push(PathBuf::from(appdata).join("npm").join("claude.cmd"));
        }
    } else {
        out.push(PathBuf::from("/opt/homebrew/bin/claude"));
        out.push(PathBuf::from("/usr/local/bin/claude"));
        out.push(PathBuf::from("/usr/bin/claude"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            out.push(dir.join(exe_name()));
        }
    }
    out
}

fn is_file(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

/// Last resort on macOS/Linux: ask the user's login shell, which has the
/// PATH they see in Terminal (nvm, asdf, custom installs).
async fn login_shell_lookup() -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let child = Command::new(shell)
        .args(["-lc", "command -v claude"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(10), child).await.ok()?.ok()?;
    let line = String::from_utf8_lossy(&out.stdout).lines().last()?.trim().to_string();
    let p = PathBuf::from(line);
    if p.is_absolute() && is_file(&p) { Some(p) } else { None }
}

/// A user-set path wins; an empty one means "find it".
pub async fn resolve_binary(configured: Option<&str>) -> Result<PathBuf, String> {
    if let Some(c) = configured.map(str::trim).filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        return if is_file(&p) {
            Ok(p)
        } else {
            Err(format!("No Claude Code program at {c}. Fix the path in Settings or clear it to search automatically."))
        };
    }
    if let Some(p) = candidate_paths().into_iter().find(|p| is_file(p)) {
        return Ok(p);
    }
    login_shell_lookup().await.ok_or_else(|| {
        "Claude Code isn't installed (or wasn't found). Install it from claude.com/claude-code, run `claude` once to log in, or set its path in Settings.".to_string()
    })
}

/// Base command: no API-key env vars, so the CLI uses the user's
/// subscription login, and a neutral working directory, so no project
/// CLAUDE.md is picked up.
fn base_command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .current_dir(std::env::temp_dir())
        .kill_on_drop(true);
    cmd
}

#[tauri::command]
pub async fn claude_cli_status(path: Option<String>) -> ClaudeCliStatus {
    let mut status = ClaudeCliStatus {
        found: false, path: None, version: None, logged_in: false,
        auth_method: None, subscription_type: None, error: None,
    };
    let bin = match resolve_binary(path.as_deref()).await {
        Ok(b) => b,
        Err(e) => { status.error = Some(e); return status; }
    };
    status.found = true;
    status.path = Some(bin.to_string_lossy().into_owned());

    let mut v = base_command(&bin);
    v.arg("--version").stdin(Stdio::null());
    if let Ok(Ok(out)) = tokio::time::timeout(STATUS_TIMEOUT, v.output()).await {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() { status.version = Some(s); }
    }

    let mut a = base_command(&bin);
    a.args(["auth", "status"]).stdin(Stdio::null());
    match tokio::time::timeout(STATUS_TIMEOUT, a.output()).await {
        Ok(Ok(out)) => match serde_json::from_slice::<serde_json::Value>(&out.stdout) {
            Ok(j) => {
                status.logged_in = j["loggedIn"].as_bool().unwrap_or(false);
                status.auth_method = j["authMethod"].as_str().map(String::from);
                status.subscription_type = j["subscriptionType"].as_str().map(String::from);
                if !status.logged_in {
                    status.error = Some("Claude Code is installed but not logged in. Open Terminal, run `claude`, and log in.".into());
                }
            }
            Err(_) => status.error = Some("Couldn't read `claude auth status`. Update Claude Code (`claude update`).".into()),
        },
        Ok(Err(e)) => status.error = Some(format!("Couldn't run Claude Code: {e}")),
        Err(_) => status.error = Some("Claude Code didn't answer within 20 seconds.".into()),
    }
    status
}

/// Pull the answer out of `--output-format json`. Newer CLIs print an array
/// of events ending in a `result`; older ones print just the result object.
pub fn parse_print_output(stdout: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| format!("Unexpected output from Claude Code: {}", truncate(stdout, 300)))?;
    let result = match &v {
        serde_json::Value::Array(items) => items
            .iter()
            .rev()
            .find(|i| i["type"] == "result")
            .cloned()
            .ok_or("Claude Code returned no result")?,
        obj => obj.clone(),
    };
    let text = result["result"].as_str().unwrap_or("").trim().to_string();
    if result["is_error"].as_bool().unwrap_or(false) || result["subtype"].as_str().is_some_and(|s| s != "success") {
        let msg = if text.is_empty() { result["subtype"].as_str().unwrap_or("error").to_string() } else { text };
        return Err(format!("Claude Code error: {}", truncate(&msg, 300)));
    }
    if text.is_empty() {
        return Err("Empty answer from Claude Code".into());
    }
    Ok(text)
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

/// Temp file holding one call's system prompt; deleted when dropped.
struct SystemPromptFile(PathBuf);

impl SystemPromptFile {
    fn create(text: &str) -> Result<Self, String> {
        use std::io::Write;
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "audiobook-tagger-prompt-{}-{}-{}.txt",
            std::process::id(),
            nanos,
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&p).map_err(|e| format!("Couldn't write the prompt file: {e}"))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("Couldn't write the prompt file: {e}"))?;
        Ok(Self(p))
    }
}

impl Drop for SystemPromptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tauri::command]
pub async fn claude_cli_call(
    system_prompt: String,
    user_prompt: String,
    model: String,
    path: Option<String>,
) -> Result<String, String> {
    if !ALLOWED_MODELS.contains(&model.as_str()) {
        return Err(format!("Unknown Claude Code model: {model}"));
    }
    let bin = resolve_binary(path.as_deref()).await?;
    // The system prompt goes in a private temp file, not on the command line:
    // Windows caps a command line at ~32K characters, and a `claude.cmd`
    // (npm install) can't take multi-line arguments at all.
    let sp_file = SystemPromptFile::create(&system_prompt)?;
    let mut cmd = base_command(&bin);
    cmd.args(["-p", "--model", &model, "--system-prompt-file"])
    .arg(&sp_file.0)
    .args([
        "--tools", "",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--no-session-persistence",
        "--output-format", "json",
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
    // The prompt goes on stdin: no argument-length limit, nothing in `ps`.
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(user_prompt.as_bytes()).await.map_err(|e| format!("Couldn't send the prompt to Claude Code: {e}"))?;
        drop(stdin);
    }
    let out = match tokio::time::timeout(CALL_TIMEOUT, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| format!("Claude Code failed: {e}"))?,
        Err(_) => return Err("Claude Code took longer than 3 minutes; nothing was applied.".into()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    match parse_print_output(&stdout) {
        Ok(t) => Ok(t),
        Err(e) if stdout.trim().is_empty() => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.trim().is_empty() { Err(e) } else { Err(format!("Claude Code error: {}", truncate(&stderr, 300))) }
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_event_array() {
        let s = r#"[{"type":"system","subtype":"init"},{"type":"result","subtype":"success","is_error":false,"result":" {\"a\":1} "}]"#;
        assert_eq!(parse_print_output(s).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn parses_single_result_object() {
        let s = r#"{"type":"result","subtype":"success","is_error":false,"result":"hi"}"#;
        assert_eq!(parse_print_output(s).unwrap(), "hi");
    }

    #[test]
    fn surfaces_cli_errors() {
        let s = r#"[{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached"}]"#;
        let e = parse_print_output(s).unwrap_err();
        assert!(e.contains("usage limit"), "{e}");
        let s = r#"{"type":"result","subtype":"error_max_turns","is_error":false}"#;
        assert!(parse_print_output(s).unwrap_err().contains("error_max_turns"));
    }

    #[test]
    fn rejects_garbage_and_empty() {
        assert!(parse_print_output("not json").is_err());
        assert!(parse_print_output(r#"{"type":"result","subtype":"success","result":""}"#).is_err());
    }

    #[test]
    fn prompt_file_is_written_then_removed() {
        let f = SystemPromptFile::create("line one\nline \"two\" %PATH%").unwrap();
        let p = f.0.clone();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "line one\nline \"two\" %PATH%");
        drop(f);
        assert!(!p.exists());
    }

    #[tokio::test]
    async fn bad_configured_path_is_an_error() {
        let e = resolve_binary(Some("/nonexistent/claude")).await.unwrap_err();
        assert!(e.contains("/nonexistent/claude"));
    }

    #[tokio::test]
    async fn rejects_unknown_model() {
        let e = claude_cli_call("s".into(), "u".into(), "--dangerously-skip-permissions".into(), None).await.unwrap_err();
        assert!(e.contains("Unknown"));
    }

    /// Live: needs a logged-in `claude`. `cargo test claude_cli -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn live_call_uses_subscription_login() {
        let st = claude_cli_status(None).await;
        assert!(st.found && st.logged_in, "{st:?}");
        assert_eq!(st.auth_method.as_deref(), Some("claude.ai"), "{st:?}");
        let out = claude_cli_call(
            "You tag audiobooks. Answer with JSON only.".into(),
            "File: the_hobbit_jrr_tolkien.m4b. Return {\"title\":..., \"author\":...}".into(),
            "haiku".into(),
            None,
        ).await.unwrap();
        println!("ANSWER: {out}");
        assert!(out.contains("Hobbit"), "{out}");
    }
}
