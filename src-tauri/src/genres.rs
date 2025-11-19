use serde::{Serialize, Deserialize};
use anyhow::Result;

pub const APPROVED_GENRES: &[&str] = &[
    "Action", "Adventure", "Anthology", "Arts", "Biography", "Business",
    "Children's", "Classic", "Collection", "Comedy", "Comics", "Coming of Age",
    "Cooking", "Crime", "Drama", "Dystopian", "Essays", "Fantasy", "Fiction",
    "Gardening", "Health", "Historical Fiction", "History", "Horror", "Humor",
    "LGBTQ+", "Magic", "Mystery", "Non-Fiction", "Paranormal", "Philosophy",
    "Poetry", "Reference", "Religion", "Romance", "Satire", "Science",
    "Science Fiction", "Self-Help", "Short Stories", "Social Science", "Sports",
    "Spirituality", "Thriller", "Time Travel", "Travel", "True Crime", "Young Adult"
];

#[derive(Debug, Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAIChoice {
    message: OpenAIMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAIMessage {
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanedMetadata {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub narrator: Option<String>,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
}

pub async fn clean_metadata_with_ai(
    title: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
    genre: Option<&str>,
    comment: Option<&str>,
    api_key: &str,
) -> Result<CleanedMetadata> {
    let cache_key = format!("{}|{}|{}|{}|{}", 
        title.unwrap_or(""), artist.unwrap_or(""), album.unwrap_or(""),
        genre.unwrap_or(""), comment.unwrap_or("")
    );
    
    if let Some(cached) = crate::genre_cache::get_metadata_cached(&cache_key) {
        println!("          💾 Cache hit!");
        return Ok(cached);
    }
    
    let approved_genres = APPROVED_GENRES.join(", ");
    
    let comment_preview = comment.map(|c| {
        if c.len() > 500 {
            format!("{}...", &c[..500])
        } else {
            c.to_string()
        }
    });
    
    let prompt = format!(
r#"You are a metadata cleaning expert for audiobook libraries. Clean and extract metadata.

CURRENT METADATA:
- Title: {}
- Author: {}
- Genre: {}
- Comment: {}

APPROVED GENRES (max 3): {}

TASKS:
1. Title: Remove (Unabridged), [Retail], 320kbps
2. Author: Clean name, remove "by", "Read by", "Narrated by"
3. Narrator: CRITICAL - Extract from comment. Look for "Narrated by", "Read by", "Performed by"
4. Genre: Map to approved genres, max 3, comma-separated
5. Series: Extract if present

Return ONLY JSON (no markdown):
{{"title":"clean title","author":"author","narrator":"narrator or null","genre":"Genre1, Genre2"}}

JSON:"#,
        title.unwrap_or("N/A"),
        artist.unwrap_or("N/A"),
        genre.unwrap_or("N/A"),
        comment_preview.as_deref().unwrap_or("N/A"),
        approved_genres
    );
    
    println!("          📤 Sending to OpenAI...");
    
    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": "gpt-5-nano",
            "messages": [{"role": "user", "content": prompt}],
            "verbosity": "low",
            "reasoning_effort": "minimal"
        }))
        .send()
        .await?;
    
    if !response.status().is_success() {
        let error_text = response.text().await?;
        println!("          ❌ API error: {}", error_text);
        anyhow::bail!("API error");
    }
    
    let response_text = response.text().await?;
    let openai_response: OpenAIResponse = serde_json::from_str(&response_text)?;
    
    if let Some(choice) = openai_response.choices.first() {
        let content = &choice.message.content;
        let json_str = content.trim()
            .trim_start_matches("```json").trim_start_matches("```")
            .trim_end_matches("```").trim();
        
        match serde_json::from_str::<CleanedMetadata>(json_str) {
            Ok(cleaned) => {
                println!("          ✅ AI: Title={:?}, Author={:?}, Narrator={:?}, Genre={:?}", 
                    cleaned.title, cleaned.author, cleaned.narrator, cleaned.genre);
                crate::genre_cache::set_metadata_cached(&cache_key, cleaned.clone());
                Ok(cleaned)
            }
            Err(e) => {
                println!("          ❌ Parse error: {}", e);
                println!("          JSON: {}", json_str);
                anyhow::bail!("Parse failed")
            }
        }
    } else {
        anyhow::bail!("No response")
    }
}

pub fn map_genre_basic(genre: &str) -> Option<String> {
    let normalized = genre.trim().to_lowercase();
    for approved in APPROVED_GENRES {
        if approved.to_lowercase() == normalized {
            return Some(approved.to_string());
        }
    }
    match normalized.as_str() {
        "personal development" => Some("Self-Help".to_string()),
        "literary fiction" => Some("Fiction".to_string()),
        "sci-fi" | "scifi" => Some("Science Fiction".to_string()),
        _ => None
    }
}

pub fn enforce_genre_policy_basic(genres: &[String]) -> Vec<String> {
    let mut approved = Vec::new();
    for genre in genres {
        if let Some(mapped) = map_genre_basic(genre) {
            if !approved.contains(&mapped) { approved.push(mapped); }
        }
        if approved.len() >= 3 { break; }
    }
    if approved.is_empty() { approved.push("Fiction".to_string()); }
    approved
}