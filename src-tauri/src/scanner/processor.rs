use super::types::*;
use crate::config::Config;
use crate::cache;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};  // Add Ordering and AtomicUsize
use std::sync::Arc;
use tokio::sync::Semaphore;
use lofty::probe::Probe;
use lofty::tag::Accessor;
use lofty::file::TaggedFileExt;
// ADD THIS FUNCTION HERE - AT THE TOP!
pub async fn process_all_groups(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    
    let max_workers = config.max_workers;
    let semaphore = Arc::new(Semaphore::new(max_workers));
    
    let total = groups.len();
    println!("⚙️  Processing {} groups with {} workers", total, max_workers);
    
    let processed_count = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();
    
    for group in groups {
        if let Some(ref flag) = cancel_flag {
            if flag.load(Ordering::SeqCst) {
                println!("Processing cancelled");
                break;
            }
        }
        
        let sem = Arc::clone(&semaphore);
        let config_clone = config.clone();
        let cancel_clone = cancel_flag.clone();
        let count_clone = Arc::clone(&processed_count);
        let group_name = group.group_name.clone();
        
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            let result = process_book_group(group, &config_clone, cancel_clone).await;
            
            let current = count_clone.fetch_add(1, Ordering::SeqCst) + 1;
            crate::progress::update_progress(current, total, &group_name);
            
            result
        });
        
        handles.push(handle);
    }
    
    let mut results = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(Ok(processed)) => results.push(processed),
            Ok(Err(e)) => eprintln!("Failed to process group: {}", e),
            Err(e) => eprintln!("Task failed: {}", e),
        }
    }
    
    Ok(results)
}

async fn process_book_group(
    mut group: BookGroup,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<BookGroup, Box<dyn std::error::Error + Send + Sync>> {
    
    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::SeqCst) {
            return Ok(group);
        }
    }
    
    let cache_key = format!("book_{}", group.group_name);
    
    // Check cache first
    if let Some(cached_metadata) = cache::get::<BookMetadata>(&cache_key) {
        println!("💾 Cache hit for: {}", group.group_name);
        group.metadata = cached_metadata;
    } else {
        println!("📖 Processing: {}", group.group_name);
        
        // Read first file's tags
        let sample_file = &group.files[0];
        let file_tags = read_file_tags(&sample_file.path);
        
        // Create RawFileData for GPT extraction
        let raw_file = RawFileData {
            path: sample_file.path.clone(),
            filename: sample_file.filename.clone(),
            parent_dir: std::path::Path::new(&sample_file.path)
                .parent()
                .unwrap_or(std::path::Path::new(""))
                .to_string_lossy()
                .to_string(),
            tags: file_tags.clone(),
        };
        
        // Extract with GPT
        let (extracted_title, extracted_author) = extract_book_info_with_gpt(
            &raw_file,
            &group.group_name,
            config.openai_api_key.as_deref()
        ).await;
        
        println!("   📝 Extracted: '{}' by '{}'", extracted_title, extracted_author);
        
        // FALLBACK CHAIN: Try Google Books → Audible → GPT
        let mut google_data = None;
        let mut audible_data = None;
        
        // Try Google Books first
        if let Some(ref api_key) = config.google_books_api_key {
            println!("   🔍 Fetching Google Books data...");
            match fetch_google_books_data(&extracted_title, &extracted_author, api_key).await {
                Ok(data) => {
                    if data.is_some() {
                        println!("   ✅ Google Books data found");
                        google_data = data;
                    } else {
                        println!("   ⚠️  No Google Books data");
                    }
                }
                Err(e) => {
                    println!("   ⚠️  Google Books error: {}", e);
                    // Google failed, try Audible
                    println!("   🎧 Trying Audible as fallback...");
                    audible_data = fetch_audible_metadata(&extracted_title, &extracted_author).await;
                }
            }
        } else {
            // No Google API key, try Audible
            println!("   🎧 No Google Books API key, trying Audible...");
            audible_data = fetch_audible_metadata(&extracted_title, &extracted_author).await;
        }
        
        // If we still don't have data, try GPT enrichment as last resort
        let needs_gpt_enrichment = google_data.is_none() && audible_data.is_none();
        
        // Fetch cover art using dedicated module
        println!("   🖼️  Fetching cover art...");
        let cover_art = match crate::cover_art::fetch_and_download_cover(
            &extracted_title,
            &extracted_author,
            audible_data.as_ref().and_then(|d| d.asin.clone()).as_deref(),
            config.google_books_api_key.as_deref(),
        ).await {
            Ok(cover) => {
                if cover.data.is_some() {
                    println!("   ✅ Cover art downloaded");
                    
                    // Cache the cover separately for the cover viewer
                    if let Some(ref data) = cover.data {
                        let cover_cache_key = format!("cover_{}", group.id);
                        let mime_type = cover.mime_type.clone().unwrap_or_else(|| "image/jpeg".to_string());
                        if let Err(e) = cache::set(&cover_cache_key, &(data.clone(), mime_type)) {
                            println!("   ⚠️  Failed to cache cover: {}", e);
                        }
                    }
                } else if cover.url.is_some() {
                    println!("   ⚠️  Cover URL found but download failed");
                } else {
                    println!("   ⚠️  No cover art found");
                }
                Some(cover)
            }
            Err(e) => {
                println!("   ⚠️  Cover art error: {}", e);
                None
            }
        };
        
        // Merge all metadata with GPT
        println!("   🤖 Merging metadata with GPT...");
        let mut final_metadata = if needs_gpt_enrichment {
            // Use GPT to enrich with missing data
            enrich_with_gpt(
                &group.group_name,
                &extracted_title,
                &extracted_author,
                &file_tags,
                config.openai_api_key.as_deref()
            ).await
        } else {
            merge_all_with_gpt(
                &group.group_name,
                &extracted_title,
                &extracted_author,
                &file_tags,
                google_data,
                audible_data,
                config.openai_api_key.as_deref()
            ).await
        };
        
        // Add cover art to metadata
        if let Some(cover) = cover_art {
            final_metadata.cover_url = cover.url;
            final_metadata.cover_data = cover.data;
            final_metadata.cover_mime = cover.mime_type;
        }
        
        println!("   ✅ Processing complete for: {}", final_metadata.title);
        
        group.metadata = final_metadata;
        
        // Cache the result
        if let Err(e) = cache::set(&cache_key, &group.metadata) {
            println!("   ⚠️  Failed to cache metadata: {}", e);
        } else {
            println!("   💾 Cached metadata");
        }
    }
    
    // Calculate changes by reading existing tags
    println!("   🔄 Calculating tag changes...");
    group.total_changes = calculate_changes(&mut group);
    println!("   📊 {} total changes detected", group.total_changes);
    
    Ok(group)
}
async fn fetch_audible_metadata(
    title: &str,
    author: &str,
) -> Option<AudibleMetadata> {
    println!("   🎧 Searching Audible CLI...");
    
    // Build search query
    let search_query = format!("{} {}", title, author);
    
    // Call audible CLI
    let output = tokio::process::Command::new("audible")
        .args(&["search", "-t", &search_query, "--output-format", "json"])
        .output()
        .await;
    
    match output {
        Ok(result) if result.status.success() => {
            let json_str = String::from_utf8_lossy(&result.stdout);
            
            #[derive(serde::Deserialize)]
            struct AudibleResponse {
                products: Vec<AudibleProduct>,
            }
            
            #[derive(serde::Deserialize)]
            struct AudibleProduct {
                asin: String,
                title: String,
                authors: Option<Vec<AudibleAuthor>>,
                narrators: Option<Vec<AudibleNarrator>>,
                series: Option<Vec<AudibleSeriesInfo>>,
                publisher_name: Option<String>,
                release_date: Option<String>,
                merchandising_summary: Option<String>,
            }
            
            #[derive(serde::Deserialize)]
            struct AudibleAuthor {
                name: String,
            }
            
            #[derive(serde::Deserialize)]
            struct AudibleNarrator {
                name: String,
            }
            
            #[derive(serde::Deserialize)]
            struct AudibleSeriesInfo {
                title: String,
                sequence: Option<String>,
            }
            
            match serde_json::from_str::<AudibleResponse>(&json_str) {
                Ok(response) => {
                    if let Some(product) = response.products.first() {
                        println!("   ✅ Audible data found: {}", product.title);
                        
                        return Some(AudibleMetadata {
                            asin: Some(product.asin.clone()),
                            title: Some(product.title.clone()),
                            authors: product.authors.as_ref()
                                .map(|a| a.iter().map(|author| author.name.clone()).collect())
                                .unwrap_or_default(),
                            narrators: product.narrators.as_ref()
                                .map(|n| n.iter().map(|narrator| narrator.name.clone()).collect())
                                .unwrap_or_default(),
                            series: product.series.as_ref()
                                .map(|s| s.iter().map(|series| AudibleSeries {
                                    name: series.title.clone(),
                                    position: series.sequence.clone(),
                                }).collect())
                                .unwrap_or_default(),
                            publisher: product.publisher_name.clone(),
                            release_date: product.release_date.clone(),
                            description: product.merchandising_summary.clone(),
                        });
                    } else {
                        println!("   ⚠️  No Audible results");
                    }
                }
                Err(e) => {
                    println!("   ⚠️  Failed to parse Audible response: {}", e);
                }
            }
        }
        Ok(_) => {
            println!("   ⚠️  Audible CLI returned error");
        }
        Err(e) => {
            println!("   ⚠️  Audible CLI not available: {}", e);
        }
    }
    
    None
}
#[derive(Clone)]
struct FileTags {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<String>,
    comment: Option<String>,
}

fn read_file_tags(path: &str) -> FileTags {
    match Probe::open(path) {
        Ok(probe) => match probe.read() {
            Ok(tagged) => {
                let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
                if let Some(t) = tag {
                    FileTags {
                        title: t.title().map(|s| s.to_string()),
                        artist: t.artist().map(|s| s.to_string()),
                        album: t.album().map(|s| s.to_string()),
                        genre: t.genre().map(|s| s.to_string()),
                        year: t.year().map(|y| y.to_string()),
                        comment: t.comment().map(|s| s.to_string()),
                    }
                } else {
                    FileTags {
                        title: None,
                        artist: None,
                        album: None,
                        genre: None,
                        year: None,
                        comment: None,
                    }
                }
            },
            Err(_) => FileTags {
                title: None,
                artist: None,
                album: None,
                genre: None,
                year: None,
                comment: None,
            },
        },
        Err(_) => FileTags {
            title: None,
            artist: None,
            album: None,
            genre: None,
            year: None,
            comment: None,
        },
    }
}

#[derive(Clone)]
struct RawFileData {
    path: String,
    filename: String,
    parent_dir: String,
    tags: FileTags,
}

// #[derive(Clone)]
// struct FileTags {
//     title: Option<String>,
//     artist: Option<String>,
//     album: Option<String>,
//     genre: Option<String>,
//     year: Option<String>,
//     comment: Option<String>,
// }
fn calculate_changes(group: &mut BookGroup) -> usize {
    let mut total_changes = 0;
    
    for file in &mut group.files {
        file.changes.clear();
        
        let existing_tags = read_file_tags(&file.path);
        
        if existing_tags.title.as_deref() != Some(&group.metadata.title) {
            file.changes.insert("title".to_string(), MetadataChange {
                old: existing_tags.title.unwrap_or_default(),
                new: group.metadata.title.clone(),
            });
            total_changes += 1;
        }
        
        if existing_tags.artist.as_deref() != Some(&group.metadata.author) {
            file.changes.insert("author".to_string(), MetadataChange {
                old: existing_tags.artist.unwrap_or_default(),
                new: group.metadata.author.clone(),
            });
            total_changes += 1;
        }
        
        if let Some(ref narrator) = group.metadata.narrator {
            if existing_tags.comment.as_deref() != Some(narrator) {
                file.changes.insert("narrator".to_string(), MetadataChange {
                    old: existing_tags.comment.unwrap_or_default(),
                    new: narrator.clone(),
                });
                total_changes += 1;
            }
        }
        
        if !group.metadata.genres.is_empty() {
            let new_genre = group.metadata.genres.join(", ");
            if existing_tags.genre.as_deref() != Some(&new_genre) {
                file.changes.insert("genre".to_string(), MetadataChange {
                    old: existing_tags.genre.unwrap_or_default(),
                    new: new_genre,
                });
                total_changes += 1;
            }
        }
        
        if let Some(ref year) = group.metadata.year {
            if existing_tags.year.as_deref() != Some(year) {
                file.changes.insert("year".to_string(), MetadataChange {
                    old: existing_tags.year.unwrap_or_default(),
                    new: year.clone(),
                });
                total_changes += 1;
            }
        }
        
        file.status = if file.changes.is_empty() {
            "unchanged".to_string()
        } else {
            "pending".to_string()
        };
    }
    
    total_changes
}

fn extract_book_number_from_folder(folder: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?i)book\s*[#]?(\d+)|[#](\d+)|[-_\s](\d{2})[-_\s]").ok()?;
    if let Some(caps) = re.captures(folder) {
        caps.get(1)
            .or_else(|| caps.get(2))
            .or_else(|| caps.get(3))
            .map(|m| m.as_str().to_string())
    } else {
        None
    }
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
        match call_gpt_api(&prompt, api_key, "gpt-4o-mini", 300).await {
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
pub async fn enrich_with_gpt(
    folder_name: &str,
    extracted_title: &str,
    extracted_author: &str,
    file_tags: &FileTags,
    api_key: Option<&str>
) -> BookMetadata {
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            // No API key, return basic metadata
            return BookMetadata {
                title: extracted_title.to_string(),
                author: extracted_author.to_string(),
                subtitle: None,
                narrator: None,
                series: extract_series_from_folder(folder_name).0,
                sequence: extract_series_from_folder(folder_name).1,
                genres: vec![],
                publisher: None,
                year: None,
                description: None,
                isbn: None,
                cover_data: None,
                cover_mime: None,
                cover_url: None,
            };
        }
    };
    
    println!("   🤖 Using GPT to enrich metadata (no external sources available)...");
    
    let prompt = format!(
r#"You are enriching audiobook metadata when no external databases are available.

FOLDER NAME: {}
TITLE: {}
AUTHOR: {}
COMMENT TAG: {:?}

Based on your knowledge, provide as much metadata as you can for this audiobook:

1. Narrator: Check if the comment field contains narrator info, or use your knowledge
2. Series: Extract from folder name if present (patterns like Book 01, Book 45, etc.)
3. Sequence: Extract book number from folder or filename AS A STRING
4. Genres: Provide 1-3 appropriate genres from this list: {}
5. Publisher: If you know the typical publisher for this author/series
6. Year: If you know when this book was published AS A STRING
7. Description: A brief 2-3 sentence description of the book

IMPORTANT: All values must be strings or null. Numbers like 1 must be written as "1".

Return ONLY valid JSON (use null for missing fields):
{{
  "narrator": null,
  "series": null,
  "sequence": null,
  "genres": ["Genre1", "Genre2"],
  "publisher": null,
  "year": null,
  "description": null
}}

JSON:"#,
        folder_name,
        extracted_title,
        extracted_author,
        file_tags.comment,
        crate::genres::APPROVED_GENRES.join(", ")
    );
    
    match call_gpt_api(&prompt, api_key, "gpt-4o-mini", 800).await {
        Ok(json_str) => {
            // Parse as generic JSON first to handle type mismatches
            match serde_json::from_str::<serde_json::Value>(&json_str) {
                Ok(json) => {
                    println!("   ✅ GPT enrichment successful");
                    
                    // Helper to convert Value to Option<String>
                    let get_string = |v: &serde_json::Value| -> Option<String> {
                        match v {
                            serde_json::Value::String(s) => Some(s.clone()),
                            serde_json::Value::Number(n) => Some(n.to_string()),
                            serde_json::Value::Null => None,
                            _ => None,
                        }
                    };
                    
                    let get_string_array = |v: &serde_json::Value| -> Vec<String> {
                        match v {
                            serde_json::Value::Array(arr) => {
                                arr.iter()
                                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                                    .collect()
                            }
                            _ => vec![],
                        }
                    };
                    
                    BookMetadata {
                        title: extracted_title.to_string(),
                        author: extracted_author.to_string(),
                        subtitle: None,
                        narrator: json.get("narrator").and_then(get_string),
                        series: json.get("series").and_then(get_string),
                        sequence: json.get("sequence").and_then(get_string),
                        genres: json.get("genres").map(get_string_array).unwrap_or_default(),
                        publisher: json.get("publisher").and_then(get_string),
                        year: json.get("year").and_then(get_string),
                        description: json.get("description").and_then(get_string),
                        isbn: None,
                        cover_data: None,
                        cover_mime: None,
                        cover_url: None,
                    }
                }
                Err(e) => {
                    println!("   ⚠️  GPT parse error: {}", e);
                    BookMetadata {
                        title: extracted_title.to_string(),
                        author: extracted_author.to_string(),
                        subtitle: None,
                        narrator: None,
                        series: extract_series_from_folder(folder_name).0,
                        sequence: extract_series_from_folder(folder_name).1,
                        genres: vec![],
                        publisher: None,
                        year: None,
                        description: None,
                        isbn: None,
                        cover_data: None,
                        cover_mime: None,
                        cover_url: None,
                    }
                }
            }
        }
        Err(e) => {
            println!("   ⚠️  GPT enrichment failed: {}", e);
            BookMetadata {
                title: extracted_title.to_string(),
                author: extracted_author.to_string(),
                subtitle: None,
                narrator: None,
                series: extract_series_from_folder(folder_name).0,
                sequence: extract_series_from_folder(folder_name).1,
                genres: vec![],
                publisher: None,
                year: None,
                description: None,
                isbn: None,
                cover_data: None,
                cover_mime: None,
                cover_url: None,
            }
        }
    }
}

fn extract_series_from_folder(folder_name: &str) -> (Option<String>, Option<String>) {
    // Try to extract series name and book number from folder
    if let Some(book_num) = extract_book_number_from_folder(folder_name) {
        // Try to extract series name (everything before the book number pattern)
        let patterns = [
            regex::Regex::new(r"(.+?)\s+(?:Book\s*[#]?)?\d+").ok(),
            regex::Regex::new(r"(.+?)\s+[#]\d+").ok(),
            regex::Regex::new(r"\[(.+?)\s+\d+\]").ok(),
        ];
        
        for pattern in patterns.iter().flatten() {
            if let Some(caps) = pattern.captures(folder_name) {
                if let Some(series_name) = caps.get(1) {
                    return (Some(series_name.as_str().trim().to_string()), Some(book_num));
                }
            }
        }
        
        return (None, Some(book_num));
    }
    
    (None, None)
}
#[derive(serde::Deserialize, Debug)]
struct AudibleMetadata {
    asin: Option<String>,  // ADD THIS LINE
    title: Option<String>,
    authors: Vec<String>,
    narrators: Vec<String>,
    series: Vec<AudibleSeries>,
    publisher: Option<String>,
    release_date: Option<String>,
    description: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
struct AudibleSeries {
    name: String,
    position: Option<String>,
}

async fn merge_all_with_gpt(
    folder_name: &str,
    extracted_title: &str,
    extracted_author: &str,
    file_tags: &FileTags,
    google_data: Option<GoogleBookData>,
    audible_data: Option<AudibleMetadata>,
    api_key: Option<&str>
) -> BookMetadata {
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            // Return fallback metadata if no API key
            return fallback_metadata(extracted_title, extracted_author, google_data, audible_data, None);
        }
    };
    
    // ... rest of merge_all_with_gpt remains the same
    // PRE-EXTRACT reliable year from sources
    let reliable_year = audible_data.as_ref()
        .and_then(|d| d.release_date.clone())
        .and_then(|date| date.split('-').next().map(|s| s.to_string()))
        .or_else(|| {
            google_data.as_ref()
                .and_then(|d| d.year.clone())
        });
    
    let google_summary = if let Some(ref data) = google_data {
        format!(
            "Title: {:?}, Subtitle: {:?}, Publisher: {:?}, Year: {:?}, Genres: {:?}",
            data.subtitle, data.subtitle, data.publisher, data.year, data.genres
        )
    } else {
        "No data".to_string()
    };
    
    let audible_summary = if let Some(ref data) = audible_data {
        format!(
            "Title: {:?}, Authors: {:?}, Narrators: {:?}, Series: {:?}, Publisher: {:?}, Release Date: {:?}",
            data.title, data.authors, data.narrators, data.series, data.publisher, data.release_date
        )
    } else {
        "No data".to_string()
    };
    
    let year_instruction = if let Some(ref year) = reliable_year {
        format!("CRITICAL: Use EXACTLY this year: {} (from Audible/Google Books - DO NOT CHANGE)", year)
    } else {
        "year: If not found in sources, return null".to_string()
    };
    
    let prompt = format!(
r#"You are an audiobook metadata specialist. Combine information from all sources to produce the most accurate metadata.

SOURCES:
1. Folder: {}
2. Extracted from tags: title='{}', author='{}'
3. Google Books: {}
4. Audible: {}
5. Sample comment: {:?}

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
        file_tags.comment,
        crate::genres::APPROVED_GENRES.join(", "),
        year_instruction
    );
    
    match call_gpt_api(&prompt, api_key, "gpt-4o-mini", 1000).await {
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
                    fallback_metadata(extracted_title, extracted_author, google_data, audible_data, reliable_year)
                }
            }
        }
        Err(e) => {
            println!("   ⚠️  GPT merge error: {}", e);
            fallback_metadata(extracted_title, extracted_author, google_data, audible_data, reliable_year)
        }
    }
}
fn fallback_metadata(
    extracted_title: &str,
    extracted_author: &str,
    google_data: Option<GoogleBookData>,
    audible_data: Option<AudibleMetadata>,
    reliable_year: Option<String>
) -> BookMetadata {
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
        cover_data: None,      // ADD THIS
        cover_mime: None,      // ADD THIS
        cover_url: None,       // ADD THIS
    }
}

async fn call_gpt_api(
    prompt: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You extract audiobook metadata. Return ONLY valid JSON, no markdown."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.3,
            "max_tokens": max_tokens
        }))
        .send()
        .await?;
    
    if !response.status().is_success() {
        return Err(format!("GPT API error: {}", response.status()).into());
    }
    
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
    
    let result: Response = response.json().await?;
    let content = result.choices.first()
        .ok_or("No GPT response")?
        .message.content.trim();
    
    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    
    Ok(json_str.to_string())
}

struct GoogleBookData {
    subtitle: Option<String>,
    description: Option<String>,
    publisher: Option<String>,
    year: Option<String>,
    genres: Vec<String>,
    isbn: Option<String>,
}

async fn fetch_google_books_data(
    title: &str,
    author: &str,
    api_key: &str,
) -> Result<Option<GoogleBookData>, Box<dyn std::error::Error + Send + Sync>> {
    
    let query = format!("intitle:{} inauthor:{}", title, author);
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&key={}",
        urlencoding::encode(&query),
        api_key
    );
    
    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;
    
    if !response.status().is_success() {
        return Ok(None);
    }
    
    #[derive(serde::Deserialize)]
    struct Response {
        #[serde(default)]
        items: Vec<Item>,
    }
    
    #[derive(serde::Deserialize)]
    struct Item {
        #[serde(rename = "volumeInfo")]
        volume_info: VolumeInfo,
    }
    
    #[derive(serde::Deserialize)]
    struct VolumeInfo {
        subtitle: Option<String>,
        description: Option<String>,
        publisher: Option<String>,
        #[serde(rename = "publishedDate")]
        published_date: Option<String>,
        categories: Option<Vec<String>>,
        #[serde(rename = "industryIdentifiers", default)]
        industry_identifiers: Vec<IndustryId>,
    }
    
    #[derive(serde::Deserialize)]
    struct IndustryId {
        #[serde(rename = "type")]
        id_type: String,
        identifier: String,
    }
    
    let books: Response = response.json().await?;
    
    if let Some(book) = books.items.first() {
        let vi = &book.volume_info;
        
        let isbn = vi.industry_identifiers.iter()
            .find(|id| id.id_type == "ISBN_13" || id.id_type == "ISBN_10")
            .map(|id| id.identifier.clone());
        
        Ok(Some(GoogleBookData {
            subtitle: vi.subtitle.clone(),
            description: vi.description.clone(),
            publisher: vi.publisher.clone(),
            year: vi.published_date.as_ref().and_then(|d| d.get(..4)).map(String::from),
            genres: vi.categories.clone().unwrap_or_default(),
            isbn,
        }))
    } else {
        Ok(None)
    }
}