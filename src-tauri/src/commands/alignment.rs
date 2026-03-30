//! Tauri commands for audio-text alignment (Immersion Sync).

use crate::alignment::aeneas::AeneasAligner;
use crate::alignment::queue::{AlignmentJob, AlignmentQueue, JobStatus, QueueStats};
use crate::alignment::{
    export_srt, export_vtt, match_chapters, AlignedFragment, AlignmentGranularity,
    AlignmentOptions, BookAlignment, ChapterAlignment,
};
use crate::chapters::get_chapters;
use crate::config::Config;
use crate::epub::{parse_epub, preview_epub, EpubChapter, EpubPreview};
use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

// ============================================================================
// STATE
// ============================================================================

/// Global alignment queue state
pub struct AlignmentState {
    queue: Mutex<Option<AlignmentQueue>>,
}

impl AlignmentState {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(None),
        }
    }

    fn get_queue(&self, config: &Config) -> Result<std::sync::MutexGuard<Option<AlignmentQueue>>> {
        let mut guard = self.queue.lock().unwrap();

        if guard.is_none() {
            let db_path = get_queue_db_path(config)?;
            *guard = Some(AlignmentQueue::open(&db_path)?);
        }

        Ok(guard)
    }
}

impl Default for AlignmentState {
    fn default() -> Self {
        Self::new()
    }
}

fn get_queue_db_path(config: &Config) -> Result<PathBuf> {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("audiobook-tagger");

    std::fs::create_dir_all(&data_dir)?;
    Ok(data_dir.join("alignment_queue.db"))
}

// ============================================================================
// EPUB COMMANDS
// ============================================================================

/// Preview an EPUB file structure
#[tauri::command]
pub async fn preview_epub_file(path: String) -> Result<EpubPreview, String> {
    preview_epub(&path).map_err(|e| e.to_string())
}

/// Parse an EPUB and get full chapter content
#[tauri::command]
pub async fn parse_epub_file(path: String) -> Result<Vec<EpubChapterInfo>, String> {
    let content = parse_epub(&path).map_err(|e| e.to_string())?;

    Ok(content
        .chapters
        .into_iter()
        .map(|c| EpubChapterInfo {
            index: c.index,
            title: c.title,
            word_count: c.word_count,
            text_preview: c.text.chars().take(200).collect(),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapterInfo {
    pub index: usize,
    pub title: String,
    pub word_count: usize,
    pub text_preview: String,
}

// ============================================================================
// LIBRARY SCANNING
// ============================================================================

/// Book eligible for alignment (has both audio and ebook)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EligibleBook {
    pub id: String,
    pub library_id: String,
    pub title: String,
    pub author: String,
    pub has_audio: bool,
    pub has_ebook: bool,
}

/// Scan ABS library for books eligible for alignment
#[tauri::command]
pub async fn scan_library_for_alignment(
    config: State<'_, Mutex<Config>>,
) -> Result<Vec<EligibleBook>, String> {
    let config = config.lock().unwrap().clone();

    if config.abs_base_url.is_empty() || config.abs_api_token.is_empty() {
        return Err("AudiobookShelf not configured".to_string());
    }

    let client = reqwest::Client::new();

    // Get all libraries
    let libraries_url = format!("{}/api/libraries", config.abs_base_url);
    let libraries_resp = client
        .get(&libraries_url)
        .header("Authorization", format!("Bearer {}", config.abs_api_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch libraries: {}", e))?;

    #[derive(Deserialize)]
    struct LibrariesResponse {
        libraries: Vec<LibraryInfo>,
    }

    #[derive(Deserialize)]
    struct LibraryInfo {
        id: String,
        name: String,
    }

    let libraries: LibrariesResponse = libraries_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse libraries: {}", e))?;

    let mut eligible_books = Vec::new();

    // Scan each library
    for library in libraries.libraries {
        // Get items with expanded media info
        let items_url = format!(
            "{}/api/libraries/{}/items?expanded=1&limit=500",
            config.abs_base_url, library.id
        );

        let items_resp = client
            .get(&items_url)
            .header("Authorization", format!("Bearer {}", config.abs_api_token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch items: {}", e))?;

        #[derive(Deserialize)]
        struct ItemsResponse {
            results: Vec<LibraryItem>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LibraryItem {
            id: String,
            media: Option<MediaInfo>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct MediaInfo {
            metadata: Option<MediaMetadata>,
            audio_files: Option<Vec<serde_json::Value>>,
            ebook_file: Option<serde_json::Value>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct MediaMetadata {
            title: Option<String>,
            author_name: Option<String>,
        }

        let items: ItemsResponse = items_resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse items: {}", e))?;

        for item in items.results {
            if let Some(media) = item.media {
                let has_audio = media
                    .audio_files
                    .as_ref()
                    .map(|f| !f.is_empty())
                    .unwrap_or(false);
                let has_ebook = media.ebook_file.is_some();

                // Only include books with both audio AND ebook
                if has_audio && has_ebook {
                    let metadata = media.metadata.unwrap_or(MediaMetadata {
                        title: None,
                        author_name: None,
                    });

                    eligible_books.push(EligibleBook {
                        id: item.id,
                        library_id: library.id.clone(),
                        title: metadata.title.unwrap_or_else(|| "Unknown".to_string()),
                        author: metadata.author_name.unwrap_or_else(|| "Unknown".to_string()),
                        has_audio,
                        has_ebook,
                    });
                }
            }
        }
    }

    Ok(eligible_books)
}

// ============================================================================
// ALIGNMENT STATUS
// ============================================================================

/// Check if Aeneas is available
#[tauri::command]
pub async fn check_aeneas_available() -> bool {
    AeneasAligner::is_available()
}

/// Get alignment system status
#[tauri::command]
pub async fn get_alignment_status(
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<AlignmentStatus, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let stats = queue_guard
        .as_ref()
        .map(|q| q.get_stats())
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(QueueStats {
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            total_alignments: 0,
        });

    Ok(AlignmentStatus {
        aeneas_available: AeneasAligner::is_available(),
        queue_stats: stats,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentStatus {
    pub aeneas_available: bool,
    pub queue_stats: QueueStats,
}

// ============================================================================
// QUEUE COMMANDS
// ============================================================================

/// Add a book to the alignment queue
#[tauri::command]
pub async fn queue_alignment(
    book_id: String,
    library_id: String,
    title: String,
    author: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<String, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    // Check if job already exists
    if queue
        .job_exists_for_book(&book_id)
        .map_err(|e| e.to_string())?
    {
        return Err("Job already exists for this book".to_string());
    }

    let job = AlignmentJob::new(book_id, library_id, title, author);
    let job_id = job.id.clone();

    queue.insert_job(&job).map_err(|e| e.to_string())?;

    Ok(job_id)
}

/// Queue multiple books for alignment
#[tauri::command]
pub async fn queue_alignment_batch(
    books: Vec<BookToAlign>,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<Vec<String>, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    let mut job_ids = Vec::new();

    for book in books {
        // Skip if job already exists
        if queue
            .job_exists_for_book(&book.book_id)
            .map_err(|e| e.to_string())?
        {
            continue;
        }

        let job = AlignmentJob::new(book.book_id, book.library_id, book.title, book.author);
        let job_id = job.id.clone();

        queue.insert_job(&job).map_err(|e| e.to_string())?;
        job_ids.push(job_id);
    }

    Ok(job_ids)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookToAlign {
    pub book_id: String,
    pub library_id: String,
    pub title: String,
    pub author: String,
}

/// Get all jobs in the queue
#[tauri::command]
pub async fn get_alignment_jobs(
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<Vec<AlignmentJob>, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    queue.get_all_jobs().map_err(|e| e.to_string())
}

/// Get a specific job
#[tauri::command]
pub async fn get_alignment_job(
    job_id: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<Option<AlignmentJob>, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    queue.get_job(&job_id).map_err(|e| e.to_string())
}

/// Cancel a pending job
#[tauri::command]
pub async fn cancel_alignment_job(
    job_id: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<(), String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    if let Some(mut job) = queue.get_job(&job_id).map_err(|e| e.to_string())? {
        if job.status == JobStatus::Pending {
            job.status = JobStatus::Cancelled;
            queue.update_job(&job).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// Retry a failed job
#[tauri::command]
pub async fn retry_alignment_job(
    job_id: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<(), String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    if let Some(mut job) = queue.get_job(&job_id).map_err(|e| e.to_string())? {
        if job.can_retry() {
            job.retry();
            queue.update_job(&job).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// Clear completed/cancelled jobs
#[tauri::command]
pub async fn clear_completed_jobs(
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<usize, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    queue.clear_completed().map_err(|e| e.to_string())
}

// ============================================================================
// ALIGNMENT RESULTS
// ============================================================================

/// Get alignment data for a book
#[tauri::command]
pub async fn get_book_alignment(
    book_id: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<Option<BookAlignment>, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    queue.get_alignment(&book_id).map_err(|e| e.to_string())
}

/// Check if a book has alignment data
#[tauri::command]
pub async fn has_alignment(
    book_id: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<bool, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    queue.has_alignment(&book_id).map_err(|e| e.to_string())
}

/// Export alignment as VTT
#[tauri::command]
pub async fn export_alignment_vtt(
    book_id: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<String, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    let alignment = queue
        .get_alignment(&book_id)
        .map_err(|e| e.to_string())?
        .ok_or("No alignment found for this book")?;

    Ok(export_vtt(&alignment))
}

/// Export alignment as SRT
#[tauri::command]
pub async fn export_alignment_srt(
    book_id: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<String, String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    let alignment = queue
        .get_alignment(&book_id)
        .map_err(|e| e.to_string())?
        .ok_or("No alignment found for this book")?;

    Ok(export_srt(&alignment))
}

/// Delete alignment data for a book
#[tauri::command]
pub async fn delete_book_alignment(
    book_id: String,
    config: State<'_, Mutex<Config>>,
    alignment_state: State<'_, AlignmentState>,
) -> Result<(), String> {
    let config = config.lock().unwrap().clone();
    let queue_guard = alignment_state
        .get_queue(&config)
        .map_err(|e| e.to_string())?;

    let queue = queue_guard.as_ref().ok_or("Queue not initialized")?;

    queue
        .delete_alignment(&book_id)
        .map_err(|e| e.to_string())
}

// ============================================================================
// DIRECT ALIGNMENT (for testing/single book)
// ============================================================================

/// Run alignment on local files (for testing)
#[tauri::command]
pub async fn align_local_files(
    audio_path: String,
    epub_path: String,
    options: AlignmentOptions,
) -> Result<BookAlignment, String> {
    // Parse EPUB
    let epub_content = parse_epub(&epub_path).map_err(|e| format!("EPUB parse error: {}", e))?;

    // Get audio chapters
    let audio_chapters =
        get_chapters(&audio_path).map_err(|e| format!("Audio chapter error: {}", e))?;

    // Match chapters
    let matched = match_chapters(
        &audio_chapters.chapters,
        &epub_content.chapters,
        &epub_content.full_text,
    );

    // Initialize Aeneas
    let aligner = AeneasAligner::new(&options.language, options.granularity)
        .map_err(|e| format!("Aeneas init error: {}", e))?;

    // Align each chapter
    let mut chapter_alignments = Vec::new();
    let audio_path = std::path::Path::new(&audio_path);

    for chapter in &matched {
        log::info!("Aligning chapter: {}", chapter.title);

        // For now, create fragment from the whole chapter text
        // Full word-level alignment would extract audio segment and run Aeneas
        let fragments = vec![AlignedFragment {
            id: format!("f{}", chapter.index),
            begin: chapter.audio_start,
            end: chapter.audio_end,
            text: chapter.text.clone(),
            words: Vec::new(),
        }];

        chapter_alignments.push(ChapterAlignment {
            index: chapter.index,
            title: chapter.title.clone(),
            audio_start: chapter.audio_start,
            audio_end: chapter.audio_end,
            text_start_char: chapter.text_start_char,
            text_end_char: chapter.text_end_char,
            fragments,
        });
    }

    let total_duration = matched.last().map(|c| c.audio_end).unwrap_or(0.0);

    let author = epub_content
        .metadata
        .authors
        .first()
        .cloned()
        .unwrap_or_default();

    Ok(BookAlignment {
        book_id: "local".to_string(),
        title: epub_content
            .metadata
            .title
            .unwrap_or_else(|| "Unknown".to_string()),
        author,
        language: options.language,
        granularity: options.granularity,
        total_duration,
        chapters: chapter_alignments,
        created_at: Utc::now(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
