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
    /// Track number tag; one of the two signals for a numbered track set.
    track: Option<u32>,
}

pub(crate) struct RawFile {
    pub(crate) path: String,
    filename: String,
    parent_dir: String,
    /// The scan root this file was found under; folders at/above it are never
    /// read as author/series.
    root: String,
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
    out.track = tag.track();

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
    // The freeform/TXXX SERIES-PART value is checked BEFORE the movement number:
    // MVIN and the MP4 movement-number atom only hold whole numbers, so a
    // decimal position ("1.5") survives only in SERIES-PART (writer.rs writes
    // both).
    out.series_number = lookup_tag_field(
        tag,
        &["SERIES-PART", "Series-Part", "Series Part", "SERIES_PART", "MVIN"],
        &[],
    )
    .or_else(|| lookup_tag_field(tag, &[], &[ItemKey::MovementNumber]));

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

pub(crate) fn collect_audio_files(paths: &[String]) -> Vec<RawFile> {
    let mut files = Vec::new();
    for root in paths {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                // Folder-name rules apply only BELOW the root: a root the user
                // picked that happens to be named ".books" must still scan.
                if e.depth() > 0 && e.file_type().is_dir() {
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
                    // "._" = macOS resource forks; ".tagtmp-" = a temp copy a
                    // crashed tag write left behind (writer::TEMP_PREFIX).
                    if name.starts_with("._") || name.starts_with(crate::writer::TEMP_PREFIX) {
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
                        root: root.clone(),
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
/// A folder is a chapter folder ONLY when its WHOLE name is a chapter keyword plus a
/// number and nothing after it (e.g. "Disc 1", "CD2", "Chapter 05", "Part 3",
/// "Track 07"). Pure-number folders ("01", "5") are deliberately NOT chapter folders:
/// they are usually distinct numbered book folders (Series/1, Series/2), and merging
/// two different books mangles data while an over-split is recoverable. Titled folders
/// that merely start with a keyword+number ("Part 3 - The Return") are book folders too.
fn is_chapter_folder(name: &str) -> bool {
    use std::sync::OnceLock;
    static CHAPTER_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = CHAPTER_RE
        .get_or_init(|| regex::Regex::new(r"^(chapter|ch|disc|disk|cd|part|track)\s*\.?\s*\d+$").unwrap());
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

/// Well-known container folders (exact, case-insensitive) that hold a library
/// but are never an author or series name.
fn is_container_folder(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    matches!(
        lower.as_str(),
        "audiobooks" | "audiobook" | "audio" | "audio books" | "media" | "library" | "libraries"
            | "book" | "books" | "ebooks" | "downloads" | "download" | "desktop" | "documents"
            | "my documents" | "music" | "my music" | "itunes" | "itunes media" | "volumes"
            | "users" | "home" | "mnt" | "srv" | "onedrive" | "dropbox" | "icloud drive"
            | "google drive" | "public"
    ) || {
        // Drive roots: "C:" (or a bare "C" left after splitting "C:\").
        let drive = lower.trim_end_matches(':');
        drive.len() == 1 && drive.chars().all(|c| c.is_ascii_alphabetic())
    }
}

fn path_parts(path: &str) -> Vec<String> {
    path.replace('\\', "/")
        .split('/')
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect()
}

#[cfg(test)]
fn parse_folder_hierarchy(path: &str) -> FolderHierarchy {
    parse_folder_hierarchy_in(path, "")
}

/// Parse author/series/sequence from a book folder path. Components at or above
/// `scan_root` (the folder the user chose) are ignored, as are well-known
/// container folders (Downloads, Desktop, Music, Audiobooks, ...), home
/// directories (`/Users/<name>`, `/home/<name>`) and drive roots - otherwise
/// `/Users/x/Downloads/Stephen King/It` made "Downloads" the author.
fn parse_folder_hierarchy_in(path: &str, scan_root: &str) -> FolderHierarchy {
    let mut result = FolderHierarchy::default();
    let mut owned = path_parts(path);
    let root_parts = path_parts(scan_root);
    if !root_parts.is_empty()
        && owned.len() >= root_parts.len()
        && owned[..root_parts.len()]
            .iter()
            .zip(&root_parts)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
    {
        owned.drain(..root_parts.len());
    }
    let parts: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();

    if parts.is_empty() {
        return result;
    }

    // Start after the LAST container component above the book folder (the book
    // folder itself is never skipped). The folder after users/home is a login
    // name, also skipped.
    let mut start_idx = 0;
    for i in 0..parts.len().saturating_sub(1) {
        let lower = parts[i].to_lowercase();
        if is_container_folder(parts[i]) {
            start_idx = i + 1;
            if (lower == "users" || lower == "home") && i + 1 < parts.len() - 1 {
                start_idx = i + 2;
            }
        }
    }
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
                // Preserve a genuine zero sequence ("Wheel Time 0" -> "0"), matching
                // item 6's normalize_seq_num behavior in the sequence path.
                let n = normalize_seq_num(num.as_str());
                if name.len() >= 3
                    && name.split_whitespace().count() >= 2
                    && !name.chars().all(|c| c.is_ascii_digit())
                    && !name.to_lowercase().ends_with(" book")
                {
                    return (Some(normalize_series_name(name)), Some(n));
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

fn pick_metadata(raw_files: &[RawFile], parent_dir: &str, group_name: &str, scan_root: &str) -> BookMetadata {
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
    let hierarchy = parse_folder_hierarchy_in(parent_dir, scan_root);

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

/// Lowercased book key with explicit part/disc markers stripped
/// ("Big Book Part 2" -> "big book"). Bare trailing numbers are kept on purpose:
/// "Harry Potter 1" and "Harry Potter 2" are different books. A purely numeric
/// value ("01") carries no identity and yields "".
fn book_key(raw: &str) -> String {
    use std::sync::OnceLock;
    static PART_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = PART_RE.get_or_init(|| {
        regex::Regex::new(r"(?i)[\s,:_\-\(\[]*\b(part|pt|disc|disk|cd)\.?\s*\d+(\s*(of|/)\s*\d+)?[\)\]]?\s*$").unwrap()
    });
    let lower = raw.trim().to_lowercase();
    let stripped = re.replace(&lower, "").trim().to_string();
    if stripped.chars().all(|c| c.is_ascii_digit() || c.is_whitespace() || "-_.".contains(c)) {
        String::new()
    } else {
        stripped
    }
}

fn file_stem(f: &RawFile) -> String {
    Path::new(&f.filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn is_single_file_book_format(f: &RawFile) -> bool {
    let ext = Path::new(&f.filename)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    ext == "m4b" || ext == "m4a"
}

/// The track number a filename carries: the first run of 1-3 digits, with the
/// text before it (`prefix`) and the whole stem with that run masked as "#"
/// (`pattern`), all lowercased. "01 - Chapter" -> (1, "", "# - chapter");
/// "track07" -> (7, "track", "track#"). Four-digit runs are years or titles
/// ("1984"), never track numbers.
struct StemNumber {
    number: u32,
    prefix: String,
    pattern: String,
}

fn stem_number(stem: &str) -> Option<StemNumber> {
    let lower = stem.trim().to_lowercase();
    let start = lower.find(|c: char| c.is_ascii_digit())?;
    let len = lower[start..].find(|c: char| !c.is_ascii_digit()).unwrap_or(lower.len() - start);
    if len > 3 {
        return None;
    }
    Some(StemNumber {
        number: lower[start..start + len].parse().ok()?,
        prefix: lower[..start].trim().to_string(),
        pattern: format!("{}#{}", &lower[..start], &lower[start + len..]),
    })
}

/// True when, within each directory, `numbers` are distinct and (when
/// `consecutive`) each one is exactly one more than the previous. Per
/// directory, so Disc 1/track01-02 + Disc 2/track01 still counts.
fn numbered_per_dir(files: &[RawFile], numbers: &[u32], consecutive: bool) -> bool {
    let mut by_dir: HashMap<&str, Vec<u32>> = HashMap::new();
    for (f, n) in files.iter().zip(numbers) {
        by_dir.entry(f.parent_dir.as_str()).or_default().push(*n);
    }
    by_dir.into_values().all(|mut nums| {
        nums.sort_unstable();
        nums.windows(2).all(|w| if consecutive { w[1] == w[0] + 1 } else { w[1] != w[0] })
    })
}

/// Whether a folder's files are ONE book's numbered tracks.
///
/// Rule: the folder is one numbered track set only when there is positive
/// evidence of numbering, never merely because the files lack an album tag:
///   1. every file carries a track-number tag and, per directory, those
///      numbers are consecutive (1, 2, 3 ...); or
///   2. every filename carries a track number (1-3 digits) after the same
///      leading text, and per directory those numbers are consecutive
///      ("00 intro", "01", "02") or the names are otherwise identical
///      ("01 - Chapter", "02 - Chapter", gaps allowed).
/// Anything else is treated as possibly several books, and its files are told
/// apart by title or filename: a wrong split is recoverable, a wrong merge
/// writes one book's tags over another's files.
fn is_numbered_track_set(files: &[RawFile]) -> bool {
    if files.len() < 2 {
        return false;
    }
    if let Some(tracks) = files.iter().map(|f| f.tags.track).collect::<Option<Vec<u32>>>() {
        if numbered_per_dir(files, &tracks, true) {
            return true;
        }
    }
    let Some(parsed) = files.iter().map(|f| stem_number(&file_stem(f))).collect::<Option<Vec<_>>>() else {
        return false;
    };
    if parsed.iter().any(|p| p.prefix != parsed[0].prefix) {
        return false;
    }
    let numbers: Vec<u32> = parsed.iter().map(|p| p.number).collect();
    let same_pattern = parsed.iter().all(|p| p.pattern == parsed[0].pattern);
    numbered_per_dir(files, &numbers, true) || (same_pattern && numbered_per_dir(files, &numbers, false))
}

/// Which book a file belongs to within its folder. "" = no identity of its
/// own (joins the folder's single keyed book, if there is one).
///
/// - mp3/flac/...: the album; without one, a file in a numbered track set has
///   no identity (it is a chapter), otherwise its title, else its filename.
/// - m4b/m4a are usually whole books: title, else album, else filename. In a
///   numbered track set they are per-track files, so a shared album wins over
///   their differing track titles, and an untagged one keys by its filename
///   with the number masked ("01.m4a" and "02.m4a" are the same book).
/// - A purely numeric title or filename ("1984") is still an identity: it
///   falls back to the filename, never to "".
fn file_book_key(f: &RawFile, track_set: bool) -> String {
    let tag_key = |o: &Option<String>| o.as_deref().map(book_key).filter(|k| !k.is_empty());
    let stem = file_stem(f);
    let stem_key = || {
        let k = book_key(&stem);
        if k.is_empty() { stem.trim().to_lowercase() } else { k }
    };
    if is_single_file_book_format(f) {
        if track_set {
            if let Some(album) = tag_key(&f.tags.album) {
                return album;
            }
        }
        tag_key(&f.tags.title).or_else(|| tag_key(&f.tags.album)).unwrap_or_else(|| {
            match stem_number(&stem) {
                Some(n) if track_set => book_key(&n.pattern),
                _ => stem_key(),
            }
        })
    } else {
        if let Some(album) = tag_key(&f.tags.album) {
            return album;
        }
        if track_set {
            return String::new();
        }
        tag_key(&f.tags.title).unwrap_or_else(stem_key)
    }
}

/// Split one folder's files into books. Keyless files (album-less tracks of a
/// numbered set) join the single keyed book when there is exactly one (an
/// untagged intro track), else form their own group.
fn split_folder_into_books(raw_files: Vec<RawFile>) -> Vec<(String, Vec<RawFile>)> {
    let track_set = is_numbered_track_set(&raw_files);
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<RawFile>> = HashMap::new();
    for f in raw_files {
        let key = file_book_key(&f, track_set);
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(f);
    }
    let keyed = order.iter().filter(|k| !k.is_empty()).count();
    if keyed <= 1 {
        let all: Vec<RawFile> = order.iter().flat_map(|k| buckets.remove(k).unwrap_or_default()).collect();
        return vec![(String::new(), all)];
    }
    order
        .into_iter()
        .map(|k| {
            let files = buckets.remove(&k).unwrap_or_default();
            (k, files)
        })
        .collect()
}

pub(crate) fn group_files(files: Vec<RawFile>) -> Vec<BookGroup> {
    // Key by the climbed book directory (past chapter/disc subfolders) so a
    // multi-disc layout (Author/Book/Disc 1 + Disc 2) merges into one group.
    let mut map: HashMap<String, Vec<RawFile>> = HashMap::new();
    for f in files {
        let book_dir = book_dir_for(&f.parent_dir);
        map.entry(book_dir).or_default().push(f);
    }

    let mut groups: Vec<BookGroup> = Vec::new();
    for (book_dir, folder_files) in map {
        let books = split_folder_into_books(folder_files);
        let split = books.len() > 1;
        for (_key, mut raw_files) in books {
            // Sort by full path so tracks stay ordered across discs
            // (Disc 1/track01, Disc 1/track02, Disc 2/track01, ...).
            raw_files.sort_by(|a, b| natord_cmp(&a.path, &b.path));

            let folder_name = Path::new(&book_dir)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            // Several books share this folder: each is named after its own
            // file, and the folder is read as their PARENT (author/series), as
            // if each book had a folder of its own.
            let (group_name, hierarchy_dir) = if split {
                let first = &raw_files[0];
                let name = if raw_files.len() == 1 {
                    file_stem(first)
                } else {
                    first.tags.album.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| file_stem(first))
                };
                let dir = Path::new(&book_dir).join(&name).to_string_lossy().to_string();
                (name, dir)
            } else {
                (folder_name, book_dir.clone())
            };

            let group_type = if raw_files.len() == 1 { "single" } else { "chapters" }.to_string();
            let scan_root = raw_files[0].root.clone();
            let metadata = pick_metadata(&raw_files, &hierarchy_dir, &group_name, &scan_root);

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

            groups.push(BookGroup {
                id: uuid::Uuid::new_v4().to_string(),
                group_name,
                group_type,
                metadata,
                files: audio_files,
                total_changes: 0,
                scan_status: "not_scanned".to_string(),
                abs_id: None,
            });
        }
    }

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
        // Pure-number folders are NOT chapter folders: they are usually distinct
        // numbered BOOK folders (Series/1, Series/2), and a wrong merge mangles
        // data while a wrong split is recoverable. Data-preservation wins.
        assert!(!is_chapter_folder("01"));
        assert!(!is_chapter_folder("5"));
        // A titled folder that merely starts with a keyword+number is a book folder.
        assert!(!is_chapter_folder("Part 3 - The Return"));
        // Real chapter/disc folders: keyword + number and nothing after.
        assert!(is_chapter_folder("Disc 1"));
        assert!(is_chapter_folder("CD2"));
        assert!(is_chapter_folder("Chapter 05"));
        assert!(is_chapter_folder("Part 3"));
        assert!(is_chapter_folder("Track 3"));
        assert!(is_chapter_folder("Track 07"));
        assert!(is_chapter_folder("disk 2"));
    }

    #[test]
    fn numbered_book_folders_do_not_merge() {
        // Series/1 and Series/2 are two DIFFERENT books, not two discs of one.
        let mk = |dir: &str, fname: &str| RawFile {
            path: format!("{}/{}", dir, fname),
            filename: fname.to_string(),
            parent_dir: dir.to_string(),
            root: String::new(),
            tags: EmbeddedTags::default(),
        };
        let files = vec![
            mk("/audiobooks/Some Series/1", "audio.mp3"),
            mk("/audiobooks/Some Series/2", "audio.mp3"),
        ];
        let groups = group_files(files);
        assert_eq!(groups.len(), 2, "numbered book folders must stay separate");
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
            root: String::new(),
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

        // Genuine zero sequence is preserved, not dropped (item 6 parity).
        let (s, n) = extract_series_from_folder("Wheel Time 0");
        assert_eq!(s.as_deref(), Some("Wheel Time"));
        assert_eq!(n.as_deref(), Some("0"));
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
            root: String::new(),
            tags: EmbeddedTags::default(),
        };
        let tagged = RawFile {
            path: "/b/Author/Book/01-ch.mp3".to_string(),
            filename: "01-ch.mp3".to_string(),
            parent_dir: "/b/Author/Book".to_string(),
            root: String::new(),
            tags: EmbeddedTags {
                album: Some("Real Title".to_string()),
                author: Some("Real Author".to_string()),
                ..Default::default()
            },
        };
        let meta = pick_metadata(&[untagged, tagged], "/b/Author/Book", "Book", "");
        assert_eq!(meta.title, "Real Title");
        assert_eq!(meta.author, "Real Author");
    }

    // ---- Separate books sharing one folder ----

    fn raw(dir: &str, fname: &str, tags: EmbeddedTags) -> RawFile {
        RawFile {
            path: format!("{}/{}", dir, fname),
            filename: fname.to_string(),
            parent_dir: dir.to_string(),
            root: String::new(),
            tags,
        }
    }

    fn names(groups: &[BookGroup]) -> Vec<String> {
        let mut v: Vec<String> = groups.iter().map(|g| g.metadata.title.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn single_file_books_in_one_folder_are_separate() {
        let d = "/audiobooks/Stephen King";
        let groups = group_files(vec![
            raw(d, "It.m4b", EmbeddedTags::default()),
            raw(d, "Carrie.m4b", EmbeddedTags::default()),
        ]);
        assert_eq!(groups.len(), 2, "two m4b books must not merge");
        assert_eq!(names(&groups), vec!["Carrie", "It"]);
        for g in &groups {
            assert_eq!(g.files.len(), 1);
            assert_eq!(g.metadata.author, "Stephen King");
        }
    }

    #[test]
    fn tagged_m4b_books_in_one_folder_are_separate() {
        let d = "/audiobooks/Stephen King";
        let t = |title: &str| EmbeddedTags { title: Some(title.into()), album: Some(title.into()), ..Default::default() };
        let groups = group_files(vec![raw(d, "a.m4b", t("It")), raw(d, "b.m4b", t("Carrie"))]);
        assert_eq!(names(&groups), vec!["Carrie", "It"]);
    }

    #[test]
    fn mp3_books_with_distinct_albums_are_separate() {
        let d = "/audiobooks/Mixed";
        let a = |album: &str, title: &str| EmbeddedTags { album: Some(album.into()), title: Some(title.into()), ..Default::default() };
        let groups = group_files(vec![
            raw(d, "01.mp3", a("Book One", "Chapter 1")),
            raw(d, "02.mp3", a("Book One", "Chapter 2")),
            raw(d, "03.mp3", a("Book Two", "Chapter 1")),
        ]);
        assert_eq!(groups.len(), 2);
        assert_eq!(names(&groups), vec!["Book One", "Book Two"]);
    }

    #[test]
    fn multi_part_mp3_set_stays_one_book() {
        let d = "/audiobooks/Stephen King/The Stand";
        let ch = |title: &str| EmbeddedTags { album: Some("The Stand".into()), title: Some(title.into()), ..Default::default() };
        let groups = group_files(vec![
            raw(d, "00 intro.mp3", EmbeddedTags::default()),
            raw(d, "01.mp3", ch("Chapter 1")),
            raw(d, "02.mp3", ch("Chapter 2")),
            raw(d, "03.mp3", ch("Chapter 3")),
        ]);
        assert_eq!(groups.len(), 1, "one book's tracks must stay grouped");
        assert_eq!(groups[0].files.len(), 4);
        // Untagged mp3 tracks with no album stay together too.
        let groups = group_files(vec![
            raw(d, "track01.mp3", EmbeddedTags::default()),
            raw(d, "track02.mp3", EmbeddedTags::default()),
        ]);
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn multi_part_m4b_of_one_book_stays_grouped() {
        let d = "/audiobooks/Author Name/Big Book";
        let groups = group_files(vec![
            raw(d, "Big Book Part 1.m4b", EmbeddedTags::default()),
            raw(d, "Big Book Part 2.m4b", EmbeddedTags::default()),
        ]);
        assert_eq!(groups.len(), 1);
        let groups = group_files(vec![
            raw(d, "01.m4b", EmbeddedTags::default()),
            raw(d, "02.m4b", EmbeddedTags::default()),
        ]);
        assert_eq!(groups.len(), 1);
    }

    // ---- Task 13: unrelated books sharing a folder (audit W-1, W-4) ----

    fn titled(title: &str) -> EmbeddedTags {
        EmbeddedTags { title: Some(title.into()), ..Default::default() }
    }

    #[test]
    fn numeric_title_is_its_own_book() {
        let d = "/audiobooks/George Orwell";
        let groups = group_files(vec![
            raw(d, "1984.m4b", EmbeddedTags::default()),
            raw(d, "Animal Farm.m4b", EmbeddedTags::default()),
        ]);
        assert_eq!(groups.len(), 2, "{groups:?}");
        assert_eq!(names(&groups), vec!["1984", "Animal Farm"]);
        // The same holds when the numeric title is in the tag.
        let groups = group_files(vec![
            raw(d, "1984.m4b", titled("1984")),
            raw(d, "Animal Farm.m4b", titled("Animal Farm")),
        ]);
        assert_eq!(groups.len(), 2, "{groups:?}");
        for g in &groups {
            assert_eq!(g.files.len(), 1);
        }
    }

    #[test]
    fn albumless_mp3s_with_distinct_titles_split() {
        let d = "/audiobooks/Stephen King";
        let groups = group_files(vec![
            raw(d, "Carrie.mp3", titled("Carrie")),
            raw(d, "Misery.mp3", titled("Misery")),
        ]);
        assert_eq!(groups.len(), 2, "{groups:?}");
        assert_eq!(names(&groups), vec!["Carrie", "Misery"]);
    }

    #[test]
    fn stray_file_does_not_join_keyed_book() {
        let d = "/audiobooks/Mixed";
        let groups = group_files(vec![
            raw(d, "Dune.m4b", EmbeddedTags::default()),
            raw(d, "Emma.mp3", EmbeddedTags::default()),
        ]);
        assert_eq!(groups.len(), 2, "{groups:?}");
        assert_eq!(names(&groups), vec!["Dune", "Emma"]);
    }

    #[test]
    fn per_track_m4a_with_shared_album_is_one_book() {
        let d = "/audiobooks/Dune";
        let t = |title: &str| EmbeddedTags { album: Some("Dune".into()), title: Some(title.into()), ..Default::default() };
        let groups = group_files(vec![
            raw(d, "01.m4a", t("The Spice")),
            raw(d, "02.m4a", t("Arrakis")),
            raw(d, "03.m4a", t("Muad'Dib")),
        ]);
        assert_eq!(groups.len(), 1, "{groups:?}");
        assert_eq!(groups[0].files.len(), 3);
        assert_eq!(groups[0].metadata.title, "Dune");
        assert_ne!(groups[0].metadata.author, "Dune", "folder name must not become the author");
    }

    #[test]
    fn numbered_track_set_stays_one_book() {
        let d = "/audiobooks/Some Author/Some Book";
        let files: Vec<RawFile> = (1..=30)
            .map(|n| raw(d, &format!("{:02} - Chapter.mp3", n), EmbeddedTags::default()))
            .collect();
        let groups = group_files(files);
        assert_eq!(groups.len(), 1, "{groups:?}");
        assert_eq!(groups[0].files.len(), 30);
        // Per-track titles that differ do not split a numbered set either.
        let files: Vec<RawFile> = (1..=30)
            .map(|n| raw(d, &format!("{:02} - Chapter.mp3", n), titled(&format!("Chapter {n}"))))
            .collect();
        assert_eq!(group_files(files).len(), 1);
    }

    #[test]
    fn dot_named_root_scans() {
        let tmp = tempfile::Builder::new().prefix("tagger-test-").tempdir().unwrap();
        let root = tmp.path().join(".books");
        let book = root.join("Frank Herbert").join("Dune");
        std::fs::create_dir_all(&book).unwrap();
        std::fs::write(book.join("Dune.m4b"), b"").unwrap();
        // Hidden folders BELOW the root are still skipped.
        let hidden = root.join(".hidden");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(hidden.join("Secret.m4b"), b"").unwrap();
        let found = collect_audio_files(&[root.to_string_lossy().to_string()]);
        assert_eq!(found.len(), 1, "only the visible book is found");
        let groups = group_files(found);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].metadata.title, "Dune");
        assert_eq!(groups[0].metadata.author, "Frank Herbert");
    }

    // ---- Container folders / scan root never become the author ----

    #[test]
    fn container_folders_are_not_authors() {
        let h = parse_folder_hierarchy("/Users/x/Downloads/Stephen King/It");
        assert_eq!(h.author.as_deref(), Some("Stephen King"));
        assert_eq!(h.series, None);
        let h = parse_folder_hierarchy(r"C:\Users\Philip\Desktop\The Talisman");
        assert_eq!(h.author, None);
        assert_eq!(h.series, None);
        let h = parse_folder_hierarchy("/home/philip/Music/Some Book");
        assert_eq!(h.author, None);
        let h = parse_folder_hierarchy("/Volumes/My Drive/Documents/Neil Gaiman/Coraline");
        assert_eq!(h.author.as_deref(), Some("Neil Gaiman"));
    }

    #[test]
    fn folders_at_or_above_scan_root_are_ignored() {
        let h = parse_folder_hierarchy_in("/srv/Collections/Shelf Two/Coraline", "/srv/Collections/Shelf Two");
        assert_eq!(h.author, None, "the scan root itself is not an author");
        assert_eq!(h.series, None);
        let h = parse_folder_hierarchy_in("/srv/Collections/Shelf Two/Neil Gaiman/Coraline", "/srv/Collections/Shelf Two/");
        assert_eq!(h.author.as_deref(), Some("Neil Gaiman"));
    }
}
