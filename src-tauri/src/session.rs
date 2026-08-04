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

/// Second slot. When the user answers the restore prompt with "keep current
/// books", the snapshot they declined is moved here rather than deleted, so
/// autosave can resume into the primary slot without the previous session
/// being destroyed by the very next write. Never read automatically: it is a
/// manual-recovery artifact, and a later preserve overwrites it (one
/// generation, same policy as the log rotation).
pub fn default_prev_session_path() -> PathBuf {
    app_data_dir().join("session.prev.json")
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

/// Read a snapshot back.
///
/// `Ok(None)` means there is genuinely no saved session. `Err` means a file is
/// there but could not be read (permissions, a bad disk, a partial mount).
/// Those two must not be collapsed: on `Err` the caller has to assume real
/// work is sitting in that file and must NOT autosave over it, whereas on
/// `Ok(None)` autosaving immediately is correct.
pub fn read_session_at(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(data) => Ok(Some(data)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Move the current snapshot into the second slot, replacing whatever was
/// there. Missing primary is success: there is simply nothing to preserve.
/// After this the primary slot is free, so autosave can resume without
/// destroying the snapshot the user declined to restore.
pub fn preserve_session_at(path: &Path, prev_path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if let Some(parent) = prev_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(path, prev_path).map_err(|e| e.to_string())
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

/// `Ok(None)` = nothing saved. `Err` = a snapshot exists but is unreadable,
/// which the frontend turns into a paused autosave rather than a silent
/// overwrite.
#[tauri::command]
pub fn load_session() -> Result<Option<String>, String> {
    read_session_at(&default_session_path())
}

#[tauri::command]
pub fn clear_session() -> Result<(), String> {
    clear_session_at(&default_session_path())
}

#[tauri::command]
pub fn preserve_session() -> Result<(), String> {
    preserve_session_at(&default_session_path(), &default_prev_session_path())
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

        assert_eq!(read_session_at(&path).unwrap(), None, "no session before first save");

        let payload = r#"{"version":1,"groups":[{"id":"g1"}]}"#;
        write_session_at(&path, payload).unwrap();
        assert_eq!(read_session_at(&path).unwrap().unwrap(), payload);

        clear_session_at(&path).unwrap();
        assert_eq!(read_session_at(&path).unwrap(), None, "cleared session is gone");
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
        assert_eq!(read_session_at(&path).unwrap().unwrap(), "{}");
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
        assert_eq!(read_session_at(&path).unwrap().unwrap(), r#"{"n":2}"#);
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
            read_session_at(&path).unwrap().unwrap(),
            r#"{"good":true}"#,
            "the refused write must not destroy the previous snapshot"
        );
        assert!(!tmp_path_for(&path).exists());
    }

    #[test]
    fn a_present_but_unreadable_session_is_an_error_not_an_absence() {
        // A directory where a file is expected is the portable way to make
        // read_to_string fail with something other than NotFound. Collapsing
        // this to None would tell the caller "nothing saved", and it would
        // autosave straight over a file that may hold real work.
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        fs::create_dir(&path).unwrap();

        let err = read_session_at(&path).unwrap_err();
        assert!(!err.is_empty(), "the IO reason is reported, got: {err}");
    }

    #[test]
    fn a_missing_session_is_an_absence_not_an_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        assert_eq!(read_session_at(&path).unwrap(), None);
    }

    // ---- second slot ----

    #[test]
    fn preserve_moves_the_snapshot_into_the_second_slot() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        let prev = dir.path().join("session.prev.json");

        write_session_at(&path, r#"{"declined":true}"#).unwrap();
        preserve_session_at(&path, &prev).unwrap();

        assert_eq!(read_session_at(&path).unwrap(), None, "primary slot is free");
        assert_eq!(
            fs::read_to_string(&prev).unwrap(),
            r#"{"declined":true}"#,
            "the declined session is preserved, not destroyed"
        );
    }

    #[test]
    fn autosave_after_preserve_does_not_touch_the_second_slot() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        let prev = dir.path().join("session.prev.json");

        write_session_at(&path, r#"{"old":true}"#).unwrap();
        preserve_session_at(&path, &prev).unwrap();
        // Autosave resumes into the primary slot.
        write_session_at(&path, r#"{"new":true}"#).unwrap();

        assert_eq!(read_session_at(&path).unwrap().unwrap(), r#"{"new":true}"#);
        assert_eq!(fs::read_to_string(&prev).unwrap(), r#"{"old":true}"#);
    }

    #[test]
    fn preserve_keeps_one_generation() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        let prev = dir.path().join("session.prev.json");

        write_session_at(&path, r#"{"gen":1}"#).unwrap();
        preserve_session_at(&path, &prev).unwrap();
        write_session_at(&path, r#"{"gen":2}"#).unwrap();
        preserve_session_at(&path, &prev).unwrap();

        assert_eq!(fs::read_to_string(&prev).unwrap(), r#"{"gen":2}"#);
    }

    #[test]
    fn preserving_a_missing_snapshot_is_success() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.json");
        let prev = dir.path().join("session.prev.json");
        assert!(preserve_session_at(&path, &prev).is_ok());
        assert!(!prev.exists());
    }

    #[test]
    fn the_second_slot_sits_beside_the_primary_one() {
        assert_eq!(
            default_prev_session_path().parent().unwrap(),
            default_session_path().parent().unwrap()
        );
        assert!(default_prev_session_path().ends_with("session.prev.json"));
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
