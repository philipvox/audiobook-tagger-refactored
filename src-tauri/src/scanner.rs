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

    // Series / series number from TXXX frames (written by v1 and common tagging tools)
    out.series = lookup_txxx(tag, &["SERIES", "MVNM", "Series"]);
    out.series_number = lookup_txxx(tag, &["SERIES-PART", "MVIN", "Series-Part", "Series Part"]);

    out
}

fn lookup_txxx(tag: &lofty::tag::Tag, keys: &[&str]) -> Option<String> {
    for key in keys {
        let ik = ItemKey::Unknown(key.to_string());
        for item in tag.items() {
            if item.key() == &ik {
                if let ItemValue::Text(s) = item.value() {
                    let s = s.trim().to_string();
                    if !s.is_empty() {
                        return Some(s);
                    }
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

fn is_chapter_folder(name: &str) -> bool {
    use std::sync::OnceLock;
    static CHAPTER_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = CHAPTER_RE.get_or_init(|| {
        regex::Regex::new(
            r"^(disc|disk|cd|part|chapter|ch|vol|volume)\s*\d|^\d{1,2}[_\s]*[-–]|^\d{1,2}[_\s]+(part|ch)",
        )
        .unwrap()
    });
    re.is_match(&name.to_lowercase())
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

    let root_markers = ["audiobooks", "audiobook", "media", "library", "books", "audio"];
    let mut root_idx = None;
    for (i, part) in parts.iter().enumerate() {
        let lower = part.to_lowercase();
        if root_markers.iter().any(|m| lower == *m || lower.ends_with(m)) {
            root_idx = Some(i);
            break;
        }
    }

    let start_idx = root_idx.map(|i| i + 1).unwrap_or(0);
    let relevant_parts: Vec<&str> = parts[start_idx..].to_vec();

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
                result.author = Some(relevant_parts[n - 3].to_string());
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

fn extract_sequence_from_folder_name(folder: &str) -> Option<String> {
    if let Ok(re) = regex::Regex::new(r"^(\d{1,3})\s*[-–—\.]\s*") {
        if let Some(caps) = re.captures(folder) {
            if let Some(num) = caps.get(1) {
                let n = num.as_str().trim_start_matches('0');
                if !n.is_empty() {
                    return Some(n.to_string());
                }
            }
        }
    }
    if let Ok(re) = regex::Regex::new(r"^\[(\d+)\]") {
        if let Some(caps) = re.captures(folder) {
            if let Some(num) = caps.get(1) {
                return Some(num.as_str().trim_start_matches('0').to_string());
            }
        }
    }
    if let Ok(re) = regex::Regex::new(r"(?i)book\s*[#]?(\d+)") {
        if let Some(caps) = re.captures(folder) {
            if let Some(num) = caps.get(1) {
                return Some(num.as_str().trim_start_matches('0').to_string());
            }
        }
    }
    if let Ok(re) = regex::Regex::new(r"#(\d+)") {
        if let Some(caps) = re.captures(folder) {
            if let Some(num) = caps.get(1) {
                return Some(num.as_str().trim_start_matches('0').to_string());
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
    // "Series ##" at end
    if let Ok(re) = regex::Regex::new(r"^(.+?)\s+(\d{1,2})$") {
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

fn pick_metadata(raw_files: &[RawFile], parent_dir: &str, group_name: &str) -> BookMetadata {
    // Use the first file's embedded tags as the base.
    let first_tags = raw_files.first().map(|f| f.tags.clone()).unwrap_or_default();

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
    let mut map: HashMap<String, Vec<RawFile>> = HashMap::new();
    for f in files {
        map.entry(f.parent_dir.clone()).or_default().push(f);
    }

    let mut groups: Vec<BookGroup> = map
        .into_iter()
        .map(|(parent_dir, mut raw_files)| {
            raw_files.sort_by(|a, b| natord_cmp(&a.filename, &b.filename));

            let folder_name = Path::new(&parent_dir)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let group_name = if is_chapter_folder(&folder_name) {
                Path::new(&parent_dir)
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().to_string())
                    .filter(|n| !n.is_empty() && !is_chapter_folder(n))
                    .unwrap_or_else(|| folder_name.clone())
            } else {
                folder_name
            };

            let group_type = if raw_files.len() == 1 {
                "single"
            } else {
                "chapters"
            }
            .to_string();

            let metadata = pick_metadata(&raw_files, &parent_dir, &group_name);

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
    let files = collect_audio_files(&paths);
    let total_files = files.len();
    let groups = group_files(files);
    Ok(ScanResult { groups, total_files })
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
}
