// Session persistence + persistent operation log (#58).
//
// Issue #58: a long enrichment run crashes or the window gets closed, and every
// edit that had not been pushed to AudiobookShelf is gone on reopen, with no
// log left behind to show what had happened. This module gives the frontend
// two durable places to write:
//
//   * session.json - the working state snapshot, written atomically (tmp file
//     + rename) so a crash mid-write can never truncate a good snapshot into
//     an unreadable one. The previous snapshot survives until the new one is
//     complete on disk.
//   * session.log  - an append-only operation log, rotated once at 5MB so it
//     cannot grow without bound but a crash still leaves the recent history.
//
// Both live in the same app data dir as writer.rs's undo journal
// (dirs::data_dir()/com.audiobook.tagger.v2), so everything this app persists
// outside the user's library sits in one folder.
//
// Data-preservation rules encoded here:
//   * clear_session only ever removes the file when the caller explicitly asks;
//     nothing in this module expires or garbage-collects a snapshot.
//   * a failed write leaves the previous snapshot intact and removes the tmp
//     file, so there is never a half-written session.json.
//   * log failures are returned as Err and never panic; the frontend treats
//     them as fire-and-forget.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Refuse to persist a snapshot larger than this. A snapshot for a 2,700-book
/// library measures about 8MB, so anything past 100MB means something is wrong
/// (embedded binary data, a runaway loop) and we would rather fail loudly than
/// fill the user's disk.
pub const MAX_SESSION_BYTES: usize = 100 * 1024 * 1024;

/// Rotate session.log once it reaches this size.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Same directory convention as writer.rs's undo journal.
pub fn app_data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    base.join("com.audiobook.tagger.v2")
}

pub fn default_session_path() -> PathBuf {
    app_data_dir().join("session.json")
}

pub fn default_log_path() -> PathBuf {
    app_data_dir().join("session.log")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The tmp file an atomic write stages through. Kept as a sibling of the target
/// so the final rename stays on one filesystem (a cross-device rename would
/// fail and defeat the atomicity).
fn tmp_path_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "session.json".to_string());
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{}.tmp", name))
}

// ============================================================================
// Session snapshot
// ============================================================================

/// Write `json` to `path` atomically. The caller's previous snapshot is only
/// replaced once the new bytes are fully on disk; on any failure the tmp file
/// is removed and the previous snapshot is left untouched.
pub fn write_session_at(path: &Path, json: &str) -> Result<(), String> {
    if json.len() > MAX_SESSION_BYTES {
        return Err(format!(
            "session snapshot is {} bytes, over the {} byte limit; not saved",
            json.len(),
            MAX_SESSION_BYTES
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = tmp_path_for(path);

    let staged = (|| -> Result<(), String> {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        // Flush to the OS before the rename so a crash right after the rename
        // cannot leave a renamed-but-empty file.
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(e) = staged {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

/// Read a snapshot back. Returns None when there is no session file (or it is
/// unreadable) - the caller treats that as "nothing to restore".
pub fn read_session_at(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// Remove the saved snapshot. Missing is success (nothing to clear).
pub fn clear_session_at(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ============================================================================
// Operation log
// ============================================================================

/// Format a UNIX timestamp as `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Implemented here rather than pulling in a date crate: the log only needs a
/// sortable UTC stamp. Uses Howard Hinnant's civil-from-days algorithm, which
/// is exact for the whole proleptic Gregorian range (no leap-second handling,
/// same as UNIX time itself).
pub fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Shift the epoch to 0000-03-01 so leap days land at the end of the cycle.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // day of era, [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day of year (Mar-based)
    let mp = (5 * doy + 2) / 153; // Mar-based month, [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = yoe as i64 + era * 400 + if m <= 2 { 1 } else { 0 };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, hh, mm, ss
    )
}

/// Append one timestamped line to the log, rotating first when the existing
/// file has reached `max_bytes`. Rotation keeps exactly one generation:
/// session.log becomes session.log.1 (replacing any previous .1) and a fresh
/// session.log is started.
///
/// `max_bytes` is a parameter so tests can rotate at a handful of bytes instead
/// of writing 5MB; the command wrapper always passes MAX_LOG_BYTES.
pub fn append_log_at(path: &Path, line: &str, now: u64, max_bytes: u64) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if let Ok(meta) = fs::metadata(path) {
        if meta.len() >= max_bytes {
            let rotated = rotated_log_path(path);
            // A failed rotation must not lose the line, so fall through and
            // keep appending to the oversized file rather than returning early.
            let _ = fs::rename(path, rotated);
        }
    }

    // Collapse newlines so one event is always exactly one line in the file.
    let flattened: String = line
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{} {}", format_utc(now), flattened).map_err(|e| e.to_string())
}

/// `session.log` -> `session.log.1`
pub fn rotated_log_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "session.log".to_string());
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{}.1", name))
}

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command]
pub fn save_session(json: String) -> Result<(), String> {
    write_session_at(&default_session_path(), &json)
}

#[tauri::command]
pub fn load_session() -> Option<String> {
    read_session_at(&default_session_path())
}

#[tauri::command]
pub fn clear_session() -> Result<(), String> {
    clear_session_at(&default_session_path())
}

#[tauri::command]
pub fn append_log(line: String) -> Result<(), String> {
    append_log_at(&default_log_path(), &line, now_secs(), MAX_LOG_BYTES)
}

#[tauri::command]
pub fn get_log_path() -> String {
    default_log_path().to_string_lossy().to_string()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // ---- session snapshot ----

    #[test]
    fn session_round_trips_save_load_clear() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");

        assert!(read_session_at(&path).is_none(), "no session before first save");

        let payload = r#"{"version":1,"groups":[{"id":"g1"}]}"#;
        write_session_at(&path, payload).unwrap();
        assert_eq!(read_session_at(&path).unwrap(), payload);

        clear_session_at(&path).unwrap();
        assert!(read_session_at(&path).is_none(), "cleared session is gone");
    }

    #[test]
    fn clearing_a_missing_session_is_success() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        assert!(clear_session_at(&path).is_ok());
    }

    #[test]
    fn save_creates_the_parent_directory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("deeper").join("session.json");
        write_session_at(&path, "{}").unwrap();
        assert_eq!(read_session_at(&path).unwrap(), "{}");
    }

    #[test]
    fn save_leaves_no_tmp_file_behind() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        write_session_at(&path, r#"{"a":1}"#).unwrap();

        let tmp = tmp_path_for(&path);
        assert!(!tmp.exists(), "tmp file cleaned up by the rename");

        let entries: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["session.json".to_string()]);
    }

    #[test]
    fn overwriting_replaces_the_previous_snapshot_atomically() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        write_session_at(&path, r#"{"n":1}"#).unwrap();
        write_session_at(&path, r#"{"n":2}"#).unwrap();
        assert_eq!(read_session_at(&path).unwrap(), r#"{"n":2}"#);
        assert!(!tmp_path_for(&path).exists());
    }

    #[test]
    fn oversized_snapshot_is_refused_and_leaves_the_old_one_intact() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        write_session_at(&path, r#"{"good":true}"#).unwrap();

        let huge = "x".repeat(MAX_SESSION_BYTES + 1);
        let err = write_session_at(&path, &huge).unwrap_err();
        assert!(err.contains("over the"), "truthful size error, got: {err}");
        assert!(err.contains(&MAX_SESSION_BYTES.to_string()));

        assert_eq!(
            read_session_at(&path).unwrap(),
            r#"{"good":true}"#,
            "the refused write must not destroy the previous snapshot"
        );
        assert!(!tmp_path_for(&path).exists());
    }

    // ---- log ----

    #[test]
    fn log_appends_timestamped_lines() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.log");

        append_log_at(&path, "[batch] resolve start", 1_785_900_000, MAX_LOG_BYTES).unwrap();
        append_log_at(&path, "[batch] resolve complete", 1_785_900_060, MAX_LOG_BYTES).unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "2026-08-05T03:20:00Z [batch] resolve start");
        assert_eq!(lines[1], "2026-08-05T03:21:00Z [batch] resolve complete");
    }

    #[test]
    fn log_flattens_embedded_newlines_into_one_line() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.log");
        append_log_at(&path, "line one\nline two\r\nthree", 0, MAX_LOG_BYTES).unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents.lines().count(), 1, "one event is one line");
        assert!(contents.contains("line one line two  three"));
    }

    #[test]
    fn log_rotates_at_the_threshold_and_keeps_one_generation() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.log");
        let rotated = rotated_log_path(&path);

        // Each line here is ~51 bytes, so with a 100 byte threshold the third
        // append is the one that finds an oversized log and rotates it.
        for i in 0..3 {
            append_log_at(&path, &format!("gen1 event {i} padding padding"), 0, 100).unwrap();
        }

        assert!(rotated.exists(), "rotation produced session.log.1");
        let current = fs::read_to_string(&path).unwrap();
        let archived = fs::read_to_string(&rotated).unwrap();

        assert!(archived.contains("gen1 event 0"), "old lines preserved in .1");
        assert!(archived.contains("gen1 event 1"));
        assert_eq!(archived.lines().count(), 2);

        assert_eq!(current.lines().count(), 1, "fresh log started after rotation");
        assert!(
            current.contains("gen1 event 2"),
            "the line that triggered rotation still lands"
        );
    }

    #[test]
    fn log_rotation_keeps_only_one_archive() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.log");
        let rotated = rotated_log_path(&path);

        for i in 0..40 {
            append_log_at(&path, &format!("event {i} with some padding text"), 0, 60).unwrap();
        }

        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 2, "only session.log and session.log.1 exist: {names:?}");
        assert!(rotated.exists());
        // The archive is the most recent rotation, not the oldest one.
        let archived = fs::read_to_string(&rotated).unwrap();
        assert!(!archived.contains("event 0"), "older generations are dropped");
    }

    #[test]
    fn log_does_not_rotate_below_the_threshold() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.log");
        append_log_at(&path, "small", 0, MAX_LOG_BYTES).unwrap();
        append_log_at(&path, "also small", 0, MAX_LOG_BYTES).unwrap();
        assert!(!rotated_log_path(&path).exists());
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
    }

    // ---- timestamp formatting ----
    // Ground truth generated with `date -u -r <secs> +%Y-%m-%dT%H:%M:%SZ`.

    #[test]
    fn format_utc_matches_known_timestamps() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(1), "1970-01-01T00:00:01Z");
        assert_eq!(format_utc(951_782_400), "2000-02-29T00:00:00Z"); // leap day, century leap
        assert_eq!(format_utc(1_078_012_800), "2004-02-29T00:00:00Z"); // leap day
        assert_eq!(format_utc(1_767_225_599), "2025-12-31T23:59:59Z"); // year boundary
        assert_eq!(format_utc(1_767_225_600), "2026-01-01T00:00:00Z");
        assert_eq!(format_utc(1_785_900_000), "2026-08-05T03:20:00Z");
        assert_eq!(format_utc(4_102_444_800), "2100-01-01T00:00:00Z"); // non-leap century
    }

    #[test]
    fn default_paths_share_the_writer_app_data_dir() {
        let session = default_session_path();
        let log = default_log_path();
        assert_eq!(session.parent(), log.parent());
        assert_eq!(session.parent().unwrap(), app_data_dir());
        assert_eq!(
            crate::writer::default_journal_path().parent().unwrap(),
            app_data_dir(),
            "session files live beside the undo journal"
        );
    }
}
