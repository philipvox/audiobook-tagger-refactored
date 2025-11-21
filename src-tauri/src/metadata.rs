use serde::{Deserialize, Serialize};
use anyhow::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookMetadata {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub narrator: Option<String>,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub genres: Vec<String>,
    pub publisher: Option<String>,
    pub publish_date: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
    pub language: Option<String>,
    pub cover_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleBooksResponse {
    #[serde(default)]
    items: Vec<GoogleBookItem>,
    #[serde(rename = "totalItems", default)]
    total_items: u32,
}

#[derive(Debug, Deserialize)]
struct GoogleBookItem {
    #[serde(rename = "volumeInfo")]
    volume_info: VolumeInfo,
}

#[derive(Debug, Deserialize)]
struct VolumeInfo {
    title: Option<String>,
    subtitle: Option<String>,
    authors: Option<Vec<String>>,
    publisher: Option<String>,
    #[serde(rename = "publishedDate")]
    published_date: Option<String>,
    description: Option<String>,
    #[serde(rename = "industryIdentifiers", default)]
    industry_identifiers: Vec<IndustryId>,
    categories: Option<Vec<String>>,
    language: Option<String>,
    #[serde(rename = "imageLinks")]
    image_links: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct IndustryId {
    #[serde(rename = "type")]
    id_type: String,
    identifier: String,
}

pub async fn fetch_from_google_books(
    title: &str,
    author: &str,
) -> Result<Option<BookMetadata>> {
    let clean_title = clean_for_search(title);
    let clean_author = clean_for_search(author);
    
    println!("          📚 Google Books Query:");
    println!("             Title: '{}' | Author: '{}'", clean_title, clean_author);
    
    let query = format!("intitle:{} inauthor:{}", clean_title, clean_author);
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}",
        urlencoding::encode(&query)
    );
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    
    let response = client.get(&url).send().await?;
    
    if !response.status().is_success() {
        println!("             ❌ API error: {}", response.status());
        return Ok(None);
    }
    
    let books: GoogleBooksResponse = response.json().await?;
    
    if let Some(book) = books.items.first() {
        let vi = &book.volume_info;
        
        println!("             ✅ Found:");
        println!("                Title: {:?}", vi.title);
        println!("                Subtitle: {:?}", vi.subtitle);
        println!("                Authors: {:?}", vi.authors);
        println!("                Publisher: {:?}", vi.publisher);
        println!("                Date: {:?}", vi.published_date);
        println!("                Categories: {:?}", vi.categories);
        println!("                ISBN: {:?}", vi.industry_identifiers);
        println!("                Description: {} chars", vi.description.as_ref().map(|d| d.len()).unwrap_or(0));
        
        let isbn = vi.industry_identifiers.iter()
            .find(|id| id.id_type == "ISBN_13" || id.id_type == "ISBN_10")
            .map(|id| id.identifier.clone());
        
        let cover_url = if let Some(image_links) = &vi.image_links {
            image_links.get("extraLarge")
                .or_else(|| image_links.get("large"))
                .or_else(|| image_links.get("medium"))
                .or_else(|| image_links.get("small"))
                .or_else(|| image_links.get("thumbnail"))
                .cloned()
        } else {
            None
        };
        
        let metadata = BookMetadata {
            title: vi.title.clone(),
            subtitle: vi.subtitle.clone(),
            authors: vi.authors.clone().unwrap_or_default(),
            narrator: None,
            series: None,
            sequence: None,
            genres: vi.categories.clone().unwrap_or_default(),
            publisher: vi.publisher.clone(),
            publish_date: vi.published_date.clone(),
            description: vi.description.clone(),
            isbn,
            language: vi.language.clone(),
            cover_url,
        };
        
        Ok(Some(metadata))
    } else {
        println!("             ⚠️  No results");
        Ok(None)
    }
}

fn clean_for_search(input: &str) -> String {
    let mut cleaned = input.to_string();
    
    let patterns = [
        "(Unabridged)", "[Unabridged]", "- Unabridged",
        "(Retail)", "[Retail]", "- Retail",
        "320kbps", "128kbps", "64kbps", "256kbps",
        "- 320kbps", "- 128kbps",
        "(320)", "(128)", "[320]", "[128]",
        "Book 1", "Book 2", "Book 3",
        "#1", "#2", "#3", "#4", "#5",
    ];
    
    for pattern in &patterns {
        cleaned = cleaned.replace(pattern, " ");
    }
    
    while cleaned.contains("  ") {
        cleaned = cleaned.replace("  ", " ");
    }
    
    let trimmed = cleaned.trim();
    if trimmed.len() > 100 {
        trimmed.chars().take(100).collect()
    } else {
        trimmed.to_string()
    }
}

pub fn clean_title(title: &str) -> String {
    clean_for_search(title)
}

pub fn extract_series_from_title(title: &str) -> (String, Option<String>, Option<String>) {
    let re = regex::Regex::new(r"(?i)(.+?)(?:,|\s+[-–:])\s*(?:Book|Vol\.?|Volume|#)\s*(\d+|One|Two|Three|Four|Five)").unwrap();
    
    if let Some(caps) = re.captures(title) {
        let clean_title = caps.get(1).unwrap().as_str().trim().to_string();
        let sequence = caps.get(2).unwrap().as_str();
        let sequence_num = match sequence.to_lowercase().as_str() {
            "one" => "1",
            "two" => "2",
            "three" => "3",
            "four" => "4",
            "five" => "5",
            _ => sequence,
        }.to_string();
        
        return (clean_title.clone(), Some(clean_title), Some(sequence_num));
    }
    
    (title.to_string(), None, None)
}

pub fn extract_narrator_from_comment(comment: &str) -> Option<String> {
    let patterns = [
        r"(?i)narrated by\s+([^,\.\n]+)",
        r"(?i)read by\s+([^,\.\n]+)",
        r"(?i)performed by\s+([^,\.\n]+)",
        r"(?i)narrator:\s*([^,\.\n]+)",
    ];
    
    for pattern in &patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(comment) {
                let narrator = caps.get(1).unwrap().as_str().trim();
                if !narrator.is_empty() {
                    return Some(narrator.to_string());
                }
            }
        }
    }
    
    None
}