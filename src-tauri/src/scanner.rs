use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

use lofty::file::TaggedFileExt;
use lofty::prelude::{Accessor, ItemKey};
use lofty::probe::Probe;
use lofty::tag::ItemValue;

const AUDIO_EXTENSIONS: &[&str] = &["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFile {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub changes: HashMap<String, serde_json::Value>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookMetadata {
    pub title: String,
    pub author: String,
    pub narrator: String,
    pub series: String,
    pub series_number: String,
    pub year: String,
    pub genres: Vec<String>,
    pub tags: Vec<String>,
    pub description: String,
    pub age_rating: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookGroup {
    pub id: String,
    pub group_name: String,
    pub group_type: String,
    pub metadata: BookMetadata,
    pub files: Vec<AudioFile>,
    pub total_changes: usize,
    pub scan_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abs_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub groups: Vec<BookGroup>,
    pub total_files: usize,
}

#[derive(Debug, Default, Clone)]
struct EmbeddedTags {
    title: Option<String>,
    author: Option<String>,
    album: Option<String>,
    narrator: Option<String>,
    series: Option<String>,
    series_number: Option<String>,
    year: Option<String>,
    genre: Option<String>,
}

struct RawFile {
    path: String,
    filename: String,
    parent_dir: String,
    tags: EmbeddedTags,
}

fn read_embedded_tags(path: &Path) -> EmbeddedTags {
    let mut out = EmbeddedTags::default();

    let tagged = match Probe::open(path).and_then(|p| p.read()) {
        Ok(t) => t,
        Err(_) => return out,
    };

    let tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(t) => t,
        None => return out,
    };

    let non_empty = |s: String| {
        let s = s.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    };

    out.title = tag.title().and_then(|c| non_empty(c.into_owned()));
    out.album = tag.album().and_then(|c| non_empty(c.into_owned()));
    out.year = tag.year().map(|y| y.to_string());
    out.genre = tag.genre().and_then(|c| non_empty(c.into_owned()));

    // Author: prefer AlbumArtist, fall back to TrackArtist
    out.author = tag
        .get_string(&ItemKey::AlbumArtist)
        .map(|s| s.to_string())
        .and_then(|s| non_empty(s))
        .or_else(|| tag.artist().and_then(|c| non_empty(c.into_owned())));

    // Narrator: Composer (the convention v1 writes)
    out.narrator = tag
        .get_string(&ItemKey::Composer)
        .map(|s| s.to_string())
        .and_then(|s| non_empty(s));

    // Series / series number from freeform/TXXX/movement frames.
    // MP4 freeform atoms surface as ItemKey::Unknown("----:com.apple.iTunes:SERIES");
    // ID3 MVNM/MVIN map to ItemKey::Movement / ItemKey::MovementNumber.
    out.series = lookup_tag_field(
        tag,
        &["SERIES", "Series", "Series-Name", "MVNM"],
        &[ItemKey::Movement],
    );
    out.series_number = lookup_tag_field(
        tag,
        &["SERIES-PART", "Series-Part", "Series Part", "SERIES_PART", "MVIN"],
        &[ItemKey::MovementNumber],
    );

    out
}

/// Look up a tag field by name, tolerant of the many ways series metadata is stored.
///
/// `known` holds strongly-typed keys checked first (e.g. ID3 MVNM -> ItemKey::Movement).
/// `names` are matched case-insensitively against each `ItemKey::Unknown` key both as the
/// full stored string and as the trailing segment after the last ':' (so MP4 freeform
/// atoms like "----:com.apple.iTunes:SERIES" match the bare name "SERIES").
fn lookup_tag_field(tag: &lofty::tag::Tag, names: &[&str], known: &[ItemKey]) -> Option<String> {
    for k in known {
        if let Some(s) = tag.get_string(k) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }

    for item in tag.items() {
        let key_str = match item.key() {
            ItemKey::Unknown(s) => s.as_str(),
            _ => continue,
        };
        let trailing = key_str.rsplit(':').next().unwrap_or(key_str);
        let matches = names
            .iter()
            .any(|n| key_str.eq_ignore_ascii_case(n) || trailing.eq_ignore_ascii_case(n));
        if matches {
            if let ItemValue::Text(s) = item.value() {
                let s = s.trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

fn collect_audio_files(paths: &[String]) -> Vec<RawFile> {
    let mut files = Vec::new();
    for root in paths {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.file_type().is_dir() {
                    if let Some(name) = e.path().file_name().and_then(|n| n.to_str()) {
                        if name.starts_with("backup_")
                            || name == "backups"
                            || name == ".backups"
                            || name.starts_with(".")
                        {
                            return false;
                        }
                    }
                }
                if let Some(name) = e.path().file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("._") {
                        return false;
                    }
                }
                true
            })
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext_lower = ext.to_string_lossy().to_lowercase();
                if ext_lower == "bak" {
                    continue;
                }
                if AUDIO_EXTENSIONS.contains(&ext_lower.as_str()) {
                    let parent = path
                        .parent()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .to_string();
                    let tags = read_embedded_tags(path);
                    files.push(RawFile {
                        path: path.to_string_lossy().to_string(),
                        filename: path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string(),
                        parent_dir: parent,
                        tags,
                    });
                }
            }
        }
    }
    files
}

/// A chapter/disc subfolder that should be climbed past to find the real book folder.
///
/// Matches only a leading chapter keyword followed by a number (e.g. "Disc 1", "CD2",
/// "Chapter 05", "Part 3", "Track 07") or a pure-number folder (e.g. "01", "5").
/// It must NOT match "NN - Title" book folders (e.g. "01 - The Way of Kings").
fn is_chapter_folder(name: &str) -> bool {
    use std::sync::OnceLock;
    static CHAPTER_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = CHAPTER_RE.get_or_init(|| {
        regex::Regex::new(r"^(chapter|disc|disk|cd|part|track|ch)\s*\d|^\d+$").unwrap()
    });
    re.is_match(name.trim().to_lowercase().as_str())
}

/// Climb up from a file's parent directory past any chapter/disc subfolders to the
/// directory that represents the actual book. Used to merge multi-disc layouts
/// (Author/Book/Disc 1 + Author/Book/Disc 2) into one group.
fn book_dir_for(parent_dir: &str) -> String {
    let mut current = Path::new(parent_dir).to_path_buf();
    loop {
        let leaf = current
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if leaf.is_empty() || !is_chapter_folder(&leaf) {
            break;
        }
        match current.parent() {
            Some(p) if p.file_name().is_some() => current = p.to_path_buf(),
            _ => break,
        }
    }
    current.to_string_lossy().to_string()
}

fn natord_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let extract_num = |s: &str, i: usize| -> Option<(u64, usize)> {
        if i < s.len() && s.as_bytes()[i].is_ascii_digit() {
            let end = s[i..]
                .find(|c: char| !c.is_ascii_digit())
                .map(|p| i + p)
                .unwrap_or(s.len());
            s[i..end].parse::<u64>().ok().map(|n| (n, end))
        } else {
            None
        }
    };
    let (mut i, mut j) = (0, 0);
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    while i < ab.len() && j < bb.len() {
        match (extract_num(a, i), extract_num(b, j)) {
            (Some((na, ni)), Some((nb, nj))) => {
                match na.cmp(&nb) {
                    std::cmp::Ordering::Equal => {}
                    ord => return ord,
                }
                i = ni;
                j = nj;
            }
            _ => {
                let ca = ab[i].to_ascii_lowercase();
                let cb = bb[j].to_ascii_lowercase();
                match ca.cmp(&cb) {
                    std::cmp::Ordering::Equal => {}
                    ord => return ord,
                }
                i += 1;
                j += 1;
            }
        }
    }
    ab.len().cmp(&bb.len())
}

// ---------------------------------------------------------------------------
// Folder hierarchy parsing (ported from v1 scanner/processor.rs)
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct FolderHierarchy {
    author: Option<String>,
    series: Option<String>,
    sequence: Option<String>,
}

fn parse_folder_hierarchy(path: &str) -> FolderHierarchy {
    let mut result = FolderHierarchy::default();
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();

    if parts.is_empty() {
        return result;
    }

    // Exact-match root markers only (no ends_with, which mis-fired on names like
    // "Notebooks" or "MyAudio"). Plural/singular variants are listed explicitly.
    let root_markers = [
        "audiobooks", "audiobook", "audio", "media", "library", "libraries", "book", "books",
    ];
    let mut root_idx = None;
    for (i, part) in parts.iter().enumerate() {
        let lower = part.to_lowercase();
        if root_markers.iter().any(|m| lower == *m) {
            root_idx = Some(i);
            break;
        }
    }

    let start_idx = root_idx.map(|i| i + 1).unwrap_or(0);
    let mut relevant_parts: Vec<&str> = parts[start_idx..].to_vec();

    // Disc-aware: drop trailing chapter/disc folders so a file inside
    // Author/Book/Disc 1 resolves to the Book folder, not the disc.
    while relevant_parts.len() > 1
        && is_chapter_folder(relevant_parts[relevant_parts.len() - 1])
    {
        relevant_parts.pop();
    }

    match relevant_parts.len() {
        0 => {}
        1 => {
            result.sequence = extract_sequence_from_folder_name(relevant_parts[0]);
        }
        2 => {
            let first = relevant_parts[0];
            let second = relevant_parts[1];
            if folder_looks_like_author_name(first) {
                result.author = Some(first.to_string());
                let (series, seq) = extract_series_from_folder(second);
                result.series = series;
                result.sequence = seq.or_else(|| extract_sequence_from_folder_name(second));
            } else {
                result.series = Some(first.to_string());
                result.sequence = extract_sequence_from_folder_name(second);
            }
        }
        _ => {
            let n = relevant_parts.len();
            // Book folder is the deepest (n-1). The parent of the book folder
            // is either a series or the author, depending on hierarchy depth.
            let book_folder = relevant_parts[n - 1];
            let parent = relevant_parts[n - 2];
            if n >= 3 {
                // Only trust the grandparent as an author when it actually looks like a
                // person's name and is not a mount/junk path component. Otherwise leave
                // author empty for embedded tags / AI to fill (data-preservation).
                let candidate = relevant_parts[n - 3];
                if folder_looks_like_author_name(candidate) && !looks_like_junk_component(candidate)
                {
                    result.author = Some(candidate.to_string());
                }
                result.series = Some(parent.to_string());
            } else if folder_looks_like_author_name(parent) {
                result.author = Some(parent.to_string());
            } else {
                result.series = Some(parent.to_string());
            }
            let (series, seq) = extract_series_from_folder(book_folder);
            if result.series.is_none() {
                result.series = series;
            }
            result.sequence = seq.or_else(|| extract_sequence_from_folder_name(book_folder));
        }
    }

    // Handle "Author - Series" combined folder pattern
    if let Some(author) = result.author.clone() {
        if author.contains(" - ") {
            let parts: Vec<&str> = author.splitn(2, " - ").collect();
            if parts.len() == 2 {
                result.author = Some(parts[0].trim().to_string());
                if result.series.is_none() {
                    result.series = Some(parts[1].trim().to_string());
                }
            }
        }
    }

    result
}

fn folder_looks_like_author_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        return false;
    }
    let lower = name.to_lowercase();
    if lower.contains(" book ") || lower.contains('#') || lower.contains("volume") {
        return false;
    }
    if name.contains(' ') {
        return true;
    }
    name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
}

/// Path components that are clearly filesystem structure, not an author name:
/// mount points, dot-prefixed dirs, drive letters, and single all-caps tokens.
fn looks_like_junk_component(name: &str) -> bool {
    if name.is_empty() || name.starts_with('.') {
        return true;
    }
    let lower = name.to_lowercase();
    if matches!(
        lower.as_str(),
        "volumes" | "users" | "user" | "mnt" | "media" | "home" | "srv" | "data" | "storage"
    ) {
        return true;
    }
    // Drive letter such as "C" or "C:"
    let drive = name.trim_end_matches(':');
    if drive.len() == 1 && drive.chars().all(|c| c.is_ascii_alphabetic()) {
        return true;
    }
    // Single all-caps token with no spaces (e.g. "NAS", "MEDIA")
    if !name.contains(' ')
        && name.chars().any(|c| c.is_alphabetic())
        && name.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase())
    {
        return true;
    }
    false
}

/// Strip leading zeros but preserve a genuine zero sequence ("0", "00" -> "0").
fn normalize_seq_num(raw: &str) -> String {
    let trimmed = raw.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn extract_sequence_from_folder_name(folder: &str) -> Option<String> {
    if let Ok(re) = regex::Regex::new(r"^(\d{1,3})\s*[-–—\.]\s*") {
        if let Some(caps) = re.captures(folder) {
            if let Some(num) = caps.get(1) {
                return Some(normalize_seq_num(num.as_str()));
            }
        }
    }
    if let Ok(re) = regex::Regex::new(r"^\[(\d+)\]") {
        if let Some(caps) = re.captures(folder) {
            if let Some(num) = caps.get(1) {
                return Some(normalize_seq_num(num.as_str()));
            }
        }
    }
    if let Ok(re) = regex::Regex::new(r"(?i)book\s*[#]?(\d+)") {
        if let Some(caps) = re.captures(folder) {
            if let Some(num) = caps.get(1) {
                return Some(normalize_seq_num(num.as_str()));
            }
        }
    }
    if let Ok(re) = regex::Regex::new(r"#(\d+)") {
        if let Some(caps) = re.captures(folder) {
            if let Some(num) = caps.get(1) {
                return Some(normalize_seq_num(num.as_str()));
            }
        }
    }
    None
}

fn extract_series_from_folder(folder_name: &str) -> (Option<String>, Option<String>) {
    // "[Series Name #N]" at start
    if let Ok(re) = regex::Regex::new(r"^\[(.+?)\s*[#]?(\d+)\]") {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let name = series.as_str().trim();
                let n = num.as_str().trim_start_matches('0');
                if name.len() >= 3 && !n.is_empty() {
                    return (Some(normalize_series_name(name)), Some(n.to_string()));
                }
            }
        }
    }
    // "Series Name Book N"
    if let Ok(re) = regex::Regex::new(r"(?i)^(.+?)\s+Book\s*[#]?(\d+)") {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let name = series.as_str().trim();
                let n = num.as_str().trim_start_matches('0');
                if name.len() >= 3 && !n.is_empty() {
                    return (Some(normalize_series_name(name)), Some(n.to_string()));
                }
            }
        }
    }
    // "Series Name #N"
    if let Ok(re) = regex::Regex::new(r"^(.+?)\s*#(\d+)") {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let name = series.as_str().trim();
                let n = num.as_str().trim_start_matches('0');
                if name.len() >= 3 && !n.is_empty() {
                    return (Some(normalize_series_name(name)), Some(n.to_string()));
                }
            }
        }
    }
    // "Series ## - Title"
    if let Ok(re) = regex::Regex::new(r"^(.+?)\s+(\d{1,2})\s*[-–—]\s*.+$") {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let name = series.as_str().trim();
                let n = num.as_str().trim_start_matches('0');
                if name.len() >= 3
                    && !name.chars().all(|c| c.is_ascii_digit())
                    && !name.to_lowercase().ends_with(" book")
                    && !n.is_empty()
                {
                    return (Some(normalize_series_name(name)), Some(n.to_string()));
                }
            }
        }
    }
    // "Series ##" at end. Require the name to have 2+ words so single-word titles
    // like "Catch 22" or "Mila 18" are not mistaken for a series with a number.
    if let Ok(re) = regex::Regex::new(r"^(.+?)\s+(\d{1,2})$") {
        if let Some(caps) = re.captures(folder_name) {
            if let (Some(series), Some(num)) = (caps.get(1), caps.get(2)) {
                let name = series.as_str().trim();
                let n = num.as_str().trim_start_matches('0');
                if name.len() >= 3
                    && name.split_whitespace().count() >= 2
                    && !name.chars().all(|c| c.is_ascii_digit())
                    && !name.to_lowercase().ends_with(" book")
                    && !n.is_empty()
                {
                    return (Some(normalize_series_name(name)), Some(n.to_string()));
                }
            }
        }
    }
    (None, None)
}

fn normalize_series_name(name: &str) -> String {
    let mut s = name.trim().to_string();
    let strip_after = [
        " (Book", "(Book", " (Books", "(Books",
        " - Book", "- Book", ", Book",
    ];
    for p in &strip_after {
        if let Some(pos) = s.find(p) {
            s = s[..pos].trim().to_string();
        }
    }
    if s.ends_with(',') {
        s.pop();
        s = s.trim().to_string();
    }
    let suffixes = [" Series", " Trilogy", " Saga", " Chronicles", " Collection", " Books"];
    for suf in &suffixes {
        if s.to_lowercase().ends_with(&suf.to_lowercase()) {
            s = s[..s.len() - suf.len()].trim().to_string();
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

fn tags_are_meaningful(t: &EmbeddedTags) -> bool {
    t.title.is_some()
        || t.album.is_some()
        || t.author.is_some()
        || t.narrator.is_some()
        || t.series.is_some()
        || t.year.is_some()
        || t.genre.is_some()
}

fn pick_metadata(raw_files: &[RawFile], parent_dir: &str, group_name: &str) -> BookMetadata {
    // Prefer the first file that actually carries embedded tags; fall back to the
    // first file. A leading "intro" or silence track often has empty tags while
    // later tracks are fully tagged.
    let first_tags = raw_files
        .iter()
        .find(|f| tags_are_meaningful(&f.tags))
        .or_else(|| raw_files.first())
        .map(|f| f.tags.clone())
        .unwrap_or_default();

    // Folder-hierarchy parse of the book's parent directory fills any gaps
    // left by missing embedded tags.
    let hierarchy = parse_folder_hierarchy(parent_dir);

    let title = first_tags
        .album
        .clone()
        .filter(|s| !s.is_empty())
        .or(first_tags.title.clone())
        .unwrap_or_else(|| group_name.to_string());

    let author = first_tags
        .author
        .clone()
        .or(hierarchy.author)
        .unwrap_or_default();

    let narrator = first_tags.narrator.clone().unwrap_or_default();

    let series = first_tags
        .series
        .clone()
        .or(hierarchy.series)
        .unwrap_or_default();

    let series_number = first_tags
        .series_number
        .clone()
        .or(hierarchy.sequence)
        .unwrap_or_default();

    let year = first_tags.year.clone().unwrap_or_default();
    let genres = first_tags
        .genre
        .clone()
        .map(|g| vec![g])
        .unwrap_or_default();

    BookMetadata {
        title,
        author,
        narrator,
        series,
        series_number,
        year,
        genres,
        tags: Vec::new(),
        description: String::new(),
        age_rating: String::new(),
    }
}

fn group_files(files: Vec<RawFile>) -> Vec<BookGroup> {
    // Key by the climbed book directory (past chapter/disc subfolders) so a
    // multi-disc layout (Author/Book/Disc 1 + Disc 2) merges into one group.
    let mut map: HashMap<String, Vec<RawFile>> = HashMap::new();
    for f in files {
        let book_dir = book_dir_for(&f.parent_dir);
        map.entry(book_dir).or_default().push(f);
    }

    let mut groups: Vec<BookGroup> = map
        .into_iter()
        .map(|(book_dir, mut raw_files)| {
            // Sort by full path so tracks stay ordered across discs
            // (Disc 1/track01, Disc 1/track02, Disc 2/track01, ...).
            raw_files.sort_by(|a, b| natord_cmp(&a.path, &b.path));

            let group_name = Path::new(&book_dir)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let group_type = if raw_files.len() == 1 {
                "single"
            } else {
                "chapters"
            }
            .to_string();

            let metadata = pick_metadata(&raw_files, &book_dir, &group_name);

            let audio_files: Vec<AudioFile> = raw_files
                .iter()
                .map(|f| AudioFile {
                    id: uuid::Uuid::new_v4().to_string(),
                    path: f.path.clone(),
                    filename: f.filename.clone(),
                    changes: HashMap::new(),
                    status: "unchanged".to_string(),
                })
                .collect();

            BookGroup {
                id: uuid::Uuid::new_v4().to_string(),
                group_name,
                group_type,
                metadata,
                files: audio_files,
                total_changes: 0,
                scan_status: "not_scanned".to_string(),
                abs_id: None,
            }
        })
        .collect();

    groups.sort_by(|a, b| a.group_name.to_lowercase().cmp(&b.group_name.to_lowercase()));
    groups
}

#[tauri::command]
pub async fn scan_library(paths: Vec<String>) -> Result<ScanResult, String> {
    // The walk + per-file lofty probe is blocking I/O; keep it off the async
    // runtime's worker threads so the UI stays responsive during large scans.
    tauri::async_runtime::spawn_blocking(move || {
        let files = collect_audio_files(&paths);
        let total_files = files.len();
        let groups = group_files(files);
        ScanResult { groups, total_files }
    })
    .await
    .map_err(|e| format!("Scan task failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hierarchy_author_series_book() {
        let h = parse_folder_hierarchy(
            "/mnt/audiobooks/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings",
        );
        assert_eq!(h.author.as_deref(), Some("Brandon Sanderson"));
        assert_eq!(h.series.as_deref(), Some("Stormlight Archive"));
        assert_eq!(h.sequence.as_deref(), Some("1"));
    }

    #[test]
    fn hierarchy_author_book() {
        let h = parse_folder_hierarchy("/media/Stephen King/The Talisman");
        assert_eq!(h.author.as_deref(), Some("Stephen King"));
        assert_eq!(h.series, None);
    }

    #[test]
    fn hierarchy_flat_book_only() {
        // No author in path — this is the failure case the user hit.
        // Hierarchy returns nothing; embedded tags must carry the load.
        let h = parse_folder_hierarchy("/Audiobooks/The Talisman");
        assert_eq!(h.author, None);
        assert_eq!(h.series, None);
    }

    #[test]
    fn hierarchy_combined_author_series() {
        let h = parse_folder_hierarchy(
            "/audiobooks/Brandon Sanderson - Stormlight Archive/The Way of Kings",
        );
        assert_eq!(h.author.as_deref(), Some("Brandon Sanderson"));
        assert_eq!(h.series.as_deref(), Some("Stormlight Archive"));
    }

    #[test]
    fn hierarchy_windows_paths() {
        let h = parse_folder_hierarchy(
            r"C:\Audiobooks\Brandon Sanderson\Stormlight Archive\01 - The Way of Kings",
        );
        assert_eq!(h.author.as_deref(), Some("Brandon Sanderson"));
        assert_eq!(h.series.as_deref(), Some("Stormlight Archive"));
    }

    #[test]
    fn series_extraction_patterns() {
        let (s, n) = extract_series_from_folder("Discworld 01 - The Colour of Magic");
        assert_eq!(s.as_deref(), Some("Discworld"));
        assert_eq!(n.as_deref(), Some("1"));

        let (s, n) = extract_series_from_folder("Harry Potter Book 3");
        assert_eq!(s.as_deref(), Some("Harry Potter"));
        assert_eq!(n.as_deref(), Some("3"));

        let (s, n) = extract_series_from_folder("[Stormlight 2] Words of Radiance");
        assert_eq!(s.as_deref(), Some("Stormlight"));
        assert_eq!(n.as_deref(), Some("2"));
    }

    #[test]
    fn normalize_series_name_strips_suffixes() {
        assert_eq!(normalize_series_name("Wheel of Time Series"), "Wheel of Time");
        assert_eq!(normalize_series_name("Foundation Trilogy"), "Foundation");
        assert_eq!(normalize_series_name("Stormlight (Book 1)"), "Stormlight");
    }

    // ---- Item 1: tag key matching ----

    #[test]
    fn reads_mp4_freeform_series_atoms() {
        use lofty::tag::TagType;
        use lofty::tag::{Tag, TagItem};
        // Real MP4 files surface freeform atoms as ItemKey::Unknown on read; lofty's
        // checked insert rejects them, so use push_unchecked to reproduce that state.
        let mut tag = Tag::new(TagType::Mp4Ilst);
        tag.push_unchecked(TagItem::new(
            ItemKey::Unknown("----:com.apple.iTunes:SERIES".to_string()),
            ItemValue::Text("Stormlight Archive".to_string()),
        ));
        tag.push_unchecked(TagItem::new(
            ItemKey::Unknown("----:com.apple.iTunes:SERIES-PART".to_string()),
            ItemValue::Text("2".to_string()),
        ));
        assert_eq!(
            lookup_tag_field(&tag, &["SERIES", "Series"], &[ItemKey::Movement]).as_deref(),
            Some("Stormlight Archive")
        );
        assert_eq!(
            lookup_tag_field(&tag, &["SERIES-PART"], &[ItemKey::MovementNumber]).as_deref(),
            Some("2")
        );
    }

    #[test]
    fn reads_id3_movement_series() {
        use lofty::tag::TagType;
        use lofty::tag::{Tag, TagItem};
        let mut tag = Tag::new(TagType::Id3v2);
        tag.push(TagItem::new(
            ItemKey::Movement,
            ItemValue::Text("Discworld".to_string()),
        ));
        tag.push(TagItem::new(
            ItemKey::MovementNumber,
            ItemValue::Text("5".to_string()),
        ));
        assert_eq!(
            lookup_tag_field(&tag, &["SERIES"], &[ItemKey::Movement]).as_deref(),
            Some("Discworld")
        );
        assert_eq!(
            lookup_tag_field(&tag, &["SERIES-PART"], &[ItemKey::MovementNumber]).as_deref(),
            Some("5")
        );
    }

    // ---- Item 2: chapter folders / multi-disc merge ----

    #[test]
    fn is_chapter_folder_rules() {
        // "NN - Title" is a BOOK folder, not a chapter folder
        assert!(!is_chapter_folder("01 - The Way of Kings"));
        assert!(!is_chapter_folder("1 - Prologue"));
        assert!(!is_chapter_folder("The Way of Kings"));
        assert!(!is_chapter_folder("Partials"));
        // Real chapter/disc folders
        assert!(is_chapter_folder("Disc 1"));
        assert!(is_chapter_folder("CD2"));
        assert!(is_chapter_folder("Chapter 05"));
        assert!(is_chapter_folder("Part 3"));
        assert!(is_chapter_folder("Track 07"));
        assert!(is_chapter_folder("disk 2"));
        assert!(is_chapter_folder("01"));
        assert!(is_chapter_folder("5"));
    }

    #[test]
    fn hierarchy_skips_disc_folders() {
        let h = parse_folder_hierarchy("/audiobooks/Stephen King/The Stand/Disc 1");
        assert_eq!(h.author.as_deref(), Some("Stephen King"));
        assert_eq!(h.series, None);
    }

    #[test]
    fn multi_disc_merges_into_one_group() {
        let mk = |dir: &str, fname: &str| RawFile {
            path: format!("{}/{}", dir, fname),
            filename: fname.to_string(),
            parent_dir: dir.to_string(),
            tags: EmbeddedTags::default(),
        };
        let files = vec![
            mk("/audiobooks/Stephen King/The Stand/Disc 1", "track01.mp3"),
            mk("/audiobooks/Stephen King/The Stand/Disc 1", "track02.mp3"),
            mk("/audiobooks/Stephen King/The Stand/Disc 2", "track01.mp3"),
        ];
        let groups = group_files(files);
        assert_eq!(groups.len(), 1, "multi-disc should merge to one group");
        let g = &groups[0];
        assert_eq!(g.files.len(), 3);
        assert_eq!(g.group_name, "The Stand");
        assert_eq!(g.metadata.title, "The Stand");
        assert_eq!(g.metadata.author, "Stephen King");
        assert_eq!(g.metadata.series, "");
    }

    // ---- Item 4: deep-path junk components ----

    #[test]
    fn deep_path_junk_author_left_empty() {
        // A single all-caps mount token must not become the author.
        let h = parse_folder_hierarchy("/NAS/Stormlight Archive/01 - The Way of Kings");
        assert_eq!(h.author, None);
        assert_eq!(h.series.as_deref(), Some("Stormlight Archive"));
    }

    // ---- Item 5: bare "Name NN" needs 2+ words ----

    #[test]
    fn bare_series_number_requires_two_words() {
        assert_eq!(extract_series_from_folder("Catch 22"), (None, None));
        assert_eq!(extract_series_from_folder("Mila 18"), (None, None));
        let (s, n) = extract_series_from_folder("Harry Potter 3");
        assert_eq!(s.as_deref(), Some("Harry Potter"));
        assert_eq!(n.as_deref(), Some("3"));
    }

    // ---- Item 6: sequence zero preserved ----

    #[test]
    fn sequence_zero_preserved() {
        assert_eq!(extract_sequence_from_folder_name("[0]"), Some("0".to_string()));
        assert_eq!(
            extract_sequence_from_folder_name("0 - Prologue"),
            Some("0".to_string())
        );
        assert_eq!(
            extract_sequence_from_folder_name("007 - Casino Royale"),
            Some("7".to_string())
        );
    }

    // ---- Item 7: first meaningful tag set wins ----

    #[test]
    fn pick_metadata_prefers_tagged_file() {
        let untagged = RawFile {
            path: "/b/Author/Book/00-intro.mp3".to_string(),
            filename: "00-intro.mp3".to_string(),
            parent_dir: "/b/Author/Book".to_string(),
            tags: EmbeddedTags::default(),
        };
        let tagged = RawFile {
            path: "/b/Author/Book/01-ch.mp3".to_string(),
            filename: "01-ch.mp3".to_string(),
            parent_dir: "/b/Author/Book".to_string(),
            tags: EmbeddedTags {
                album: Some("Real Title".to_string()),
                author: Some("Real Author".to_string()),
                ..Default::default()
            },
        };
        let meta = pick_metadata(&[untagged, tagged], "/b/Author/Book", "Book");
        assert_eq!(meta.title, "Real Title");
        assert_eq!(meta.author, "Real Author");
    }
}
