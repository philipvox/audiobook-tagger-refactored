use crate::metadata::{BookMetadata, clean_title, extract_series_from_title, extract_narrator_from_comment, fetch_from_google_books};
use crate::genres::APPROVED_GENRES;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessedMetadata {
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
}

pub async fn process_metadata(
    raw_title: Option<&str>,
    raw_artist: Option<&str>,
    _raw_album: Option<&str>,
    raw_genre: Option<&str>,
    raw_comment: Option<&str>,
    use_google_books: bool,
    api_key: Option<&str>,
) -> Result<ProcessedMetadata> {
    println!("          🔄 Processing metadata...");
    
    // Step 1: Clean basic fields
    let clean_title_str = raw_title.map(clean_title).unwrap_or_default();
    let (title_without_series, series, sequence) = extract_series_from_title(&clean_title_str);
    
    let author = raw_artist.unwrap_or("Unknown").to_string();
    
    // Step 2: Try Google Books if enabled
    let mut google_data: Option<BookMetadata> = None;
    if use_google_books && !title_without_series.is_empty() && !author.is_empty() {
        google_data = fetch_from_google_books(&title_without_series, &author).await.ok().flatten();
    }
    
    // Step 3: Extract narrator from comment
    let narrator = raw_comment
        .and_then(extract_narrator_from_comment)
        .or_else(|| google_data.as_ref().and_then(|g| g.narrator.clone()));
    
    // Step 4: Merge genres from multiple sources
    let mut all_genres = Vec::new();
    
    // From file tags
    if let Some(g) = raw_genre {
        all_genres.extend(g.split(&[',', ';'][..]).map(|s| s.trim().to_string()));
    }
    
    // From Google Books
    if let Some(ref google) = google_data {
        all_genres.extend(google.genres.clone());
    }
    
    // Step 5: Map genres to approved list
    let mapped_genres = map_genres_to_approved(&all_genres);
    
    // Step 6: Get description - prefer Google Books, fallback to cleaned comment
    let description = google_data.as_ref()
        .and_then(|g| g.description.clone())
        .and_then(|d| clean_description(&d))
        .or_else(|| {
            raw_comment
                .map(|c| c.to_string())
                .and_then(|c| clean_description(&c))
        });
    
    // Step 7: Use AI for final enhancement if API key provided
    let final_metadata = if let Some(key) = api_key {
        enhance_with_ai(
            &title_without_series,
            &author,
            narrator.as_deref(),
            &mapped_genres,
            description.as_deref(),
            series.as_deref(),
            sequence.as_deref(),
            google_data.as_ref(),
            key
        ).await?
    } else {
        ProcessedMetadata {
            title: title_without_series.clone(),
            subtitle: google_data.as_ref().and_then(|g| g.subtitle.clone()),
            author: author.clone(),
            narrator,
            series: series.clone(),
            sequence: sequence.clone(),
            genres: mapped_genres,
            publisher: google_data.as_ref().and_then(|g| g.publisher.clone()),
            year: google_data.as_ref().and_then(|g| g.publish_date.clone().map(|d| d[..4].to_string())),
            description,
        }
    };
    
    Ok(final_metadata)
}

fn clean_description(desc: &str) -> Option<String> {
    // Remove common debug/code patterns
    let cleaned = desc
        .replace("Some(\"", "")
        .replace("\")", "")
        .replace("[\"", "")
        .replace("\"]", "");
    
    // Remove lines that look like debug output
    let lines: Vec<&str> = cleaned
        .lines()
        .filter(|line| {
            let l = line.trim();
            !l.starts_with("Title:") &&
            !l.starts_with("Authors:") &&
            !l.starts_with("Publisher:") &&
            !l.starts_with("Date:") &&
            !l.contains("ABOUT")
        })
        .collect();
    
    let clean_text = lines.join("\n").trim().to_string();
    
    // Remove "narrated by" sections
    let re_narrator = regex::Regex::new(r"(?i)narrated by [^\n\.]+\.?").ok()?;
    let without_narrator = re_narrator.replace_all(&clean_text, "").to_string();
    
    let trimmed = without_narrator.trim();
    
    // Only return if substantial (at least 50 chars)
    if trimmed.len() >= 50 {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn map_genres_to_approved(genres: &[String]) -> Vec<String> {
    let mut approved = Vec::new();
    
    for genre in genres {
        let normalized = genre.trim().to_lowercase();
        
        // Exact match
        for &approved_genre in APPROVED_GENRES {
            if approved_genre.to_lowercase() == normalized {
                if !approved.contains(&approved_genre.to_string()) {
                    approved.push(approved_genre.to_string());
                }
                break;
            }
        }
        
        // Fuzzy matches
        let mapped = match normalized.as_str() {
            "personal development" | "self improvement" => Some("Self-Help"),
            "sci-fi" | "scifi" | "science-fiction" => Some("Science Fiction"),
            "ya" | "teen" => Some("Young Adult"),
            "children" | "childrens" | "kids" => Some("Children's"),
            "literary fiction" | "contemporary" => Some("Fiction"),
            _ => None,
        };
        
        if let Some(m) = mapped {
            if !approved.contains(&m.to_string()) {
                approved.push(m.to_string());
            }
        }
        
        if approved.len() >= 3 {
            break;
        }
    }
    
    if approved.is_empty() {
        approved.push("Fiction".to_string());
    }
    
    approved
}

async fn enhance_with_ai(
    title: &str,
    author: &str,
    narrator: Option<&str>,
    genres: &[String],
    description: Option<&str>,
    series: Option<&str>,
    sequence: Option<&str>,
    google_data: Option<&BookMetadata>,
    api_key: &str,
) -> Result<ProcessedMetadata> {
    // Build context for AI
    let mut context = format!("Book Title: {}\nAuthor: {}", title, author);
    
    if let Some(s) = series {
        context.push_str(&format!("\nSeries: {}", s));
        if let Some(seq) = sequence {
            context.push_str(&format!(" (Book #{})", seq));
        }
    }
    if !genres.is_empty() {
        context.push_str(&format!("\nGenres: {}", genres.join(", ")));
    }
    if let Some(n) = narrator {
        context.push_str(&format!("\nNarrator: {}", n));
    }
    if let Some(d) = description {
        // Limit description length in prompt
        let desc_preview = if d.len() > 500 {
            format!("{}...", &d[..500])
        } else {
            d.to_string()
        };
        context.push_str(&format!("\nExisting Description: {}", desc_preview));
    }
    
    let prompt = format!(
r#"You are a metadata expert for audiobooks. Enhance the following audiobook metadata.

{}

REQUIREMENTS:
1. Return ONLY valid JSON (no markdown, no code fences, no extra text)
2. Keep title and author EXACTLY as provided unless obviously malformed
3. Description MUST be:
   - At least 150 characters
   - Well-formatted and engaging
   - NOT include narrator information
   - NOT include debug strings or code artifacts
4. If description is missing, write a compelling one based on the title/genre
5. Narrator should ONLY be the person's name (no "Narrated by" prefix)
6. Genres must be from: {}
7. Year in YYYY format

JSON FORMAT:
{{
  "title": "exact title",
  "subtitle": null,
  "narrator": "Name Only" or null,
  "description": "compelling description (150+ chars, no narrator info)",
  "genres": ["Genre1", "Genre2"],
  "publisher": "Publisher Name" or null,
  "year": "YYYY" or null
}}"#,
        context,
        APPROVED_GENRES.join(", ")
    );
    
    println!("          🤖 Calling GPT-5-nano for metadata enhancement...");
    
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
                    "content": "You are a metadata expert. Return ONLY valid JSON. No markdown formatting, no code fences, just pure JSON."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.3,
            "max_completion_tokens": 1000,
            "verbosity": "low",
            "reasoning_effort": "minimal"
        }))
        .send()
        .await?;
    
    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        println!("          ⚠️  GPT API error: {} - {}", status, error_text);
        
        // Fallback to basic metadata
        return Ok(ProcessedMetadata {
            title: title.to_string(),
            subtitle: google_data.and_then(|g| g.subtitle.clone()),
            author: author.to_string(),
            narrator: narrator.map(String::from),
            series: series.map(String::from),
            sequence: sequence.map(String::from),
            genres: genres.to_vec(),
            publisher: google_data.and_then(|g| g.publisher.clone()),
            year: google_data.and_then(|g| g.publish_date.clone().map(|d| d[..4].to_string())),
            description: description.map(String::from),
        });
    }
    
    #[derive(Deserialize)]
    struct Response {
        choices: Vec<Choice>,
    }
    
    #[derive(Deserialize)]
    struct Choice {
        message: Message,
    }
    
    #[derive(Deserialize)]
    struct Message {
        content: String,
    }
    
    #[derive(Deserialize)]
    struct AIMetadata {
        title: String,
        subtitle: Option<String>,
        narrator: Option<String>,
        description: Option<String>,
        genres: Vec<String>,
        publisher: Option<String>,
        year: Option<String>,
    }
    
    let result: Response = response.json().await?;
    let content = result.choices.first()
        .map(|c| c.message.content.trim())
        .ok_or_else(|| anyhow::anyhow!("No GPT response"))?;
    
    println!("          📝 GPT Response received");
    
    // Clean up response - remove markdown fences if present
    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    
    let ai_meta: AIMetadata = serde_json::from_str(json_str)
        .map_err(|e| {
            println!("          ❌ Failed to parse GPT JSON: {}", e);
            println!("          Raw response: {}", json_str);
            e
        })?;
    
    // Validate description length
    let final_description = ai_meta.description
        .filter(|d| d.len() >= 100)
        .or_else(|| description.map(String::from));
    
    println!("          ✅ Metadata enhanced successfully");
    if let Some(ref desc) = final_description {
        println!("          📖 Description: {} chars", desc.len());
    }
    
    Ok(ProcessedMetadata {
        title: ai_meta.title,
        subtitle: ai_meta.subtitle,
        author: author.to_string(),
        narrator: ai_meta.narrator.or_else(|| narrator.map(String::from)),
        series: series.map(String::from),
        sequence: sequence.map(String::from),
        genres: ai_meta.genres,
        publisher: ai_meta.publisher.or_else(|| google_data.and_then(|g| g.publisher.clone())),
        year: ai_meta.year.or_else(|| google_data.and_then(|g| g.publish_date.clone().map(|d| d[..4].to_string()))),
        description: final_description,
    })
}