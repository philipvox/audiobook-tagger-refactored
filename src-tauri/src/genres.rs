use serde::{Serialize, Deserialize};
use anyhow::Result;
use std::collections::HashMap;

/// Primary approved genres for audiobook categorization
/// These are the genres that will be written to file tags
pub const APPROVED_GENRES: &[&str] = &[
    // Fiction Genres
    "Action", "Adventure", "Anthology", "Chick Lit", "Classic", "Collection",
    "Comedy", "Coming of Age", "Contemporary", "Crime", "Drama", "Dystopian",
    "Erotica", "Family Saga", "Fantasy", "Fiction", "Gothic", "Historical Fiction",
    "Horror", "Humor", "Legal Thriller", "Literary Fiction", "Magic", "Military",
    "Mystery", "Mythology", "Paranormal", "Political Thriller", "Post-Apocalyptic",
    "Psychological Thriller", "Romance", "Satire", "Science Fiction", "Short Stories",
    "Spy", "Supernatural", "Suspense", "Techno-Thriller", "Thriller", "Time Travel",
    "Urban Fantasy", "War", "Western", "Women's Fiction",

    // Non-Fiction Genres
    "Arts", "Autobiography", "Biography", "Business", "Cooking", "Current Events",
    "Economics", "Education", "Essays", "Gardening", "Health", "History", "Humor",
    "Journalism", "LGBTQ+", "Memoir", "Music", "Nature", "Non-Fiction", "Parenting",
    "Philosophy", "Photography", "Poetry", "Politics", "Psychology", "Reference",
    "Religion", "Science", "Self-Help", "Social Science", "Spirituality", "Sports",
    "Technology", "Travel", "True Crime",

    // Children's Age Categories (IMPORTANT - these are mutually exclusive)
    "Children's 0-2",      // Baby/Toddler books
    "Children's 3-5",      // Preschool/Kindergarten
    "Children's 6-8",      // Early Reader/Chapter Books
    "Children's 9-12",     // Middle Grade
    "Teen 13-17",          // Young Adult / Teen

    // Legacy age categories (for backwards compatibility)
    "Children's", "Middle Grade", "Teen", "Young Adult", "Adult", "New Adult",

    // Format/Style
    "Graphic Novel", "Comics", "Manga",
];

/// Children's series with known age ranges
pub fn get_children_series_ages() -> std::collections::HashMap<&'static str, &'static str> {
    let mut map = std::collections::HashMap::new();

    // Ages 0-2 (Baby/Toddler)
    map.insert("goodnight moon", "Children's 0-2");
    map.insert("pat the bunny", "Children's 0-2");
    map.insert("brown bear", "Children's 0-2");
    map.insert("eric carle", "Children's 0-2");
    map.insert("sandra boynton", "Children's 0-2");

    // Ages 3-5 (Preschool)
    map.insert("curious george", "Children's 3-5");
    map.insert("peppa pig", "Children's 3-5");
    map.insert("paw patrol", "Children's 3-5");
    map.insert("llama llama", "Children's 3-5");
    map.insert("pete the cat", "Children's 3-5");
    map.insert("elephant and piggie", "Children's 3-5");
    map.insert("mo willems", "Children's 3-5");
    map.insert("dr. seuss", "Children's 3-5");
    map.insert("dr seuss", "Children's 3-5");
    map.insert("clifford", "Children's 3-5");
    map.insert("berenstain bears", "Children's 3-5");
    map.insert("arthur", "Children's 3-5");
    map.insert("disney princess", "Children's 3-5");
    map.insert("disney frozen", "Children's 3-5");

    // Ages 6-8 (Early Reader/Chapter Books)
    map.insert("magic tree house", "Children's 6-8");
    map.insert("junie b. jones", "Children's 6-8");
    map.insert("ivy + bean", "Children's 6-8");
    map.insert("dogman", "Children's 6-8");
    map.insert("dog man", "Children's 6-8");
    map.insert("captain underpants", "Children's 6-8");
    map.insert("dork diaries", "Children's 6-8");
    map.insert("diary of a wimpy kid", "Children's 6-8");
    map.insert("bad guys", "Children's 6-8");
    map.insert("geronimo stilton", "Children's 6-8");
    map.insert("cam jansen", "Children's 6-8");
    map.insert("nate the great", "Children's 6-8");
    map.insert("a to z mysteries", "Children's 6-8");
    map.insert("flat stanley", "Children's 6-8");
    map.insert("rainbow magic", "Children's 6-8");
    map.insert("fancy nancy", "Children's 6-8");
    map.insert("fly guy", "Children's 6-8");
    map.insert("wings of fire", "Children's 6-8");
    map.insert("babysitters club", "Children's 6-8");

    // Ages 9-12 (Middle Grade)
    map.insert("percy jackson", "Children's 9-12");
    map.insert("heroes of olympus", "Children's 9-12");
    map.insert("kane chronicles", "Children's 9-12");
    map.insert("rick riordan", "Children's 9-12");
    map.insert("harry potter", "Children's 9-12");
    map.insert("narnia", "Children's 9-12");
    map.insert("chronicles of narnia", "Children's 9-12");
    map.insert("land of stories", "Children's 9-12");
    map.insert("keeper of the lost cities", "Children's 9-12");
    map.insert("nevermoor", "Children's 9-12");
    map.insert("rangers apprentice", "Children's 9-12");
    map.insert("ranger's apprentice", "Children's 9-12");
    map.insert("warriors", "Children's 9-12"); // Warrior Cats
    map.insert("warrior cats", "Children's 9-12");
    map.insert("redwall", "Children's 9-12");
    map.insert("spiderwick", "Children's 9-12");
    map.insert("how to train your dragon", "Children's 9-12");
    map.insert("eragon", "Children's 9-12");
    map.insert("inheritance cycle", "Children's 9-12");
    map.insert("artemis fowl", "Children's 9-12");
    map.insert("fablehaven", "Children's 9-12");
    map.insert("alex rider", "Children's 9-12");
    map.insert("goosebumps", "Children's 9-12");
    map.insert("animorphs", "Children's 9-12");
    map.insert("hatchet", "Children's 9-12");
    map.insert("holes", "Children's 9-12");
    map.insert("wonder", "Children's 9-12");
    map.insert("matilda", "Children's 9-12");
    map.insert("roald dahl", "Children's 9-12");
    map.insert("charlie and the chocolate factory", "Children's 9-12");
    map.insert("bfg", "Children's 9-12");
    map.insert("lemony snicket", "Children's 9-12");
    map.insert("series of unfortunate events", "Children's 9-12");

    // Ages 13-17 (Teen/Young Adult)
    map.insert("hunger games", "Teen 13-17");
    map.insert("divergent", "Teen 13-17");
    map.insert("maze runner", "Teen 13-17");
    map.insert("twilight", "Teen 13-17");
    map.insert("throne of glass", "Teen 13-17");
    map.insert("sarah j maas", "Teen 13-17");
    map.insert("court of thorns and roses", "Teen 13-17");
    map.insert("acotar", "Teen 13-17");
    map.insert("six of crows", "Teen 13-17");
    map.insert("shadow and bone", "Teen 13-17");
    map.insert("leigh bardugo", "Teen 13-17");
    map.insert("mortal instruments", "Teen 13-17");
    map.insert("cassandra clare", "Teen 13-17");
    map.insert("shadowhunters", "Teen 13-17");
    map.insert("red queen", "Teen 13-17");
    map.insert("the fault in our stars", "Teen 13-17");
    map.insert("john green", "Teen 13-17");
    map.insert("looking for alaska", "Teen 13-17");
    map.insert("perks of being a wallflower", "Teen 13-17");
    map.insert("to all the boys", "Teen 13-17");
    map.insert("hate u give", "Teen 13-17");
    map.insert("children of blood and bone", "Teen 13-17");
    map.insert("legendborn", "Teen 13-17");
    map.insert("daughter of the moon goddess", "Teen 13-17");
    map.insert("house of salt and sorrows", "Teen 13-17");
    map.insert("shatter me", "Teen 13-17");
    map.insert("cinder", "Teen 13-17");
    map.insert("lunar chronicles", "Teen 13-17");
    map.insert("vampire academy", "Teen 13-17");

    map
}

/// Detect the appropriate age category from title, series, or author
pub fn detect_children_age_category(title: &str, series: Option<&str>, author: Option<&str>) -> Option<String> {
    let series_ages = get_children_series_ages();

    // Combine all text to search
    let search_text = format!(
        "{} {} {}",
        title.to_lowercase(),
        series.unwrap_or("").to_lowercase(),
        author.unwrap_or("").to_lowercase()
    );

    // Check against known series/authors
    for (keyword, age_category) in series_ages.iter() {
        if search_text.contains(keyword) {
            return Some(age_category.to_string());
        }
    }

    None
}

/// Ensure children's books have proper age-specific genres
/// This should be called after GPT processing to enforce age categories
pub fn enforce_children_age_genres(
    genres: &mut Vec<String>,
    title: &str,
    series: Option<&str>,
    author: Option<&str>,
) {
    // Check if we can detect the age category
    if let Some(age_genre) = detect_children_age_category(title, series, author) {
        // Remove generic children's/ya/middle grade tags and replace with specific age
        genres.retain(|g| {
            let lower = g.to_lowercase();
            !lower.contains("children") &&
            !lower.contains("middle grade") &&
            lower != "young adult" &&
            lower != "teen" &&
            lower != "ya"
        });

        // Add the specific age genre if not already present
        if !genres.iter().any(|g| g == &age_genre) {
            // Insert at beginning for priority
            genres.insert(0, age_genre);
        }

        // Limit to 3 genres
        genres.truncate(3);
    }
}

/// Map legacy age categories to new age-specific ones based on context
pub fn upgrade_legacy_age_genre(genre: &str, title: &str, series: Option<&str>) -> String {
    let lower = genre.to_lowercase();

    // If already specific, return as-is
    if lower.starts_with("children's ") && lower.chars().any(|c| c.is_ascii_digit()) {
        return genre.to_string();
    }
    if lower.starts_with("teen ") && lower.chars().any(|c| c.is_ascii_digit()) {
        return genre.to_string();
    }

    // Try to detect specific age
    if let Some(specific) = detect_children_age_category(title, series, None) {
        return specific;
    }

    // Default mappings for generic categories
    match lower.as_str() {
        "children's" | "children" | "kids" => "Children's 6-8".to_string(), // Safe default
        "middle grade" => "Children's 9-12".to_string(),
        "young adult" | "ya" | "teen" => "Teen 13-17".to_string(),
        _ => genre.to_string(),
    }
}

/// Genre aliases - maps alternative names to approved genres
fn get_genre_aliases() -> HashMap<&'static str, &'static str> {
    let mut map = HashMap::new();

    // Common aliases
    map.insert("sci-fi", "Science Fiction");
    map.insert("scifi", "Science Fiction");
    map.insert("sf", "Science Fiction");
    map.insert("personal development", "Self-Help");
    map.insert("self improvement", "Self-Help");
    map.insert("literary fiction", "Literary Fiction");
    map.insert("literary", "Literary Fiction");

    // Age-specific mappings
    map.insert("ya", "Teen 13-17");
    map.insert("young-adult", "Teen 13-17");
    map.insert("ya fiction", "Teen 13-17");
    map.insert("young adult", "Teen 13-17");
    map.insert("teen fiction", "Teen 13-17");
    map.insert("children", "Children's 6-8");
    map.insert("kids", "Children's 6-8");
    map.insert("juvenile", "Children's 6-8");
    map.insert("juvenile fiction", "Children's 6-8");
    map.insert("picture book", "Children's 3-5");
    map.insert("picture books", "Children's 3-5");
    map.insert("early reader", "Children's 6-8");
    map.insert("early readers", "Children's 6-8");
    map.insert("chapter book", "Children's 6-8");
    map.insert("chapter books", "Children's 6-8");
    map.insert("middle grade", "Children's 9-12");
    map.insert("middle-grade", "Children's 9-12");
    map.insert("mg", "Children's 9-12");

    map.insert("nonfiction", "Non-Fiction");
    map.insert("non fiction", "Non-Fiction");
    map.insert("bio", "Biography");
    map.insert("autobio", "Autobiography");
    map.insert("auto-biography", "Autobiography");
    map.insert("memoir", "Memoir");
    map.insert("memoirs", "Memoir");

    // Fantasy subgenres
    map.insert("epic fantasy", "Fantasy");
    map.insert("high fantasy", "Fantasy");
    map.insert("dark fantasy", "Fantasy");
    map.insert("sword and sorcery", "Fantasy");
    map.insert("fairytale", "Fantasy");
    map.insert("fairy tale", "Fantasy");

    // Science Fiction subgenres
    map.insert("space opera", "Science Fiction");
    map.insert("hard sci-fi", "Science Fiction");
    map.insert("cyberpunk", "Science Fiction");
    map.insert("steampunk", "Science Fiction");
    map.insert("military sci-fi", "Science Fiction");

    // Thriller subgenres
    map.insert("suspense thriller", "Thriller");
    map.insert("action thriller", "Thriller");
    map.insert("medical thriller", "Thriller");

    // Romance subgenres
    map.insert("romantic suspense", "Romance");
    map.insert("contemporary romance", "Romance");
    map.insert("historical romance", "Romance");
    map.insert("paranormal romance", "Paranormal");
    map.insert("romantic comedy", "Romance");

    // Mystery subgenres
    map.insert("cozy mystery", "Mystery");
    map.insert("detective", "Mystery");
    map.insert("police procedural", "Mystery");
    map.insert("whodunit", "Mystery");
    map.insert("noir", "Mystery");

    // Horror subgenres
    map.insert("supernatural horror", "Horror");
    map.insert("psychological horror", "Horror");
    map.insert("dark fiction", "Horror");
    map.insert("ghost story", "Horror");

    // Other mappings
    map.insert("general fiction", "Fiction");
    map.insert("general", "Fiction");
    map.insert("audiobook", "Fiction"); // Shouldn't be a genre
    map.insert("unabridged", "Fiction"); // Shouldn't be a genre
    map.insert("adult fiction", "Fiction");
    map.insert("inspirational", "Spirituality");
    map.insert("faith", "Religion");
    map.insert("christian", "Religion");
    map.insert("cooking & food", "Cooking");
    map.insert("food & drink", "Cooking");
    map.insert("health & fitness", "Health");
    map.insert("health & wellness", "Health");
    map.insert("mind body spirit", "Spirituality");
    map.insert("new age", "Spirituality");
    map.insert("true story", "Non-Fiction");
    map.insert("based on true story", "Non-Fiction");

    map
}

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

/// Map a genre string to an approved genre
///
/// Uses exact matching first, then tries aliases, then fuzzy matching
pub fn map_genre_basic(genre: &str) -> Option<String> {
    let normalized = genre.trim().to_lowercase();

    // Skip empty or obviously bad values
    if normalized.is_empty() ||
       normalized == "audiobook" ||
       normalized == "audio book" ||
       normalized == "unabridged" {
        return None;
    }

    // Exact match (case-insensitive)
    for approved in APPROVED_GENRES {
        if approved.to_lowercase() == normalized {
            return Some(approved.to_string());
        }
    }

    // Try aliases
    let aliases = get_genre_aliases();
    if let Some(&mapped) = aliases.get(normalized.as_str()) {
        return Some(mapped.to_string());
    }

    // Partial match - if the genre contains an approved genre
    for approved in APPROVED_GENRES {
        let approved_lower = approved.to_lowercase();
        if normalized.contains(&approved_lower) || approved_lower.contains(&normalized) {
            return Some(approved.to_string());
        }
    }

    // No match found
    None
}

/// Map a genre with sub-genre information
///
/// Returns (primary_genre, sub_genre) tuple for hierarchical categorization
pub fn map_genre_hierarchical(genre: &str) -> (Option<String>, Option<String>) {
    let normalized = genre.trim().to_lowercase();

    // Check for subgenre patterns like "Fiction > Fantasy > Epic Fantasy"
    if normalized.contains(" > ") {
        let parts: Vec<&str> = normalized.split(" > ").collect();
        if parts.len() >= 2 {
            let primary = map_genre_basic(parts.last().unwrap_or(&""));
            let sub = if parts.len() >= 2 {
                map_genre_basic(parts.get(parts.len() - 2).unwrap_or(&""))
            } else {
                None
            };
            return (primary, sub);
        }
    }

    // Check for subgenre patterns like "Epic Fantasy"
    let fantasy_subs = ["epic fantasy", "high fantasy", "dark fantasy", "urban fantasy", "sword and sorcery"];
    let scifi_subs = ["space opera", "hard sci-fi", "cyberpunk", "steampunk", "military sci-fi"];
    let romance_subs = ["contemporary romance", "historical romance", "paranormal romance", "romantic suspense"];
    let mystery_subs = ["cozy mystery", "police procedural", "noir", "detective"];
    let thriller_subs = ["psychological thriller", "legal thriller", "techno-thriller", "political thriller"];

    for sub in fantasy_subs {
        if normalized.contains(sub) {
            return (Some("Fantasy".to_string()), Some(sub.to_string()));
        }
    }
    for sub in scifi_subs {
        if normalized.contains(sub) {
            return (Some("Science Fiction".to_string()), Some(sub.to_string()));
        }
    }
    for sub in romance_subs {
        if normalized.contains(sub) {
            return (Some("Romance".to_string()), Some(sub.to_string()));
        }
    }
    for sub in mystery_subs {
        if normalized.contains(sub) {
            return (Some("Mystery".to_string()), Some(sub.to_string()));
        }
    }
    for sub in thriller_subs {
        if normalized.contains(sub) {
            return (Some("Thriller".to_string()), Some(sub.to_string()));
        }
    }

    (map_genre_basic(genre), None)
}

/// Enforce genre policy: max 3 genres, prioritized, no duplicates
///
/// Priority order:
/// 1. Specific genres (Mystery, Thriller, Fantasy, etc.)
/// 2. Age categories (Young Adult, Children's)
/// 3. Broad categories (Fiction, Non-Fiction)
pub fn enforce_genre_policy_basic(genres: &[String]) -> Vec<String> {
    let mut mapped: Vec<String> = genres
        .iter()
        .filter_map(|g| map_genre_basic(g))
        .collect();

    // Remove duplicates while preserving order
    let mut seen = std::collections::HashSet::new();
    mapped.retain(|g| seen.insert(g.clone()));

    // Priority sorting: specific genres first
    let broad_genres = ["Fiction", "Non-Fiction", "Adult"];
    let age_genres = ["Children's", "Young Adult", "Teen", "Middle Grade", "New Adult"];

    mapped.sort_by(|a, b| {
        let a_is_broad = broad_genres.contains(&a.as_str());
        let b_is_broad = broad_genres.contains(&b.as_str());
        let a_is_age = age_genres.contains(&a.as_str());
        let b_is_age = age_genres.contains(&b.as_str());

        // Broad genres go last
        if a_is_broad && !b_is_broad { return std::cmp::Ordering::Greater; }
        if b_is_broad && !a_is_broad { return std::cmp::Ordering::Less; }

        // Age genres go second-to-last
        if a_is_age && !b_is_age && !b_is_broad { return std::cmp::Ordering::Greater; }
        if b_is_age && !a_is_age && !a_is_broad { return std::cmp::Ordering::Less; }

        std::cmp::Ordering::Equal
    });

    // Take top 3
    mapped.truncate(3);

    // If empty, default to Fiction
    if mapped.is_empty() {
        mapped.push("Fiction".to_string());
    }

    // Don't have both Fiction and a specific fiction genre
    if mapped.len() > 1 && mapped.contains(&"Fiction".to_string()) {
        // Remove "Fiction" if we have a more specific genre
        let has_specific = mapped.iter().any(|g| {
            !broad_genres.contains(&g.as_str()) && !age_genres.contains(&g.as_str())
        });
        if has_specific {
            mapped.retain(|g| g != "Fiction");
        }
    }

    mapped
}

/// Split combined genre strings into individual genres
///
/// Handles various separators used by different sources:
/// - Comma-separated: "Suspense, Crime Thrillers, Police Procedurals"
/// - Slash-separated (Google Books): "Fiction / Thrillers / Suspense"
/// - Ampersand-separated: "Mystery & Thriller"
///
/// Returns a flattened Vec of individual genre strings
pub fn split_combined_genres(genres: &[String]) -> Vec<String> {
    let mut result = Vec::new();

    for genre in genres {
        let trimmed = genre.trim();

        // Check for various separators and split accordingly
        if trimmed.contains(" / ") {
            // Google Books hierarchical format: "Fiction / Thrillers / Suspense"
            for part in trimmed.split(" / ") {
                let cleaned = part.trim();
                if !cleaned.is_empty() {
                    result.push(cleaned.to_string());
                }
            }
        } else if trimmed.contains(", ") {
            // Comma-separated: "Suspense, Crime Thrillers"
            for part in trimmed.split(", ") {
                let cleaned = part.trim();
                if !cleaned.is_empty() {
                    result.push(cleaned.to_string());
                }
            }
        } else if trimmed.contains(" & ") {
            // Ampersand-separated: "Mystery & Thriller"
            for part in trimmed.split(" & ") {
                let cleaned = part.trim();
                if !cleaned.is_empty() {
                    result.push(cleaned.to_string());
                }
            }
        } else if !trimmed.is_empty() {
            // Single genre, just add it
            result.push(trimmed.to_string());
        }
    }

    // Remove duplicates while preserving order
    let mut seen = std::collections::HashSet::new();
    result.retain(|g| seen.insert(g.to_lowercase()));

    result
}

/// Enforce genre policy with automatic splitting of combined genres
///
/// This is an enhanced version that first splits combined genre strings,
/// then applies the standard genre policy.
pub fn enforce_genre_policy_with_split(genres: &[String]) -> Vec<String> {
    let split_genres = split_combined_genres(genres);
    enforce_genre_policy_basic(&split_genres)
}