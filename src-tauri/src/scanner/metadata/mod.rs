// src-tauri/src/scanner/metadata/mod.rs - Complete with GPT extraction
use super::types::*;
use crate::config::Config;
use crate::cache;
use serde::{Deserialize, Serialize};

pub async fn enrich_metadata(
    group: &BookGroup,
    config: &Config,
) -> Result<BookMetadata, Box<dyn std::error::Error + Send + Sync>> {
    
    let cache_key = format!("metadata_{}", group.group_name);
    
    // Check cache first
    if let Some(cached) = cache::get::<BookMetadata>(&cache_key) {
        println!("✨ Cache hit for: {}", group.group_name);
        return Ok(cached);
    }
    
    println!("📖 Processing: {}", group.group_name);
    
    // Extract with GPT
    let mut metadata = extract_with_gpt(&group.group_name, config).await?;
    
    // Enhance with Google Books if API key available
    if let Some(ref api_key) = config.google_books_api_key {
        if let Ok(Some(google_data)) = fetch_google_books(&metadata.title, &metadata.author, api_key).await {
            metadata = merge_with_google(metadata, google_data);
        }
    }
    
    // Cache the result
    cache::set(&cache_key, &metadata)?;
    
    Ok(metadata)
}

async fn extract_with_gpt(
    folder_name: &str,
    config: &Config,
) -> Result<BookMetadata, Box<dyn std::error::Error + Send + Sync>> {
    
    let api_key = config.openai_api_key.as_ref()
        .ok_or("OpenAI API key not configured")?;
    
    let prompt = format!(
r#"Extract audiobook metadata from this folder name: "{}"

Return ONLY valid JSON (no markdown, no code fences):
{{
  "title": "book title",
  "author": "author name",
  "narrator": "narrator name or null",
  "series": "series name or null",
  "sequence": "book number or null",
  "year": "YYYY or null"
}}

Rules:
- Remove file artifacts like [Unabridged], (Retail), bitrates
- Extract series info (e.g. "Book 1" -> series name + sequence: "1")
- Be precise with title and author"#, folder_name);

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "You extract audiobook metadata. Return ONLY valid JSON."},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.3,
            "max_tokens": 300
        }))
        .send()
        .await?;
    
    #[derive(Deserialize)]
    struct Response { choices: Vec<Choice> }
    
    #[derive(Deserialize)]
    struct Choice { message: Message }
    
    #[derive(Deserialize)]
    struct Message { content: String }
    
    #[derive(Deserialize)]
    struct GPTMetadata {
        title: String,
        author: String,
        narrator: Option<String>,
        series: Option<String>,
        sequence: Option<String>,
        year: Option<String>,
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
    
    let gpt: GPTMetadata = serde_json::from_str(json_str)?;
    
    Ok(BookMetadata {
        title: gpt.title,
        author: gpt.author,
        subtitle: None,
        narrator: gpt.narrator,
        series: gpt.series,
        sequence: gpt.sequence,
        genres: vec![],
        description: None,
        publisher: None,
        year: gpt.year,
        isbn: None,
    })
}

async fn fetch_google_books(
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
    
    #[derive(Deserialize)]
    struct Response {
        #[serde(default)]
        items: Vec<Item>,
    }
    
    #[derive(Deserialize)]
    struct Item {
        #[serde(rename = "volumeInfo")]
        volume_info: VolumeInfo,
    }
    
    #[derive(Deserialize)]
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
    
    #[derive(Deserialize)]
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

#[derive(Debug)]
struct GoogleBookData {
    subtitle: Option<String>,
    description: Option<String>,
    publisher: Option<String>,
    year: Option<String>,
    genres: Vec<String>,
    isbn: Option<String>,
}

fn merge_with_google(mut metadata: BookMetadata, google: GoogleBookData) -> BookMetadata {
    metadata.subtitle = metadata.subtitle.or(google.subtitle);
    metadata.description = metadata.description.or(google.description);
    metadata.publisher = metadata.publisher.or(google.publisher);
    metadata.year = metadata.year.or(google.year);
    metadata.isbn = metadata.isbn.or(google.isbn);
    
    if metadata.genres.is_empty() {
        metadata.genres = google.genres;
    }
    
    metadata
}