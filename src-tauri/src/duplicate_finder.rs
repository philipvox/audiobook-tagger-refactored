// src-tauri/src/duplicate_finder.rs
// Find duplicate audiobooks in the library using multiple detection methods

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::fs;

/// A group of duplicate books
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateGroup {
    pub id: String,
    pub match_type: MatchType,
    pub confidence: f64,  // 0.0 to 1.0
    pub books: Vec<DuplicateBook>,
    pub recommended_keep: Option<String>,  // folder_path of recommended book to keep
}

/// Information about a potential duplicate book
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateBook {
    pub folder_path: String,
    pub title: String,
    pub author: String,
    pub narrator: Option<String>,
    pub duration_seconds: Option<u64>,
    pub file_count: usize,
    pub total_size_bytes: u64,
    pub has_cover: bool,
    pub cover_path: Option<String>,  // Full path to cover image
    pub has_metadata_file: bool,
    pub quality_score: f64,  // Higher is better
    pub audio_format: Option<String>,  // mp3, m4b, etc.
    pub in_correct_folder: bool,  // Is the book in a folder matching its author?
}

/// How the duplicates were detected
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MatchType {
    ExactTitle,           // Exact title match (after normalization)
    SimilarTitle,         // Fuzzy title match (>85% similarity)
    SameAsin,             // Same ASIN
    SameIsbn,             // Same ISBN
    AudioFingerprint,     // Audio content fingerprinting
    DurationAndTitle,     // Same duration + similar title
}

/// Scan options for duplicate detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateScanOptions {
    pub check_exact_titles: bool,
    pub check_similar_titles: bool,
    pub check_asin: bool,
    pub check_duration: bool,
    pub similarity_threshold: f64,  // For fuzzy matching (0.0 to 1.0)
    pub duration_tolerance_seconds: u64,  // How close durations must be
}

impl Default for DuplicateScanOptions {
    fn default() -> Self {
        Self {
            check_exact_titles: true,
            check_similar_titles: true,
            check_asin: true,
            check_duration: true,
            similarity_threshold: 0.85,
            duration_tolerance_seconds: 60,  // 1 minute tolerance
        }
    }
}

/// Scan result summary
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateScanResult {
    pub duplicate_groups: Vec<DuplicateGroup>,
    pub total_books_scanned: usize,
    pub total_duplicates_found: usize,
    pub potential_space_savings_bytes: u64,
}

/// Internal book data for comparison
#[derive(Debug, Clone)]
struct BookData {
    folder_path: String,
    title: String,
    title_normalized: String,
    author: String,
    author_normalized: String,
    narrator: Option<String>,
    asin: Option<String>,
    isbn: Option<String>,
    duration_seconds: Option<u64>,
    file_count: usize,
    total_size_bytes: u64,
    has_cover: bool,
    cover_path: Option<String>,
    has_metadata_file: bool,
    audio_format: Option<String>,
}

/// Scan a library path for duplicates
pub fn scan_for_duplicates(
    library_path: &str,
    options: &DuplicateScanOptions,
) -> Result<DuplicateScanResult, String> {
    println!("🔍 Scanning for duplicates in: {}", library_path);

    let library_dir = Path::new(library_path);
    if !library_dir.exists() {
        return Err(format!("Library path does not exist: {}", library_path));
    }

    // Collect all book folders
    let books = collect_book_folders(library_path)?;
    println!("📚 Found {} book folders", books.len());

    let mut duplicate_groups: Vec<DuplicateGroup> = Vec::new();
    let mut processed_pairs: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    // Check for exact title matches
    if options.check_exact_titles {
        let groups = find_exact_title_matches(&books, &mut processed_pairs);
        duplicate_groups.extend(groups);
    }

    // Check for similar title matches
    if options.check_similar_titles {
        let groups = find_similar_title_matches(&books, options.similarity_threshold, &mut processed_pairs);
        duplicate_groups.extend(groups);
    }

    // Check for ASIN matches
    if options.check_asin {
        let groups = find_asin_matches(&books, &mut processed_pairs);
        duplicate_groups.extend(groups);
    }

    // Check for duration + title matches
    if options.check_duration {
        let groups = find_duration_matches(&books, options.duration_tolerance_seconds, &mut processed_pairs);
        duplicate_groups.extend(groups);
    }

    // Calculate statistics
    let total_duplicates = duplicate_groups.iter()
        .map(|g| g.books.len() - 1)  // -1 because one is the "original"
        .sum();

    let potential_savings: u64 = duplicate_groups.iter()
        .map(|g| {
            // Sum sizes of all but the largest/best quality book
            let mut sizes: Vec<u64> = g.books.iter().map(|b| b.total_size_bytes).collect();
            sizes.sort_by(|a, b| b.cmp(a));  // Sort descending
            sizes.iter().skip(1).sum::<u64>()  // Skip largest, sum rest
        })
        .sum();

    println!("✅ Found {} duplicate groups ({} total duplicates)",
        duplicate_groups.len(), total_duplicates);
    println!("💾 Potential space savings: {:.2} GB",
        potential_savings as f64 / (1024.0 * 1024.0 * 1024.0));

    Ok(DuplicateScanResult {
        duplicate_groups,
        total_books_scanned: books.len(),
        total_duplicates_found: total_duplicates,
        potential_space_savings_bytes: potential_savings,
    })
}

/// Collect all book folders with their metadata
fn collect_book_folders(library_path: &str) -> Result<Vec<BookData>, String> {
    let mut books = Vec::new();
    collect_books_recursive(library_path, &mut books)?;
    Ok(books)
}

fn collect_books_recursive(path: &str, books: &mut Vec<BookData>) -> Result<(), String> {
    let dir = Path::new(path);

    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory {}: {}", path, e))?;

    let mut has_audio = false;
    let mut has_metadata = false;
    let mut audio_files: Vec<(String, u64)> = Vec::new();
    let mut subdirs: Vec<String> = Vec::new();
    let mut cover_path: Option<String> = None;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_lowercase();

        if entry_path.is_dir() {
            subdirs.push(entry_path.to_string_lossy().to_string());
        } else if entry_path.is_file() {
            // Check for audio files
            if file_name.ends_with(".mp3") || file_name.ends_with(".m4a")
                || file_name.ends_with(".m4b") || file_name.ends_with(".flac")
                || file_name.ends_with(".ogg") {
                has_audio = true;
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                audio_files.push((file_name.clone(), size));
            }

            // Check for metadata
            if file_name == "metadata.json" {
                has_metadata = true;
            }

            // Check for cover - store the actual path
            if file_name.starts_with("cover.") || file_name.starts_with("folder.") {
                // Prefer common image formats
                let ext = file_name.rsplit('.').next().unwrap_or("");
                if ["jpg", "jpeg", "png", "webp", "gif"].contains(&ext) {
                    cover_path = Some(entry_path.to_string_lossy().to_string());
                }
            }
        }
    }

    // If this folder has audio files, it's a book folder
    if has_audio {
        let book = extract_book_data(path, &audio_files, has_metadata, cover_path)?;
        books.push(book);
    } else {
        // Recurse into subdirectories
        for subdir in subdirs {
            let _ = collect_books_recursive(&subdir, books);
        }
    }

    Ok(())
}

/// Extract book metadata from folder
fn extract_book_data(
    folder_path: &str,
    audio_files: &[(String, u64)],
    has_metadata_file: bool,
    cover_path: Option<String>,
) -> Result<BookData, String> {
    let path = Path::new(folder_path);

    // Try to read metadata.json
    let metadata_path = path.join("metadata.json");
    let (title, author, narrator, asin, isbn) = if metadata_path.exists() {
        parse_metadata_json(&metadata_path)?
    } else {
        // Fall back to folder name parsing
        let folder_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        parse_folder_name(folder_name)
    };

    // Calculate total size
    let total_size: u64 = audio_files.iter().map(|(_, size)| size).sum();

    // Detect audio format
    let audio_format = audio_files.first()
        .map(|(name, _)| {
            if name.ends_with(".m4b") { "m4b" }
            else if name.ends_with(".m4a") { "m4a" }
            else if name.ends_with(".mp3") { "mp3" }
            else if name.ends_with(".flac") { "flac" }
            else { "unknown" }
        })
        .map(String::from);

    // Estimate duration from file size (rough: ~1MB per minute for audiobooks)
    let estimated_duration = Some((total_size / (1024 * 1024)) * 60);

    Ok(BookData {
        folder_path: folder_path.to_string(),
        title: title.clone(),
        title_normalized: normalize_title(&title),
        author: author.clone(),
        author_normalized: normalize_title(&author),
        narrator,
        asin,
        isbn,
        duration_seconds: estimated_duration,
        file_count: audio_files.len(),
        total_size_bytes: total_size,
        has_cover: cover_path.is_some(),
        cover_path,
        has_metadata_file,
        audio_format,
    })
}

/// Parse metadata.json file
fn parse_metadata_json(path: &Path) -> Result<(String, String, Option<String>, Option<String>, Option<String>), String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read metadata: {}", e))?;

    #[derive(Deserialize)]
    struct Metadata {
        #[serde(default)]
        title: Option<String>,
        // Support both "author" (string) and "authors" (array)
        #[serde(default)]
        author: Option<String>,
        #[serde(default)]
        authors: Option<Vec<String>>,
        #[serde(default)]
        narrator: Option<String>,
        #[serde(default)]
        narrators: Option<Vec<String>>,
        #[serde(default)]
        asin: Option<String>,
        #[serde(default)]
        isbn: Option<String>,
    }

    let metadata: Metadata = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse metadata: {}", e))?;

    // Get title
    let title = metadata.title.unwrap_or_default();

    // Get author - prefer "authors" array, fall back to "author" string
    let author = metadata.authors
        .and_then(|authors| {
            if authors.is_empty() {
                None
            } else {
                Some(authors.join(", "))
            }
        })
        .or(metadata.author)
        .unwrap_or_default();

    // Get narrator - prefer "narrators" array, fall back to "narrator" string
    let narrator = metadata.narrators
        .and_then(|narrators| {
            if narrators.is_empty() {
                None
            } else {
                Some(narrators.join(", "))
            }
        })
        .or(metadata.narrator);

    Ok((title, author, narrator, metadata.asin, metadata.isbn))
}

/// Parse folder name to extract title and author
fn parse_folder_name(folder_name: &str) -> (String, String, Option<String>, Option<String>, Option<String>) {
    // Common pattern: "Author - Title"
    if folder_name.contains(" - ") {
        let parts: Vec<&str> = folder_name.splitn(2, " - ").collect();
        if parts.len() == 2 {
            return (parts[1].to_string(), parts[0].to_string(), None, None, None);
        }
    }

    (folder_name.to_string(), String::new(), None, None, None)
}

/// Normalize title for comparison
fn normalize_title(title: &str) -> String {
    title.to_lowercase()
        // Remove parenthetical content (series info, etc.)
        .split('(').next().unwrap_or(title)
        // Remove common suffixes
        .replace(" - unabridged", "")
        .replace(" (unabridged)", "")
        .replace(": a novel", "")
        .replace(", a novel", "")
        // Remove articles
        .trim_start_matches("the ")
        .trim_start_matches("a ")
        .trim_start_matches("an ")
        // Remove punctuation
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Calculate string similarity (Jaro-Winkler-like)
fn string_similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    let a_words: std::collections::HashSet<&str> = a.split_whitespace().collect();
    let b_words: std::collections::HashSet<&str> = b.split_whitespace().collect();

    if a_words.is_empty() || b_words.is_empty() {
        return 0.0;
    }

    let intersection = a_words.intersection(&b_words).count();
    let union = a_words.union(&b_words).count();

    intersection as f64 / union as f64
}

/// Check if the book's folder path contains the correct author name
/// Returns a score from 0.0 to 1.0
fn check_folder_matches_author(book: &BookData) -> f64 {
    if book.author.is_empty() {
        return 0.5;  // Can't verify, neutral score
    }

    let path_lower = book.folder_path.to_lowercase();
    let author_lower = book.author.to_lowercase();

    // Extract author's last name and full name variants
    let author_words: Vec<&str> = author_lower.split_whitespace().collect();

    // Check if path contains the full author name
    let author_normalized = author_lower.replace(",", "").replace(".", "");
    if path_lower.contains(&author_normalized) {
        return 1.0;  // Perfect match
    }

    // Check individual significant words (skip common words)
    let skip_words = ["the", "a", "an", "of", "and", "jr", "sr", "ii", "iii", "ph.d", "dr", "mr", "mrs", "ms"];
    let significant_words: Vec<&str> = author_words.iter()
        .filter(|w| w.len() > 2 && !skip_words.contains(&w.as_ref()))
        .copied()
        .collect();

    if significant_words.is_empty() {
        return 0.5;
    }

    // Check if path contains author's last name (usually most important)
    if let Some(last_name) = significant_words.last() {
        if path_lower.contains(last_name) {
            // Check if first name also matches for higher confidence
            if significant_words.len() > 1 {
                if let Some(first_name) = significant_words.first() {
                    if path_lower.contains(first_name) {
                        return 1.0;  // Both first and last name in path
                    }
                }
            }
            return 0.8;  // Last name matches
        }
    }

    // Check if ANY significant author word is in the path
    let matching_words = significant_words.iter()
        .filter(|w| path_lower.contains(*w))
        .count();

    if matching_words > 0 {
        return 0.6;  // Partial match
    }

    // No match - book is in wrong folder
    0.0
}

/// Calculate quality score for a book (higher is better)
fn calculate_quality_score(book: &BookData) -> f64 {
    let mut score = 0.0;

    // HIGHEST PRIORITY: Prefer books in correct author folder
    // This is the most important factor - a book in the wrong folder is misorganized
    let folder_author_score = check_folder_matches_author(book);
    score += folder_author_score * 50.0;  // Up to 50 points for correct folder

    // Prefer books with metadata files
    if book.has_metadata_file {
        score += 30.0;
    }

    // Prefer books with covers
    if book.has_cover {
        score += 20.0;
    }

    // Prefer m4b over mp3
    if let Some(ref format) = book.audio_format {
        match format.as_str() {
            "m4b" => score += 15.0,
            "m4a" => score += 10.0,
            "flac" => score += 12.0,
            _ => {}
        }
    }

    // Prefer larger files (usually higher quality)
    score += (book.total_size_bytes as f64 / (1024.0 * 1024.0 * 100.0)).min(20.0);

    // Prefer fewer files (single file = easier to manage)
    if book.file_count == 1 {
        score += 10.0;
    }

    score
}

/// Convert BookData to DuplicateBook
fn book_data_to_duplicate(book: &BookData) -> DuplicateBook {
    let quality_score = calculate_quality_score(book);
    let folder_match_score = check_folder_matches_author(book);

    DuplicateBook {
        folder_path: book.folder_path.clone(),
        title: book.title.clone(),
        author: book.author.clone(),
        narrator: book.narrator.clone(),
        duration_seconds: book.duration_seconds,
        file_count: book.file_count,
        total_size_bytes: book.total_size_bytes,
        has_cover: book.has_cover,
        cover_path: book.cover_path.clone(),
        has_metadata_file: book.has_metadata_file,
        quality_score,
        audio_format: book.audio_format.clone(),
        in_correct_folder: folder_match_score >= 0.8,  // 80%+ match = correct folder
    }
}

/// Find books with exact title matches
fn find_exact_title_matches(
    books: &[BookData],
    processed: &mut std::collections::HashSet<(String, String)>,
) -> Vec<DuplicateGroup> {
    let mut groups: HashMap<String, Vec<&BookData>> = HashMap::new();

    // Group by normalized title + author
    for book in books {
        if book.title_normalized.is_empty() {
            continue;
        }
        let key = format!("{}|{}", book.title_normalized, book.author_normalized);
        groups.entry(key).or_default().push(book);
    }

    // Filter to groups with duplicates
    groups.into_iter()
        .filter(|(_, group)| group.len() > 1)
        .filter_map(|(_, group)| {
            // Check if already processed
            let paths: Vec<_> = group.iter().map(|b| b.folder_path.clone()).collect();
            let pair_key = (paths[0].clone(), paths[1].clone());
            if processed.contains(&pair_key) {
                return None;
            }

            // Mark as processed
            for i in 0..paths.len() {
                for j in (i+1)..paths.len() {
                    processed.insert((paths[i].clone(), paths[j].clone()));
                    processed.insert((paths[j].clone(), paths[i].clone()));
                }
            }

            let mut dup_books: Vec<DuplicateBook> = group.iter()
                .map(|b| book_data_to_duplicate(b))
                .collect();

            // Sort by quality score descending
            dup_books.sort_by(|a, b| b.quality_score.partial_cmp(&a.quality_score).unwrap());

            let recommended = dup_books.first().map(|b| b.folder_path.clone());

            Some(DuplicateGroup {
                id: uuid::Uuid::new_v4().to_string(),
                match_type: MatchType::ExactTitle,
                confidence: 1.0,
                books: dup_books,
                recommended_keep: recommended,
            })
        })
        .collect()
}

/// Find books with similar titles (fuzzy matching)
fn find_similar_title_matches(
    books: &[BookData],
    threshold: f64,
    processed: &mut std::collections::HashSet<(String, String)>,
) -> Vec<DuplicateGroup> {
    let mut groups: Vec<DuplicateGroup> = Vec::new();

    for i in 0..books.len() {
        for j in (i+1)..books.len() {
            let book_a = &books[i];
            let book_b = &books[j];

            // Skip if already processed
            let pair = (book_a.folder_path.clone(), book_b.folder_path.clone());
            if processed.contains(&pair) {
                continue;
            }

            // Skip if either title is empty
            if book_a.title_normalized.is_empty() || book_b.title_normalized.is_empty() {
                continue;
            }

            // Calculate title similarity
            let title_sim = string_similarity(&book_a.title_normalized, &book_b.title_normalized);

            // Also check author similarity if both have authors
            let author_match = if !book_a.author_normalized.is_empty() && !book_b.author_normalized.is_empty() {
                string_similarity(&book_a.author_normalized, &book_b.author_normalized) > 0.5
            } else {
                true  // Can't verify, assume possible match
            };

            if title_sim >= threshold && author_match {
                processed.insert(pair);
                processed.insert((book_b.folder_path.clone(), book_a.folder_path.clone()));

                let mut dup_books = vec![
                    book_data_to_duplicate(book_a),
                    book_data_to_duplicate(book_b),
                ];
                dup_books.sort_by(|a, b| b.quality_score.partial_cmp(&a.quality_score).unwrap());

                let recommended = dup_books.first().map(|b| b.folder_path.clone());

                groups.push(DuplicateGroup {
                    id: uuid::Uuid::new_v4().to_string(),
                    match_type: MatchType::SimilarTitle,
                    confidence: title_sim,
                    books: dup_books,
                    recommended_keep: recommended,
                });
            }
        }
    }

    groups
}

/// Find books with matching ASINs
fn find_asin_matches(
    books: &[BookData],
    processed: &mut std::collections::HashSet<(String, String)>,
) -> Vec<DuplicateGroup> {
    let mut asin_groups: HashMap<String, Vec<&BookData>> = HashMap::new();

    for book in books {
        if let Some(ref asin) = book.asin {
            if !asin.is_empty() {
                asin_groups.entry(asin.clone()).or_default().push(book);
            }
        }
    }

    asin_groups.into_iter()
        .filter(|(_, group)| group.len() > 1)
        .filter_map(|(_, group)| {
            let paths: Vec<_> = group.iter().map(|b| b.folder_path.clone()).collect();
            let pair_key = (paths[0].clone(), paths[1].clone());
            if processed.contains(&pair_key) {
                return None;
            }

            for i in 0..paths.len() {
                for j in (i+1)..paths.len() {
                    processed.insert((paths[i].clone(), paths[j].clone()));
                    processed.insert((paths[j].clone(), paths[i].clone()));
                }
            }

            let mut dup_books: Vec<DuplicateBook> = group.iter()
                .map(|b| book_data_to_duplicate(b))
                .collect();
            dup_books.sort_by(|a, b| b.quality_score.partial_cmp(&a.quality_score).unwrap());

            let recommended = dup_books.first().map(|b| b.folder_path.clone());

            Some(DuplicateGroup {
                id: uuid::Uuid::new_v4().to_string(),
                match_type: MatchType::SameAsin,
                confidence: 1.0,
                books: dup_books,
                recommended_keep: recommended,
            })
        })
        .collect()
}

/// Find books with similar duration and title
fn find_duration_matches(
    books: &[BookData],
    tolerance_seconds: u64,
    processed: &mut std::collections::HashSet<(String, String)>,
) -> Vec<DuplicateGroup> {
    let mut groups: Vec<DuplicateGroup> = Vec::new();

    for i in 0..books.len() {
        for j in (i+1)..books.len() {
            let book_a = &books[i];
            let book_b = &books[j];

            // Skip if already processed
            let pair = (book_a.folder_path.clone(), book_b.folder_path.clone());
            if processed.contains(&pair) {
                continue;
            }

            // Need both to have duration estimates
            let (dur_a, dur_b) = match (book_a.duration_seconds, book_b.duration_seconds) {
                (Some(a), Some(b)) => (a, b),
                _ => continue,
            };

            // Check if durations are within tolerance
            let duration_diff = if dur_a > dur_b { dur_a - dur_b } else { dur_b - dur_a };
            if duration_diff > tolerance_seconds {
                continue;
            }

            // Also need some title similarity (at least 50%)
            let title_sim = string_similarity(&book_a.title_normalized, &book_b.title_normalized);
            if title_sim < 0.5 {
                continue;
            }

            processed.insert(pair);
            processed.insert((book_b.folder_path.clone(), book_a.folder_path.clone()));

            let mut dup_books = vec![
                book_data_to_duplicate(book_a),
                book_data_to_duplicate(book_b),
            ];
            dup_books.sort_by(|a, b| b.quality_score.partial_cmp(&a.quality_score).unwrap());

            let recommended = dup_books.first().map(|b| b.folder_path.clone());

            // Confidence based on title similarity
            let confidence = (title_sim + 0.5) / 1.5;  // Scale to 0.33-1.0 range

            groups.push(DuplicateGroup {
                id: uuid::Uuid::new_v4().to_string(),
                match_type: MatchType::DurationAndTitle,
                confidence,
                books: dup_books,
                recommended_keep: recommended,
            });
        }
    }

    groups
}

/// Delete a book folder permanently
pub fn delete_book_folder(folder_path: &str) -> Result<(), String> {
    let path = Path::new(folder_path);
    if !path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    fs::remove_dir_all(path)
        .map_err(|e| format!("Failed to delete folder: {}", e))
}

/// Move a book folder to system trash
#[cfg(target_os = "macos")]
pub fn move_to_trash(folder_path: &str) -> Result<(), String> {
    let path = Path::new(folder_path);
    if !path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    trash::delete(path)
        .map_err(|e| format!("Failed to move to trash: {}", e))
}

#[cfg(not(target_os = "macos"))]
pub fn move_to_trash(folder_path: &str) -> Result<(), String> {
    let path = Path::new(folder_path);
    if !path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    trash::delete(path)
        .map_err(|e| format!("Failed to move to trash: {}", e))
}
