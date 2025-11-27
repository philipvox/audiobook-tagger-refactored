use super::types::*;
use crate::config::Config;
use crate::cache;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use lofty::probe::Probe;
use lofty::tag::Accessor;
use lofty::file::TaggedFileExt;
use futures::stream::{self, StreamExt};

/// Normalize text - replace & with and, fix quotes, etc.
fn normalize_text(text: &str) -> String {
    let mut normalized = text.to_string();
    
    // Replace & with and
    normalized = normalized.replace(" & ", " and ");
    normalized = normalized.replace("&", " and ");
    
    // Normalize apostrophes and quotes
    normalized = normalized.replace("\u{2019}", "'");  // right single quote to apostrophe
    normalized = normalized.replace("\u{2018}", "'");  // left single quote to apostrophe
    normalized = normalized.replace("\u{201C}", "\""); // left double quote
    normalized = normalized.replace("\u{201D}", "\""); // right double quote
    
    // Normalize hyphens and dashes
    normalized = normalized.replace("\u{2014}", "-");  // em dash
    normalized = normalized.replace("\u{2013}", "-");  // en dash
    
    // Normalize whitespace
    normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    
    normalized.trim().to_string()
}

/// Normalize series names with additional title-casing
fn normalize_series_name(name: &str) -> String {
    let mut normalized = normalize_text(name);
    
    // Remove certain punctuation for series names
    normalized = normalized.replace(":", "");
    normalized = normalized.replace(";", "");
    normalized = normalized.replace(" - ", " ");
    
    // Title case
    normalized = normalized
        .split(' ')
        .map(|word| {
            let mut chars: Vec<char> = word.chars().collect();
            if !chars.is_empty() {
                chars[0] = chars[0].to_uppercase().next().unwrap_or(chars[0]);
                for c in chars.iter_mut().skip(1) {
                    *c = c.to_lowercase().next().unwrap_or(*c);
                }
            }
            chars.into_iter().collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(" ");
    
    // Fix common words that should be lowercase (unless first word)
    let lowercase_words = ["and", "the", "of", "in", "on", "at", "to", "for", "a", "an"];
    let words: Vec<&str> = normalized.split(' ').collect();
    normalized = words
        .iter()
        .enumerate()
        .map(|(i, word)| {
            if i > 0 && lowercase_words.contains(&word.to_lowercase().as_str()) {
                word.to_lowercase()
            } else {
                word.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    
    normalized.trim().to_string()
}

// ✅ TURBO: 50 workers, parallel metadata, cover tracking
pub async fn process_all_groups(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>
) -> Result<Vec<BookGroup>, Box<dyn std::error::Error + Send + Sync>> {
    
    // ✅ 10 workers - balanced for speed vs rate limiting on APIs
    let max_workers = 10;
    let total = groups.len();
    
    println!("⚡ TURBO SCAN: {} books, {} workers (parallel metadata, then covers)", total, max_workers);
    
    let processed_count = Arc::new(AtomicUsize::new(0));
    let covers_found = Arc::new(AtomicUsize::new(0));
    let cancel = cancel_flag.clone();
    let start_time = std::time::Instant::now();
    
    let results: Vec<_> = stream::iter(groups)
        .map(|group| {
            let config_clone = config.clone();
            let cancel_clone = cancel.clone();
            let count_clone = Arc::clone(&processed_count);
            let covers_clone = Arc::clone(&covers_found);
            let group_name = group.group_name.clone();
            
            async move {
                if let Some(ref flag) = cancel_clone {
                    if flag.load(Ordering::Relaxed) {
                        return None;
                    }
                }
                
                let result = process_book_group(group, &config_clone, cancel_clone, Arc::clone(&covers_clone)).await;
                
                let current = count_clone.fetch_add(1, Ordering::Relaxed) + 1;
                let covers = covers_clone.load(Ordering::Relaxed);
                
                // ✅ Progress every 10 books with cover count
                if current % 10 == 0 || current == total {
                    crate::progress::update_progress_with_covers(current, total, &group_name, covers);
                }
                
                result.ok()
            }
        })
        .buffer_unordered(max_workers)
        .filter_map(|x| async { x })
        .collect()
        .await;
    
    let elapsed = start_time.elapsed();
    let books_per_sec = results.len() as f64 / elapsed.as_secs_f64();
    let final_covers = covers_found.load(Ordering::Relaxed);
    println!("✅ Done: {} books, {} covers in {:.1}s ({:.1}/sec)", 
        results.len(), final_covers, elapsed.as_secs_f64(), books_per_sec);
    
    Ok(results)
}

async fn process_book_group(
    mut group: BookGroup,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    covers_found: Arc<AtomicUsize>,
) -> Result<BookGroup, Box<dyn std::error::Error + Send + Sync>> {
    
    
    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }
    
    let cache_key = format!("book_{}", group.group_name);
    
    // Check cache first - instant return if cached
    if let Some(cached_metadata) = cache::get::<BookMetadata>(&cache_key) {
        group.metadata = cached_metadata;
        group.total_changes = calculate_changes(&mut group);
        return Ok(group);
    }
    
    
    // Read first file's tags
    let sample_file = &group.files[0];
    let file_tags = read_file_tags(&sample_file.path);
    
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
    
    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }
    
    // Extract with GPT (or fallback to tags)
    let (extracted_title, extracted_author) = extract_book_info_with_gpt(
        &raw_file,
        &group.group_name,
        config.openai_api_key.as_deref()
    ).await;
    
    
    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }
    
    // ✅ TURBO: Fetch Google Books AND Audible in parallel (metadata only)
    let title_clone = extracted_title.clone();
    let author_clone = extracted_author.clone();
    let google_api_key = config.google_books_api_key.clone();
    
    let google_future = async {
        if let Some(ref api_key) = google_api_key {
            fetch_google_books_data(&title_clone, &author_clone, api_key).await.ok().flatten()
        } else {
            None
        }
    };
    
    let title_clone2 = extracted_title.clone();
    let author_clone2 = extracted_author.clone();
    let audible_future = fetch_audible_metadata(&title_clone2, &author_clone2);
    
    // ✅ Run metadata fetches in parallel (NOT cover - we need ASIN first!)
    let (google_data, audible_data) = tokio::join!(
        google_future,
        audible_future
    );
    
    if let Some(ref aud) = audible_data {
    }
    
    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }
    
    // ✅ NOW fetch cover - we have ASIN from Audible if available
    let asin = audible_data.as_ref().and_then(|d| d.asin.clone());
    let cover_art = match crate::cover_art::fetch_and_download_cover(
        &extracted_title,
        &extracted_author,
        asin.as_deref(),  // ✅ Pass ASIN so Audible covers work!
        config.google_books_api_key.as_deref(),
    ).await {
        Ok(cover) if cover.data.is_some() => {
            if let Some(ref data) = cover.data {
                let cover_cache_key = format!("cover_{}", group.id);
                let mime_type = cover.mime_type.clone().unwrap_or_else(|| "image/jpeg".to_string());
                let _ = cache::set(&cover_cache_key, &(data.clone(), mime_type));
                // ✅ Track cover found
                covers_found.fetch_add(1, Ordering::Relaxed);
            }
            Some(cover)
        }
        _ => None
    };
    
    // If we still don't have data, try GPT enrichment as last resort
    let needs_gpt_enrichment = google_data.is_none() && audible_data.is_none();
    
    if let Some(ref flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Ok(group);
        }
    }
    
    // Merge all metadata with GPT
    let mut final_metadata = if needs_gpt_enrichment {
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
    
    // Add cover URL to metadata (data is cached separately)
    if let Some(cover) = cover_art {
        final_metadata.cover_url = cover.url;
        final_metadata.cover_mime = cover.mime_type;
    }
    
    
    group.metadata = final_metadata;
    
    // Cache the result
    let _ = cache::set(&cache_key, &group.metadata);
    
    // Calculate changes
    group.total_changes = calculate_changes(&mut group);
    
    Ok(group)
}

async fn fetch_audible_metadata(
    title: &str,
    author: &str,
) -> Option<AudibleMetadata> {
    // Build search query for Audible website
    let search_query = format!("{} {}", title, author);
    // Simple URL encoding
    let encoded_query = search_query
        .replace(' ', "+")
        .replace('&', "%26")
        .replace('\'', "%27");
    let search_url = format!(
        "https://www.audible.com/search?keywords={}",
        encoded_query
    );
    
    
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .ok()?;
    
    let response = match client.get(&search_url).send().await {
        Ok(r) => r,
        Err(e) => {
            return None;
        }
    };
    
    let html = match response.text().await {
        Ok(h) => h,
        Err(e) => {
            return None;
        }
    };
    
    // Parse the search results page to find the first result ASIN
    // Look for product link pattern: /pd/Title/ASIN
    let asin_regex = regex::Regex::new(r#"/pd/[^/]+/([A-Z0-9]{10})"#).ok()?;
    let asin = match asin_regex.captures(&html) {
        Some(caps) => caps.get(1)?.as_str().to_string(),
        None => {
            // Try alternate pattern
            let alt_regex = regex::Regex::new(r#"data-asin="([A-Z0-9]{10})""#).ok()?;
            match alt_regex.captures(&html) {
                Some(caps) => caps.get(1)?.as_str().to_string(),
                None => {
                    return None;
                }
            }
        }
    };
    
    
    // Now fetch the product details page
    let product_url = format!("https://www.audible.com/pd/{}", asin);
    let product_response = match client.get(&product_url).send().await {
        Ok(r) => r,
        Err(e) => {
            return None;
        }
    };
    
    let product_html = match product_response.text().await {
        Ok(h) => h,
        Err(e) => {
            return None;
        }
    };
    
    // Extract title from og:title meta tag (most reliable)
    let title_regex = regex::Regex::new(r#"<meta[^>]*property="og:title"[^>]*content="([^"]+)""#).ok()?;
    let extracted_title = title_regex.captures(&product_html)
        .and_then(|c| c.get(1))
        .map(|m| {
            let t = m.as_str().trim();
            // Remove " (Audiobook)" suffix if present
            t.replace(" (Audiobook)", "").replace(" Audiobook", "")
        });
    
    // Also try alternate title pattern
    let extracted_title = extracted_title.or_else(|| {
        let alt_title_regex = regex::Regex::new(r#"<h1[^>]*>([^<]+)</h1>"#).ok()?;
        alt_title_regex.captures(&product_html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
    });
    
    
    // Extract author - look for "By:" or author link
    let author_regex = regex::Regex::new(r#"/author/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
    let extracted_author = author_regex.captures(&product_html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());
    
    // Extract narrator - look for "Narrated by:" pattern
    let narrator_regex = regex::Regex::new(r#"/narrator/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
    let extracted_narrator = narrator_regex.captures(&product_html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());
    
    // Extract series info - THIS IS THE KEY PART
    // Pattern 1: Look for series link followed by "Book X"
    // Example: <a href="/series/Mr-Putter-Tabby/...">Mr. Putter & Tabby</a>, Book 14
    let series_with_book_regex = regex::Regex::new(
        r#"/series/[^"]*"[^>]*>([^<]+)</a>[^<]*,?\s*Book\s*(\d+)"#
    ).ok()?;
    
    let (series_name, series_position) = if let Some(caps) = series_with_book_regex.captures(&product_html) {
        let name = caps.get(1).map(|m| m.as_str().trim().to_string());
        let position = caps.get(2).map(|m| m.as_str().to_string());
        (name, position)
    } else {
        // Pattern 2: Try looking in the breadcrumb or metadata area
        // Sometimes it's formatted as "Series Name, Book X" without the link structure
        let series_text_regex = regex::Regex::new(
            r#"([^<>"]+),\s*Book\s*(\d+)\s*</a>"#
        ).ok()?;
        
        if let Some(caps) = series_text_regex.captures(&product_html) {
            let name = caps.get(1).map(|m| m.as_str().trim().to_string());
            let position = caps.get(2).map(|m| m.as_str().to_string());
            (name, position)
        } else {
            // Pattern 3: Just find series name without position
            let series_only_regex = regex::Regex::new(r#"/series/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
            let name = series_only_regex.captures(&product_html)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string());
            if name.is_some() {
            }
            (name, None)
        }
    };
    
    // Extract publisher
    let publisher_regex = regex::Regex::new(r#"/publisher/[^"]*"[^>]*>([^<]+)</a>"#).ok()?;
    let publisher = publisher_regex.captures(&product_html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());
    
    // Extract release date from JSON-LD or meta
    let date_regex = regex::Regex::new(r#""datePublished"\s*:\s*"([^"]+)""#).ok()?;
    let release_date = date_regex.captures(&product_html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    
    let series_vec = if let Some(name) = series_name {
        vec![AudibleSeries {
            name,
            position: series_position,
        }]
    } else {
        vec![]
    };
    
    Some(AudibleMetadata {
        asin: Some(asin),
        title: extracted_title,
        authors: extracted_author.map(|a| vec![a]).unwrap_or_default(),
        narrators: extracted_narrator.map(|n| vec![n]).unwrap_or_default(),
        series: series_vec,
        publisher,
        release_date,
        description: None,
    })
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
                    FileTags { title: None, artist: None, album: None, genre: None, year: None, comment: None }
                }
            },
            Err(_) => FileTags { title: None, artist: None, album: None, genre: None, year: None, comment: None },
        },
        Err(_) => FileTags { title: None, artist: None, album: None, genre: None, year: None, comment: None },
    }
}

#[derive(Clone)]
struct RawFileData {
    path: String,
    filename: String,
    parent_dir: String,
    tags: FileTags,
}

fn calculate_changes(group: &mut BookGroup) -> usize {
    let mut total_changes = 0;
    
    for file in &mut group.files {
        file.changes.clear();
        
        let existing_tags = match Probe::open(&file.path) {
            Ok(probe) => match probe.read() {
                Ok(tagged) => {
                    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
                    tag.map(|t| (
                        t.title().map(|s| s.to_string()),
                        t.artist().map(|s| s.to_string()),
                        t.album().map(|s| s.to_string()),
                    ))
                },
                Err(_) => None,
            },
            Err(_) => None,
        };
        
        if let Some((existing_title, existing_artist, existing_album)) = existing_tags {
            if existing_title.as_deref() != Some(&group.metadata.title) {
                file.changes.insert("title".to_string(), MetadataChange {
                    old: existing_title.unwrap_or_default(),
                    new: group.metadata.title.clone(),
                });
                total_changes += 1;
            }
            
            if existing_artist.as_deref() != Some(&group.metadata.author) {
                file.changes.insert("author".to_string(), MetadataChange {
                    old: existing_artist.unwrap_or_default(),
                    new: group.metadata.author.clone(),
                });
                total_changes += 1;
            }
            
            if existing_album.as_deref() != Some(&group.metadata.title) {
                file.changes.insert("album".to_string(), MetadataChange {
                    old: existing_album.unwrap_or_default(),
                    new: group.metadata.title.clone(),
                });
                total_changes += 1;
            }
        } else {
            file.changes.insert("title".to_string(), MetadataChange {
                old: String::new(),
                new: group.metadata.title.clone(),
            });
            file.changes.insert("author".to_string(), MetadataChange {
                old: String::new(),
                new: group.metadata.author.clone(),
            });
            file.changes.insert("album".to_string(), MetadataChange {
                old: String::new(),
                new: group.metadata.title.clone(),
            });
            total_changes += 3;
        }
        
        if let Some(ref narrator) = group.metadata.narrator {
            file.changes.insert("narrator".to_string(), MetadataChange {
                old: String::new(),
                new: narrator.clone(),
            });
            total_changes += 1;
        }
        
        if !group.metadata.genres.is_empty() {
            file.changes.insert("genre".to_string(), MetadataChange {
                old: String::new(),
                new: group.metadata.genres.join(", "),
            });
            total_changes += 1;
        }
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
                    Err(e) => {
                        if attempt == 2 {
                            return (
                                sample_file.tags.title.clone().unwrap_or_else(|| folder_name.to_string()),
                                sample_file.tags.artist.clone().unwrap_or_else(|| String::from("Unknown"))
                            );
                        }
                    }
                }
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
            return BookMetadata {
                title: extracted_title.to_string(),
                author: extracted_author.to_string(),
                subtitle: None,
                narrator: None,
                series: extract_series_from_folder(folder_name).0.map(|s| normalize_series_name(&s)),
                sequence: extract_series_from_folder(folder_name).1,
                genres: vec![],
                publisher: None,
                year: None,
                description: None,
                isbn: None,
                asin: None,
                cover_mime: None,
                cover_url: None,
            };
        }
    };
    
    let prompt = format!(
r#"You are enriching audiobook metadata using your knowledge.

FOLDER NAME: {}
TITLE: {}
AUTHOR: {}
COMMENT TAG: {:?}

Based on your knowledge, provide metadata for this audiobook:

1. Narrator: Check comment field or use your knowledge
2. Series: What series does this book belong to?
3. Sequence: See SEQUENCE DETERMINATION below
4. Genres: Provide 1-4 appropriate genres from this list: {}
5. Publisher: If you know the publisher
6. Year: Publication year AS A STRING
7. Description: A brief 2-3 sentence description

SEQUENCE DETERMINATION - THINK STEP BY STEP:
1. Identify the series this book belongs to
2. List the books in this series by publication year (earliest first)
3. Find this book's position in that chronological order
4. Return that position number as a string

Example for "Mr. Putter & Tabby Walk the Dog" by Cynthia Rylant:
- Series started 1994 with "Pour the Tea" (#1)
- "Walk the Dog" was published 1994 as the 2nd book
- So sequence = "2"

DO NOT default to "1" - think through the actual publication order.

IMPORTANT: All values must be strings or null. Numbers like 14 must be written as "14".

Return ONLY valid JSON:
{{
  "narrator": null,
  "series": "series name or null",
  "sequence": "position in publication order",
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
            match serde_json::from_str::<serde_json::Value>(&json_str) {
                Ok(json) => {
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
                    
                    let series = json.get("series").and_then(get_string).map(|s| normalize_series_name(&s));
                    let sequence = json.get("sequence").and_then(get_string);
                    
                    BookMetadata {
                        title: extracted_title.to_string(),
                        author: extracted_author.to_string(),
                        subtitle: None,
                        narrator: json.get("narrator").and_then(get_string),
                        series,
                        sequence,
                        genres: json.get("genres").map(get_string_array).unwrap_or_default(),
                        publisher: json.get("publisher").and_then(get_string),
                        year: json.get("year").and_then(get_string),
                        description: json.get("description").and_then(get_string),
                        isbn: None,
                        asin: None,
                        cover_mime: None,
                        cover_url: None,
                    }
                }
                Err(e) => {
                    BookMetadata {
                        title: extracted_title.to_string(),
                        author: extracted_author.to_string(),
                        subtitle: None,
                        narrator: None,
                        series: extract_series_from_folder(folder_name).0.map(|s| normalize_series_name(&s)),
                        sequence: extract_series_from_folder(folder_name).1,
                        genres: vec![],
                        publisher: None,
                        year: None,
                        description: None,
                        isbn: None,
                        asin: None,
                        cover_mime: None,
                        cover_url: None,
                    }
                }
            }
        }
        Err(_) => {
            BookMetadata {
                title: extracted_title.to_string(),
                author: extracted_author.to_string(),
                subtitle: None,
                narrator: None,
                series: extract_series_from_folder(folder_name).0.map(|s| normalize_series_name(&s)),
                sequence: extract_series_from_folder(folder_name).1,
                genres: vec![],
                publisher: None,
                year: None,
                description: None,
                isbn: None,
                asin: None,
                cover_mime: None,
                cover_url: None,
            }
        }
    }
}

fn extract_series_from_folder(folder_name: &str) -> (Option<String>, Option<String>) {
    if let Some(book_num) = extract_book_number_from_folder(folder_name) {
        let patterns = [
            regex::Regex::new(r"(.+?)\s+(?:Book\s*[#]?)?\d+").ok(),
            regex::Regex::new(r"(.+?)\s+[#]\d+").ok(),
            regex::Regex::new(r"\[(.+?)\s+\d+\]").ok(),
        ];
        
        for pattern in patterns.iter().flatten() {
            if let Some(caps) = pattern.captures(folder_name) {
                if let Some(series_name) = caps.get(1) {
                    return (Some(normalize_series_name(series_name.as_str().trim())), Some(book_num));
                }
            }
        }
        
        return (None, Some(book_num));
    }
    
    (None, None)
}

#[derive(serde::Deserialize, Debug)]
struct AudibleMetadata {
    asin: Option<String>,
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
    if let Some(ref aud) = audible_data {
        for s in &aud.series {
        }
    } else {
    }
    
    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            return fallback_metadata(extracted_title, extracted_author, google_data, audible_data, None);
        }
    };
    
    let reliable_year = audible_data.as_ref()
        .and_then(|d| d.release_date.clone())
        .and_then(|date| date.split('-').next().map(|s| s.to_string()))
        .or_else(|| {
            google_data.as_ref()
                .and_then(|d| d.year.clone())
        });
    
    // Extract Audible series info BEFORE consuming for summary
    // This is the authoritative source for sequence numbers!
    let audible_series = audible_data.as_ref()
        .and_then(|d| d.series.first())
        .map(|s| (s.name.clone(), s.position.clone()));
    
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

APPROVED GENRES (maximum 3, comma separated):
{}

OUTPUT FIELDS:
* title: Book title only. Remove junk and remove all series markers.
* subtitle: Use only if provided by Google Books or Audible.
* author: Clean and standardized.
* narrator: Use Audible narrators or find in comments.
* series: The series this book belongs to.
* sequence: See SEQUENCE DETERMINATION below.
* genres: Select one to three from the approved list. If the book is clearly for young children (picture books, early readers, etc.), always include "Children's". If the book is for young adults (YA), include "Young Adult" or other appropriate tags such as "Fantasy", "Romance", or "Science Fiction" based on the content. Use your best judgment to match the tone, audience, and themes.
* publisher: Prefer Google Books or Audible.
* {}
* description: Short description from Google Books or Audible, minimum length 200 characters.
* isbn: From Google Books.

SEQUENCE DETERMINATION - THINK STEP BY STEP:
1. Identify the series name (e.g., "Mr. Putter & Tabby")
2. Recall ALL books in this series in publication order by release year
3. Find where THIS specific book title falls in that chronological list
4. The sequence number is its position (1st published = "1", 5th published = "5", etc.)

For example, Mr. Putter & Tabby series by Cynthia Rylant:
- "Pour the Tea" (1994) = "1"
- "Walk the Dog" (1994) = "2" 
- "Bake the Cake" (1994) = "3"
- "Pick the Pears" (1995) = "4"
- ... and so on through all 26+ books

DO NOT guess "1" or "2" - actually recall the publication order.
If you don't know the exact position, estimate based on the title's publication year relative to when the series started.

Return ONLY valid JSON:
{{
  "title": "specific book title",
  "subtitle": null,
  "author": "author name",
  "narrator": "narrator name or null",
  "series": "series name or null",
  "sequence": "number based on publication order",
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
                    
                    // Override with reliable data
                    if let Some(year) = reliable_year {
                        metadata.year = Some(year);
                    }
                    
                    // Normalize series name
                    if let Some(ref series) = metadata.series {
                        metadata.series = Some(normalize_series_name(series));
                    }
                    
                    // CRITICAL: Use Audible's sequence if available - it's authoritative!
                    if let Some((ref audible_series_name, ref audible_position)) = audible_series {
                        if let Some(ref pos) = audible_position {
                            metadata.sequence = Some(pos.clone());
                        }
                        // Also use Audible's series name if GPT didn't find one
                        if metadata.series.is_none() {
                            metadata.series = Some(normalize_series_name(audible_series_name));
                        }
                    }
                    
                    metadata
                }
                Err(e) => {
                    fallback_metadata(extracted_title, extracted_author, google_data, audible_data, reliable_year)
                }
            }
        }
        Err(e) => {
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
            .and_then(|d| d.series.first().map(|s| normalize_series_name(&s.name))),
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
        asin: audible_data.as_ref().and_then(|d| d.asin.clone()),
        cover_mime: None,
        cover_url: None,
    }
}

async fn call_gpt_api(
    prompt: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();
    
    // GPT-5 models require temperature=1 or omitted
    let is_gpt5 = model.starts_with("gpt-5");
    
    let body = if is_gpt5 {
        // GPT-5 models: no temperature, use max_completion_tokens, add reasoning_effort
        serde_json::json!({
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
            "max_completion_tokens": max_tokens + 2000,
            "reasoning_effort": "high"
        })
    } else {
        serde_json::json!({
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
        })
    };
    
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await?;
    
    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("GPT API error: {}", error_text).into());
    }
    
    let response_text = response.text().await?;
    
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
    
    let result: Response = match serde_json::from_str(&response_text) {
        Ok(r) => r,
        Err(e) => {
            return Err(format!("Parse error: {}", e).into());
        }
    };
    
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
    // Simple URL encoding without external crate
    let encoded_query = query
        .replace(' ', "+")
        .replace('&', "%26")
        .replace('\'', "%27")
        .replace(':', "%3A");
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&key={}",
        encoded_query,
        api_key
    );
    
    
    let client = reqwest::Client::new();
    let response = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(None);
        }
    };
    
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
    
    let books: Response = match response.json().await {
        Ok(b) => b,
        Err(e) => {
            return Ok(None);
        }
    };
    
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