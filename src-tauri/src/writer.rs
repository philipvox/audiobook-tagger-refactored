// Local-file write backend: write_tags, undo journal, preview_rename, rename_files.
//
// Task 9b. The contracts here are defined by the FRONTEND (Tasks 5-7), not by an
// abstract spec. Where the brief's return-shape sketch and the actual frontend
// consumption differ, the frontend wins. Documented divergences:
//
//   * write_tags errors[] entries carry `file_id` (useTagOperations.js reads
//     `result.errors.some(e => e.file_id === fileId)`), not the brief's `path`.
//     We include both file_id and path.
//   * rename_files returns `renamed` as an ARRAY of {old_path,new_path,status}
//     (ScannerPage does `for (const r of renameResult.renamed)`), NOT a count.
//   * get_undo_status returns snake_case `books_count`, `age_seconds`, plus a
//     `files` array of restored paths (UndoToast/ScannerPage read exactly those).
//
// Data-preservation is paramount: a backup copy is made BEFORE any modification
// when backup=true; a file whose backup fails to land is never modified; rename
// refuses to overwrite an existing distinct target; undo restores exactly what
// the journal recorded. Per-file status is reported truthfully.
//
// Tag keys written here MATCH the keys scanner.rs reads (title/AlbumArtist/
// Composer/Genre/Movement/MovementNumber/year), so a write is round-trippable by
// a later scan on both ID3v2 (mp3) and Mp4Ilst (m4b) files.
//
// Write-field honesty: apply_changes_to_tag embeds every field the tag format can
// express and returns the fields it did NOT embed as a `skipped` list. A skipped
// field is never a hard failure (support is asymmetric across ID3v2/MP4, and some
// fields are ABS-only, e.g. tags/genres/dna). write_tags surfaces this per file as
// a `skipped_fields` array so the frontend can stop over-promising in its preview.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};
use lofty::probe::Probe;
use lofty::tag::{ItemValue, Tag, TagItem, TagType};

// ============================================================================
// write_tags
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct WriteFile {
    pub path: String,
    // Each change is `{ old, new }` (see src/lib/applyMetadata.js). A bare scalar
    // is also accepted defensively.
    #[serde(default)]
    pub changes: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
pub struct WriteRequest {
    #[serde(default)]
    pub file_ids: Vec<String>,
    #[serde(default)]
    pub files: HashMap<String, WriteFile>,
    #[serde(default)]
    pub backup: bool,
}

/// Extract the value to write from a change entry: `{old, new}` -> new, else the
/// scalar itself. Null -> None (nothing to write). Numbers stringified.
pub fn change_value(raw: &Value) -> Option<String> {
    let candidate = if let Some(obj) = raw.as_object() {
        // A {old,new} change object: write the `new` side.
        obj.get("new").cloned().unwrap_or(Value::Null)
    } else {
        raw.clone()
    };
    match candidate {
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

/// Parse a leading run of digits into u32 (tolerates "2020-01-01" -> 2020).
fn leading_u32(s: &str) -> Option<u32> {
    let digits: String = s.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

/// Apply the change set to a tag in place. Returns the list of requested fields
/// that could NOT be embedded in this tag type -- either a checked `insert_text`
/// returned false (the key has no home in this format, e.g. publisher on MP4 or
/// description/isbn/asin on ID3v2) or the field is ABS-only (tags/genres/dna).
/// A skipped field is reported to the caller, NEVER treated as a hard failure.
/// A change whose value is null (nothing to write) is not counted as skipped.
pub fn apply_changes_to_tag(tag: &mut Tag, changes: &HashMap<String, Value>) -> Vec<String> {
    let mut skipped = Vec::new();
    // MP4/m4b (the primary AudiobookShelf format) stores series in freeform atoms
    // that scanner.rs's lookup_tag_field fallback reads; write those too so ABS
    // and other tools see the series and any stale freeform value is overwritten.
    let is_mp4 = tag.tag_type() == TagType::Mp4Ilst;
    for (field, raw) in changes {
        let value = match change_value(raw) {
            Some(v) => v,
            None => continue,
        };
        let wrote = match field.as_str() {
            "title" => {
                tag.set_title(value);
                true
            }
            "author" | "albumartist" => tag.insert_text(ItemKey::AlbumArtist, value),
            "artist" => {
                tag.set_artist(value);
                true
            }
            "album" => {
                tag.set_album(value);
                true
            }
            // Narrator convention (matches scanner.rs read + v1 write): Composer.
            // The value already carries the "Narrated by X" form the UI staged.
            "narrator" => tag.insert_text(ItemKey::Composer, value),
            "genre" => {
                tag.set_genre(value);
                true
            }
            // Series / sequence via the same movement keys scanner.rs reads. On
            // Mp4Ilst these map to the ©mvn/©mvi atoms, on ID3v2 to MVNM/MVIN.
            "series" => {
                let ok = tag.insert_text(ItemKey::Movement, value.clone());
                if is_mp4 {
                    set_mp4_freeform(tag, "----:com.apple.iTunes:SERIES", &value);
                }
                ok
            }
            "sequence" | "series_number" | "series-part" => {
                let ok = tag.insert_text(ItemKey::MovementNumber, value.clone());
                if is_mp4 {
                    set_mp4_freeform(tag, "----:com.apple.iTunes:SERIES-PART", &value);
                }
                ok
            }
            // Descriptive metadata other tools + AudiobookShelf read. Support is
            // asymmetric across formats: insert_text returns false when a key has
            // no home in this tag type, so that field lands in `skipped` (reported,
            // never a hard failure).
            //   description -> MP4 `desc` atom; no ID3v2 home (skipped on mp3).
            "description" => tag.insert_text(ItemKey::Description, value),
            //   publisher -> ID3v2 TPUB; no ILST atom (skipped on m4b).
            "publisher" => tag.insert_text(ItemKey::Publisher, value),
            //   language -> ID3v2 TLAN / MP4 ----:com.apple.iTunes:LANGUAGE (both).
            "language" => tag.insert_text(ItemKey::Language, value),
            //   subtitle -> ID3v2 TIT3 / MP4 ----:com.apple.iTunes:SUBTITLE (both);
            //   TrackSubtitle maps to that exact freeform atom on MP4.
            "subtitle" => tag.insert_text(ItemKey::TrackSubtitle, value),
            // ISBN/ASIN have no ItemKey; only MP4 has a conventional freeform home,
            // written the same way as the SERIES atoms above. Skipped on ID3v2.
            "isbn" => {
                if is_mp4 {
                    set_mp4_freeform(tag, "----:com.apple.iTunes:ISBN", &value);
                    true
                } else {
                    false
                }
            }
            "asin" => {
                if is_mp4 {
                    set_mp4_freeform(tag, "----:com.apple.iTunes:ASIN", &value);
                    true
                } else {
                    false
                }
            }
            "year" => match leading_u32(&value) {
                Some(y) => {
                    tag.set_year(y);
                    true
                }
                // Unparseable year: requested but not embedded -> reported skipped.
                None => false,
            },
            "track" => match leading_u32(&value) {
                Some(t) => {
                    tag.set_track(t);
                    true
                }
                None => false,
            },
            // Unknown / ABS-only field (tags, genres, dna, age, ...): not embeddable.
            _ => false,
        };
        if !wrote {
            skipped.push(field.clone());
        }
    }
    skipped
}

/// Write (replacing any stale value) an MP4 freeform atom by its exact stored key
/// string, e.g. "----:com.apple.iTunes:SERIES". lofty's checked insert rejects
/// Unknown keys, so remove-then-push_unchecked mirrors how such atoms exist on a
/// real MP4 file (see scanner.rs's freeform read + its reads_mp4_freeform test).
fn set_mp4_freeform(tag: &mut Tag, atom_key: &str, value: &str) {
    let key = ItemKey::Unknown(atom_key.to_string());
    tag.remove_key(&key);
    tag.push_unchecked(TagItem::new(key, ItemValue::Text(value.to_string())));
}

/// `<path>.bak` alongside the original.
pub fn backup_path_for(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".bak");
    PathBuf::from(s)
}

/// Result of attempting to write one file. `journal` is Some whenever a backup
/// landed (even if the subsequent tag save failed), so undo can restore a
/// partially written file. `result` is the truthful per-file outcome. `skipped`
/// lists the requested fields that could not be embedded in this file's format
/// (reported to the caller, never a hard failure).
struct FileWriteOutcome {
    result: Result<(), String>,
    journal: Option<JournalEntry>,
    skipped: Vec<String>,
}

fn write_one_file(file: &WriteFile, backup: bool) -> FileWriteOutcome {
    let path = PathBuf::from(&file.path);
    if !path.exists() {
        return FileWriteOutcome {
            result: Err("file not found".to_string()),
            journal: None,
            skipped: Vec::new(),
        };
    }

    // Backup FIRST. If it fails, never touch the original.
    let mut journal = None;
    if backup {
        let bak = backup_path_for(&path);
        if let Err(e) = fs::copy(&path, &bak) {
            return FileWriteOutcome {
                result: Err(format!("backup failed: {e}")),
                journal: None,
                skipped: Vec::new(),
            };
        }
        journal = Some(JournalEntry {
            original_path: file.path.clone(),
            backup_path: bak.to_string_lossy().to_string(),
        });
    }

    // Read, mutate, save.
    let mut tagged = match Probe::open(&path).and_then(|p| p.read()) {
        Ok(t) => t,
        Err(e) => {
            return FileWriteOutcome {
                result: Err(format!("read failed: {e}")),
                journal,
                skipped: Vec::new(),
            }
        }
    };
    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = match tagged.primary_tag_mut() {
        Some(t) => t,
        None => {
            return FileWriteOutcome {
                result: Err("could not create a writable tag".to_string()),
                journal,
                skipped: Vec::new(),
            }
        }
    };
    // Embed everything this format can express; unembeddable/ABS-only fields are
    // reported as `skipped` rather than failing the write.
    let skipped = apply_changes_to_tag(tag, &file.changes);

    match tagged.save_to_path(&path, WriteOptions::default()) {
        Ok(()) => FileWriteOutcome {
            result: Ok(()),
            journal,
            skipped,
        },
        Err(e) => FileWriteOutcome {
            result: Err(format!("save failed: {e}")),
            journal,
            skipped,
        },
    }
}

#[tauri::command]
pub fn write_tags(request: WriteRequest) -> Value {
    let mut success = 0usize;
    let mut failed = 0usize;
    let mut errors: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let mut journal_entries: Vec<JournalEntry> = Vec::new();

    // Iterate file_ids to preserve the caller's order; fall back to the map keys
    // for any ids the caller omitted from file_ids.
    let mut ordered_ids: Vec<String> = request.file_ids.clone();
    for id in request.files.keys() {
        if !ordered_ids.contains(id) {
            ordered_ids.push(id.clone());
        }
    }

    for id in &ordered_ids {
        let file = match request.files.get(id) {
            Some(f) => f,
            None => {
                failed += 1;
                errors.push(json!({ "file_id": id, "path": "", "error": "no file payload for this id" }));
                results.push(json!({ "file_id": id, "path": "", "status": "failed", "skipped_fields": [] }));
                continue;
            }
        };

        let FileWriteOutcome {
            result,
            journal,
            skipped,
        } = write_one_file(file, request.backup);
        if let Some(entry) = journal {
            journal_entries.push(entry);
        }
        match result {
            Ok(()) => {
                success += 1;
                results.push(json!({ "file_id": id, "path": file.path, "status": "success", "skipped_fields": skipped }));
            }
            Err(e) => {
                failed += 1;
                errors.push(json!({ "file_id": id, "path": file.path, "error": e }));
                results.push(json!({ "file_id": id, "path": file.path, "status": "failed", "skipped_fields": skipped }));
            }
        }
    }

    // Journal handling: overwrite/clear on EVERY write so a backup=false write
    // (or one where all backups failed) leaves get_undo_status.available=false.
    let journal_path = default_journal_path();
    let _ = clear_journal(&journal_path);
    if request.backup && !journal_entries.is_empty() {
        let journal = UndoJournal {
            timestamp: now_secs(),
            entries: journal_entries,
        };
        let _ = write_journal(&journal_path, &journal);
    }

    json!({
        "success": success,
        "failed": failed,
        "errors": errors,
        "results": results,
    })
}

// ============================================================================
// Undo journal
// ============================================================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct JournalEntry {
    pub original_path: String,
    pub backup_path: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UndoJournal {
    pub timestamp: u64,
    pub entries: Vec<JournalEntry>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn default_journal_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    base.join("com.audiobook.tagger.v2").join("undo_journal.json")
}

pub fn write_journal(path: &Path, journal: &UndoJournal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

pub fn read_journal(path: &Path) -> Option<UndoJournal> {
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn clear_journal(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Restore every backup recorded in the journal (rename .bak back over the
/// original). Returns (restored original paths, failed entries with their reason).
/// Failed entries are returned intact so the caller can keep them in the journal
/// for a later retry rather than orphaning their `.bak`.
pub fn restore_from_journal(journal: &UndoJournal) -> (Vec<String>, Vec<(JournalEntry, String)>) {
    let mut restored = Vec::new();
    let mut failed: Vec<(JournalEntry, String)> = Vec::new();
    for entry in &journal.entries {
        let bak = PathBuf::from(&entry.backup_path);
        let orig = PathBuf::from(&entry.original_path);
        if !bak.exists() {
            failed.push((entry.clone(), "backup file missing".to_string()));
            continue;
        }
        // rename replaces the (modified) original with the backup and removes .bak.
        match fs::rename(&bak, &orig) {
            Ok(()) => restored.push(entry.original_path.clone()),
            Err(e) => failed.push((entry.clone(), e.to_string())),
        }
    }
    (restored, failed)
}

#[tauri::command]
pub fn get_undo_status() -> Value {
    let journal_path = default_journal_path();
    match read_journal(&journal_path) {
        Some(journal) if !journal.entries.is_empty() => {
            let age = now_secs().saturating_sub(journal.timestamp);
            let files: Vec<String> = journal
                .entries
                .iter()
                .map(|e| e.original_path.clone())
                .collect();
            json!({
                "available": true,
                "books_count": journal.entries.len(),
                "count": journal.entries.len(),
                "age_seconds": age,
                "files": files,
            })
        }
        _ => json!({
            "available": false,
            "books_count": 0,
            "count": 0,
            "age_seconds": 0,
            "files": [],
        }),
    }
}

#[tauri::command]
pub fn undo_last_write() -> Value {
    let journal_path = default_journal_path();
    let journal = match read_journal(&journal_path) {
        Some(j) if !j.entries.is_empty() => j,
        _ => {
            return json!({
                "success": false,
                "error": "Nothing to undo.",
                "failed": 0,
                "restored_files": [],
                "results": [],
            });
        }
    };

    let (restored, failed) = restore_from_journal(&journal);
    let failed_count = failed.len();
    let total = restored.len() + failed_count;

    // Keep failed entries (with their backup paths) in the journal so
    // get_undo_status still reports them and a retry can restore them; only clear
    // the journal outright when every file restored. Preserve the original
    // timestamp so undo-availability age still reflects the original write.
    if failed.is_empty() {
        let _ = clear_journal(&journal_path);
    } else {
        let remaining = UndoJournal {
            timestamp: journal.timestamp,
            entries: failed.iter().map(|(entry, _)| entry.clone()).collect(),
        };
        let _ = write_journal(&journal_path, &remaining);
    }

    let results: Vec<Value> = restored
        .iter()
        .map(|orig| json!({ "old_path": orig, "new_path": orig }))
        .collect();

    let mut resp = json!({
        "success": restored.len(),
        "failed": failed_count,
        "restored_files": restored,
        "files": restored,
        "results": results,
    });
    // ANY failure must read as failure to the JS guard (`success === false ||
    // error`): a numeric `success` (even 0) is never `=== false`, and a partial
    // restore that reported success would tell the user everything reverted while
    // a failed file's backup still sits unrestored. Report truthfully.
    if failed_count > 0 {
        let first_reason = failed
            .first()
            .map(|(_, reason)| reason.clone())
            .unwrap_or_default();
        resp["success"] = json!(false);
        resp["error"] = json!(format!(
            "Restored {} of {} files; {} failed: {}",
            restored.len(),
            total,
            failed_count,
            first_reason
        ));
    }
    resp
}

#[tauri::command]
pub fn clear_undo_state() -> Value {
    let journal_path = default_journal_path();
    let _ = clear_journal(&journal_path);
    json!({ "cleared": true })
}

// ============================================================================
// preview_rename / rename_files
// ============================================================================

/// Characters not allowed in a filename on Windows (superset that also keeps mac/
/// Linux names portable). '/' and '\\' would also split the path.
fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => {}
            c if (c as u32) < 0x20 => {}
            _ => out.push(c),
        }
    }
    // Collapse whitespace runs, trim, and strip trailing dots/spaces (Windows).
    let collapsed: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.trim_matches(|c: char| c == '.' || c == ' ').to_string()
}

/// Remove any leftover `{...}` blocks. Runs AFTER known `{var}` tokens have been
/// substituted, so this only strips unknown/conditional blocks (a safety net for
/// someone pasting the default template); it never touches `{title}` etc.
fn strip_braces(s: &str) -> String {
    let mut out = String::new();
    let mut depth: usize = 0;
    for c in s.chars() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
            }
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// A value is "present" when it is Some and, after trimming, non-empty. Note a
/// sequence of "0" is present (checked by emptiness, not truthiness).
fn field_str(meta: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = meta.get(key) {
            let s = match v {
                Value::String(s) => s.trim().to_string(),
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            };
            if !s.is_empty() {
                return s;
            }
        }
    }
    String::new()
}

/// Render a rename template into a filename STEM (no extension). Known vars:
/// {title} {author} {series} {sequence} {year} {narrator}. Missing vars render
/// empty; leftover unknown `{...}` blocks are stripped.
pub fn render_template(template: &str, meta: &Value) -> String {
    let resolve = |var: &str| -> String {
        match var {
            "title" => field_str(meta, &["title"]),
            "author" => field_str(meta, &["author"]),
            "series" => field_str(meta, &["series"]),
            "sequence" => field_str(meta, &["sequence", "series_number"]),
            "year" => field_str(meta, &["year", "published_year"]),
            "narrator" => field_str(meta, &["narrator"]),
            _ => String::new(),
        }
    };
    let mut out = template.to_string();
    for var in ["title", "author", "series", "sequence", "year", "narrator"] {
        out = out.replace(&format!("{{{var}}}"), &resolve(var));
    }
    strip_braces(&out)
}

/// Compute the new absolute path from an old path + rendered stem, preserving the
/// original extension and directory. Returns (new_path, changed).
pub fn compute_new_path(old_path: &str, stem: &str) -> (String, bool) {
    let sanitized = sanitize_filename(stem);
    if sanitized.is_empty() {
        return (old_path.to_string(), false);
    }
    let old = PathBuf::from(old_path);
    let mut filename = sanitized;
    if let Some(ext) = old.extension().and_then(|e| e.to_str()) {
        filename.push('.');
        filename.push_str(ext);
    }
    let new = match old.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.join(&filename),
        _ => PathBuf::from(&filename),
    };
    let new_path = new.to_string_lossy().to_string();
    let changed = new_path != old_path;
    (new_path, changed)
}

#[tauri::command]
pub fn preview_rename(file_path: String, metadata: Value, template: Option<String>) -> Value {
    let template = template.unwrap_or_default();
    if template.trim().is_empty() {
        return json!({ "old_path": file_path, "new_path": file_path, "changed": false });
    }
    let stem = render_template(&template, &metadata);
    let (new_path, changed) = compute_new_path(&file_path, &stem);
    json!({ "old_path": file_path, "new_path": new_path, "changed": changed })
}

#[derive(Debug, Deserialize)]
pub struct RenamePair {
    // The caller also sends `file_id`; serde ignores it (unused by the backend,
    // the frontend maps results back by old_path/new_path).
    pub old_path: String,
    pub new_path: String,
}

/// True when new_path names the very same file as old_path (e.g. a case-only
/// rename on a case-insensitive filesystem), which is NOT a collision.
fn same_file(old: &Path, new: &Path) -> bool {
    match (fs::canonicalize(old), fs::canonicalize(new)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Perform one rename, refusing to overwrite a distinct existing target.
pub fn rename_one(old_path: &str, new_path: &str) -> Result<(), String> {
    let old = PathBuf::from(old_path);
    let new = PathBuf::from(new_path);
    if !old.exists() {
        return Err("source file not found".to_string());
    }
    if new.exists() && !same_file(&old, &new) {
        return Err("target already exists".to_string());
    }
    if let Some(parent) = new.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::rename(&old, &new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_files(renames: Vec<RenamePair>) -> Value {
    let mut renamed: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let mut failed = 0usize;

    for pair in &renames {
        match rename_one(&pair.old_path, &pair.new_path) {
            Ok(()) => {
                renamed.push(json!({
                    "old_path": pair.old_path,
                    "new_path": pair.new_path,
                    "status": "renamed",
                }));
                results.push(json!({
                    "old_path": pair.old_path,
                    "new_path": pair.new_path,
                    "status": "renamed",
                }));
            }
            Err(e) => {
                failed += 1;
                results.push(json!({
                    "old_path": pair.old_path,
                    "new_path": pair.new_path,
                    "status": "failed",
                    "error": e,
                }));
            }
        }
    }

    json!({
        "renamed": renamed,
        "failed": failed,
        "results": results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::tag::{TagType, TagItem};
    use lofty::tag::ItemValue;
    use tempfile::tempdir;

    // ---- change_value ----

    #[test]
    fn change_value_extracts_new_from_object() {
        let v = json!({ "old": "A", "new": "B" });
        assert_eq!(change_value(&v).as_deref(), Some("B"));
    }

    #[test]
    fn change_value_accepts_bare_scalar_and_number() {
        assert_eq!(change_value(&json!("X")).as_deref(), Some("X"));
        assert_eq!(change_value(&json!(2020)).as_deref(), Some("2020"));
        assert_eq!(change_value(&json!(null)), None);
    }

    // ---- tag write round-trip (in-memory Tag; lofty cannot synthesize a valid
    //      audio file in-test, so the file-level save_to_path glue is exercised
    //      only in the real app. The mutation logic it wraps is fully tested here
    //      against both ID3v2 and Mp4Ilst tags.) ----

    fn roundtrip_changes() -> HashMap<String, Value> {
        let mut c = HashMap::new();
        c.insert("title".into(), json!({ "old": "", "new": "The Way of Kings" }));
        c.insert("author".into(), json!({ "old": "", "new": "Brandon Sanderson" }));
        c.insert("narrator".into(), json!({ "old": "", "new": "Narrated by Michael Kramer" }));
        c.insert("genre".into(), json!({ "old": "", "new": "Fantasy, Epic" }));
        c.insert("series".into(), json!({ "old": "", "new": "Stormlight Archive" }));
        c.insert("sequence".into(), json!({ "old": "", "new": "1" }));
        c.insert("year".into(), json!({ "old": "", "new": "2010" }));
        // ABS-only / unsupported field must be skipped silently, not fail.
        c.insert("tags".into(), json!({ "old": "", "new": "dna:pacing:fast" }));
        c
    }

    fn assert_roundtrip(tag: &Tag) {
        assert_eq!(tag.title().as_deref(), Some("The Way of Kings"));
        assert_eq!(tag.get_string(&ItemKey::AlbumArtist), Some("Brandon Sanderson"));
        assert_eq!(tag.get_string(&ItemKey::Composer), Some("Narrated by Michael Kramer"));
        assert_eq!(tag.genre().as_deref(), Some("Fantasy, Epic"));
        assert_eq!(tag.get_string(&ItemKey::Movement), Some("Stormlight Archive"));
        assert_eq!(tag.get_string(&ItemKey::MovementNumber), Some("1"));
        assert_eq!(tag.year(), Some(2010));
    }

    #[test]
    fn tag_roundtrip_id3v2() {
        let mut tag = Tag::new(TagType::Id3v2);
        let skipped = apply_changes_to_tag(&mut tag, &roundtrip_changes());
        // Only the ABS-only `tags` field is unembeddable; the rest round-trip.
        assert_eq!(skipped, vec!["tags"], "only ABS-only tags should skip");
        assert_roundtrip(&tag);
    }

    #[test]
    fn tag_roundtrip_mp4ilst() {
        // m4b is the real production format; series maps to the ©mvn/©mvi atoms.
        let mut tag = Tag::new(TagType::Mp4Ilst);
        let skipped = apply_changes_to_tag(&mut tag, &roundtrip_changes());
        assert_eq!(skipped, vec!["tags"], "only ABS-only tags should skip");
        assert_roundtrip(&tag);
        // AND the MP4 freeform atoms scanner's fallback / ABS read must be written.
        assert_eq!(
            tag.get_string(&ItemKey::Unknown("----:com.apple.iTunes:SERIES".into())),
            Some("Stormlight Archive")
        );
        assert_eq!(
            tag.get_string(&ItemKey::Unknown("----:com.apple.iTunes:SERIES-PART".into())),
            Some("1")
        );
    }

    #[test]
    fn mp4_freeform_series_overwrites_stale_value() {
        // A previous tagger left a stale freeform SERIES atom; a write must replace
        // it (not append a second), so ABS never sees two-sources drift.
        let mut tag = Tag::new(TagType::Mp4Ilst);
        tag.push_unchecked(TagItem::new(
            ItemKey::Unknown("----:com.apple.iTunes:SERIES".into()),
            ItemValue::Text("Old Series".into()),
        ));
        let mut c = HashMap::new();
        c.insert("series".into(), json!({ "old": "", "new": "New Series" }));
        apply_changes_to_tag(&mut tag, &c);
        let key = ItemKey::Unknown("----:com.apple.iTunes:SERIES".into());
        let values: Vec<&str> = tag.get_strings(&key).collect();
        assert_eq!(values, vec!["New Series"], "stale freeform value must be replaced, not duplicated");
    }

    #[test]
    fn id3_does_not_write_mp4_freeform_atoms() {
        // The MP4-only freeform atoms must not leak onto ID3v2 files.
        let mut tag = Tag::new(TagType::Id3v2);
        let mut c = HashMap::new();
        c.insert("series".into(), json!({ "old": "", "new": "S" }));
        apply_changes_to_tag(&mut tag, &c);
        assert_eq!(
            tag.get_string(&ItemKey::Unknown("----:com.apple.iTunes:SERIES".into())),
            None
        );
        assert_eq!(tag.get_string(&ItemKey::Movement), Some("S"));
    }

    fn descriptive_changes() -> HashMap<String, Value> {
        let mut c = HashMap::new();
        c.insert("description".into(), json!({ "old": "", "new": "A sweeping epic." }));
        c.insert("publisher".into(), json!({ "old": "", "new": "Tor Books" }));
        c.insert("language".into(), json!({ "old": "", "new": "English" }));
        c.insert("subtitle".into(), json!({ "old": "", "new": "Book One" }));
        c.insert("isbn".into(), json!({ "old": "", "new": "9780765326355" }));
        c.insert("asin".into(), json!({ "old": "", "new": "B003ZWFO7E" }));
        c
    }

    #[test]
    fn writes_descriptive_fields_id3v2() {
        // ID3v2 expresses publisher (TPUB), language (TLAN), subtitle (TIT3) but
        // has no home for description, isbn, or asin -> those three are skipped.
        let mut tag = Tag::new(TagType::Id3v2);
        let skipped = apply_changes_to_tag(&mut tag, &descriptive_changes());
        assert_eq!(tag.get_string(&ItemKey::Publisher), Some("Tor Books"));
        assert_eq!(tag.get_string(&ItemKey::Language), Some("English"));
        assert_eq!(tag.get_string(&ItemKey::TrackSubtitle), Some("Book One"));
        let mut got: Vec<&str> = skipped.iter().map(|s| s.as_str()).collect();
        got.sort();
        assert_eq!(got, vec!["asin", "description", "isbn"]);
    }

    #[test]
    fn writes_descriptive_fields_mp4ilst() {
        // MP4 expresses description (desc), language, subtitle (SUBTITLE freeform),
        // isbn/asin (freeform) but has no publisher atom -> publisher is skipped.
        let mut tag = Tag::new(TagType::Mp4Ilst);
        let skipped = apply_changes_to_tag(&mut tag, &descriptive_changes());
        assert_eq!(tag.get_string(&ItemKey::Description), Some("A sweeping epic."));
        assert_eq!(tag.get_string(&ItemKey::Language), Some("English"));
        assert_eq!(tag.get_string(&ItemKey::TrackSubtitle), Some("Book One"));
        assert_eq!(
            tag.get_string(&ItemKey::Unknown("----:com.apple.iTunes:ISBN".into())),
            Some("9780765326355")
        );
        assert_eq!(
            tag.get_string(&ItemKey::Unknown("----:com.apple.iTunes:ASIN".into())),
            Some("B003ZWFO7E")
        );
        assert_eq!(skipped, vec!["publisher"]);
    }

    #[test]
    fn tag_write_preserves_existing_untouched_fields() {
        let mut tag = Tag::new(TagType::Id3v2);
        tag.push(TagItem::new(ItemKey::Comment, ItemValue::Text("keep me".into())));
        let mut c = HashMap::new();
        c.insert("title".into(), json!({ "old": "", "new": "New Title" }));
        apply_changes_to_tag(&mut tag, &c);
        assert_eq!(tag.get_string(&ItemKey::Comment), Some("keep me"));
        assert_eq!(tag.title().as_deref(), Some("New Title"));
    }

    // ---- backup + undo restore round-trip (real filesystem) ----

    #[test]
    fn backup_and_undo_restore_roundtrip() {
        let dir = tempdir().unwrap();
        let orig = dir.path().join("book.m4b");
        let bak = backup_path_for(&orig);
        // Original content, then a simulated pre-write backup + a modified file.
        fs::write(&orig, b"ORIGINAL").unwrap();
        fs::copy(&orig, &bak).unwrap();
        fs::write(&orig, b"MODIFIED").unwrap();

        let journal_path = dir.path().join("undo.json");
        let journal = UndoJournal {
            timestamp: now_secs(),
            entries: vec![JournalEntry {
                original_path: orig.to_string_lossy().to_string(),
                backup_path: bak.to_string_lossy().to_string(),
            }],
        };
        write_journal(&journal_path, &journal).unwrap();

        let loaded = read_journal(&journal_path).unwrap();
        let (restored, failed) = restore_from_journal(&loaded);
        assert!(failed.is_empty());
        assert_eq!(restored.len(), 1);
        // Original content is back and the .bak was consumed.
        assert_eq!(fs::read(&orig).unwrap(), b"ORIGINAL");
        assert!(!bak.exists());
    }

    // Helper mirroring undo_last_write's journal-keeping decision so the partial/
    // full/none cases are testable without touching the global app-data journal.
    fn resolve_journal_after_undo(
        journal_path: &Path,
        journal: &UndoJournal,
    ) -> (Vec<String>, Vec<(JournalEntry, String)>) {
        let (restored, failed) = restore_from_journal(journal);
        if failed.is_empty() {
            clear_journal(journal_path).unwrap();
        } else {
            let remaining = UndoJournal {
                timestamp: journal.timestamp,
                entries: failed.iter().map(|(e, _)| e.clone()).collect(),
            };
            write_journal(journal_path, &remaining).unwrap();
        }
        (restored, failed)
    }

    #[test]
    fn undo_partial_failure_keeps_failed_entries_in_journal() {
        let dir = tempdir().unwrap();
        // Entry 1: real backup present -> restores. Entry 2: backup missing -> fails.
        let orig1 = dir.path().join("a.m4b");
        let bak1 = backup_path_for(&orig1);
        fs::write(&orig1, b"MODIFIED").unwrap();
        fs::write(&bak1, b"ORIGINAL").unwrap();
        let orig2 = dir.path().join("b.m4b");
        let bak2 = backup_path_for(&orig2);

        let journal_path = dir.path().join("undo.json");
        let journal = UndoJournal {
            timestamp: now_secs(),
            entries: vec![
                JournalEntry {
                    original_path: orig1.to_string_lossy().to_string(),
                    backup_path: bak1.to_string_lossy().to_string(),
                },
                JournalEntry {
                    original_path: orig2.to_string_lossy().to_string(),
                    backup_path: bak2.to_string_lossy().to_string(),
                },
            ],
        };
        write_journal(&journal_path, &journal).unwrap();

        let (restored, failed) = resolve_journal_after_undo(&journal_path, &journal);
        assert_eq!(restored, vec![orig1.to_string_lossy().to_string()]);
        assert_eq!(failed.len(), 1);
        assert!(!failed[0].1.is_empty(), "failure must carry a reason");
        // The failed entry (and its backup path) is retained for retry.
        let remaining = read_journal(&journal_path).unwrap();
        assert_eq!(remaining.entries.len(), 1);
        assert_eq!(remaining.entries[0].original_path, orig2.to_string_lossy().to_string());
        assert_eq!(remaining.timestamp, journal.timestamp, "timestamp preserved");
    }

    #[test]
    fn undo_full_success_clears_journal() {
        let dir = tempdir().unwrap();
        let orig = dir.path().join("a.m4b");
        let bak = backup_path_for(&orig);
        fs::write(&orig, b"MODIFIED").unwrap();
        fs::write(&bak, b"ORIGINAL").unwrap();
        let journal_path = dir.path().join("undo.json");
        let journal = UndoJournal {
            timestamp: now_secs(),
            entries: vec![JournalEntry {
                original_path: orig.to_string_lossy().to_string(),
                backup_path: bak.to_string_lossy().to_string(),
            }],
        };
        write_journal(&journal_path, &journal).unwrap();

        let (restored, failed) = resolve_journal_after_undo(&journal_path, &journal);
        assert_eq!(restored.len(), 1);
        assert!(failed.is_empty());
        assert!(read_journal(&journal_path).is_none(), "journal cleared on full success");
    }

    #[test]
    fn undo_full_failure_keeps_journal() {
        let dir = tempdir().unwrap();
        // Backup missing -> the sole entry fails and must be retained.
        let orig = dir.path().join("a.m4b");
        let bak = backup_path_for(&orig);
        let journal_path = dir.path().join("undo.json");
        let journal = UndoJournal {
            timestamp: now_secs(),
            entries: vec![JournalEntry {
                original_path: orig.to_string_lossy().to_string(),
                backup_path: bak.to_string_lossy().to_string(),
            }],
        };
        write_journal(&journal_path, &journal).unwrap();

        let (restored, failed) = resolve_journal_after_undo(&journal_path, &journal);
        assert!(restored.is_empty());
        assert_eq!(failed.len(), 1);
        let remaining = read_journal(&journal_path).unwrap();
        assert_eq!(remaining.entries.len(), 1);
    }

    #[test]
    fn undo_status_available_only_with_entries() {
        let dir = tempdir().unwrap();
        let journal_path = dir.path().join("undo.json");
        // No journal file -> unavailable.
        assert!(read_journal(&journal_path).is_none());
        // Empty journal counts as unavailable per get_undo_status logic.
        let empty = UndoJournal { timestamp: now_secs(), entries: vec![] };
        write_journal(&journal_path, &empty).unwrap();
        let loaded = read_journal(&journal_path).unwrap();
        assert!(loaded.entries.is_empty());
    }

    // ---- rename collision refusal ----

    #[test]
    fn rename_refuses_to_overwrite_existing_target() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.m4b");
        let b = dir.path().join("b.m4b");
        fs::write(&a, b"A").unwrap();
        fs::write(&b, b"B").unwrap();

        let err = rename_one(&a.to_string_lossy(), &b.to_string_lossy());
        assert!(err.is_err(), "rename over an existing distinct file must fail");
        // Both files untouched.
        assert_eq!(fs::read(&a).unwrap(), b"A");
        assert_eq!(fs::read(&b).unwrap(), b"B");
    }

    #[test]
    fn rename_to_free_target_succeeds() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.m4b");
        let c = dir.path().join("c.m4b");
        fs::write(&a, b"A").unwrap();
        assert!(rename_one(&a.to_string_lossy(), &c.to_string_lossy()).is_ok());
        assert!(!a.exists());
        assert_eq!(fs::read(&c).unwrap(), b"A");
    }

    #[test]
    fn rename_missing_source_fails() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("nope.m4b");
        let c = dir.path().join("c.m4b");
        assert!(rename_one(&a.to_string_lossy(), &c.to_string_lossy()).is_err());
    }

    // ---- template formatting ----

    #[test]
    fn template_basic_substitution_and_extension() {
        let meta = json!({ "author": "Brandon Sanderson", "title": "The Way of Kings", "year": "2010" });
        let stem = render_template("{author} - {title} ({year})", &meta);
        assert_eq!(stem, "Brandon Sanderson - The Way of Kings (2010)");
        let (new_path, changed) = compute_new_path("/books/old.m4b", &stem);
        assert_eq!(new_path, "/books/Brandon Sanderson - The Way of Kings (2010).m4b");
        assert!(changed);
    }

    #[test]
    fn template_sequence_zero_is_present() {
        let meta = json!({ "series": "Prequels", "sequence": "0", "title": "Origins" });
        let stem = render_template("{series} {sequence} - {title}", &meta);
        assert_eq!(stem, "Prequels 0 - Origins");
    }

    #[test]
    fn template_missing_fields_render_empty() {
        let meta = json!({ "author": "Anon", "title": "Solo" });
        // year and narrator absent -> render empty, collapse to a clean stem.
        let stem = render_template("{author} - {title} ({year})", &meta);
        assert_eq!(stem, "Anon - Solo ()");
        let (new_path, _) = compute_new_path("/x/y.mp3", &stem);
        assert_eq!(new_path, "/x/Anon - Solo ().mp3");
    }

    #[test]
    fn template_sanitizes_illegal_chars() {
        let meta = json!({ "title": "A/B: C? D*" });
        let stem = render_template("{title}", &meta);
        let (new_path, _) = compute_new_path("/x/y.m4b", &stem);
        // Illegal chars removed, whitespace collapsed.
        assert_eq!(new_path, "/x/AB C D.m4b");
    }

    #[test]
    fn template_strips_leftover_unknown_blocks() {
        let meta = json!({ "author": "A", "title": "T" });
        // Safety net for a pasted conditional-block default: unknown {...} vanish.
        let stem = render_template("{author} - {[series #sequence] }{title}", &meta);
        assert_eq!(stem, "A - T");
    }

    #[test]
    fn empty_template_yields_no_change() {
        let (new_path, changed) = compute_new_path("/x/y.m4b", &render_template("", &json!({})));
        assert_eq!(new_path, "/x/y.m4b");
        assert!(!changed);
    }
}
