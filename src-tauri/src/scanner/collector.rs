// src-tauri/src/scanner/collector.rs
use super::types::{AudioFile, BookGroup, BookMetadata, GroupType, RawFileData, ScanStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::path::Path;
use walkdir::WalkDir;
use std::collections::HashMap;
use serde::Deserialize;

const AUDIO_EXTENSIONS: &[&str] = &["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"];

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

    (Some(BookMetadata {
        title,
        author,
        subtitle: abs_meta.subtitle,
        narrator,
        series,
        sequence,
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
    }), true)
}

pub async fn collect_and_group_files(
    paths: &[String],
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    use futures::stream::{self, StreamExt};

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
        .buffer_unordered(10)  // Scan up to 10 root paths in parallel
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

    let groups = group_files_by_book(all_files);

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

    groups.into_iter()
        .map(|(parent_dir, mut files)| {
            files.sort_by(|a, b| a.filename.cmp(&b.filename));

            let group_name = Path::new(&parent_dir)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

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
