// src-tauri/src/folder_fixer.rs
// AI-powered folder organization for AudiobookShelf compatibility

use anyhow::Result;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::SystemTime;
use walkdir::WalkDir;

use crate::scanner::collector::is_chapter_folder;
use crate::file_rename::sanitize_filename;

const AUDIO_EXTENSIONS: &[&str] = &["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"];

// ============================================================================
// GPT-5-nano API (OpenAI Responses API)
// ============================================================================

/// Call GPT-5-nano via OpenAI Responses API with retry logic
async fn call_codex_api(prompt: &str, api_key: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let body = serde_json::json!({
        "model": "gpt-5-nano",
        "input": [
            {
                "role": "developer",
                "content": "You extract audiobook metadata. Return ONLY valid JSON, no markdown."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "max_output_tokens": 2000,
        "reasoning": {
            "effort": "low"
        },
        "text": {
            "format": {
                "type": "json_object"
            }
        }
    });

    // Try up to 2 times
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        }

        let response = match client
            .post("https://api.openai.com/v1/responses")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                if attempt == 1 {
                    return Err(format!("Request failed: {}", e));
                }
                continue;
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            if attempt == 1 {
                return Err(format!("API error {}: {}", status, error_text));
            }
            continue;
        }

        let response_text = match response.text().await {
            Ok(t) => t,
            Err(e) => {
                if attempt == 1 {
                    return Err(format!("Failed to read response: {}", e));
                }
                continue;
            }
        };

        // Parse OpenAI Responses API format
        match parse_responses_api(&response_text) {
            Ok(content) => return Ok(content),
            Err(e) => {
                if attempt == 1 {
                    return Err(format!("Parse error: {} (raw: {})", e, response_text.chars().take(200).collect::<String>()));
                }
                continue;
            }
        }
    }

    Err("All retries failed".to_string())
}

/// Parse OpenAI Responses API response
fn parse_responses_api(response_text: &str) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct ResponsesApiResponse {
        output: Vec<OutputItem>,
    }

    #[derive(serde::Deserialize)]
    struct OutputItem {
        content: Option<Vec<ContentItem>>,
        #[serde(rename = "type")]
        item_type: String,
    }

    #[derive(serde::Deserialize)]
    struct ContentItem {
        text: Option<String>,
        #[serde(rename = "type")]
        content_type: String,
    }

    let result: ResponsesApiResponse = serde_json::from_str(response_text)
        .map_err(|e| format!("Failed to parse GPT-5-nano response: {}", e))?;

    // Find the message output and extract text
    for item in &result.output {
        if item.item_type == "message" {
            if let Some(contents) = &item.content {
                for c in contents {
                    if c.content_type == "output_text" || c.content_type == "text" {
                        if let Some(text) = &c.text {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                let json_str = trimmed
                                    .trim_start_matches("```json")
                                    .trim_start_matches("```")
                                    .trim_end_matches("```")
                                    .trim();
                                return Ok(json_str.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    Err(format!("No text in response. Output types: {:?}",
        result.output.iter().map(|o| &o.item_type).collect::<Vec<_>>()))
}

/// Try to read metadata from common metadata files in the folder
/// Returns (title, author, series) if found
fn try_read_metadata_file(folder_path: &str) -> Option<(String, String, Option<String>)> {
    let folder = Path::new(folder_path);

    // Common metadata file names
    let metadata_files = [
        "metadata.json",
        "metadata.abs.json",  // AudiobookShelf
        "book.json",
        "info.json",
        ".metadata.json",
        "audiobook.json",
    ];

    for filename in &metadata_files {
        let meta_path = folder.join(filename);
        if meta_path.exists() {
            if let Ok(content) = fs::read_to_string(&meta_path) {
                if let Some(meta) = parse_metadata_json(&content) {
                    println!("   📄 Found metadata in {}: {} by {}", filename, meta.0, meta.1);
                    return Some(meta);
                }
            }
        }
    }

    // Also check for .opf files (common in ebook/audiobook collections)
    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if ext == "opf" {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Some(meta) = parse_opf_metadata(&content) {
                            println!("   📄 Found metadata in OPF: {} by {}", meta.0, meta.1);
                            return Some(meta);
                        }
                    }
                }
            }
        }
    }

    None
}

/// Decode common HTML entities in a string
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&aring;", "å")
        .replace("&Aring;", "Å")
        .replace("&eacute;", "é")
        .replace("&Eacute;", "É")
        .replace("&egrave;", "è")
        .replace("&Egrave;", "È")
        .replace("&agrave;", "à")
        .replace("&Agrave;", "À")
        .replace("&ouml;", "ö")
        .replace("&Ouml;", "Ö")
        .replace("&uuml;", "ü")
        .replace("&Uuml;", "Ü")
        .replace("&ntilde;", "ñ")
        .replace("&Ntilde;", "Ñ")
        .replace("&ccedil;", "ç")
        .replace("&Ccedil;", "Ç")
        .replace("&nbsp;", " ")
}

/// Check if an author name looks valid (not a title fragment or placeholder)
fn is_valid_author_name(author: &str, title: &str) -> bool {
    let author_lower = author.to_lowercase();
    let title_lower = title.to_lowercase();

    // Reject if author is empty or too short
    if author.trim().len() < 3 {
        return false;
    }

    // Reject if author looks like a title fragment (starts with common title words)
    let bad_prefixes = ["the ", "a ", "an ", "le ", "la ", "les ", "un ", "une ", "meurtre ", "learn "];
    for prefix in &bad_prefixes {
        if author_lower.starts_with(prefix) {
            return false;
        }
    }

    // Reject if author is a significant substring of the title (likely extracted wrong)
    if title_lower.contains(&author_lower) && author.len() > 5 {
        return false;
    }

    // Reject if author contains brackets (likely ASIN or similar)
    if author.contains('[') || author.contains(']') {
        return false;
    }

    // Reject common placeholder names
    let bad_authors = ["unknown", "various", "n/a", "none", "author"];
    if bad_authors.contains(&author_lower.trim()) {
        return false;
    }

    true
}

/// Parse metadata from a JSON file
fn parse_metadata_json(content: &str) -> Option<(String, String, Option<String>)> {
    // Try to parse as generic JSON and extract common fields
    let json: serde_json::Value = serde_json::from_str(content).ok()?;

    // Try various common field names for title
    let title = json.get("title")
        .or_else(|| json.get("bookTitle"))
        .or_else(|| json.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| decode_html_entities(s))?;

    // Try various common field names for author
    let author = json.get("author")
        .or_else(|| json.get("authors"))
        .or_else(|| json.get("authorName"))
        .or_else(|| json.get("creator"))
        .and_then(|v| {
            // Could be string or array
            if let Some(s) = v.as_str() {
                Some(decode_html_entities(s))
            } else if let Some(arr) = v.as_array() {
                // Join multiple authors
                let authors: Vec<String> = arr.iter()
                    .filter_map(|a| {
                        if let Some(s) = a.as_str() {
                            Some(decode_html_entities(s))
                        } else if let Some(name) = a.get("name").and_then(|n| n.as_str()) {
                            Some(decode_html_entities(name))
                        } else {
                            None
                        }
                    })
                    .collect();
                if !authors.is_empty() {
                    Some(authors.join(", "))
                } else {
                    None
                }
            } else {
                None
            }
        })?;

    // Validate author name - reject bad metadata
    if !is_valid_author_name(&author, &title) {
        return None;
    }

    // Try to get series (optional) - can be string, object with name, or array
    let series = json.get("series")
        .or_else(|| json.get("seriesName"))
        .and_then(|v| {
            if let Some(s) = v.as_str() {
                // Direct string
                let decoded = decode_html_entities(s);
                if !decoded.is_empty() { Some(decoded) } else { None }
            } else if let Some(arr) = v.as_array() {
                // Array of series objects - take the first one
                arr.first()
                    .and_then(|first| first.get("name"))
                    .and_then(|n| n.as_str())
                    .map(|s| decode_html_entities(s))
            } else if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                // Single object with name field
                Some(decode_html_entities(name))
            } else {
                None
            }
        });

    Some((title, author, series))
}

/// Parse metadata from an OPF file (XML format used by Calibre and others)
fn parse_opf_metadata(content: &str) -> Option<(String, String, Option<String>)> {
    // Simple regex-based extraction for OPF files
    lazy_static::lazy_static! {
        static ref TITLE_RE: Regex = Regex::new(r#"<dc:title[^>]*>([^<]+)</dc:title>"#).unwrap();
        static ref AUTHOR_RE: Regex = Regex::new(r#"<dc:creator[^>]*>([^<]+)</dc:creator>"#).unwrap();
        static ref SERIES_RE: Regex = Regex::new(r#"name="calibre:series"\s+content="([^"]+)""#).unwrap();
    }

    let title = TITLE_RE.captures(content)
        .and_then(|c| c.get(1))
        .map(|m| decode_html_entities(m.as_str().trim()))?;

    let author = AUTHOR_RE.captures(content)
        .and_then(|c| c.get(1))
        .map(|m| decode_html_entities(m.as_str().trim()))?;

    // Validate author name
    if !is_valid_author_name(&author, &title) {
        return None;
    }

    let series = SERIES_RE.captures(content)
        .and_then(|c| c.get(1))
        .map(|m| decode_html_entities(m.as_str().trim()));

    Some((title, author, series))
}


// ============================================================================
// TYPES
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IssueType {
    ChapterSubfolder,
    FlatStructure,
    WrongNaming,
    MixedBooks,
    MissingAuthorFolder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderIssue {
    pub path: String,
    pub issue_type: IssueType,
    pub description: String,
    pub severity: u8, // 1-3: low, medium, high
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedMove {
    pub id: String,
    pub source: String,
    pub destination: String,
    pub file_count: usize,
    pub confidence: u8,
    pub reason: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedBook {
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub files: Vec<String>,
    pub source_folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderAnalysis {
    pub root_path: String,
    pub total_folders: usize,
    pub total_audio_files: usize,
    pub issues: Vec<FolderIssue>,
    pub proposed_changes: Vec<ProposedMove>,
    pub detected_books: Vec<DetectedBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixResult {
    pub success: bool,
    pub moves_completed: usize,
    pub moves_failed: usize,
    pub errors: Vec<String>,
    pub backup_path: Option<String>,
}

// ============================================================================
// ANALYSIS
// ============================================================================

/// Analyze a folder structure and detect issues
pub async fn analyze_folder_structure(
    root_path: &str,
    api_key: Option<&str>,
) -> Result<FolderAnalysis> {
    println!("📂 Analyzing folder structure: {}", root_path);

    let mut issues: Vec<FolderIssue> = Vec::new();
    let mut proposed_changes: Vec<ProposedMove> = Vec::new();
    let mut detected_books: Vec<DetectedBook> = Vec::new();
    let mut total_folders = 0;
    let mut total_audio_files = 0;

    // Collect all folders and their audio files
    let mut folder_contents: HashMap<String, Vec<String>> = HashMap::new();

    for entry in WalkDir::new(root_path)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && !name.starts_with("backup_")
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_dir() {
            total_folders += 1;
            continue;
        }

        let path = entry.path();
        if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if AUDIO_EXTENSIONS.contains(&ext_lower.as_str()) {
                total_audio_files += 1;

                if let Some(parent) = path.parent() {
                    let parent_str = parent.to_string_lossy().to_string();
                    folder_contents
                        .entry(parent_str)
                        .or_insert_with(Vec::new)
                        .push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    println!("   Found {} folders, {} audio files", total_folders, total_audio_files);

    // Analyze each folder with audio files
    for (folder_path, files) in &folder_contents {
        let folder_name = Path::new(folder_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Check for chapter subfolders
        if is_chapter_folder(&folder_name) {
            let parent = Path::new(folder_path).parent();
            let grandparent = parent.and_then(|p| p.file_name());

            issues.push(FolderIssue {
                path: folder_path.clone(),
                issue_type: IssueType::ChapterSubfolder,
                description: format!(
                    "Folder '{}' looks like a chapter/part marker. Files should be in parent folder.",
                    folder_name
                ),
                severity: 2,
            });

            // Propose merging into parent
            if let Some(parent_path) = parent {
                let parent_str = parent_path.to_string_lossy().to_string();
                proposed_changes.push(ProposedMove {
                    id: uuid::Uuid::new_v4().to_string(),
                    source: folder_path.clone(),
                    destination: parent_str,
                    file_count: files.len(),
                    confidence: 90,
                    reason: format!("Merge chapter subfolder '{}' into parent book folder", folder_name),
                    is_directory: true,
                });
            }
        }

        // Check folder naming format
        let naming_analysis = analyze_folder_naming(folder_path, &folder_name);
        if let Some(issue) = naming_analysis.issue {
            issues.push(issue);
        }
        if let Some(proposed) = naming_analysis.proposed_move {
            proposed_changes.push(proposed);
        }

        // Detect if this folder has proper author/title structure
        let depth = folder_path.strip_prefix(root_path)
            .unwrap_or(folder_path)
            .chars()
            .filter(|c| *c == '/' || *c == '\\')
            .count();

        if depth < 2 && files.len() > 0 {
            // Files at root or one level deep - likely missing author folder
            issues.push(FolderIssue {
                path: folder_path.clone(),
                issue_type: IssueType::MissingAuthorFolder,
                description: format!(
                    "Folder '{}' contains audio files but may be missing proper Author/Title structure",
                    folder_name
                ),
                severity: 1,
            });
        }
    }

    // Use GPT to analyze uncertain folders if API key provided
    if let Some(key) = api_key {
        let uncertain_folders: Vec<_> = folder_contents.iter()
            .filter(|(path, files)| {
                let folder_name = Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                // Folders that need GPT analysis:
                // - Multiple unrelated files (potential mixed books)
                // - Unclear naming
                files.len() > 10 || !looks_like_book_folder(&folder_name)
            })
            .take(10) // Limit GPT calls
            .collect();

        for (folder_path, files) in uncertain_folders {
            match analyze_with_gpt(folder_path, files, key).await {
                Ok(gpt_analysis) => {
                    for book in gpt_analysis.detected_books {
                        detected_books.push(book);
                    }
                    for change in gpt_analysis.proposed_changes {
                        proposed_changes.push(change);
                    }
                }
                Err(e) => {
                    println!("   ⚠️ GPT analysis failed for {}: {}", folder_path, e);
                }
            }
        }
    }

    // Sort issues by severity
    issues.sort_by(|a, b| b.severity.cmp(&a.severity));

    Ok(FolderAnalysis {
        root_path: root_path.to_string(),
        total_folders,
        total_audio_files,
        issues,
        proposed_changes,
        detected_books,
    })
}

// ============================================================================
// FOLDER NAMING ANALYSIS
// ============================================================================

struct NamingAnalysis {
    issue: Option<FolderIssue>,
    proposed_move: Option<ProposedMove>,
}

fn analyze_folder_naming(folder_path: &str, folder_name: &str) -> NamingAnalysis {
    lazy_static::lazy_static! {
        // Good patterns: "Author - Title", "Author/Title"
        static ref AUTHOR_TITLE: Regex = Regex::new(r"^([^-]+?)\s*[-–]\s*(.+)$").unwrap();
        // Bad patterns: just numbers, random characters
        static ref BAD_NAME: Regex = Regex::new(r"^[\d\s_\-\.]+$").unwrap();
        // Contains ASIN or weird codes
        static ref HAS_ASIN: Regex = Regex::new(r"\b[A-Z0-9]{10}\b").unwrap();
    }

    let mut result = NamingAnalysis {
        issue: None,
        proposed_move: None,
    };

    // Check for bad naming patterns
    if BAD_NAME.is_match(folder_name) {
        result.issue = Some(FolderIssue {
            path: folder_path.to_string(),
            issue_type: IssueType::WrongNaming,
            description: format!("Folder '{}' has unclear naming (just numbers/symbols)", folder_name),
            severity: 2,
        });
    } else if HAS_ASIN.is_match(folder_name) {
        result.issue = Some(FolderIssue {
            path: folder_path.to_string(),
            issue_type: IssueType::WrongNaming,
            description: format!("Folder '{}' contains ASIN or product code that should be removed", folder_name),
            severity: 1,
        });
    }

    result
}

fn looks_like_book_folder(name: &str) -> bool {
    // A good book folder name should have:
    // - More than just numbers
    // - Actual words
    // - Not look like a chapter marker

    if is_chapter_folder(name) {
        return false;
    }

    // Has at least some letters
    let letter_count = name.chars().filter(|c| c.is_alphabetic()).count();
    if letter_count < 3 {
        return false;
    }

    true
}

// ============================================================================
// GPT ANALYSIS (Parallel Processing)
// ============================================================================

#[derive(Debug, Deserialize)]
struct GptFolderResponse {
    #[serde(default)]
    detected_books: Vec<GptDetectedBook>,
    #[serde(default)]
    proposed_structure: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GptDetectedBook {
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    series: Option<String>,
    #[serde(default)]
    sequence: Option<String>,
}

struct GptAnalysisResult {
    detected_books: Vec<DetectedBook>,
    proposed_changes: Vec<ProposedMove>,
}

/// Try to extract book info from folder name without GPT
/// DISABLED - Always use GPT for proper analysis
/// The regex approach was too error-prone (e.g., "Learn Italian" matched as author name)
fn try_parse_folder_name(_folder_name: &str) -> Option<(String, String, Option<String>)> {
    // Always return None to force GPT analysis
    // GPT is much better at understanding whether something is an author name vs. a title
    None
}

/// Extract just the title from a folder name (for folders without author)
fn extract_title_from_folder(folder_name: &str) -> String {
    lazy_static::lazy_static! {
        // Remove ASIN/ISBN codes like [B01N6QQJP1]
        static ref ASIN_CODE: Regex = Regex::new(r"\s*\[[A-Z0-9]{10}\]\s*").unwrap();
    }
    ASIN_CODE.replace_all(folder_name, "").trim().to_string()
}

/// Analyze a single folder with GPT (for parallel processing)
async fn analyze_single_folder_gpt(
    folder_path: String,
    files: Vec<String>,
    root_path: String,
    api_key: String,
) -> Option<GptAnalysisResult> {
    let folder_name = Path::new(&folder_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // FAST PATH: Try to parse folder name without GPT
    if let Some((author, title, series)) = try_parse_folder_name(&folder_name) {
        let safe_author = sanitize_filename(&author);
        let safe_title = sanitize_filename(&title);

        let dest_path = if let Some(ref s) = series {
            let safe_series = sanitize_filename(s);
            format!("{}/{}/{}", safe_author, safe_series, safe_title)
        } else {
            format!("{}/{}", safe_author, safe_title)
        };

        let current_rel = folder_path.strip_prefix(&root_path)
            .unwrap_or(&folder_path)
            .trim_start_matches('/');

        let mut proposed_changes = Vec::new();
        if current_rel != dest_path {
            proposed_changes.push(ProposedMove {
                id: uuid::Uuid::new_v4().to_string(),
                source: folder_path.clone(),
                destination: dest_path,
                file_count: files.len(),
                confidence: 95, // High confidence from folder name parsing
                reason: format!("Restructure '{}' by {} (from folder name)", title, author),
                is_directory: true,
            });
        }

        return Some(GptAnalysisResult {
            detected_books: vec![DetectedBook {
                title,
                author,
                series,
                sequence: None,
                files: files.iter().map(|f| {
                    Path::new(f).file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                }).collect(),
                source_folder: folder_path,
            }],
            proposed_changes,
        });
    }

    // FAST PATH: Check for metadata.json or similar files in the folder
    if let Some(meta) = try_read_metadata_file(&folder_path) {
        if !meta.0.is_empty() && !meta.1.is_empty() {
            let (title, author, series) = meta;
            let safe_author = sanitize_filename(&author);
            let safe_title = sanitize_filename(&title);

            let dest_path = if let Some(ref s) = series {
                let safe_series = sanitize_filename(s);
                format!("{}/{}/{}", safe_author, safe_series, safe_title)
            } else {
                format!("{}/{}", safe_author, safe_title)
            };

            let current_rel = folder_path.strip_prefix(&root_path)
                .unwrap_or(&folder_path)
                .trim_start_matches('/');

            let mut proposed_changes = Vec::new();
            if current_rel != dest_path {
                proposed_changes.push(ProposedMove {
                    id: uuid::Uuid::new_v4().to_string(),
                    source: folder_path.clone(),
                    destination: dest_path,
                    file_count: files.len(),
                    confidence: 95, // High confidence from metadata file
                    reason: format!("Restructure '{}' by {} (from metadata)", title, author),
                    is_directory: true,
                });
            }

            return Some(GptAnalysisResult {
                detected_books: vec![DetectedBook {
                    title,
                    author,
                    series,
                    sequence: None,
                    files: files.iter().map(|f| {
                        Path::new(f).file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default()
                    }).collect(),
                    source_folder: folder_path,
                }],
                proposed_changes,
            });
        }
    }

    // SLOW PATH: Use GPT for unclear folder names
    let file_names: Vec<String> = files.iter()
        .filter_map(|f| Path::new(f).file_name())
        .map(|n| n.to_string_lossy().to_string())
        .collect();

    // Get clean title (without ASIN) for the prompt
    let clean_title = extract_title_from_folder(&folder_name);

    // Only show first 3 files to give more context
    let file_list = file_names.iter().take(3).map(|f| format!("{}", f)).collect::<Vec<_>>().join(", ");

    let prompt = format!(
r#"Audiobook folder: "{clean_title}"
Files: {file_list}
Who wrote this book? Return ONLY the real author - use "Unknown" if unsure.
{{"title":"...","author":"...","series":"..."}}"#,
        clean_title = clean_title,
        file_list = file_list
    );

    // Use GPT-5.1-codex-mini with retry logic
    match call_codex_api(&prompt, &api_key).await {
        Ok(response) => {
            // Parse simple {"title":"...","author":"..."} response
            match parse_simple_book_response(&response) {
                Ok((title, author, series)) => {
                    if title.is_empty() || author.is_empty() {
                        println!("   ⚠️ Empty title/author for: {}", clean_title);
                        return None;
                    }

                    let safe_author = sanitize_filename(&author);
                    let safe_title = sanitize_filename(&title);

                    let dest_path = if let Some(ref s) = series {
                        let safe_series = sanitize_filename(s);
                        format!("{}/{}/{}", safe_author, safe_series, safe_title)
                    } else {
                        format!("{}/{}", safe_author, safe_title)
                    };

                    let current_rel = folder_path.strip_prefix(&root_path)
                        .unwrap_or(&folder_path)
                        .trim_start_matches('/');

                    let mut proposed_changes = Vec::new();
                    if current_rel != dest_path {
                        proposed_changes.push(ProposedMove {
                            id: uuid::Uuid::new_v4().to_string(),
                            source: folder_path.clone(),
                            destination: dest_path,
                            file_count: files.len(),
                            confidence: 80,
                            reason: format!("Restructure '{}' by {}", title, author),
                            is_directory: true,
                        });
                    }

                    return Some(GptAnalysisResult {
                        detected_books: vec![DetectedBook {
                            title,
                            author,
                            series,
                            sequence: None,
                            files: files.iter().map(|f| {
                                Path::new(f).file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_default()
                            }).collect(),
                            source_folder: folder_path,
                        }],
                        proposed_changes,
                    });
                }
                Err(e) => {
                    println!("   ⚠️ Parse error for {}: {} (response: {})", clean_title, e, response.chars().take(100).collect::<String>());
                }
            }
        }
        Err(e) => {
            println!("   ⚠️ GPT API error for {}: {}", clean_title, e);
        }
    }

    None
}

/// Parse simple {"title":"...","author":"...","series":"..."} response from GPT
/// Handles both complete and truncated JSON responses
fn parse_simple_book_response(response: &str) -> Result<(String, String, Option<String>)> {
    // Try regex extraction FIRST - works even on truncated JSON
    lazy_static::lazy_static! {
        static ref TITLE_RE: Regex = Regex::new(r#""title"\s*:\s*"([^"]+)""#).unwrap();
        static ref AUTHOR_RE: Regex = Regex::new(r#""author"\s*:\s*"([^"]+)""#).unwrap();
        static ref SERIES_RE: Regex = Regex::new(r#""series"\s*:\s*"([^"]+)""#).unwrap();
    }

    let title = TITLE_RE.captures(response)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let author = AUTHOR_RE.captures(response)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let series = SERIES_RE.captures(response)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    if !title.is_empty() && !author.is_empty() {
        return Ok((title, author, series));
    }

    // If regex failed, try full JSON parsing
    if let Ok(json_str) = extract_json_from_response(response) {
        #[derive(serde::Deserialize)]
        struct SimpleBook {
            #[serde(default)]
            title: String,
            #[serde(default)]
            author: String,
            #[serde(default)]
            series: Option<String>,
        }

        if let Ok(book) = serde_json::from_str::<SimpleBook>(&json_str) {
            if !book.title.is_empty() && !book.author.is_empty() {
                return Ok((book.title, book.author, book.series));
            }
        }
    }

    // Return partial results if we have at least a title
    if !title.is_empty() {
        return Ok((title, if author.is_empty() { "Unknown".to_string() } else { author }, series));
    }

    Err(anyhow::anyhow!("Could not extract title/author from: {}", response.chars().take(50).collect::<String>()))
}

fn parse_gpt_folder_response(response: &str) -> Result<GptFolderResponse> {
    // Try to extract JSON from response
    let json_str = extract_json_from_response(response)?;

    // Try to parse
    match serde_json::from_str::<GptFolderResponse>(&json_str) {
        Ok(parsed) => Ok(parsed),
        Err(e) => {
            // Try regex extraction as fallback
            extract_book_info_regex(response)
                .map_err(|_| anyhow::anyhow!("Failed to parse: {}", e))
        }
    }
}

fn extract_json_from_response(text: &str) -> Result<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow::anyhow!("Empty response"));
    }

    if let Some(start) = text.find('{') {
        let mut depth = 0;
        let mut in_string = false;
        let mut escape_next = false;

        for (i, c) in text[start..].char_indices() {
            if escape_next {
                escape_next = false;
                continue;
            }

            match c {
                '\\' if in_string => escape_next = true,
                '"' => in_string = !in_string,
                '{' if !in_string => depth += 1,
                '}' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(text[start..=start + i].to_string());
                    }
                }
                _ => {}
            }
        }

        // Fallback: take everything from { to last }
        if let Some(end) = text.rfind('}') {
            if end >= start {
                return Ok(text[start..=end].to_string());
            }
        }
    }

    Err(anyhow::anyhow!("No JSON found"))
}

fn extract_book_info_regex(text: &str) -> Result<GptFolderResponse> {
    lazy_static::lazy_static! {
        static ref TITLE_RE: Regex = Regex::new(r#""title"\s*:\s*"([^"]+)""#).unwrap();
        static ref AUTHOR_RE: Regex = Regex::new(r#""author"\s*:\s*"([^"]+)""#).unwrap();
        static ref SERIES_RE: Regex = Regex::new(r#""series"\s*:\s*"([^"]+)""#).unwrap();
    }

    let title = TITLE_RE.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let author = AUTHOR_RE.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    if title.is_empty() && author.is_empty() {
        return Err(anyhow::anyhow!("Could not extract book info"));
    }

    let series = SERIES_RE.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    Ok(GptFolderResponse {
        detected_books: vec![GptDetectedBook {
            title,
            author,
            files: Vec::new(),
            series,
            sequence: None,
        }],
        proposed_structure: None,
    })
}

// Legacy function for backwards compatibility
async fn analyze_with_gpt(
    folder_path: &str,
    files: &[String],
    api_key: &str,
) -> Result<GptAnalysisResult> {
    analyze_single_folder_gpt(
        folder_path.to_string(),
        files.to_vec(),
        String::new(),
        api_key.to_string(),
    ).await.ok_or_else(|| anyhow::anyhow!("GPT analysis failed"))
}

// ============================================================================
// APPLY FIXES
// ============================================================================

/// Apply the proposed folder fixes
pub async fn apply_folder_fixes(
    changes: Vec<ProposedMove>,
    root_path: &str,
    create_backup: bool,
) -> Result<FixResult> {
    let mut result = FixResult {
        success: true,
        moves_completed: 0,
        moves_failed: 0,
        errors: Vec::new(),
        backup_path: None,
    };

    // Create backup if requested
    if create_backup {
        // Generate timestamp for backup folder name
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup_name = format!("backup_{}", timestamp);
        let backup_path = Path::new(root_path).parent()
            .unwrap_or(Path::new(root_path))
            .join(&backup_name);

        println!("📦 Creating backup at: {}", backup_path.display());

        // For now, just note where backup would go
        // Full backup implementation would use fs_extra::dir::copy
        result.backup_path = Some(backup_path.to_string_lossy().to_string());
    }

    for change in changes {
        println!("   Moving: {} -> {}", change.source, change.destination);

        let dest_path = Path::new(root_path).join(&change.destination);

        // Create destination directory
        if let Err(e) = fs::create_dir_all(&dest_path) {
            result.errors.push(format!("Failed to create directory {}: {}", dest_path.display(), e));
            result.moves_failed += 1;
            continue;
        }

        // Move files or merge directories
        if change.is_directory {
            // Merge/move directory contents
            // If destination is a relative path, it's a restructure move
            // If destination is absolute, it's a chapter folder merge
            let actual_dest = if Path::new(&change.destination).is_absolute() {
                change.destination.clone()
            } else {
                dest_path.to_string_lossy().to_string()
            };

            match merge_directory_contents(&change.source, &actual_dest) {
                Ok(count) => {
                    println!("      ✅ Merged {} files", count);
                    result.moves_completed += 1;
                }
                Err(e) => {
                    result.errors.push(format!("Failed to merge {}: {}", change.source, e));
                    result.moves_failed += 1;
                }
            }
        } else {
            // Move individual files
            let source_path = Path::new(&change.source);
            for entry in WalkDir::new(source_path)
                .max_depth(1)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let file_name = entry.file_name();
                let dest_file = dest_path.join(file_name);

                // Try rename first, fall back to copy+delete for cross-device
                let move_result = fs::rename(entry.path(), &dest_file)
                    .or_else(|_| {
                        fs::copy(entry.path(), &dest_file)?;
                        fs::remove_file(entry.path())
                    });

                match move_result {
                    Ok(_) => result.moves_completed += 1,
                    Err(e) => {
                        result.errors.push(format!("Failed to move {:?}: {}", file_name, e));
                        result.moves_failed += 1;
                    }
                }
            }
        }
    }

    // Clean up empty directories
    cleanup_empty_dirs(root_path)?;

    result.success = result.moves_failed == 0;

    Ok(result)
}

/// Merge contents of source directory into destination
fn merge_directory_contents(source: &str, destination: &str) -> Result<usize> {
    let source_path = Path::new(source);
    let dest_path = Path::new(destination);
    let mut count = 0;

    // Ensure destination exists
    fs::create_dir_all(dest_path)?;

    for entry in WalkDir::new(source_path)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let file_name = entry.file_name();
        let dest_file = dest_path.join(file_name);

        // Don't overwrite existing files
        if !dest_file.exists() {
            // Try rename first (fast, same filesystem)
            if let Err(_) = fs::rename(entry.path(), &dest_file) {
                // Fall back to copy + delete (cross-device)
                fs::copy(entry.path(), &dest_file)?;
                fs::remove_file(entry.path())?;
            }
            count += 1;
        }
    }

    // Remove source directory if empty
    if fs::read_dir(source_path)?.next().is_none() {
        fs::remove_dir(source_path)?;
    }

    Ok(count)
}

/// Remove empty directories recursively
fn cleanup_empty_dirs(root: &str) -> Result<()> {
    let mut removed = true;

    while removed {
        removed = false;

        for entry in WalkDir::new(root)
            .min_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_dir())
        {
            let path = entry.path();

            // Check if directory is empty
            if let Ok(mut entries) = fs::read_dir(path) {
                if entries.next().is_none() {
                    if fs::remove_dir(path).is_ok() {
                        println!("   🗑️  Removed empty directory: {}", path.display());
                        removed = true;
                    }
                }
            }
        }
    }

    Ok(())
}

// ============================================================================
// LIBRARY RESTRUCTURE (Parallel GPT Analysis)
// ============================================================================

/// Analyze entire library and propose restructuring to Author/Series/Title format
pub async fn restructure_library(
    root_path: &str,
    api_key: &str,
) -> Result<FolderAnalysis> {
    println!("📚 Restructuring library: {} (parallel mode)", root_path);

    let mut analysis = FolderAnalysis {
        root_path: root_path.to_string(),
        total_folders: 0,
        total_audio_files: 0,
        issues: Vec::new(),
        proposed_changes: Vec::new(),
        detected_books: Vec::new(),
    };

    // Collect all folders with audio files
    let mut folder_contents: HashMap<String, Vec<String>> = HashMap::new();

    for entry in WalkDir::new(root_path)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && !name.starts_with("backup_")
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_dir() {
            analysis.total_folders += 1;
            continue;
        }

        let path = entry.path();
        if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if AUDIO_EXTENSIONS.contains(&ext_lower.as_str()) {
                analysis.total_audio_files += 1;

                if let Some(parent) = path.parent() {
                    let parent_str = parent.to_string_lossy().to_string();
                    folder_contents
                        .entry(parent_str)
                        .or_default()
                        .push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    println!("   Found {} folders with {} audio files",
        folder_contents.len(), analysis.total_audio_files);

    if folder_contents.is_empty() {
        return Ok(analysis);
    }

    // Filter to folders that need restructuring (not already in Author/Title structure)
    let folders_to_analyze: Vec<_> = folder_contents.iter()
        .filter(|(path, _)| {
            let rel_path = path.strip_prefix(root_path).unwrap_or(path);
            let depth = rel_path.chars().filter(|c| *c == '/' || *c == '\\').count();
            // Analyze folders at any depth that might need restructuring
            depth < 3 || !looks_like_proper_structure(path, root_path)
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    println!("   {} folders need analysis", folders_to_analyze.len());

    // Process in parallel batches - keep concurrency moderate for codex model
    const MAX_CONCURRENT: usize = 10;
    let api_key = api_key.to_string();
    let root_path_owned = root_path.to_string();

    for chunk in folders_to_analyze.chunks(MAX_CONCURRENT) {
        let futures: Vec<_> = chunk.iter()
            .map(|(folder_path, files)| {
                analyze_single_folder_gpt(
                    folder_path.clone(),
                    files.clone(),
                    root_path_owned.clone(),
                    api_key.clone(),
                )
            })
            .collect();

        let results = futures::future::join_all(futures).await;

        for result in results.into_iter().flatten() {
            analysis.detected_books.extend(result.detected_books);
            analysis.proposed_changes.extend(result.proposed_changes);
        }

        println!("   Analyzed {} books so far...", analysis.detected_books.len());
    }

    // Add chapter subfolder issues (these don't need GPT)
    for (folder_path, _files) in &folder_contents {
        let folder_name = Path::new(folder_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        if is_chapter_folder(&folder_name) {
            if let Some(parent) = Path::new(folder_path).parent() {
                analysis.issues.push(FolderIssue {
                    path: folder_path.clone(),
                    issue_type: IssueType::ChapterSubfolder,
                    description: format!("'{}' looks like chapter/part - files should be in parent", folder_name),
                    severity: 2,
                });

                // Don't add merge proposal if we already have a restructure proposal for parent
                let parent_str = parent.to_string_lossy().to_string();
                if !analysis.proposed_changes.iter().any(|c| c.source == parent_str) {
                    analysis.proposed_changes.push(ProposedMove {
                        id: uuid::Uuid::new_v4().to_string(),
                        source: folder_path.clone(),
                        destination: parent_str,
                        file_count: folder_contents.get(folder_path).map(|f| f.len()).unwrap_or(0),
                        confidence: 90,
                        reason: format!("Merge chapter folder '{}' into parent", folder_name),
                        is_directory: true,
                    });
                }
            }
        }
    }

    analysis.issues.sort_by(|a, b| b.severity.cmp(&a.severity));

    println!("   Analysis complete: {} books, {} proposed moves",
        analysis.detected_books.len(), analysis.proposed_changes.len());

    Ok(analysis)
}

/// Check if a folder path looks like it's already in Author/Title or Author/Series/Title structure
fn looks_like_proper_structure(path: &str, root: &str) -> bool {
    let rel_path = path.strip_prefix(root).unwrap_or(path).trim_start_matches('/');
    let parts: Vec<_> = rel_path.split('/').collect();

    // Need at least 2 levels (Author/Title)
    if parts.len() < 2 {
        return false;
    }

    // First level should look like an author name (has letters, not just numbers)
    let first = parts[0];
    let has_letters = first.chars().any(|c| c.is_alphabetic());
    let not_chapter = !is_chapter_folder(first);

    has_letters && not_chapter
}
