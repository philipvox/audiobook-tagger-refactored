use std::collections::HashMap;
use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};
use anyhow::Result;

use std::time::Instant;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Semaphore;
use std::sync::Arc;

static CANCELLATION_FLAG: AtomicBool = AtomicBool::new(false);

pub fn set_cancellation_flag(cancelled: bool) {
    CANCELLATION_FLAG.store(cancelled, Ordering::Relaxed);
}

pub fn is_cancelled() -> bool {
    CANCELLATION_FLAG.load(Ordering::Relaxed)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawFileData {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub tags: FileTags,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub composer: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookGroup {
    pub id: String,
    pub group_name: String,
    pub group_type: GroupType,
    pub files: Vec<AudioFile>,
    pub metadata: BookMetadata,
    pub total_changes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFile {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub status: String,
    pub changes: HashMap<String, FieldChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldChange {
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum GroupType {
    Single,
    Chapters,
    Series,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookMetadata {
    pub title: String,
    pub subtitle: Option<String>,
    pub author: String,
    pub narrator: Option<String>,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub genres: Vec<String>,
    pub publisher: Option<String>,
    pub year: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
}

fn is_already_processed(tags: &FileTags) -> bool {
    // Check if tags match our app's output format
    let has_narrator_format = tags.comment.as_ref()
        .map(|c| c.contains("Narrated by ") || c.contains("Read by "))
        .unwrap_or(false);
    
    let has_clean_genres = tags.genre.as_ref()
        .map(|g| {
            // Check if it's our comma-separated format with approved genres
            let genre_parts: Vec<&str> = g.split(',').map(|s| s.trim()).collect();
            genre_parts.len() >= 1 && genre_parts.len() <= 3 && 
            genre_parts.iter().any(|&genre| crate::genres::APPROVED_GENRES.contains(&genre))
        })
        .unwrap_or(false);
    
    let has_clean_title = tags.title.as_ref()
        .map(|t| !t.contains("(Unabridged)") && !t.contains("[Retail]") && !t.contains("320kbps") && !t.contains("Track "))
        .unwrap_or(false);
    
    println!("🔍 Already processed check:");
    println!("   Narrator format: {} (comment: {:?})", has_narrator_format, tags.comment);
    println!("   Clean genres: {} (genre: {:?})", has_clean_genres, tags.genre);
    println!("   Clean title: {} (title: {:?})", has_clean_title, tags.title);
    
    // File is considered "already processed" if it has our narrator format AND clean genres
    let is_processed = has_narrator_format && has_clean_genres;
    println!("   RESULT: {}", if is_processed { "SKIP PROCESSING" } else { "NEEDS PROCESSING" });
    
    is_processed
}
pub async fn scan_directory(
    dir_path: &str, 
    api_key: Option<String>,
    _skip_unchanged: bool,
    progress_callback: Option<Box<dyn Fn(crate::progress::ScanProgress) + Send + Sync>>
) -> Result<Vec<BookGroup>> {
    // CRITICAL: Reset cancellation flag at start
    set_cancellation_flag(false);
    
    println!("🔍 SCAN STARTED");
    println!("📂 Collecting files...");
    
    let files = collect_audio_files(dir_path)?;
    println!("📊 Found {} files\n", files.len());
    
    if files.is_empty() {
        return Ok(vec![]);
    }
    
    let groups = process_groups_with_gpt(files, api_key, _skip_unchanged, progress_callback).await;
    
    let total_changes: usize = groups.iter().map(|g| g.total_changes).sum();
    println!("✅ Complete: {} files in {} groups, {} changes", 
        groups.iter().map(|g| g.files.len()).sum::<usize>(),
        groups.len(),
        total_changes
    );
    
    Ok(groups)
}
// pub async fn scan_directory_streaming<F>(
//     dir_path: &str,
//     api_key: Option<String>,
//     skip_unchanged: bool,
//     mut callback: F,
// ) -> Result<Vec<BookGroup>>
// where
//     F: FnMut(Vec<BookGroup>) + Send + 'static,
// {
//     let files = collect_audio_files(dir_path)?;
    
//     // Process in batches of 50 books
//     let batch_size = 50;
//     let mut all_groups = Vec::new();
    
//     for chunk in files.chunks(batch_size) {
//         if is_cancelled() {
//             break;
//         }
        
//         let batch_groups = process_groups_with_gpt(
//             chunk.to_vec(),
//             api_key.clone(),
//             skip_unchanged,
//             None
//         ).await;
        
//         callback(batch_groups.clone());
//         all_groups.extend(batch_groups);
//     }
    
//     Ok(all_groups)
// }

fn collect_audio_files(dir_path: &str) -> Result<Vec<RawFileData>> {
    use walkdir::WalkDir;
    
    let mut files = Vec::new();
    
    for entry in WalkDir::new(dir_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        
        if !path.is_file() {
            continue;
        }
        
        let ext = path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        
        if !matches!(ext.as_str(), "m4b" | "m4a" | "mp3" | "flac" | "ogg") {
            continue;
        }
        
        let filename = path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        
        if filename.starts_with("._") || filename.starts_with(".DS_Store") {
            continue;
        }
        
        let tags = extract_tags(path);
        
        files.push(RawFileData {
            id: format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()),
            path: path.to_string_lossy().to_string(),
            filename,
            tags,
        });
    }
    
    Ok(files)
}

fn extract_tags(path: &Path) -> FileTags {
    use lofty::probe::Probe;
    use lofty::prelude::*;
    
    let tag = Probe::open(path)
        .ok()
        .and_then(|p| p.read().ok())
        .and_then(|t| t.primary_tag().cloned());
    
    FileTags {
        title: tag.as_ref().and_then(|t| t.title().map(|s| s.to_string())),
        artist: tag.as_ref().and_then(|t| t.artist().map(|s| s.to_string())),
        album: tag.as_ref().and_then(|t| t.album().map(|s| s.to_string())),
        album_artist: None,
        composer: None,
        genre: tag.as_ref().and_then(|t| t.genre().map(|s| s.to_string())),
        year: tag.as_ref().and_then(|t| t.year().map(|y| y.to_string())),
        track: None,
        comment: tag.as_ref().and_then(|t| t.comment().map(|s| s.to_string())),
    }
}
async fn process_groups_with_gpt(
    files: Vec<RawFileData>, 
    api_key: Option<String>,
    _skip_unchanged: bool,
    progress_callback: Option<Box<dyn Fn(crate::progress::ScanProgress) + Send + Sync>>
) -> Vec<BookGroup> {
    set_cancellation_flag(false);
    
    let total_files = files.len();
    let start_time = Instant::now();
   
    // ADD THIS LINE:
    crate::progress::set_total_files(total_files);
    
    let config = crate::config::load_config().ok();
    let max_workers = config.as_ref().map(|c| c.max_workers).unwrap_or(10);
    
    println!("🚀 Processing {} files with {} parallel workers...", total_files, max_workers);
    
    let mut folder_map: HashMap<String, Vec<RawFileData>> = HashMap::new();
    
    for file in files {
        let path = PathBuf::from(&file.path);
        let mut parent = path.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();
        
        parent = parent.replace("(book #", "(Book #").replace("(Book#", "(Book #");
        if !parent.ends_with(')') && parent.contains("Book #") {
            if let Some(pos) = parent.rfind(" - ") {
                parent = format!("{})", &parent[..pos]);
            }
        }
        if is_cancelled() {
            println!("🛑 Scan cancelled by user");
            break;
        }
        let _filename_lower = file.filename.to_lowercase();
        let parent_lower = parent.to_lowercase();
        
        let group_key = if parent_lower.contains("book #") || parent_lower.contains("book#") {
            if let Some(book_match) = parent_lower.split("book #").nth(1)
                .or_else(|| parent_lower.split("book#").nth(1)) {
                if let Some(book_num_end) = book_match.find(|c: char| !c.is_numeric() && c != ')') {
                    let book_id = &book_match[..book_num_end];
                    let base_parent = if let Some(pos) = parent.find("(Book #") {
                        parent[..pos].trim().to_string()
                    } else if let Some(pos) = parent.find("(book #") {
                        parent[..pos].trim().to_string()
                    } else {
                        parent.clone()
                    };
                    format!("{} (Book #{})", base_parent, book_id)
                } else {
                    parent.clone()
                }
            } else {
                parent.clone()
            }
        } else {
            parent.clone()
        };
        
        folder_map.entry(group_key).or_insert_with(Vec::new).push(file);
    }
    
    let mut groups = Vec::new();
    let mut group_id = 0;
    let total_groups = folder_map.len();
    let mut progress = crate::progress::ScanProgress::new(total_groups);
    let mut processed = 0;
    
    let series_groups: Vec<(String, Vec<RawFileData>)> = folder_map
    .iter()
    .filter(|(name, _)| {
        let lower = name.to_lowercase();
        lower.contains("book #") || lower.contains("book#") || lower.contains("(book ")
    })
    .map(|(k, v)| (k.clone(), v.clone()))
    .collect();

    // Collect keys BEFORE consuming series_groups
    let series_keys: std::collections::HashSet<_> = series_groups.iter().map(|(k, _)| k.clone()).collect();
// If we found multiple series books, process them all in parallel
if series_groups.len() > 5 {
    println!("🚀 Detected {} series books - processing in parallel", series_groups.len());
    
    let semaphore = Arc::new(Semaphore::new(max_workers));
    let mut handles = Vec::new();
    
    for (folder_name, folder_files) in series_groups {
        if is_cancelled() {
            break;
        }
        
        let api_key_clone = api_key.clone();
        let config_clone = config.clone();
        let sem = Arc::clone(&semaphore);
        
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            
            crate::progress::increment_progress(&folder_name);
            
            let sample_file = find_best_sample_file(&folder_files);
            
            println!("\n📖 Processing: {}", folder_name);
            
            let (book_title, book_author) = extract_book_info_with_gpt(
                sample_file,
                &folder_name,
                api_key_clone.as_deref()
            ).await;
            
            let audible_data = if let Some(ref cfg) = config_clone {
                if cfg.audible_enabled && !cfg.audible_cli_path.is_empty() {
                    crate::audible::search_audible(&book_title, &book_author, &cfg.audible_cli_path)
                        .await.ok().flatten()
                } else {
                    None
                }
            } else {
                None
            };
            
            let google_data = crate::metadata::fetch_from_google_books(&book_title, &book_author)
                .await.ok().flatten();
            
            let final_metadata = merge_all_with_gpt_retry(
                &folder_files,
                &folder_name,
                &book_title,
                &book_author,
                google_data,
                audible_data,
                api_key_clone.as_deref(),
                3
            ).await;
            
            (folder_name, folder_files, final_metadata)
        });
        
        handles.push(handle);
    }
    
    // Wait for all to complete
    for handle in handles {
        if is_cancelled() {
            break;
        }
        
        if let Ok((folder_name, folder_files, final_metadata)) = handle.await {
            let audio_files: Vec<AudioFile> = folder_files.iter().map(|f| {
                let mut changes = HashMap::new();
                
                if let Some(old_title) = &f.tags.title {
                    if old_title != &final_metadata.title {
                        changes.insert("title".to_string(), FieldChange {
                            old: old_title.clone(),
                            new: final_metadata.title.clone(),
                        });
                    }
                }
                
                if let Some(old_artist) = &f.tags.artist {
                    if old_artist != &final_metadata.author {
                        changes.insert("author".to_string(), FieldChange {
                            old: old_artist.clone(),
                            new: final_metadata.author.clone(),
                        });
                    }
                }
                
                if let Some(narrator) = &final_metadata.narrator {
                    changes.insert("narrator".to_string(), FieldChange {
                        old: f.tags.comment.clone().unwrap_or_default(),
                        new: format!("Narrated by {}", narrator),
                    });
                }
                
                if !final_metadata.genres.is_empty() {
                    let new_genre = final_metadata.genres.join(", ");
                    if let Some(old_genre) = &f.tags.genre {
                        if old_genre != &new_genre {
                            changes.insert("genre".to_string(), FieldChange {
                                old: old_genre.clone(),
                                new: new_genre,
                            });
                        }
                    } else {
                        changes.insert("genre".to_string(), FieldChange {
                            old: String::new(),
                            new: new_genre,
                        });
                    }
                }
                
                AudioFile {
                    id: f.id.clone(),
                    path: f.path.clone(),
                    filename: f.filename.clone(),
                    status: if changes.is_empty() { "unchanged" } else { "changed" }.to_string(),
                    changes,
                }
            }).collect();
            
            let total_changes = audio_files.iter().filter(|f| !f.changes.is_empty()).count();
            
            groups.push(BookGroup {
                id: group_id.to_string(),
                group_name: folder_name,
                group_type: GroupType::Chapters,
                files: audio_files,
                metadata: final_metadata,
                total_changes,
            });
            
            group_id += 1;
        }
    }
    // Remove processed series books from folder_map
    folder_map.retain(|k, _| !series_keys.contains(k));
}
let remaining_groups: Vec<_> = folder_map.into_iter().collect();

// Create cache instance for parallel processing
let cache = crate::cache::MetadataCache::new().ok();

if !remaining_groups.is_empty() {
    println!("🚀 Processing {} groups in parallel (max {} concurrent)", 
             remaining_groups.len(), max_workers);
    
    let semaphore = Arc::new(Semaphore::new(max_workers));
    let mut handles = Vec::new();
    
    for (folder_name, folder_files) in remaining_groups {
        if is_cancelled() {
            break;
        }
        
        let api_key_clone = api_key.clone();
        let config_clone = config.clone();
        let cache_clone = cache.clone();
        let sem = Arc::clone(&semaphore);
        let group_id_clone = group_id;
        group_id += 1;
        
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            
            crate::progress::increment_progress(&folder_name);
            
            let sample_file = find_best_sample_file(&folder_files);
            
            // Check if already processed
            let already_processed = is_already_processed(&sample_file.tags);
            
            if already_processed {
                let final_metadata = BookMetadata {
                    title: sample_file.tags.title.clone().unwrap_or_else(|| folder_name.clone()),
                    subtitle: None,
                    author: sample_file.tags.artist.clone().unwrap_or_else(|| "Unknown".to_string()),
                    narrator: sample_file.tags.comment.as_ref()
                        .and_then(|c| {
                            if c.starts_with("Narrated by ") {
                                Some(c.trim_start_matches("Narrated by ").to_string())
                            } else if c.starts_with("Read by ") {
                                Some(c.trim_start_matches("Read by ").to_string())
                            } else {
                                None
                            }
                        }),
                    series: None,
                    sequence: None,
                    genres: sample_file.tags.genre.as_ref()
                        .map(|g| g.split(',').map(|s| s.trim().to_string()).collect())
                        .unwrap_or_default(),
                    publisher: None,
                    year: sample_file.tags.year.clone(),
                    description: None,
                    isbn: None,
                };
                
                let audio_files: Vec<AudioFile> = folder_files.iter().map(|f| {
                    AudioFile {
                        id: f.id.clone(),
                        path: f.path.clone(),
                        filename: f.filename.clone(),
                        status: "unchanged".to_string(),
                        changes: HashMap::new(),
                    }
                }).collect();
                
                return (group_id_clone, folder_name, GroupType::Chapters, audio_files, final_metadata, 0);
            }
            
            // Check cache
            let quick_title = sample_file.tags.title.as_deref().unwrap_or(&folder_name);
            let quick_author = sample_file.tags.artist.as_deref().unwrap_or("Unknown");
            
            if let Some(ref cache_db) = cache_clone {
                if let Some(cached) = cache_db.get(quick_title, quick_author) {
                    let final_metadata = cached.final_metadata;
                    
                    let audio_files: Vec<AudioFile> = folder_files.iter().map(|f| {
                        let mut changes = HashMap::new();
                        
                        if let Some(old_title) = &f.tags.title {
                            if old_title != &final_metadata.title {
                                changes.insert("title".to_string(), FieldChange {
                                    old: old_title.clone(),
                                    new: final_metadata.title.clone(),
                                });
                            }
                        }
                        
                        if let Some(old_artist) = &f.tags.artist {
                            if old_artist != &final_metadata.author {
                                changes.insert("author".to_string(), FieldChange {
                                    old: old_artist.clone(),
                                    new: final_metadata.author.clone(),
                                });
                            }
                        }
                        
                        if let Some(narrator) = &final_metadata.narrator {
                            changes.insert("narrator".to_string(), FieldChange {
                                old: f.tags.comment.clone().unwrap_or_default(),
                                new: format!("Narrated by {}", narrator),
                            });
                        }
                        
                        if !final_metadata.genres.is_empty() {
                            let new_genre = final_metadata.genres.join(", ");
                            if let Some(old_genre) = &f.tags.genre {
                                if old_genre != &new_genre {
                                    changes.insert("genre".to_string(), FieldChange {
                                        old: old_genre.clone(),
                                        new: new_genre,
                                    });
                                }
                            } else {
                                changes.insert("genre".to_string(), FieldChange {
                                    old: String::new(),
                                    new: new_genre,
                                });
                            }
                        }
                        
                        AudioFile {
                            id: f.id.clone(),
                            path: f.path.clone(),
                            filename: f.filename.clone(),
                            status: if changes.is_empty() { "unchanged" } else { "changed" }.to_string(),
                            changes,
                        }
                    }).collect();
                    
                    let total_changes = audio_files.iter().filter(|f| !f.changes.is_empty()).count();
                    
                    return (group_id_clone, folder_name, GroupType::Chapters, audio_files, final_metadata, total_changes);
                }
            }
            
            // Full processing
            let (book_title, book_author) = extract_book_info_with_gpt(
                sample_file,
                &folder_name,
                api_key_clone.as_deref()
            ).await;
            
            let audible_data = if let Some(ref cfg) = config_clone {
                if cfg.audible_enabled && !cfg.audible_cli_path.is_empty() {
                    crate::audible::search_audible(&book_title, &book_author, &cfg.audible_cli_path)
                        .await.ok().flatten()
                } else {
                    None
                }
            } else {
                None
            };
            
            let google_data = crate::metadata::fetch_from_google_books(&book_title, &book_author)
                .await.ok().flatten();
            
            let final_metadata = merge_all_with_gpt_retry(
                &folder_files,
                &folder_name,
                &book_title,
                &book_author,
                google_data,
                audible_data,
                api_key_clone.as_deref(),
                3
            ).await;
            
            // Cache it
            if let Some(ref cache_db) = cache_clone {
                let _ = cache_db.set(&book_title, &book_author, crate::cache::CachedMetadata {
                    final_metadata: final_metadata.clone(),
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                });
            }
            
            let audio_files: Vec<AudioFile> = folder_files.iter().map(|f| {
                let mut changes = HashMap::new();
                
                if let Some(old_title) = &f.tags.title {
                    if old_title != &final_metadata.title {
                        changes.insert("title".to_string(), FieldChange {
                            old: old_title.clone(),
                            new: final_metadata.title.clone(),
                        });
                    }
                }
                
                if let Some(old_artist) = &f.tags.artist {
                    if old_artist != &final_metadata.author {
                        changes.insert("author".to_string(), FieldChange {
                            old: old_artist.clone(),
                            new: final_metadata.author.clone(),
                        });
                    }
                }
                
                if let Some(narrator) = &final_metadata.narrator {
                    changes.insert("narrator".to_string(), FieldChange {
                        old: f.tags.comment.clone().unwrap_or_default(),
                        new: format!("Narrated by {}", narrator),
                    });
                }
                
                if !final_metadata.genres.is_empty() {
                    let new_genre = final_metadata.genres.join(", ");
                    if let Some(old_genre) = &f.tags.genre {
                        if old_genre != &new_genre {
                            changes.insert("genre".to_string(), FieldChange {
                                old: old_genre.clone(),
                                new: new_genre,
                            });
                        }
                    } else {
                        changes.insert("genre".to_string(), FieldChange {
                            old: String::new(),
                            new: new_genre,
                        });
                    }
                }
                
                AudioFile {
                    id: f.id.clone(),
                    path: f.path.clone(),
                    filename: f.filename.clone(),
                    status: if changes.is_empty() { "unchanged" } else { "changed" }.to_string(),
                    changes,
                }
            }).collect();
            
            let total_changes = audio_files.iter().filter(|f| !f.changes.is_empty()).count();
            
            (group_id_clone, folder_name, GroupType::Chapters, audio_files, final_metadata, total_changes)
        });
        
        handles.push(handle);
    }
    
    // Collect results
    for handle in handles {
        if is_cancelled() {
            break;
        }
        
        if let Ok((id, name, group_type, files, metadata, total_changes)) = handle.await {
            groups.push(BookGroup {
                id: id.to_string(),
                group_name: name,
                group_type,
                files,
                metadata,
                total_changes,
            });
        }
    }
}

groups.sort_by(|a, b| a.group_name.cmp(&b.group_name));

let elapsed = start_time.elapsed();
let rate = total_files as f64 / elapsed.as_secs_f64();
println!("\n⚡ Performance: {:.1} files/sec, total time: {:?}", rate, elapsed);

    groups
}
// Add this function before extract_book_info_with_gpt
fn find_best_sample_file(files: &[RawFileData]) -> &RawFileData {
    for file in files {
        if let Some(title) = &file.tags.title {
            let lower = title.to_lowercase();
            if lower.starts_with("track") || 
               lower.starts_with("chapter") || 
               lower.starts_with("part") ||
               lower.chars().filter(|c| c.is_numeric()).count() > 3 {
                continue;
            }
            if title.len() > 10 {
                return file;
            }
        }
    }
    &files[0]
}

fn extract_book_number_from_folder(folder_name: &str) -> Option<String> {
    use regex::Regex;
    
    let patterns = [
        r"(?i)\(Book\s*#?(\d+)\)",
        r"(?i)\[Book\s*#?(\d+)\]",
        r"(?i)Book\s*#?(\d+)",
        r"(?i)#(\d+)",
    ];
    
    for pattern in &patterns {
        if let Ok(re) = Regex::new(pattern) {
            if let Some(caps) = re.captures(folder_name) {
                if let Some(num) = caps.get(1) {
                    return Some(num.as_str().to_string());
                }
            }
        }
    }
    
    None
}

async fn extract_book_info_with_gpt(
    sample_file: &RawFileData,
    folder_name: &str,
    api_key: Option<&str>
) -> (String, String) {
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            return (
                sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
                sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
            );
        }
    };
    
    let clean_title = sample_file.tags.title.as_ref()
        .map(|t| t.replace(" - Part 1", "").replace(" - Part 2", "").trim().to_string());
    let clean_artist = sample_file.tags.artist.as_ref()
        .map(|a| a.to_string());
    
    let book_number = extract_book_number_from_folder(folder_name);
    let book_hint = if let Some(num) = &book_number {
        format!("\nBOOK NUMBER DETECTED: This is Book #{} in a series", num)
    } else {
        String::new()
    };
    
    let prompt = format!(

r#"You are extracting the actual book title and author from audiobook tags.

FOLDER NAME: {}
FILENAME: {}
FILE TAGS:
* Title: {:?}
* Artist: {:?}
* Album: {:?}{}

PRIMARY RULES:
1. Ignore titles that are generic such as Track 01, Chapter 1, Part 1.
2. Prefer the folder name or album field when the title tag is generic or incomplete.
3. If the folder or filename includes a series marker like (Book #39), use the number to identify the specific book title.
4. Always output the specific book title, not only the series name.
5. Remove all track numbers, chapter numbers, punctuation clutter, and formatting noise.

CORRECT TITLE EXTRACTION:
The title must be the specific book name only. Remove all series markers including (Book #X), Book X, #X:, and any series name inside parentheses.

Examples:
* "Magic Tree House #46: Dogs In The Dead Of Night" → "Dogs in the Dead of Night"
* "Hi, Jack? (The Magic Tree House, Book 28)" → "High Time for Heroes"
* "The Magic Tree House: Book 51" → use folder or album if it contains the real title

ADDITIONAL LOGIC:
If the title tag contains only a series name or a placeholder, rely on folder or album fields to determine the true book title.

Return only valid JSON:
{{"book_title":"specific book title","author":"author name"}}

JSON:"#,
        folder_name,
        sample_file.filename,
        clean_title,
        clean_artist,
        sample_file.tags.album,
        book_hint
    );
    
    for attempt in 1..=2 {
        match call_gpt_extract_book_info(&prompt, api_key).await {
            Ok(json_str) => {
                match serde_json::from_str::<serde_json::Value>(&json_str) {
                    Ok(json) => {
                        let title = json["book_title"].as_str()
                            .unwrap_or(&sample_file.tags.title.as_deref().unwrap_or(folder_name))
                            .to_string();
                        let author = json["author"].as_str()
                            .unwrap_or(&sample_file.tags.artist.as_deref().unwrap_or("Unknown"))
                            .to_string();
                        
                        if title.to_lowercase().contains("track") || 
                           title.to_lowercase().contains("chapter") ||
                           title.to_lowercase().contains("part") {
                            if attempt == 2 {
                                return (folder_name.to_string(), author);
                            }
                            continue;
                        }
                        
                        return (title, author);
                    }
                    Err(_) => {
                        if attempt == 2 {
                            return (
                                sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
                                sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
                            );
                        }
                    }
                }
            }
            Err(e) => {
                println!("   ⚠️  GPT extraction error (attempt {}): {}", attempt, e);
                if attempt == 2 {
                    return (
                        sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
                        sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
                    );
                }
            }
        }
    }
    
    (
        sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
        sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
    )
}

async fn merge_all_with_gpt(
    files: &[RawFileData],
    folder_name: &str,
    extracted_title: &str,
    extracted_author: &str,
    google_data: Option<crate::metadata::BookMetadata>,
    audible_data: Option<crate::audible::AudibleMetadata>,
    api_key: Option<&str>
) -> BookMetadata {
    let sample_comments: Vec<String> = files.iter()
        .filter_map(|f| f.tags.comment.clone())
        .collect();
    
    // PRE-EXTRACT reliable year from sources (don't let GPT override this)
    let reliable_year = audible_data.as_ref()
        .and_then(|d| d.release_date.clone())
        .and_then(|date| {
            // Extract just the year from date strings like "2021-01-02"
            date.split('-').next().map(|s| s.to_string())
        })
        .or_else(|| {
            google_data.as_ref()
                .and_then(|d| d.publish_date.clone())
                .and_then(|date| {
                    date.split('-').next().map(|s| s.to_string())
                })
        });
    
    let google_summary = if let Some(ref data) = google_data {
        format!(
            "Title: {:?}, Authors: {:?}, Publisher: {:?}, Date: {:?}",
            data.title, data.authors, data.publisher, data.publish_date
        )
    } else {
        "No data".to_string()
    };
    
    let audible_summary = if let Some(ref data) = audible_data {
        format!(
            "Title: {:?}, Authors: {:?}, Narrators: {:?}, Series: {:?}, Publisher: {:?}, Release Date: {:?}, ASIN: {:?}",
            data.title, data.authors, data.narrators, data.series, data.publisher, data.release_date, data.asin
        )
    } else {
        "No data".to_string()
    };
    
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            return BookMetadata {
                title: extracted_title.to_string(),
                subtitle: None,
                author: extracted_author.to_string(),
                narrator: None,
                series: None,
                sequence: None,
                genres: vec![],
                publisher: google_data.as_ref().and_then(|d| d.publisher.clone()),
                year: reliable_year,
                description: google_data.as_ref().and_then(|d| d.description.clone()),
                isbn: None,
            };
        }
    };
    
    let year_instruction = if let Some(ref year) = reliable_year {
        format!("CRITICAL: Use EXACTLY this year: {} (from Audible/Google Books - DO NOT CHANGE)", year)
    } else {
        "year: If not found in sources, return null".to_string()
    };
    
    let prompt = format!(
r#"
You are an audiobook metadata specialist. Combine information from all sources to produce the most accurate metadata.

SOURCES:
1. Folder: {}
2. Extracted from tags: title='{}', author='{}'
3. Google Books: {}
4. Audible: {}
5. Sample comments: {:?}
6. Filename hint: Use folder or filename to detect series information

SERIES RULES:
If the folder or filename includes patterns like Book 01 or War of the Roses 01, extract the series name and the book number.

APPROVED GENRES (maximum 3, comma separated):
{}

OUTPUT FIELDS:
* title: Book title only. Remove junk and remove all series markers.
* subtitle: Use only if provided by Google Books or Audible.
* author: Clean and standardized.
* narrator: Use Audible narrators or find in comments.
* series: Extract from filename or folder if present.
* sequence: Extract book number from any source including patterns like 01 or 02.
* genres: Select one to three from the approved list. If the book is for children, always include "Children's" from the approved list.
* publisher: Prefer Google Books or Audible.
* {}
* description: Short description from Google Books or Audible, minimum length 200 characters.
* isbn: From Google Books.

TITLE RULES:
The title must contain only the specific book title. Remove all series indicators such as Book X, Book #X, #X:, or any series name in parentheses.

Correct examples:
* "Night of the Ninjas"
* "Dogs in the Dead of Night"
* "High Time for Heroes"

Incorrect examples:
* "Magic Tree House #46: Dogs in the Dead of Night"
* "The Magic Tree House: Book 51"
* "Hi, Jack? (The Magic Tree House)"

Return ONLY valid JSON:
{{
  "title": "specific book title",
  "subtitle": null,
  "author": "author name",
  "narrator": "narrator name or null",
  "series": "series name or null",
  "sequence": "book number or null",
  "genres": ["Genre1", "Genre2"],
  "publisher": "publisher or null",
  "year": "YYYY or null",
  "description": "description or null",
  "isbn": "isbn or null"
}}

JSON:"#,
        folder_name,
        extracted_title,
        extracted_author,
        google_summary,
        audible_summary,
        sample_comments,
        crate::genres::APPROVED_GENRES.join(", "),
        year_instruction
    );
    
    match call_gpt_merge_metadata(&prompt, api_key).await {
        Ok(json_str) => {
            match serde_json::from_str::<BookMetadata>(&json_str) {
                Ok(mut metadata) => {
                    // FORCE the reliable year back in (in case GPT changed it)
                    if let Some(year) = reliable_year {
                        metadata.year = Some(year);
                    }
                    
                    println!("   ✅ Final: title='{}', author='{}', narrator={:?}", 
                        metadata.title, metadata.author, metadata.narrator);
                    println!("            genres={:?}, publisher={:?}, year={:?}",
                        metadata.genres, metadata.publisher, metadata.year);
                    metadata
                }
                Err(e) => {
                    println!("   ⚠️  GPT parse error: {}", e);
                    println!("   ⚠️  Using fallback with available data");
                    
                    BookMetadata {
                        title: extracted_title.to_string(),
                        subtitle: google_data.as_ref().and_then(|d| d.subtitle.clone()),
                        author: extracted_author.to_string(),
                        narrator: audible_data.as_ref()
                            .and_then(|d| d.narrators.first().cloned()),
                        series: audible_data.as_ref()
                            .and_then(|d| d.series.first().map(|s| s.name.clone())),
                        sequence: audible_data.as_ref()
                            .and_then(|d| d.series.first().and_then(|s| s.position.clone())),
                        genres: google_data.as_ref()
                            .map(|d| d.genres.clone())
                            .unwrap_or_default(),
                        publisher: google_data.as_ref().and_then(|d| d.publisher.clone())
                            .or_else(|| audible_data.as_ref().and_then(|d| d.publisher.clone())),
                        year: reliable_year,
                        description: google_data.as_ref().and_then(|d| d.description.clone())
                            .or_else(|| audible_data.as_ref().and_then(|d| d.description.clone())),
                        isbn: google_data.as_ref()
                            .and_then(|d| d.isbn.clone()),
                    }
                }
            }
        }
        Err(e) => {
            println!("   ⚠️  GPT merge error: {}", e);
            println!("   ⚠️  Using fallback with available data");
            
            BookMetadata {
                title: extracted_title.to_string(),
                subtitle: google_data.as_ref().and_then(|d| d.subtitle.clone()),
                author: extracted_author.to_string(),
                narrator: audible_data.as_ref()
                    .and_then(|d| d.narrators.first().cloned()),
                series: audible_data.as_ref()
                    .and_then(|d| d.series.first().map(|s| s.name.clone())),
                sequence: audible_data.as_ref()
                    .and_then(|d| d.series.first().and_then(|s| s.position.clone())),
                genres: google_data.as_ref()
                    .map(|d| d.genres.clone())
                    .unwrap_or_default(),
                publisher: google_data.as_ref().and_then(|d| d.publisher.clone())
                    .or_else(|| audible_data.as_ref().and_then(|d| d.publisher.clone())),
                year: reliable_year,
                description: google_data.as_ref().and_then(|d| d.description.clone())
                    .or_else(|| audible_data.as_ref().and_then(|d| d.description.clone())),
                isbn: google_data.as_ref()
                    .and_then(|d| d.isbn.clone()),
            }
        }
    }
}

async fn call_gpt_extract_book_info(prompt: &str, api_key: &str) -> Result<String> {
    let client = reqwest::Client::new();
    
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": "gpt-5-nano",
            "messages": [
                {
                    "role": "system",
                    "content": "Extract book info. Return JSON: {\"book_title\":\"...\",\"author\":\"...\"}"
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "max_completion_tokens": 300,
            "verbosity": "low",
            "reasoning_effort": "minimal"
        }))
        .send()
        .await?;
    
    let status = response.status();
    let response_text = response.text().await?;
    
    if !status.is_success() {
        println!("             ❌ API Error ({}): {}", status, response_text);
        anyhow::bail!("API returned status {}: {}", status, response_text);
    }
    
    parse_gpt_response(&response_text)
}

async fn call_gpt_merge_metadata(prompt: &str, api_key: &str) -> Result<String> {
    let client = reqwest::Client::new();
    
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": "gpt-5-nano",
            "messages": [
                {
                    "role": "system",
                    "content": "You are an audiobook metadata expert. Return valid JSON only."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "max_completion_tokens": 4000,
            "verbosity": "low",
            "reasoning_effort": "minimal"
        }))
        .send()
        .await?;
    
    let status = response.status();
    let response_text = response.text().await?;
    
    if !status.is_success() {
        println!("             ❌ API Error ({}): {}", status, response_text);
        anyhow::bail!("API returned status {}: {}", status, response_text);
    }
    
    parse_gpt_response(&response_text)
}

fn parse_gpt_response(response_text: &str) -> Result<String> {
    println!("             🔍 DEBUG: Raw API response (first 500 chars): {}", &response_text[..response_text.len().min(500)]);
    
    #[derive(serde::Deserialize)]
    struct Response {
        choices: Vec<Choice>,
    }
    
    #[derive(serde::Deserialize)]
    struct Choice {
        message: Message,
    }
    
    #[derive(serde::Deserialize)]
    struct Message {
        content: String,
    }
    
    let result: Response = serde_json::from_str(response_text)?;
    
    println!("             🔍 DEBUG: Number of choices: {}", result.choices.len());
    
    let content = result.choices.first()
        .ok_or_else(|| anyhow::anyhow!("No choices"))?
        .message.content.trim();
    
    println!("             🔍 DEBUG: Content length: {}, Content preview: {}", content.len(), &content[..content.len().min(100)]);
    
    if content.is_empty() {
        anyhow::bail!("GPT returned empty content");
    }
    
    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    
    println!("             🔍 DEBUG: Final JSON (first 200 chars): {}", &json_str[..json_str.len().min(200)]);
    
    Ok(json_str.to_string())
}

fn detect_group_type(files: &[RawFileData]) -> GroupType {
    if files.len() == 1 {
        return GroupType::Single;
    }
    
    let filenames: Vec<String> = files.iter().map(|f| f.filename.to_lowercase()).collect();
    
    let has_chapter_indicators = filenames.iter().any(|name| {
        name.contains(" ch ") || name.contains(" ch.") ||
        name.contains("chapter") || 
        name.contains("track") ||
        name.contains("part ") ||
        name.contains("disc") ||
        name.starts_with("01 ") || name.starts_with("02 ") || name.starts_with("03 ") ||
        name.starts_with("1 ") || name.starts_with("2 ") || name.starts_with("3 ") ||
        name.starts_with("01-") || name.starts_with("02-") || name.starts_with("03-") ||
        name.starts_with("001 ") || name.starts_with("002 ") || name.starts_with("003 ")
    });
    
    let all_same_title = files.iter()
        .filter_map(|f| f.tags.title.as_ref())
        .collect::<std::collections::HashSet<_>>()
        .len() == 1;
    
    if has_chapter_indicators || all_same_title {
        return GroupType::Chapters;
    }
    
    if files.len() > 5 {
        return GroupType::Chapters;
    }
    
    GroupType::Chapters
}
// ============================================================================
// RETRY LOGIC WITH QUALITY VALIDATION
// ============================================================================

async fn merge_all_with_gpt_retry(
    files: &[RawFileData],
    folder_name: &str,
    extracted_title: &str,
    extracted_author: &str,
    google_data: Option<crate::metadata::BookMetadata>,
    audible_data: Option<crate::audible::AudibleMetadata>,
    api_key: Option<&str>,
    max_retries: u32,
) -> BookMetadata {
    for attempt in 1..=max_retries {
        if attempt > 1 {
            println!("   🔄 Retry attempt {}/{}", attempt, max_retries);
        }
        
        let metadata = merge_all_with_gpt(
            files,
            folder_name,
            extracted_title,
            extracted_author,
            google_data.clone(),
            audible_data.clone(),
            api_key
        ).await;
        
        let quality_score = validate_metadata_quality(&metadata, extracted_title, &audible_data);
        
        if quality_score >= 80 {
            println!("   ✅ Quality: {}% - PASSED", quality_score);
            return metadata;
        } else {
            println!("   ⚠️  Quality: {}% - RETRY", quality_score);
        }
    }
    
    println!("   ⚠️  All retries exhausted, using last result");
    merge_all_with_gpt(files, folder_name, extracted_title, extracted_author, google_data, audible_data, api_key).await
}

fn validate_metadata_quality(
    metadata: &BookMetadata,
    extracted_title: &str,
    audible_data: &Option<crate::audible::AudibleMetadata>,
) -> u32 {
    let mut score = 0;
    
    // Title must include the extracted title (e.g., "Dinosaurs Before Dark")
    if metadata.title.contains(extracted_title) {
        score += 30;
    } else {
        println!("      ❌ Title doesn't contain '{}'", extracted_title);
    }
    
    // Narrator must exist if Audible has it
    if let Some(aud) = audible_data {
        if !aud.narrators.is_empty() {
            if metadata.narrator.is_some() {
                score += 20;
            } else {
                println!("      ❌ Missing narrator (Audible has: {:?})", aud.narrators);
            }
        }
    }
    
    // Description should exist and be substantial
    if let Some(ref desc) = metadata.description {
        if desc.len() >= 100 && desc.len() <= 1000 {
            score += 20;
        }
    }
    
    // Genres should be valid
    if !metadata.genres.is_empty() && metadata.genres.len() <= 3 {
        score += 15;
    }
    
    // Series/sequence should match if present
    if metadata.series.is_some() && metadata.sequence.is_some() {
        score += 10;
    }
    
    // Has publication info
    if metadata.publisher.is_some() || metadata.year.is_some() {
        score += 5;
    }
    
    score
}
