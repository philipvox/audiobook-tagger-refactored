// src-tauri/src/scanner/collector.rs
use super::types::{AudioFile, BookGroup, BookMetadata, GroupType, RawFileData, ScanStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::path::Path;
use walkdir::WalkDir;
use std::collections::HashMap;
use serde::Deserialize;
use rayon::prelude::*;

const AUDIO_EXTENSIONS: &[&str] = &["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"];

/// Extract a sort key from filename for chapter ordering
/// Returns a single number for sorting - higher = later in order
///
/// Handles various formats:
/// - "01 - Chapter 1.mp3" -> 1 (track number)
/// - "1-01 Opening.mp3" -> 101 (disc 1 * 100 + track 1)
/// - "2-12 End Credits.mp3" -> 212 (disc 2 * 100 + track 12)
/// - "Track 05.mp3" -> 5
/// - "Chapter 10.mp3" -> 10
fn extract_sort_key(filename: &str) -> u32 {
    let name = filename.to_lowercase();

    // Pattern 1: "D-TT" or "DD-TT" format (disc-track)
    // e.g., "1-01", "2-12", "01-05"
    // These are multi-disc rips, sort by disc*100 + track
    if let Some(caps) = regex::Regex::new(r"^(\d{1,2})-(\d{1,3})\s")
        .ok()
        .and_then(|re| re.captures(&name))
    {
        let disc: u32 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
        let track: u32 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        return disc * 100 + track;
    }

    // Pattern 2: "TT - " format (track with separator)
    // e.g., "01 - Chapter 1", "12 - Title"
    if let Some(caps) = regex::Regex::new(r"^(\d{1,3})\s*[-–—]\s*")
        .ok()
        .and_then(|re| re.captures(&name))
    {
        let track: u32 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        return track;
    }

    // Pattern 3: "Track TT" or "Chapter TT"
    if let Some(caps) = regex::Regex::new(r"(?:track|chapter|part)\s*(\d{1,3})")
        .ok()
        .and_then(|re| re.captures(&name))
    {
        let track: u32 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        return track;
    }

    // Pattern 4: Just leading numbers
    if let Some(caps) = regex::Regex::new(r"^(\d{1,3})")
        .ok()
        .and_then(|re| re.captures(&name))
    {
        let track: u32 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        return track;
    }

    // No track number found - sort at end
    u32::MAX
}

/// Natural sort comparison for filenames
/// Handles numeric parts correctly: "Chapter 2" < "Chapter 10"
pub fn natural_sort_key(s: &str) -> Vec<NaturalSortPart> {
    let mut parts = Vec::new();
    let mut current_num = String::new();
    let mut current_str = String::new();

    for c in s.chars() {
        if c.is_ascii_digit() {
            if !current_str.is_empty() {
                parts.push(NaturalSortPart::Text(current_str.to_lowercase()));
                current_str.clear();
            }
            current_num.push(c);
        } else {
            if !current_num.is_empty() {
                parts.push(NaturalSortPart::Number(current_num.parse().unwrap_or(0)));
                current_num.clear();
            }
            current_str.push(c);
        }
    }

    // Push any remaining parts
    if !current_num.is_empty() {
        parts.push(NaturalSortPart::Number(current_num.parse().unwrap_or(0)));
    }
    if !current_str.is_empty() {
        parts.push(NaturalSortPart::Text(current_str.to_lowercase()));
    }

    parts
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum NaturalSortPart {
    Number(u64),
    Text(String),
}

/// Compare two strings using natural sort order
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    // First try track-based sorting
    let key_a = extract_sort_key(a);
    let key_b = extract_sort_key(b);

    // If both have valid sort keys, use them
    if key_a != u32::MAX && key_b != u32::MAX {
        match key_a.cmp(&key_b) {
            std::cmp::Ordering::Equal => {
                // Same sort key, fall back to natural sort for tiebreaker
                natural_sort_key(a).cmp(&natural_sort_key(b))
            }
            other => other
        }
    } else if key_a != u32::MAX {
        // a has key, b doesn't - a comes first
        std::cmp::Ordering::Less
    } else if key_b != u32::MAX {
        // b has key, a doesn't - b comes first
        std::cmp::Ordering::Greater
    } else {
        // Neither has a key, fall back to natural sort
        natural_sort_key(a).cmp(&natural_sort_key(b))
    }
}

// AudiobookShelf metadata.json format for reading
#[derive(Debug, Deserialize)]
struct AbsMetadataJson {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    authors: Vec<String>,
    #[serde(default)]
    narrators: Vec<String>,
    #[serde(default)]
    series: Vec<AbsSeriesJson>,
    #[serde(default)]
    genres: Vec<String>,
    #[serde(rename = "publishedYear", default)]
    published_year: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    isbn: Option<String>,
    #[serde(default)]
    asin: Option<String>,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AbsSeriesJson {
    name: String,
    #[serde(default)]
    sequence: Option<String>,
}

/// Try to load metadata.json from a folder
/// Returns (metadata, was_loaded_from_file)
fn load_metadata_json(folder_path: &str) -> (Option<BookMetadata>, bool) {
    let json_path = Path::new(folder_path).join("metadata.json");

    if !json_path.exists() {
        return (None, false);
    }

    let content = match std::fs::read_to_string(&json_path) {
        Ok(c) => c,
        Err(e) => {
            println!("   ⚠️ Failed to read metadata.json: {}", e);
            return (None, false);
        }
    };

    let abs_meta: AbsMetadataJson = match serde_json::from_str(&content) {
        Ok(m) => m,
        Err(e) => {
            println!("   ⚠️ Failed to parse metadata.json: {}", e);
            return (None, false);
        }
    };

    // Convert to BookMetadata
    let title = abs_meta.title.unwrap_or_else(|| {
        Path::new(folder_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    let author = abs_meta.authors.first().cloned().unwrap_or_else(|| "Unknown".to_string());
    // CRITICAL FIX: Keep narrator as single value (first narrator), not joined string
    // The narrators array is stored separately and used for metadata.json
    let narrator = abs_meta.narrators.first().cloned();

    let (series, sequence) = if let Some(first_series) = abs_meta.series.first() {
        (Some(first_series.name.clone()), first_series.sequence.clone())
    } else {
        (None, None)
    };

    // Check for existing cover file in folder
    let folder = Path::new(folder_path);
    let (cover_url, cover_mime) = if folder.join("cover.jpg").exists() {
        (Some(folder.join("cover.jpg").to_string_lossy().to_string()), Some("image/jpeg".to_string()))
    } else if folder.join("cover.jpeg").exists() {
        (Some(folder.join("cover.jpeg").to_string_lossy().to_string()), Some("image/jpeg".to_string()))
    } else if folder.join("cover.png").exists() {
        (Some(folder.join("cover.png").to_string_lossy().to_string()), Some("image/png".to_string()))
    } else if folder.join("folder.jpg").exists() {
        (Some(folder.join("folder.jpg").to_string_lossy().to_string()), Some("image/jpeg".to_string()))
    } else if folder.join("folder.png").exists() {
        (Some(folder.join("folder.png").to_string_lossy().to_string()), Some("image/png".to_string()))
    } else {
        (None, None)
    };

    let has_cover = cover_url.is_some();
    println!("   ✅ Loaded metadata.json for '{}'{}", title, if has_cover { " (with cover)" } else { "" });

    // Build all_series from series/sequence if present
    let all_series = if let Some(ref s) = series {
        vec![super::types::SeriesInfo::new(
            s.clone(),
            sequence.clone(),
            None, // Source unknown from metadata.json
        )]
    } else {
        vec![]
    };

    (Some(BookMetadata {
        title,
        author,
        subtitle: abs_meta.subtitle,
        narrator,
        series,
        sequence,
        all_series,
        genres: abs_meta.genres,
        description: abs_meta.description,
        publisher: abs_meta.publisher,
        year: abs_meta.published_year,
        isbn: abs_meta.isbn,
        asin: abs_meta.asin,
        cover_url,
        cover_mime,
        authors: abs_meta.authors,
        narrators: abs_meta.narrators,
        language: abs_meta.language,
        abridged: None,
        runtime_minutes: None,
        explicit: None,
        publish_date: None,
        sources: None,
        // Collection fields - detected later in processing
        is_collection: false,
        collection_books: vec![],
        confidence: None,
        // Themes/tropes - extracted later
        themes: vec![],
        tropes: vec![],
        themes_source: None,
        tropes_source: None,
    }), true)
}

pub async fn collect_and_group_files(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    use futures::stream::{self, StreamExt};

    // Load config for concurrency settings
    let config = crate::config::Config::load().unwrap_or_default();
    let file_scan_concurrency = config.get_concurrency(crate::config::ConcurrencyOp::FileScan);

    // Parallelize collection across multiple root paths
    let paths_vec: Vec<String> = paths.to_vec();
    let cancel = cancel_flag.clone();

    let all_files: Vec<RawFileData> = stream::iter(paths_vec)
        .map(|path| {
            let cancel = cancel.clone();
            async move {
                if let Some(ref flag) = cancel {
                    if flag.load(Ordering::SeqCst) {
                        return vec![];
                    }
                }
                collect_audio_files_from_path(&path).unwrap_or_default()
            }
        })
        .buffer_unordered(file_scan_concurrency)
        .flat_map(|files| stream::iter(files))
        .collect()
        .await;

    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::SeqCst) {
            println!("Collection cancelled");
            return Ok(vec![]);
        }
    }

    println!("📁 Collected {} audio files", all_files.len());

    // Count unique folders (= number of books)
    let unique_folders: std::collections::HashSet<_> = all_files.iter()
        .map(|f| f.parent_dir.clone())
        .collect();
    println!("📊 Grouping {} folders into books...", unique_folders.len());

    let start = std::time::Instant::now();
    let groups = group_files_by_book(all_files);
    println!("✅ Grouped into {} books in {:.2}s", groups.len(), start.elapsed().as_secs_f64());

    Ok(groups)
}

fn collect_audio_files_from_path(path: &str) -> Result<Vec<RawFileData>, Box<dyn std::error::Error + Send + Sync>> {
    let mut files = Vec::new();

    for entry in WalkDir::new(path)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                if let Some(dir_name) = e.path().file_name().and_then(|n| n.to_str()) {
                    if dir_name.starts_with("backup_") ||
                       dir_name == "backups" ||
                       dir_name == ".backups" {
                        println!("⏭️  Skipping backup directory: {}", e.path().display());
                        return false;
                    }
                }
            }

            if let Some(file_name) = e.path().file_name().and_then(|n| n.to_str()) {
                if file_name.starts_with("._") {
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

        if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
            if file_name.starts_with("._") {
                continue;
            }
        }

        if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            // Skip .bak files (used to hide original files from ABS after chapter splitting)
            if ext_lower == "bak" {
                continue;
            }
            // Also skip files ending with .m4b.bak, .mp3.bak, etc.
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if file_name.ends_with(".bak") {
                    continue;
                }
            }
            if AUDIO_EXTENSIONS.contains(&ext_lower.as_str()) {
                let parent = path.parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
                    .to_string();

                files.push(RawFileData {
                    path: path.to_string_lossy().to_string(),
                    filename: path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    parent_dir: parent,
                });
            }
        }
    }

    Ok(files)
}

fn group_files_by_book(files: Vec<RawFileData>) -> Vec<BookGroup> {
    let mut groups: HashMap<String, Vec<RawFileData>> = HashMap::new();

    for file in files {
        groups.entry(file.parent_dir.clone())
            .or_insert_with(Vec::new)
            .push(file);
    }

    // Use parallel iteration for faster metadata.json loading (440 folders in parallel!)
    groups.into_par_iter()
        .map(|(parent_dir, mut files)| {
            files.sort_by(|a, b| natural_cmp(&a.filename, &b.filename));

            // Get the immediate folder name
            let folder_name = Path::new(&parent_dir)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // If the folder looks like a chapter marker (e.g., "1_ Part I", "Part 1", "Disc 1"),
            // use the grandparent folder as the real book title
            let group_name = if is_chapter_folder(&folder_name) {
                // Try to get grandparent folder name (the actual book title)
                let grandparent_name = Path::new(&parent_dir)
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().to_string());

                if let Some(ref gp_name) = grandparent_name {
                    // Only use grandparent if it doesn't also look like a chapter folder
                    // and isn't empty or a root-level folder
                    if !gp_name.is_empty() && !is_chapter_folder(gp_name) {
                        println!("📂 Chapter folder '{}' detected - using grandparent '{}' as book title",
                            folder_name, gp_name);
                        gp_name.clone()
                    } else {
                        folder_name.clone()
                    }
                } else {
                    folder_name.clone()
                }
            } else {
                folder_name.clone()
            };

            let group_type = detect_group_type(&files);

            let audio_files: Vec<AudioFile> = files.iter()
                .map(|f| AudioFile {
                    id: uuid::Uuid::new_v4().to_string(),
                    path: f.path.clone(),
                    filename: f.filename.clone(),
                    changes: HashMap::new(),
                    status: "unchanged".to_string(),
                })
                .collect();

            // Try to load existing metadata.json
            let (loaded_metadata, has_metadata_file) = load_metadata_json(&parent_dir);

            let (metadata, scan_status) = if let Some(meta) = loaded_metadata {
                // Metadata was loaded from file - no need to scan
                (meta, ScanStatus::LoadedFromFile)
            } else {
                // No metadata.json found - needs scanning
                (BookMetadata {
                    title: group_name.clone(),
                    author: "Unknown".to_string(),
                    subtitle: None,
                    narrator: None,
                    series: None,
                    sequence: None,
                    all_series: vec![],
                    genres: vec![],
                    description: None,
                    publisher: None,
                    year: None,
                    isbn: None,
                    asin: None,
                    cover_url: None,
                    cover_mime: None,
                    authors: vec!["Unknown".to_string()],
                    narrators: vec![],
                    language: None,
                    abridged: None,
                    runtime_minutes: None,
                    explicit: None,
                    publish_date: None,
                    sources: None,
                    // Collection fields - detected later in processing
                    is_collection: false,
                    collection_books: vec![],
                    confidence: None,
                    // Themes/tropes - extracted later
                    themes: vec![],
                    tropes: vec![],
                    themes_source: None,
                    tropes_source: None,
                }, ScanStatus::NotScanned)
            };

            BookGroup {
                id: uuid::Uuid::new_v4().to_string(),
                group_name: metadata.title.clone(),
                group_type,
                metadata,
                files: audio_files,
                total_changes: 0,
                scan_status,
            }
        })
        .collect()
}

fn detect_group_type(files: &[RawFileData]) -> GroupType {
    if files.len() == 1 {
        GroupType::Single
    } else if files.iter().any(|f| {
        let lower = f.filename.to_lowercase();
        is_multi_part_filename(&lower)
    }) {
        GroupType::MultiPart
    } else {
        GroupType::Chapters
    }
}

fn is_multi_part_filename(filename: &str) -> bool {
    use regex::Regex;

    let keywords = [
        "part", "disk", "disc", "cd", "chapter", "chap", "ch.",
        "track", "section", "segment", "volume", "vol.", "book",
        "episode", "ep.", "side"
    ];

    if keywords.iter().any(|k| filename.contains(k)) {
        return true;
    }

    lazy_static::lazy_static! {
        static ref LEADING_NUM: Regex = Regex::new(r"^\d{1,3}[\s._-]").unwrap();
        static ref ROMAN_NUMERAL: Regex = Regex::new(r"(?i)\b(i{1,3}|iv|vi{0,3}|ix|xi{0,3}|xiv|xvi{0,3}|xix|xxi{0,3})[\s._-]").unwrap();
        static ref PART_NUM: Regex = Regex::new(r"(?i)(pt|part|ch|chap|chapter|ep|episode|sec|section|track|trk)\.?\s*\d").unwrap();
    }

    if LEADING_NUM.is_match(filename) {
        return true;
    }

    if ROMAN_NUMERAL.is_match(filename) {
        return true;
    }

    if PART_NUM.is_match(filename) {
        return true;
    }

    false
}

/// Detect if a folder name looks like a chapter/part marker rather than a book title.
/// Examples: "Chapter 01", "Disc 1", "CD1"
/// Returns true if folder appears to be a chapter/part subfolder, not a book title.
///
/// NOTE: We intentionally do NOT match:
/// - Folders that start with numbers followed by substantial text (book titles)
/// - "Part X - [Long Title]" patterns (likely separate works in a collection)
pub fn is_chapter_folder(name: &str) -> bool {
    use regex::Regex;

    lazy_static::lazy_static! {
        // Pattern 1: Just a number with optional separator, nothing substantial after
        // Matches: "1_", "01-", "1 ", "01", but NOT "12 Weeks to..."
        static ref JUST_NUMBER: Regex = Regex::new(r"^\d{1,2}[_\-\s]*$").unwrap();

        // Pattern 2: "Part" followed by roman numeral or digit, with SHORT or NO text after
        // Matches: "Part 1", "Part I", "Part 1 - Intro" (short)
        // Does NOT match: "Part 1 - Hope Springs Eternal - Rita Hayworth" (long title = separate work)
        static ref PART_SHORT: Regex = Regex::new(r"(?i)^part\s+[ivxlcdm\d]+\s*$").unwrap();
        static ref PART_WITH_SHORT_TITLE: Regex = Regex::new(r"(?i)^part\s+[ivxlcdm\d]+\s*[-:]\s*.{1,20}$").unwrap();

        // Pattern 3: "Chapter" followed by number (e.g., "Chapter 1", "Chapter 01")
        static ref CHAPTER_PATTERN: Regex = Regex::new(r"(?i)^chapter\s+\d+").unwrap();

        // Pattern 4: "Disc" or "Disk" followed by number (e.g., "Disc 1", "Disk 2")
        // These are ALWAYS chapter folders - discs are physical media divisions
        static ref DISC_PATTERN: Regex = Regex::new(r"(?i)^dis[ck]\s*\d+").unwrap();

        // Pattern 5: "CD" followed by number (e.g., "CD1", "CD 1")
        static ref CD_PATTERN: Regex = Regex::new(r"(?i)^cd\s*\d+").unwrap();

        // Pattern 6: "Book" followed by just a number (for multi-book sets like "Book 1", "Book 2")
        // But NOT "Book Title Here" which would be a book name
        static ref BOOK_NUM_PATTERN: Regex = Regex::new(r"(?i)^book\s*\d+\s*$").unwrap();

        // Pattern 7: Number followed by underscore and short text (likely chapter marker)
        // Matches: "1_ Part I", "02_Chapter", but NOT "01 Left Behind - A Novel"
        static ref NUM_UNDERSCORE: Regex = Regex::new(r"^\d{1,2}_\s*.{0,20}$").unwrap();
    }

    // Disc/CD patterns are always chapter folders (physical media divisions)
    if DISC_PATTERN.is_match(name) || CD_PATTERN.is_match(name) {
        return true;
    }

    // Chapter pattern
    if CHAPTER_PATTERN.is_match(name) {
        return true;
    }

    // Book N (just number, no title)
    if BOOK_NUM_PATTERN.is_match(name) {
        return true;
    }

    // Part patterns - only match short ones, not "Part 1 - Full Book Title"
    if PART_SHORT.is_match(name) || PART_WITH_SHORT_TITLE.is_match(name) {
        return true;
    }

    // Check if it's just a bare number (very likely a chapter folder)
    if JUST_NUMBER.is_match(name) {
        return true;
    }

    // Check underscore pattern with short text
    if NUM_UNDERSCORE.is_match(name) {
        return true;
    }

    false
}
