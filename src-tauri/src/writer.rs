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
// Write-field honesty: apply_changes embeds every field the tag format can
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
    #[serde(default)]
    pub group_size: Option<usize>,
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
///
/// `multi_file` is true when this file is one of several files that make up a
/// single book. The book title then lives in the album field (scanner.rs's
/// pick_metadata reads album first), so a `title` change is written to album and
/// the file's own track title is left alone. For a single-file book the title
/// goes to the title field, and to album too when album held the old title.
pub fn apply_changes(tag: &mut Tag, changes: &HashMap<String, Value>, multi_file: bool) -> Vec<String> {
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
                // An explicit album change in the same set wins over the title rule.
                let album_is_explicit = changes.get("album").and_then(change_value).is_some();
                if multi_file {
                    if !album_is_explicit {
                        tag.set_album(value);
                    }
                } else {
                    let album_held_old_title = tag.album().is_some_and(|album| {
                        let album = album.trim();
                        let old_change = raw.get("old").and_then(Value::as_str).map(str::trim);
                        let old_tag_title = tag.title().map(|t| t.trim().to_string());
                        !album.is_empty()
                            && (old_change == Some(album) || old_tag_title.as_deref() == Some(album))
                    });
                    if album_held_old_title && !album_is_explicit {
                        tag.set_album(value.clone());
                    }
                    tag.set_title(value);
                }
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
                    // lofty's set_year keeps the month and day of an existing full
                    // date ("2015-06-01" -> "2020-06-01"). The user asked for a
                    // year, so drop the old date first and store the year alone.
                    tag.remove_year();
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

/// Single-file form of apply_changes, kept for the tag-level unit tests.
#[cfg(test)]
pub fn apply_changes_to_tag(tag: &mut Tag, changes: &HashMap<String, Value>) -> Vec<String> {
    apply_changes(tag, changes, false)
}

/// The value of the first series-number change in the set, if any.
fn sequence_value(changes: &HashMap<String, Value>) -> Option<String> {
    ["sequence", "series_number", "series-part"]
        .iter()
        .find_map(|k| changes.get(*k).and_then(change_value))
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

#[cfg(test)]
fn write_one_file(file: &WriteFile, backup: bool) -> FileWriteOutcome {
    let multi_file = file.group_size.unwrap_or(1) > 1;
    write_one_file_recorded(file, backup, multi_file, &mut |_| Ok(()))
}

/// `record` persists the undo-journal entry for this file. It runs AFTER the
/// backup lands and BEFORE the original is touched; if it fails the backup is
/// removed and the file is left unmodified, so there is never a modified file
/// that undo does not know about.
fn write_one_file_recorded(
    file: &WriteFile,
    backup: bool,
    multi_file: bool,
    record: &mut dyn FnMut(&JournalEntry) -> Result<(), String>,
) -> FileWriteOutcome {
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
        let entry = JournalEntry {
            original_path: file.path.clone(),
            backup_path: bak.to_string_lossy().to_string(),
        };
        if let Err(e) = record(&entry) {
            let _ = fs::remove_file(&bak);
            return FileWriteOutcome {
                result: Err(format!("could not record undo journal, file left unchanged: {e}")),
                journal: None,
                skipped: Vec::new(),
            };
        }
        journal = Some(entry);
    }

    // Mutate a temp copy, then atomically swap it in (see write_tags_atomically).
    match write_tags_atomically(&path, &file.changes, multi_file) {
        Ok(skipped) => FileWriteOutcome {
            result: Ok(()),
            journal,
            skipped,
        },
        Err(e) => FileWriteOutcome {
            result: Err(e),
            journal,
            skipped: Vec::new(),
        },
    }
}

/// Write the change set into `path` without ever leaving a half-written file:
/// the tags are written into a temp copy in the SAME directory (so the final
/// rename is atomic on one filesystem), the copy is fsynced, then renamed over
/// the original. Any failure removes the temp copy and leaves the original
/// untouched. Returns the fields that could not be embedded (see
/// apply_changes).
pub fn write_tags_atomically(
    path: &Path,
    changes: &HashMap<String, Value>,
    multi_file: bool,
) -> Result<Vec<String>, String> {
    let dir = parent_dir_of(path);
    let tmp = temp_path_for(path);

    let result = (|| -> Result<Vec<String>, String> {
        fs::copy(path, &tmp).map_err(|e| format!("temp copy failed: {e}"))?;
        let skipped = write_tags_in_place(&tmp, changes, multi_file)?;
        fs::File::open(&tmp)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("fsync failed: {e}"))?;
        fs::rename(&tmp, path).map_err(|e| format!("replace failed: {e}"))?;
        // Best-effort: persist the directory entry change too (unix only).
        #[cfg(unix)]
        if let Ok(d) = fs::File::open(&dir) {
            let _ = d.sync_all();
        }
        Ok(skipped)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// lofty re-encodes every BE-signed-integer atom as 4 bytes, but iTunes-style
/// readers (ffmpeg, Apple Books, AudiobookShelf) read `stik`/`rtng`/... as ONE
/// byte and `tmpo` as two - so a 4-byte `stik` of 2 reads back as 0 ("Movie").
/// Re-encode the well-known fixed-width atoms at their spec width.
fn restore_mp4_int_widths(ilst: &mut lofty::mp4::Ilst) {
    use lofty::mp4::{Atom, AtomData, AtomIdent};
    const WIDTHS: &[(&[u8; 4], usize)] = &[
        (b"stik", 1), (b"rtng", 1), (b"pgap", 1), (b"cpil", 1), (b"hdvd", 1),
        (b"shwm", 1), (b"akID", 1), (b"tmpo", 2),
    ];
    for (code, width) in WIDTHS {
        let ident = AtomIdent::Fourcc(**code);
        let value = match ilst.get(&ident).and_then(|a| a.data().next().cloned()) {
            Some(AtomData::SignedInteger(v)) => v,
            _ => continue,
        };
        let bytes = value.to_be_bytes();
        ilst.replace_atom(Atom::new(
            ident,
            AtomData::Unknown { code: 21, data: bytes[4 - width..].to_vec() },
        ));
    }
}

/// The directory a file lives in ("." for a bare file name).
fn parent_dir_of(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// Prefix of every temp copy a tag write stages through. scanner.rs skips files
/// with this prefix and sweep_temp_files removes them.
pub const TEMP_PREFIX: &str = ".tagtmp-";

/// The sibling temp file a write of `path` stages through:
/// `.tagtmp-<uuid>.<ext>`. Its length does not depend on the original name, so a
/// long filename still has room for its temp copy (the old
/// `.<name>.tagtmp-<uuid>.<ext>` form overflowed the 255-byte limit at about
/// 210 characters). The real extension stays last so lofty's type detection
/// still works.
pub fn temp_path_for(path: &Path) -> PathBuf {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
    parent_dir_of(path).join(format!("{TEMP_PREFIX}{}.{ext}", uuid::Uuid::new_v4().simple()))
}

/// Remove temp copies a crashed write left in `dir` (not recursive). Only plain
/// files matching is_temp_file_name are touched. Returns how many were removed.
pub fn sweep_temp_files(dir: &Path) -> usize {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut removed = 0;
    for entry in entries.filter_map(|e| e.ok()) {
        let is_temp = is_temp_file_name(&entry.file_name().to_string_lossy());
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if is_temp && is_file && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Audio extensions a temp copy can carry (the formats the scanner reads).
const TEMP_AUDIO_EXTENSIONS: &[&str] = &["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"];

/// True only for a temp copy a tag write stages through, matched exactly so a
/// user's own dot-file is never swept:
///   current form  `.tagtmp-<32 lowercase hex>.<ext>`
///   older form    `.<file name>.tagtmp-<32 lowercase hex>.<ext>`
/// where `<ext>` is one audio extension.
pub fn is_temp_file_name(name: &str) -> bool {
    let rest = match name.strip_prefix('.') {
        Some(r) => r,
        None => return false,
    };
    let (stem, ext) = match rest.rsplit_once('.') {
        Some(parts) => parts,
        None => return false,
    };
    if !TEMP_AUDIO_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
        return false;
    }
    let tag = &TEMP_PREFIX[1..]; // "tagtmp-"
    let hex = match stem.strip_prefix(tag) {
        Some(h) => h,
        None => match stem.rsplit_once(TEMP_PREFIX) {
            Some((original, h)) if !original.is_empty() => h,
            _ => return false,
        },
    };
    hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

const LYRICS_COLLISION: &str = "multiple lyrics frames with the same description; file not written";
const COMMENT_COLLISION: &str = "multiple comment frames with the same description; file not written";
const ID3_UNVERIFIABLE: &str = "this file's ID3v2 tag could not be verified for lyrics and comments; file not written";
const ID3_MULTIPLE_TAGS: &str = "this file has more than one ID3v2 tag at the start; file not written";

/// What a raw walk of the leading ID3v2 tag found.
#[derive(Debug, PartialEq)]
enum RawId3 {
    /// The file does not start with an ID3v2 tag.
    NoTag,
    /// A tag is there but cannot be walked with confidence (unsupported
    /// version, tag-wide unsynchronisation, truncated or inconsistent data).
    Unverifiable,
    /// Frame counts of the first tag, and whether another tag follows it.
    Counts { lyrics: usize, comments: usize, another_tag_follows: bool },
}

/// Walk the raw bytes of the ID3v2 tag at the start of `path`, counting USLT
/// (v2.2: ULT) and COMM (v2.2: COM) frames. lofty compares those frames by
/// description only, so its reader silently keeps one of two frames that
/// share a description; comparing these raw counts with lofty's parsed counts
/// is how the writer notices. lofty also folds the frames of any further
/// leading tags into the first, so a second tag is reported too.
fn walk_raw_id3v2(path: &Path) -> RawId3 {
    use std::io::Read;
    fn syncsafe(b: &[u8]) -> usize {
        b.iter().fold(0usize, |acc, x| (acc << 7) | (*x as usize & 0x7f))
    }
    fn be(b: &[u8]) -> usize {
        b.iter().fold(0usize, |acc, x| (acc << 8) | *x as usize)
    }
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return RawId3::Unverifiable,
    };
    let mut header = [0u8; 10];
    if f.read_exact(&mut header).is_err() || &header[..3] != b"ID3" {
        return RawId3::NoTag;
    }
    let version = header[3];
    let flags = header[5];
    if flags & 0x80 != 0 || !(2..=4).contains(&version) {
        return RawId3::Unverifiable;
    }
    // Read through take() so a header claiming a huge size cannot force a huge
    // allocation; a short read means the tag is truncated.
    let size = syncsafe(&header[6..10]);
    let mut data = Vec::new();
    if (&mut f).take(size as u64).read_to_end(&mut data).is_err() || data.len() != size {
        return RawId3::Unverifiable;
    }

    let mut pos = 0usize;
    if version >= 3 && flags & 0x40 != 0 {
        let ext = match data.get(0..4) {
            Some(e) => e,
            None => return RawId3::Unverifiable,
        };
        pos = if version == 3 { 4 + be(ext) } else { syncsafe(ext) };
    }
    let (id_len, size_len, header_len) = if version == 2 { (3, 3, 6) } else { (4, 4, 10) };
    let (mut lyrics, mut comments) = (0usize, 0usize);
    while pos + header_len <= data.len() {
        let id = &data[pos..pos + id_len];
        if id[0] == 0 {
            break; // padding
        }
        let size_bytes = &data[pos + id_len..pos + id_len + size_len];
        let frame_size = if version == 4 { syncsafe(size_bytes) } else { be(size_bytes) };
        match id {
            b"USLT" | b"ULT" => lyrics += 1,
            b"COMM" | b"COM" => comments += 1,
            _ => {}
        }
        pos = match pos.checked_add(header_len + frame_size) {
            Some(p) if p <= data.len() => p,
            _ => return RawId3::Unverifiable,
        };
    }

    // An ID3v2.4 footer (flag 0x10) is 10 bytes after the tag; then see
    // whether another tag starts right away.
    if version == 4 && flags & 0x10 != 0 {
        let mut footer = [0u8; 10];
        if f.read_exact(&mut footer).is_err() || &footer[..3] != b"3DI" {
            return RawId3::Unverifiable;
        }
    }
    let mut next = [0u8; 3];
    let another_tag_follows = f.read_exact(&mut next).is_ok() && &next == b"ID3";
    RawId3::Counts { lyrics, comments, another_tag_follows }
}

/// Refuse a write that would silently drop a lyrics or comment frame: lofty's
/// parsed counts must match the raw tag, the raw tag must be walkable, and the
/// file must have a single leading tag.
fn check_id3_frames_preserved(path: &Path, parsed_lyrics: usize, parsed_comments: usize) -> Result<(), String> {
    match walk_raw_id3v2(path) {
        // Nothing lofty could drop: no lyrics or comments parsed and no tag
        // we could count in. (A tag we cannot walk that DOES hold lyrics or
        // comments is refused below.)
        RawId3::NoTag | RawId3::Unverifiable if parsed_lyrics + parsed_comments == 0 => Ok(()),
        RawId3::NoTag | RawId3::Unverifiable => Err(ID3_UNVERIFIABLE.to_string()),
        RawId3::Counts { another_tag_follows: true, .. } => Err(ID3_MULTIPLE_TAGS.to_string()),
        RawId3::Counts { lyrics, .. } if lyrics != parsed_lyrics => Err(LYRICS_COLLISION.to_string()),
        RawId3::Counts { comments, .. } if comments != parsed_comments => Err(COMMENT_COLLISION.to_string()),
        RawId3::Counts { .. } => Ok(()),
    }
}

/// Read, mutate, save `path` in place (only ever called on a temp copy).
///
/// MP4 and MPEG are written through lofty's FORMAT-SPECIFIC tags rather than
/// the generic TaggedFile: converting an Ilst to a generic Tag and back drops
/// every atom without an ItemKey - notably `stik` (media kind = Audiobook),
/// `rtng`, `tmpo`, `gnre` - so one title edit used to turn an audiobook into
/// "music". split_tag/merge_tag keeps those atoms in the remainder.
fn write_tags_in_place(
    path: &Path,
    changes: &HashMap<String, Value>,
    multi_file: bool,
) -> Result<Vec<String>, String> {
    use lofty::config::ParseOptions;
    use lofty::file::FileType;
    use lofty::tag::{MergeTag, SplitTag, TagExt};

    let file_type = Probe::open(path)
        .map_err(|e| format!("read failed: {e}"))?
        .guess_file_type()
        .map_err(|e| format!("read failed: {e}"))?
        .file_type();

    match file_type {
        Some(FileType::Mp4) => {
            let mut f = fs::File::open(path).map_err(|e| format!("read failed: {e}"))?;
            let mp4 = lofty::mp4::Mp4File::read_from(&mut f, ParseOptions::new())
                .map_err(|e| format!("read failed: {e}"))?;
            drop(f);
            let ilst = mp4.ilst().cloned().unwrap_or_default();
            let (remainder, mut tag) = ilst.split_tag();
            let skipped = apply_changes(&mut tag, changes, multi_file);
            let mut merged = remainder.merge_tag(tag);
            restore_mp4_int_widths(&mut merged);
            merged
                .save_to_path(path, WriteOptions::default())
                .map_err(|e| format!("save failed: {e}"))?;
            Ok(skipped)
        }
        Some(FileType::Mpeg) => {
            let mut f = fs::File::open(path).map_err(|e| format!("read failed: {e}"))?;
            let mpeg = lofty::mpeg::MpegFile::read_from(&mut f, ParseOptions::new())
                .map_err(|e| format!("read failed: {e}"))?;
            drop(f);
            let id3 = mpeg.id3v2().cloned().unwrap_or_default();
            // lofty turns a TXXX frame whose description is 4 chars (e.g. "ASIN")
            // into ItemKey::Unknown("ASIN"), which merge_tag then mistakes for a
            // frame ID and refuses to save (BadFrame "ASIN"). Pull those values out
            // of the generic tag and re-insert them as proper TXXX frames.
            let short_txxx: Vec<String> = (&id3)
                .into_iter()
                .filter(|fr| fr.id_str() == "TXXX")
                .filter_map(|fr| match fr.content() {
                    lofty::id3::v2::FrameValue::UserText(t) if t.description.len() == 4 => {
                        Some(t.description.clone())
                    }
                    _ => None,
                })
                .collect();
            // Same idea for lyrics: split_tag turns a USLT frame into a generic
            // ItemKey::Lyrics item, and merge_tag writes that back as a plain text
            // frame with the USLT id, which lofty refuses to save (BadFrame
            // "USLT"). Keep the original USLT frames aside, untouched, and put
            // them back after the merge.
            let lyrics: Vec<lofty::id3::v2::Frame<'static>> =
                (&id3).into_iter().filter(|fr| fr.id_str() == "USLT").cloned().collect();
            // lofty treats two USLT frames as equal when their descriptions
            // match (language is ignored) and its reader already keeps only one
            // of them, so the parsed tag can hold fewer lyrics frames than the
            // file. check_id3_frames_preserved compares with the raw tag and
            // refuses the write rather than drop lyrics.
            // COMM frames have the same weakness, and a second leading tag is
            // folded into the first on read but left behind on write.
            let parsed_comments = (&id3).into_iter().filter(|fr| fr.id_str() == "COMM").count();
            check_id3_frames_preserved(path, lyrics.len(), parsed_comments)?;
            let (remainder, mut tag) = id3.split_tag();
            tag.remove_key(&ItemKey::Lyrics);
            let mut user_text: Vec<(String, String)> = Vec::new();
            for desc in short_txxx {
                let key = ItemKey::Unknown(desc.clone());
                let vals: Vec<String> = tag.take_strings(&key).collect();
                if !vals.is_empty() {
                    user_text.push((desc, vals.join("\0")));
                }
            }
            let skipped = apply_changes(&mut tag, changes, multi_file);
            let mut merged = remainder.merge_tag(tag);
            for (desc, content) in user_text {
                let _ = merged.insert_user_text(desc, content);
            }
            // split_tag leaves some USLT frames (those with a description) in
            // the remainder, so clear every USLT the merge produced and put
            // back exactly the frames collected above. A replaced frame now
            // means two of them collided.
            let uslt_id = lofty::id3::v2::FrameId::Valid(std::borrow::Cow::Borrowed("USLT"));
            let _: Vec<_> = merged.remove(&uslt_id).collect();
            for frame in lyrics {
                if merged.insert(frame).is_some() {
                    return Err(LYRICS_COLLISION.to_string());
                }
            }
            // MVIN only holds whole numbers (lofty drops "1.5" on read), so a
            // decimal series position would be lost. Also store the exact value
            // in TXXX:SERIES-PART, which scanner.rs reads first.
            if let Some(seq) = sequence_value(changes) {
                let _ = merged.insert_user_text("SERIES-PART".to_string(), seq);
            }
            merged
                .save_to_path(path, WriteOptions::default())
                .map_err(|e| format!("save failed: {e}"))?;
            Ok(skipped)
        }
        _ => {
            let mut tagged = Probe::open(path)
                .and_then(|p| p.read())
                .map_err(|e| format!("read failed: {e}"))?;
            let tag_type = tagged.primary_tag_type();
            if tagged.primary_tag().is_none() {
                tagged.insert_tag(Tag::new(tag_type));
            }
            let tag = tagged
                .primary_tag_mut()
                .ok_or_else(|| "could not create a writable tag".to_string())?;
            let skipped = apply_changes(tag, changes, multi_file);
            tagged
                .save_to_path(path, WriteOptions::default())
                .map_err(|e| format!("save failed: {e}"))?;
            Ok(skipped)
        }
    }
}

/// Serialises the file-changing commands. They used to run one at a time on
/// the main thread; now that they are async, two batches could otherwise
/// interleave (one batch's temp sweep or journal reset racing another's write).
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run blocking file work off the async runtime's worker threads (as
/// scan_library does) so a large batch does not freeze the window, holding
/// WRITE_LOCK for the duration.
async fn run_file_job<F>(job: F) -> Result<Value, String>
where
    F: FnOnce() -> Value + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        job()
    })
    .await
    .map_err(|e| format!("File task failed: {e}"))
}

#[tauri::command]
pub async fn write_tags(request: WriteRequest) -> Result<Value, String> {
    run_file_job(move || write_tags_at(request, &default_journal_path())).await
}

/// Whether a file belongs to a multi-file book. The caller's `group_size` wins;
/// without it, files in the same request that share a directory are taken to be
/// one book (the scanner groups by folder). `files_per_dir` is the request's
/// per-directory file count, computed once per batch.
fn is_multi_file(file: &WriteFile, files_per_dir: &HashMap<PathBuf, usize>) -> bool {
    match file.group_size {
        Some(n) => n > 1,
        None => files_per_dir.get(&parent_dir_of(Path::new(&file.path))).copied().unwrap_or(0) > 1,
    }
}

pub fn write_tags_at(request: WriteRequest, journal_path: &Path) -> Value {
    let mut success = 0usize;
    let mut failed = 0usize;
    let mut errors: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let mut journal_entries: Vec<JournalEntry> = Vec::new();
    let timestamp = now_secs();

    // Iterate file_ids to preserve the caller's order; fall back to the map keys
    // for any ids the caller omitted from file_ids.
    let mut ordered_ids: Vec<String> = request.file_ids.clone();
    for id in request.files.keys() {
        if !ordered_ids.contains(id) {
            ordered_ids.push(id.clone());
        }
    }

    // Every write starts a fresh journal so a backup=false write leaves
    // get_undo_status.available=false. If the stale journal cannot be cleared,
    // undo would restore the PREVIOUS batch over this one - refuse to write.
    if let Err(e) = clear_journal(journal_path) {
        let msg = format!("could not reset undo journal: {e}");
        for id in &ordered_ids {
            let path = request.files.get(id).map(|f| f.path.clone()).unwrap_or_default();
            errors.push(json!({ "file_id": id, "path": path, "error": msg }));
            results.push(json!({ "file_id": id, "path": path, "status": "failed", "skipped_fields": [] }));
        }
        return json!({ "success": 0, "failed": ordered_ids.len(), "errors": errors, "results": results });
    }

    // Count the request's files per folder (for is_multi_file), and clear temp
    // copies a crashed earlier write left behind in those folders before any
    // new work starts.
    let mut files_per_dir: HashMap<PathBuf, usize> = HashMap::new();
    for file in request.files.values() {
        *files_per_dir.entry(parent_dir_of(Path::new(&file.path))).or_insert(0) += 1;
    }
    for dir in files_per_dir.keys() {
        sweep_temp_files(dir);
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

        // Persist the journal (including this file's entry) BEFORE the file is
        // modified, so a crash mid-batch still leaves every touched file undoable.
        let mut record = |entry: &JournalEntry| -> Result<(), String> {
            let mut entries = journal_entries.clone();
            entries.push(entry.clone());
            write_journal(journal_path, &UndoJournal { timestamp, entries })
        };
        let FileWriteOutcome {
            result,
            journal,
            skipped,
        } = write_one_file_recorded(file, request.backup, is_multi_file(file, &files_per_dir), &mut record);
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

/// Persist the journal atomically (sibling temp file, fsync, rename; see
/// session::atomic_write), so a crash mid-write can never leave a truncated
/// journal that loses track of files undo must restore.
pub fn write_journal(path: &Path, journal: &UndoJournal) -> Result<(), String> {
    let data = serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?;
    crate::session::atomic_write(path, data.as_bytes())
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
pub async fn undo_last_write() -> Result<Value, String> {
    run_file_job(|| undo_last_write_at(&default_journal_path())).await
}

pub fn undo_last_write_at(journal_path: &Path) -> Value {
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
    let journal_result = if failed.is_empty() {
        clear_journal(&journal_path)
    } else {
        let remaining = UndoJournal {
            timestamp: journal.timestamp,
            entries: failed.iter().map(|(entry, _)| entry.clone()).collect(),
        };
        write_journal(&journal_path, &remaining)
    };

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
    if let Err(e) = journal_result {
        resp["journal_error"] = json!(format!("undo journal could not be updated: {e}"));
    }
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
    match clear_journal(&journal_path) {
        Ok(()) => json!({ "cleared": true }),
        Err(e) => json!({ "cleared": false, "error": format!("could not clear undo journal: {e}") }),
    }
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
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    let base_len = trimmed.find('.').unwrap_or(trimmed.len());
    if is_reserved_device_name(trimmed[..base_len].trim_end()) {
        let mut fixed = trimmed[..base_len].trim_end().to_string();
        fixed.push('_');
        fixed.push_str(&trimmed[base_len..]);
        return fixed;
    }
    trimmed
}

/// Windows reserved device names. A file whose name (before the first dot) is
/// one of these cannot be created on Windows, so it gets a trailing underscore
/// on every platform and a library moved between machines stays valid.
fn is_reserved_device_name(base: &str) -> bool {
    let upper = base.to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => {
            let b = upper.as_bytes();
            b.len() == 4
                && (upper.starts_with("COM") || upper.starts_with("LPT"))
                && (b'1'..=b'9').contains(&b[3])
        }
    }
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
/// empty; unknown `{...}` blocks in the TEMPLATE are dropped (a safety net for
/// someone pasting a conditional-block default). The template is read in one
/// pass, so a substituted value is inserted literally: braces inside a title
/// ("Weird {Unabridged} Book") are kept, and a value is never expanded again.
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
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars();
    while let Some(c) = chars.next() {
        match c {
            '{' => {
                // Collect the whole (possibly nested) block up to its matching '}'.
                let mut depth = 1usize;
                let mut inner = String::new();
                for c in chars.by_ref() {
                    match c {
                        '{' => depth += 1,
                        '}' => depth -= 1,
                        _ => {}
                    }
                    if depth == 0 {
                        break;
                    }
                    inner.push(c);
                }
                // A known variable renders its value; anything else (or an
                // unterminated block) renders nothing.
                if depth == 0 {
                    out.push_str(&resolve(&inner));
                }
            }
            '}' => {}
            c => out.push(c),
        }
    }
    out
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

/// `part`/`total_parts` (1-based) identify a file within a multi-file book.
/// Without them every file of a group renders to the same name and all but the
/// first rename collide. When total_parts > 1 the zero-padded part number fills
/// a `{part}` token if the template has one, else " - Part NN" is appended.
#[tauri::command]
pub fn preview_rename(
    file_path: String,
    metadata: Value,
    template: Option<String>,
    part: Option<u32>,
    total_parts: Option<u32>,
) -> Value {
    let template = template.unwrap_or_default();
    if template.trim().is_empty() {
        return json!({ "old_path": file_path, "new_path": file_path, "changed": false });
    }
    let multi = match (part, total_parts) {
        (Some(p), Some(t)) if t > 1 => {
            let width = t.to_string().len().max(2);
            Some(format!("{p:0width$}"))
        }
        _ => None,
    };
    let stem = match &multi {
        Some(num) if template.contains("{part}") => {
            render_template(&template.replace("{part}", num), &metadata)
        }
        Some(num) => format!("{} - Part {num}", render_template(&template, &metadata).trim_end()),
        None => render_template(&template.replace("{part}", ""), &metadata),
    };
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
    // symlink_metadata does not follow links: a symlink source is refused (the
    // rename would move the link, not the audio file it points at), and any
    // entry at the target, even a dangling link, counts as taken.
    match fs::symlink_metadata(&old) {
        Err(_) => return Err("source file not found".to_string()),
        Ok(m) if m.file_type().is_symlink() => {
            return Err("source is a symbolic link; not renamed".to_string())
        }
        Ok(_) => {}
    }
    if fs::symlink_metadata(&new).is_ok() && !same_file(&old, &new) {
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
pub async fn rename_files(renames: Vec<RenamePair>) -> Result<Value, String> {
    run_file_job(move || rename_files_at(renames, &default_journal_path())).await
}

/// Point any undo-journal entry for `old_path` at `new_path`, so undoing a
/// write after a rename restores the RENAMED file instead of resurrecting the
/// old name next to it (a duplicate). Ok(false) when no entry matched.
fn retarget_journal(journal_path: &Path, old_path: &str, new_path: &str) -> Result<bool, String> {
    let mut journal = match read_journal(journal_path) {
        Some(j) => j,
        None => return Ok(false),
    };
    let mut hit = false;
    for e in journal.entries.iter_mut() {
        if e.original_path == old_path {
            e.original_path = new_path.to_string();
            hit = true;
        }
    }
    if hit {
        write_journal(journal_path, &journal)?;
    }
    Ok(hit)
}

pub fn rename_files_at(renames: Vec<RenamePair>, journal_path: &Path) -> Value {
    let mut renamed: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let mut failed = 0usize;

    for pair in &renames {
        let outcome = rename_one(&pair.old_path, &pair.new_path).and_then(|()| {
            match retarget_journal(journal_path, &pair.old_path, &pair.new_path) {
                Ok(_) => Ok(()),
                Err(e) => {
                    // Could not keep undo consistent: put the file back.
                    let _ = fs::rename(&pair.new_path, &pair.old_path);
                    Err(format!("could not update undo journal, rename reverted: {e}"))
                }
            }
        });
        match outcome {
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

    // ---- real-file writes against ffmpeg-made scratch files (temp dir only) ----

    fn have_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn run_ffmpeg(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("ffmpeg")
            .current_dir(dir)
            .args(["-loglevel", "error", "-y"])
            .args(args)
            .output()
            .expect("ffmpeg");
        assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// m4b with stik=2 (Audiobook), two chapters and an embedded cover.
    fn make_m4b(dir: &Path) -> PathBuf {
        run_ffmpeg(dir, &["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", "cover.png"]);
        fs::write(
            dir.join("meta.txt"),
            ";FFMETADATA1\ntitle=Orig\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=Ch One\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1500\nEND=3000\ntitle=Ch Two\n",
        )
        .unwrap();
        run_ffmpeg(dir, &[
            "-f", "lavfi", "-i", "sine=d=3", "-i", "meta.txt", "-i", "cover.png",
            "-map", "0:a", "-map", "2:v", "-map_metadata", "1", "-map_chapters", "1",
            "-c:a", "aac", "-c:v", "png", "-disposition:v", "attached_pic",
            "-metadata", "media_type=2", "-movflags", "+faststart", "book.m4b",
        ]);
        dir.join("book.m4b")
    }

    fn ffprobe(path: &Path) -> String {
        let out = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-show_chapters", "-show_format", "-show_streams"])
            .arg(path)
            .output()
            .expect("ffprobe");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn title_change(title: &str) -> HashMap<String, Value> {
        let mut c = HashMap::new();
        c.insert("title".into(), json!({ "old": "", "new": title }));
        c
    }

    #[test]
    fn m4b_write_preserves_stik_chapters_and_cover() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = tempdir().unwrap();
        let m4b = make_m4b(dir.path());
        let before = ffprobe(&m4b);
        assert!(before.contains("TAG:media_type=2"), "fixture must carry stik=2");

        let wf = WriteFile { path: m4b.to_string_lossy().to_string(), changes: title_change("New Title"), group_size: None };
        let out = write_one_file(&wf, false);
        assert!(out.result.is_ok(), "write failed: {:?}", out.result);

        let after = ffprobe(&m4b);
        assert!(after.contains("TAG:title=New Title"), "title not written:\n{after}");
        assert!(after.contains("TAG:media_type=2"), "stik (Audiobook marker) was stripped:\n{after}");
        assert!(after.contains("TAG:title=Ch One") && after.contains("TAG:title=Ch Two"), "chapters lost:\n{after}");
        assert!(after.contains("codec_name=png"), "cover lost:\n{after}");

        // A second write (re-reading lofty's own output) must stay stable too.
        let wf2 = WriteFile { path: m4b.to_string_lossy().to_string(), changes: title_change("Second"), group_size: None };
        assert!(write_one_file(&wf2, false).result.is_ok());
        let again = ffprobe(&m4b);
        assert!(again.contains("TAG:title=Second") && again.contains("TAG:media_type=2"), "{again}");
        // The atomic write leaves no temp copies behind.
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("tagtmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind");
    }

    #[test]
    fn mp3_with_txxx_asin_is_writable() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = tempdir().unwrap();
        run_ffmpeg(dir.path(), &[
            "-f", "lavfi", "-i", "sine=d=1", "-c:a", "libmp3lame", "-id3v2_version", "3",
            "-metadata", "ASIN=B00TEST123", "-metadata", "title=Orig", "book.mp3",
        ]);
        let mp3 = dir.path().join("book.mp3");
        assert!(ffprobe(&mp3).contains("B00TEST123"), "fixture must carry TXXX:ASIN");

        let wf = WriteFile { path: mp3.to_string_lossy().to_string(), changes: title_change("New Title"), group_size: None };
        let out = write_one_file(&wf, false);
        assert!(out.result.is_ok(), "write failed: {:?}", out.result);
        let after = ffprobe(&mp3);
        assert!(after.contains("TAG:title=New Title"), "title not written:\n{after}");
        assert!(after.contains("B00TEST123"), "ASIN lost:\n{after}");
    }

    fn make_mp3(dir: &Path, name: &str) -> PathBuf {
        run_ffmpeg(dir, &["-f", "lavfi", "-i", "sine=d=1", "-c:a", "libmp3lame", "-metadata", "title=Orig", name]);
        dir.join(name)
    }

    fn one_file_request(path: &Path, backup: bool) -> WriteRequest {
        let mut files = HashMap::new();
        files.insert("f1".to_string(), WriteFile { path: path.to_string_lossy().to_string(), changes: title_change("New"), group_size: None });
        WriteRequest { file_ids: vec!["f1".into()], files, backup }
    }

    #[test]
    fn journal_entry_is_on_disk_before_the_file_is_modified() {
        if !have_ffmpeg() { return; }
        let dir = tempdir().unwrap();
        let mp3 = make_mp3(dir.path(), "a.mp3");
        let original = fs::read(&mp3).unwrap();
        // A journal that can be cleared (absent) but not written: read-only dir.
        let ro = dir.path().join("ro");
        fs::create_dir(&ro).unwrap();
        let journal_path = ro.join("undo.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&ro, fs::Permissions::from_mode(0o555)).unwrap();
        }
        #[cfg(not(unix))]
        return;

        let res = write_tags_at(one_file_request(&mp3, true), &journal_path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&ro, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(res["errors"][0]["error"].as_str().unwrap_or("").contains("undo journal"), "{res}");
        assert_eq!(res["success"], json!(0), "{res}");
        assert_eq!(res["failed"], json!(1), "{res}");
        assert_eq!(fs::read(&mp3).unwrap(), original, "file modified without an undo record");
        assert!(!backup_path_for(&mp3).exists(), "orphan .bak left behind");
    }

    #[test]
    fn write_records_journal_per_file() {
        if !have_ffmpeg() { return; }
        let dir = tempdir().unwrap();
        let mp3 = make_mp3(dir.path(), "a.mp3");
        let journal_path = dir.path().join("undo.json");
        let res = write_tags_at(one_file_request(&mp3, true), &journal_path);
        assert_eq!(res["success"], json!(1), "{res}");
        let j = read_journal(&journal_path).expect("journal");
        assert_eq!(j.entries.len(), 1);
        assert_eq!(j.entries[0].original_path, mp3.to_string_lossy());
    }

    #[test]
    fn undo_after_rename_restores_renamed_file_without_duplicate() {
        if !have_ffmpeg() { return; }
        let dir = tempdir().unwrap();
        let mp3 = make_mp3(dir.path(), "a.mp3");
        let original = fs::read(&mp3).unwrap();
        let journal_path = dir.path().join("undo.json");
        let res = write_tags_at(one_file_request(&mp3, true), &journal_path);
        assert_eq!(res["success"], json!(1), "{res}");

        let renamed = dir.path().join("b.mp3");
        let r = rename_files_at(
            vec![RenamePair { old_path: mp3.to_string_lossy().to_string(), new_path: renamed.to_string_lossy().to_string() }],
            &journal_path,
        );
        assert_eq!(r["failed"], json!(0), "{r}");

        let (restored, failed) = restore_from_journal(&read_journal(&journal_path).unwrap());
        assert!(failed.is_empty(), "{failed:?}");
        assert_eq!(restored, vec![renamed.to_string_lossy().to_string()]);
        assert!(!mp3.exists(), "undo resurrected the old name (duplicate)");
        assert_eq!(fs::read(&renamed).unwrap(), original);
    }

    #[test]
    fn multi_file_group_previews_get_distinct_part_numbers() {
        let meta = json!({ "author": "A", "title": "T" });
        let p1 = preview_rename("/x/01.mp3".into(), meta.clone(), Some("{author} - {title}".into()), Some(1), Some(12));
        let p2 = preview_rename("/x/02.mp3".into(), meta.clone(), Some("{author} - {title}".into()), Some(2), Some(12));
        assert_eq!(p1["new_path"], json!("/x/A - T - Part 01.mp3"));
        assert_eq!(p2["new_path"], json!("/x/A - T - Part 02.mp3"));
        // A single-file book is unchanged.
        let solo = preview_rename("/x/a.m4b".into(), meta.clone(), Some("{author} - {title}".into()), Some(1), Some(1));
        assert_eq!(solo["new_path"], json!("/x/A - T.m4b"));
        // An explicit {part} token is honoured instead of appending.
        let tok = preview_rename("/x/03.mp3".into(), meta, Some("{part} {title}".into()), Some(3), Some(120));
        assert_eq!(tok["new_path"], json!("/x/003 T.mp3"));
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

    // ---- Task 12: writer correctness (audit W-2, W-3, W-5, W-6, W-7) ----

    /// A temp dir the scanner will walk. tempdir()'s default ".tmpXXXX" name
    /// starts with a dot, and collect_audio_files skips dot-directories.
    fn scannable_tempdir() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("tagger-test-").tempdir().unwrap()
    }

    fn read_generic_tag(path: &Path) -> Tag {
        let tagged = Probe::open(path).and_then(|p| p.read()).expect("read back");
        tagged.primary_tag().or_else(|| tagged.first_tag()).cloned().expect("a tag")
    }

    fn change(old: &str, new: &str) -> Value {
        json!({ "old": old, "new": new })
    }

    #[test]
    fn multi_file_title_goes_to_album() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let root = scannable_tempdir();
        let book = root.path().join("Some Author").join("Old Book");
        fs::create_dir_all(&book).unwrap();
        let tracks: Vec<PathBuf> = ["01.mp3", "02.mp3", "03.mp3"].iter().map(|n| make_mp3(&book, n)).collect();
        let mut files = HashMap::new();
        let mut ids = Vec::new();
        for (i, p) in tracks.iter().enumerate() {
            let id = format!("f{i}");
            let mut c = HashMap::new();
            c.insert("title".to_string(), change("Orig", "New Book Title"));
            files.insert(id.clone(), WriteFile { path: p.to_string_lossy().to_string(), changes: c, group_size: Some(3) });
            ids.push(id);
        }
        let res = write_tags_at(WriteRequest { file_ids: ids, files, backup: false }, &root.path().join("undo.json"));
        assert_eq!(res["success"], json!(3), "{res}");
        for p in &tracks {
            let tag = read_generic_tag(p);
            assert_eq!(tag.album().as_deref(), Some("New Book Title"), "album not written on {p:?}");
            assert_eq!(tag.title().as_deref(), Some("Orig"), "track title overwritten on {p:?}");
        }
        let groups = crate::scanner::group_files(crate::scanner::collect_audio_files(&[root.path().to_string_lossy().to_string()]));
        assert_eq!(groups.len(), 1, "{groups:?}");
        assert_eq!(groups[0].metadata.title, "New Book Title");
    }

    #[test]
    fn single_file_title_also_updates_matching_album() {
        let mut tag = Tag::new(TagType::Mp4Ilst);
        tag.set_title("Old".into());
        tag.set_album("Old".into());
        let mut c = HashMap::new();
        c.insert("title".to_string(), change("Old", "New"));
        apply_changes(&mut tag, &c, false);
        assert_eq!(tag.title().as_deref(), Some("New"));
        assert_eq!(tag.album().as_deref(), Some("New"));
        // An album that is NOT the old title is a different value: leave it.
        let mut tag = Tag::new(TagType::Mp4Ilst);
        tag.set_title("Old".into());
        tag.set_album("Collected Works".into());
        apply_changes(&mut tag, &c, false);
        assert_eq!(tag.title().as_deref(), Some("New"));
        assert_eq!(tag.album().as_deref(), Some("Collected Works"));
    }

    #[test]
    fn mp3_with_uslt_frame_writes() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        use lofty::config::ParseOptions;
        use lofty::id3::v2::{Frame, FrameFlags, UnsynchronizedTextFrame};
        use lofty::tag::TagExt;
        let dir = tempdir().unwrap();
        let mp3 = make_mp3(dir.path(), "lyrics.mp3");
        // Add a USLT frame to the fixture through lofty's ID3v2 API.
        let mut f = fs::File::open(&mp3).unwrap();
        let mpeg = lofty::mpeg::MpegFile::read_from(&mut f, ParseOptions::new()).unwrap();
        drop(f);
        let mut id3 = mpeg.id3v2().cloned().unwrap_or_default();
        id3.insert(
            Frame::new(
                "USLT",
                UnsynchronizedTextFrame {
                    encoding: lofty::TextEncoding::UTF8,
                    language: *b"eng",
                    description: String::new(),
                    content: "Some sung words".into(),
                },
                FrameFlags::default(),
            )
            .unwrap(),
        );
        id3.save_to_path(&mp3, WriteOptions::default()).unwrap();
        assert!(ffprobe(&mp3).contains("Some sung words"), "fixture must carry USLT");

        let wf = WriteFile { path: mp3.to_string_lossy().to_string(), changes: title_change("With Lyrics"), group_size: None };
        let out = write_one_file(&wf, false);
        assert!(out.result.is_ok(), "write failed: {:?}", out.result);
        let after = ffprobe(&mp3);
        assert!(after.contains("TAG:title=With Lyrics"), "title not written:\n{after}");
        assert!(after.contains("Some sung words"), "lyrics lost:\n{after}");
    }

    /// A hand-built ID3v2.4 tag holding TIT2 and the given language frames
    /// (frame id USLT or COMM, language, description, text). lofty's own insert
    /// cannot build these fixtures: it merges frames that share a description.
    fn raw_id3_tag(frames: &[(&[u8; 4], &[u8; 3], &str, &str)]) -> Vec<u8> {
        fn syncsafe(n: usize) -> [u8; 4] {
            [((n >> 21) & 0x7f) as u8, ((n >> 14) & 0x7f) as u8, ((n >> 7) & 0x7f) as u8, (n & 0x7f) as u8]
        }
        fn frame(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut f = id.to_vec();
            f.extend_from_slice(&syncsafe(body.len()));
            f.extend_from_slice(&[0, 0]);
            f.extend_from_slice(body);
            f
        }
        let mut body_frames = Vec::new();
        let mut tit2 = vec![3u8];
        tit2.extend_from_slice(b"Orig");
        body_frames.extend(frame(b"TIT2", &tit2));
        for (id, lang, desc, text) in frames {
            let mut body = vec![3u8];
            body.extend_from_slice(*lang);
            body.extend_from_slice(desc.as_bytes());
            body.push(0);
            body.extend_from_slice(text.as_bytes());
            body_frames.extend(frame(id, &body));
        }
        let mut out = b"ID3\x04\x00\x00".to_vec();
        out.extend_from_slice(&syncsafe(body_frames.len()));
        out.extend(body_frames);
        out
    }

    /// Replace `mp3`'s leading ID3v2 tag with the given raw tags, in order.
    fn replace_id3_tags(mp3: &Path, tags: &[Vec<u8>]) {
        let data = fs::read(mp3).unwrap();
        let audio = if data.starts_with(b"ID3") {
            let size = data[6..10].iter().fold(0usize, |acc, b| (acc << 7) | (*b as usize & 0x7f));
            &data[10 + size..]
        } else {
            &data[..]
        };
        let mut out: Vec<u8> = tags.concat();
        out.extend_from_slice(audio);
        fs::write(mp3, out).unwrap();
    }

    fn write_raw_id3_with_lyrics(mp3: &Path, lyrics: &[(&[u8; 3], &str, &str)]) {
        let frames: Vec<(&[u8; 4], &[u8; 3], &str, &str)> =
            lyrics.iter().map(|(lang, desc, text)| (b"USLT", *lang, *desc, *text)).collect();
        replace_id3_tags(mp3, &[raw_id3_tag(&frames)]);
    }

    fn assert_refused_untouched(mp3: &Path, dir: &Path, expected: &str) {
        let before = fs::read(mp3).unwrap();
        let res = write_tags_at(one_file_request(mp3, false), &dir.join("undo.json"));
        assert_eq!(res["success"], json!(0), "{res}");
        assert_eq!(res["failed"], json!(1), "{res}");
        let err = res["errors"][0]["error"].as_str().unwrap_or("");
        assert!(err.contains(expected), "expected {expected:?}: {res}");
        assert_eq!(fs::read(mp3).unwrap(), before, "file bytes changed");
        let leftovers: Vec<_> = fs::read_dir(dir).unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("tagtmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp copy left behind");
    }

    #[test]
    fn mp3_with_two_leading_id3_tags_is_refused_untouched() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = tempdir().unwrap();
        let mp3 = make_mp3(dir.path(), "two-tags.mp3");
        replace_id3_tags(&mp3, &[
            raw_id3_tag(&[(b"USLT", b"eng", "", "First tag words")]),
            raw_id3_tag(&[(b"USLT", b"eng", "", "Second tag words")]),
        ]);
        assert_eq!(
            walk_raw_id3v2(&mp3),
            RawId3::Counts { lyrics: 1, comments: 0, another_tag_follows: true }
        );
        assert_refused_untouched(&mp3, dir.path(), "more than one ID3v2 tag");
    }

    #[test]
    fn mp3_with_colliding_comment_frames_is_refused_untouched() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = tempdir().unwrap();
        let mp3 = make_mp3(dir.path(), "two-comments.mp3");
        replace_id3_tags(&mp3, &[raw_id3_tag(&[
            (b"COMM", b"eng", "", "English note"),
            (b"COMM", b"deu", "", "German note"),
        ])]);
        let probe = ffprobe(&mp3);
        assert!(probe.contains("English note") || probe.contains("German note"), "fixture must carry COMM:\n{probe}");
        assert_refused_untouched(&mp3, dir.path(), "multiple comment frames with the same description");
    }

    #[test]
    fn raw_walker_reports_unwalkable_tags() {
        let dir = tempdir().unwrap();
        // Unsynchronised tag (flag 0x80) and a header claiming more bytes than
        // the file holds: both unverifiable, and no huge allocation.
        let unsync = dir.path().join("unsync.mp3");
        let mut tag = raw_id3_tag(&[(b"USLT", b"eng", "", "words")]);
        tag[5] = 0x80;
        fs::write(&unsync, &tag).unwrap();
        assert_eq!(walk_raw_id3v2(&unsync), RawId3::Unverifiable);
        let truncated = dir.path().join("truncated.mp3");
        fs::write(&truncated, b"ID3\x04\x00\x00\x7f\x7f\x7f\x7f\x00").unwrap();
        assert_eq!(walk_raw_id3v2(&truncated), RawId3::Unverifiable);
        let none = dir.path().join("none.mp3");
        fs::write(&none, b"not a tag").unwrap();
        assert_eq!(walk_raw_id3v2(&none), RawId3::NoTag);
        // The guard's own message for a tag it cannot verify.
        assert_eq!(check_id3_frames_preserved(&unsync, 1, 0), Err(ID3_UNVERIFIABLE.to_string()));
        assert_eq!(check_id3_frames_preserved(&none, 0, 0), Ok(()));
        // A raw lyrics frame lofty did not parse at all is refused too.
        let one = dir.path().join("one.mp3");
        fs::write(&one, raw_id3_tag(&[(b"USLT", b"eng", "", "words")])).unwrap();
        assert_eq!(check_id3_frames_preserved(&one, 0, 0), Err(LYRICS_COLLISION.to_string()));
        assert_eq!(check_id3_frames_preserved(&one, 1, 0), Ok(()));
    }

    #[test]
    fn mp3_with_colliding_lyrics_frames_is_refused_untouched() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = tempdir().unwrap();
        let mp3 = make_mp3(dir.path(), "two-lyrics.mp3");
        write_raw_id3_with_lyrics(&mp3, &[(b"eng", "", "English words"), (b"deu", "", "German words")]);
        let probe = ffprobe(&mp3);
        assert!(probe.contains("English words") && probe.contains("German words"), "fixture must carry both USLT frames:\n{probe}");
        let before = fs::read(&mp3).unwrap();

        let res = write_tags_at(one_file_request(&mp3, false), &dir.path().join("undo.json"));
        assert_eq!(res["success"], json!(0), "{res}");
        assert_eq!(res["failed"], json!(1), "{res}");
        let err = res["errors"][0]["error"].as_str().unwrap_or("");
        assert!(err.contains("multiple lyrics frames with the same description"), "{res}");
        assert_eq!(fs::read(&mp3).unwrap(), before, "file bytes changed");
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("tagtmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp copy left behind");

        // Distinct descriptions do not collide: both frames survive a write.
        write_raw_id3_with_lyrics(&mp3, &[(b"eng", "verse", "English words"), (b"deu", "chorus", "German words")]);
        let res = write_tags_at(one_file_request(&mp3, false), &dir.path().join("undo.json"));
        assert_eq!(res["success"], json!(1), "{res}");
        let after = ffprobe(&mp3);
        assert!(after.contains("TAG:title=New"), "{after}");
        assert!(after.contains("English words") && after.contains("German words"), "lyrics lost:\n{after}");
    }

    #[test]
    fn multi_file_fallback_without_group_size_uses_shared_folder() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = tempdir().unwrap();
        let tracks: Vec<PathBuf> = ["01.mp3", "02.mp3", "03.mp3"].iter().map(|n| make_mp3(dir.path(), n)).collect();
        let mut files = HashMap::new();
        let mut ids = Vec::new();
        for (i, p) in tracks.iter().enumerate() {
            let id = format!("f{i}");
            let mut c = HashMap::new();
            c.insert("title".to_string(), change("Orig", "Fallback Title"));
            files.insert(id.clone(), WriteFile { path: p.to_string_lossy().to_string(), changes: c, group_size: None });
            ids.push(id);
        }
        let res = write_tags_at(WriteRequest { file_ids: ids, files, backup: false }, &dir.path().join("undo.json"));
        assert_eq!(res["success"], json!(3), "{res}");
        for p in &tracks {
            let tag = read_generic_tag(p);
            assert_eq!(tag.album().as_deref(), Some("Fallback Title"), "album not written on {p:?}");
            assert_eq!(tag.title().as_deref(), Some("Orig"), "track title overwritten on {p:?}");
        }
    }

    #[test]
    fn old_style_temp_names_are_skipped_and_swept() {
        let hex = "0123456789abcdef0123456789abcdef";
        assert!(is_temp_file_name(&format!(".book.mp3.tagtmp-{hex}.mp3")));
        assert!(is_temp_file_name(&format!(".tagtmp-{hex}.mp3")));
        assert!(is_temp_file_name(&format!(".tagtmp-{hex}.M4B")));
        // A real temp name from the writer matches.
        let real = temp_path_for(Path::new("/x/Some Book.m4b"));
        assert!(is_temp_file_name(&real.file_name().unwrap().to_string_lossy()));
        for name in [
            ".notes.tagtmp-keep.txt".to_string(),
            ".tagtmp-.mp3".to_string(),
            format!("x.tagtmp-{hex}.mp3"),
            format!("book.tagtmp-{hex}.mp3"),
            format!(".tagtmp-{}.mp3", &hex[..31]),
            format!(".tagtmp-{hex}0.mp3"),
            format!(".tagtmp-{}.mp3", hex.to_uppercase()),
            format!(".tagtmp-{hex}.txt"),
            format!(".tagtmp-{hex}"),
            format!("..tagtmp-{hex}.mp3"),
            "book.mp3".to_string(),
        ] {
            assert!(!is_temp_file_name(&name), "{name} must not count as a temp copy");
        }

        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = scannable_tempdir();
        let mp3 = make_mp3(dir.path(), "book.mp3");
        let old_style = dir.path().join(".book.mp3.tagtmp-0123456789abcdef0123456789abcdef.mp3");
        fs::copy(&mp3, &old_style).unwrap();
        let found = crate::scanner::collect_audio_files(&[dir.path().to_string_lossy().to_string()]);
        assert_eq!(found.len(), 1, "scanner must skip old-style temp copies");
        let keep = dir.path().join(".notes.tagtmp-keep.txt");
        fs::write(&keep, b"user notes").unwrap();
        assert_eq!(sweep_temp_files(dir.path()), 1);
        assert!(!old_style.exists());
        assert!(mp3.exists());
        assert!(keep.exists(), "the sweep deleted a user's dot-file");
    }

    #[test]
    fn temp_name_is_short_and_skipped() {
        let tmp = temp_path_for(Path::new("/x/A very long name.mp3"));
        let name = tmp.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(tmp.parent(), Some(Path::new("/x")));
        assert!(name.starts_with(".tagtmp-") && name.ends_with(".mp3"), "{name}");
        assert_eq!(name.len(), ".tagtmp-".len() + 32 + ".mp3".len(), "{name}");

        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = scannable_tempdir();
        let long = format!("{}.mp3", "a".repeat(226));
        assert_eq!(long.len(), 230);
        let mp3 = make_mp3(dir.path(), &long);
        let wf = WriteFile { path: mp3.to_string_lossy().to_string(), changes: title_change("Long"), group_size: None };
        let out = write_one_file(&wf, false);
        assert!(out.result.is_ok(), "230-char filename must write: {:?}", out.result);
        assert_eq!(read_generic_tag(&mp3).title().as_deref(), Some("Long"));

        // A crash leftover is invisible to the scanner and removed by the sweep.
        let leftover = dir.path().join(".tagtmp-0123456789abcdef0123456789abcdef.mp3");
        fs::copy(&mp3, &leftover).unwrap();
        let found = crate::scanner::collect_audio_files(&[dir.path().to_string_lossy().to_string()]);
        assert_eq!(found.len(), 1, "scanner must skip .tagtmp- files");
        assert_eq!(found[0].path, mp3.to_string_lossy());
        assert_eq!(sweep_temp_files(dir.path()), 1);
        assert!(!leftover.exists());
        assert!(mp3.exists(), "sweep must only remove temp files");
    }

    #[test]
    fn write_batch_sweeps_leftover_temp_files_first() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = tempdir().unwrap();
        let mp3 = make_mp3(dir.path(), "a.mp3");
        let leftover = dir.path().join(".tagtmp-ffffffffffffffffffffffffffffffff.mp3");
        fs::copy(&mp3, &leftover).unwrap();
        let res = write_tags_at(one_file_request(&mp3, false), &dir.path().join("undo.json"));
        assert_eq!(res["success"], json!(1), "{res}");
        assert!(!leftover.exists(), "leftover temp file survived the batch");
    }

    #[test]
    fn journal_write_is_atomic() {
        let dir = tempdir().unwrap();
        let journal_path = dir.path().join("undo.json");
        let good = UndoJournal {
            timestamp: 1,
            entries: vec![JournalEntry { original_path: "/a".into(), backup_path: "/a.bak".into() }],
        };
        write_journal(&journal_path, &good).unwrap();
        // Block the sibling staging file: the write must fail WITHOUT touching the
        // existing journal (a plain fs::write would have truncated it in place).
        let staging = crate::session::tmp_path_for(&journal_path);
        fs::create_dir(&staging).unwrap();
        let newer = UndoJournal { timestamp: 2, entries: vec![] };
        assert!(write_journal(&journal_path, &newer).is_err());
        let kept = read_journal(&journal_path).expect("previous journal intact");
        assert_eq!(kept.timestamp, 1);
        assert_eq!(kept.entries.len(), 1);
        fs::remove_dir(&staging).unwrap();
        write_journal(&journal_path, &newer).unwrap();
        assert_eq!(read_journal(&journal_path).unwrap().timestamp, 2);
        assert!(!staging.exists(), "staging file left behind");
    }

    #[test]
    fn mp3_decimal_series_roundtrip() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = scannable_tempdir();
        let mp3 = make_mp3(dir.path(), "a.mp3");
        let mut c = HashMap::new();
        c.insert("series".to_string(), change("", "Discworld"));
        c.insert("sequence".to_string(), change("", "1.5"));
        let wf = WriteFile { path: mp3.to_string_lossy().to_string(), changes: c, group_size: None };
        let out = write_one_file(&wf, false);
        assert!(out.result.is_ok(), "{:?}", out.result);
        assert!(ffprobe(&mp3).contains("SERIES-PART=1.5"), "TXXX:SERIES-PART not written:\n{}", ffprobe(&mp3));
        let found = crate::scanner::collect_audio_files(&[dir.path().to_string_lossy().to_string()]);
        let groups = crate::scanner::group_files(found);
        assert_eq!(groups[0].metadata.series_number, "1.5");
        assert_eq!(groups[0].metadata.series, "Discworld");

        // A second write of another value replaces it (no stale duplicate).
        let mut c = HashMap::new();
        c.insert("sequence".to_string(), change("1.5", "2.25"));
        let wf = WriteFile { path: mp3.to_string_lossy().to_string(), changes: c, group_size: None };
        assert!(write_one_file(&wf, false).result.is_ok());
        let groups = crate::scanner::group_files(crate::scanner::collect_audio_files(&[dir.path().to_string_lossy().to_string()]));
        assert_eq!(groups[0].metadata.series_number, "2.25");
    }

    #[test]
    fn m4b_year_replaces_full_date() {
        let mut tag = Tag::new(TagType::Mp4Ilst);
        tag.insert_text(ItemKey::RecordingDate, "2015-06-01".into());
        let mut c = HashMap::new();
        c.insert("year".to_string(), change("2015", "2020"));
        apply_changes(&mut tag, &c, false);
        assert_eq!(tag.get_string(&ItemKey::RecordingDate), Some("2020"));
        assert_eq!(tag.year(), Some(2020));

        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg not available");
            return;
        }
        let dir = tempdir().unwrap();
        let m4b = make_m4b(dir.path());
        // Seed a full date directly so the fixture carries month and day.
        {
            use lofty::config::ParseOptions;
            use lofty::tag::TagExt;
            let mut f = fs::File::open(&m4b).unwrap();
            let mp4 = lofty::mp4::Mp4File::read_from(&mut f, ParseOptions::new()).unwrap();
            drop(f);
            let mut ilst = mp4.ilst().cloned().unwrap_or_default();
            ilst.replace_atom(lofty::mp4::Atom::new(
                lofty::mp4::AtomIdent::Fourcc(*b"\xa9day"),
                lofty::mp4::AtomData::UTF8("2015-06-01".into()),
            ));
            ilst.save_to_path(&m4b, WriteOptions::default()).unwrap();
        }
        assert!(ffprobe(&m4b).contains("2015-06-01"), "fixture must carry a full date");
        let mut c = HashMap::new();
        c.insert("year".to_string(), change("2015", "2020"));
        let wf = WriteFile { path: m4b.to_string_lossy().to_string(), changes: c, group_size: None };
        assert!(write_one_file(&wf, false).result.is_ok());
        let after = ffprobe(&m4b);
        assert!(!after.contains("2020-06-01"), "old month/day kept:\n{after}");
        assert!(after.contains("TAG:date=2020"), "year not written:\n{after}");
    }

    #[test]
    fn rename_template_values_are_literal() {
        let meta = json!({ "title": "Weird {Unabridged} Book", "author": "A" });
        assert_eq!(render_template("{title} - {author}", &meta), "Weird {Unabridged} Book - A");
        let p = preview_rename("/x/old.m4b".into(), meta, Some("{title} - {author}".into()), None, None);
        assert_eq!(p["new_path"], json!("/x/Weird {Unabridged} Book - A.m4b"));

        // A value that looks like a token is not expanded a second time.
        let meta = json!({ "title": "{author}", "author": "A" });
        assert_eq!(render_template("{title}", &meta), "{author}");

        // Windows reserved device names get a trailing underscore on every platform.
        let (con, _) = compute_new_path("/x/old.mp3", &render_template("{title}", &json!({ "title": "CON" })));
        assert_eq!(con, "/x/CON_.mp3");
        for (stem, want) in [("con", "con_"), ("Lpt9", "Lpt9_"), ("nul.backup", "nul_.backup"), ("COM1", "COM1_"), ("CONSOLE", "CONSOLE"), ("COM0", "COM0")] {
            let (p, _) = compute_new_path("/x/old.mp3", stem);
            assert_eq!(p, format!("/x/{want}.mp3"), "stem {stem}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn rename_refuses_symlink_source() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.mp3");
        fs::write(&real, b"REAL").unwrap();
        let link = dir.path().join("link.mp3");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let target = dir.path().join("renamed.mp3");
        let err = rename_one(&link.to_string_lossy(), &target.to_string_lossy());
        assert!(err.is_err(), "renaming a symlink must be refused");
        assert!(link.symlink_metadata().is_ok(), "symlink must be left in place");
        assert!(!target.exists());
        assert_eq!(fs::read(&real).unwrap(), b"REAL");

        // A dangling symlink at the target counts as an existing target.
        let dangling = dir.path().join("dangling.mp3");
        std::os::unix::fs::symlink(dir.path().join("missing"), &dangling).unwrap();
        assert!(rename_one(&real.to_string_lossy(), &dangling.to_string_lossy()).is_err());
        assert!(real.exists());
    }
}
