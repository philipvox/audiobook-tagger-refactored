use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

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

struct RawFile {
    path: String,
    filename: String,
    parent_dir: String,
}

fn collect_audio_files(paths: &[String]) -> Vec<RawFile> {
    let mut files = Vec::new();
    for root in paths {
        for entry in WalkDir::new(root)
            .follow_links(true)
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
                    files.push(RawFile {
                        path: path.to_string_lossy().to_string(),
                        filename: path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string(),
                        parent_dir: parent,
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
                group_name: group_name.clone(),
                group_type,
                metadata: BookMetadata {
                    title: group_name,
                    author: String::new(),
                    narrator: String::new(),
                    series: String::new(),
                    series_number: String::new(),
                    year: String::new(),
                    genres: Vec::new(),
                    tags: Vec::new(),
                    description: String::new(),
                    age_rating: String::new(),
                },
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
