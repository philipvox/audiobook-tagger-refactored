// src-tauri/src/age_rating_resolver.rs
//
// Age rating resolver using existing API data + GPT synthesis.
// 1. Gathers data from connected providers (Goodreads, Hardcover, Storytel, etc.)
// 2. Combines genres, descriptions, series info from all sources
// 3. Uses GPT to analyze and determine appropriate age category

use serde::{Deserialize, Serialize};
use crate::config::Config;
use crate::custom_providers::{search_custom_providers, CustomProviderResult};

/// Input for the age rating resolver (what we already know)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgeRatingInput {
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub description: Option<String>,
    pub genres: Vec<String>,
    pub publisher: Option<String>,
}

/// Output from the age rating resolver
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgeRatingOutput {
    /// Age category: "Children's 0-2", "Children's 3-5", "Children's 6-8",
    /// "Children's 9-12", "Teen 13-17", "Young Adult", "Adult"
    pub age_category: String,

    /// Recommended minimum age (e.g., 4, 8, 12, 16)
    pub min_age: Option<u8>,

    /// Content rating: "G", "PG", "PG-13", "R"
    pub content_rating: String,

    /// Tags for the rating system
    pub age_tags: Vec<String>,

    /// Confidence: "high", "medium", "low"
    pub confidence: String,

    /// Explanation of how the age was determined
    pub reasoning: String,

    /// Data sources used for determination
    pub sources_used: Vec<String>,

    /// Whether the book is intended/written FOR kids to read, not just appropriate for them
    #[serde(default)]
    pub intended_for_kids: bool,
}

/// GPT response structure
#[derive(Debug, Deserialize)]
struct GptAgeResponse {
    age_category: String,
    #[serde(default)]
    min_age: Option<u8>,
    content_rating: String,
    #[serde(default)]
    age_tags: Vec<String>,
    #[serde(default)]
    confidence: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    intended_for_kids: Option<bool>,
}

/// System prompt for age rating synthesis
const AGE_RATING_SYSTEM_PROMPT: &str = r#"
You are an expert at determining age-appropriate ratings for books.

STEP 1 — DETERMINE THE INTENDED AUDIENCE (most important step):
Ask: "Who is this book PUBLISHED FOR? Who would buy it and read/listen to it?"

FOR-KIDS (intended_for_kids = true) — ONLY children's books, ages 0-12:
- Books published, marketed, and shelved in the CHILDREN'S section of bookstores
- The READER/LISTENER is meant to be a child (roughly under 13)
- Examples: Magic Tree House, Diary of a Wimpy Kid, Dog Man, Pete the Cat, Goodnight Moon, Junie B. Jones
- Teen/YA books are NOT "for kids" — Hunger Games, Harry Potter, Percy Jackson get for-teens/for-ya instead

NOT-FOR-KIDS (intended_for_kids = false) — EVERYTHING ELSE:
- Teen/YA novels (Hunger Games, Divergent, Twilight) → use for-teens or for-ya tag instead
- Adult novels with young protagonists (The Talisman, Ender's Game, Room, To Kill a Mockingbird)
- Parenting/education books ABOUT kids but FOR adults
- Horror, thriller, literary fiction by adult authors (Stephen King, Cormac McCarthy)
- Self-help, health, wellness, non-fiction for adult audiences

CRITICAL: A young protagonist does NOT make a book "for kids". Stephen King's The Talisman has a 12-year-old hero but is an ADULT horror/fantasy novel. "It" features children but is adult horror.

STEP 2 — DETERMINE AGE CATEGORY:
- If intended_for_kids is FALSE and it's teen/YA → "Teen 13-17" or "Young Adult" + for-teens/for-ya
- If intended_for_kids is FALSE and it's adult → "Adult" + not-for-kids
- If intended_for_kids is TRUE → use the children's categories below
- NEVER use children's categories for adult books, even with child protagonists

STRONG CHILDREN'S SIGNALS (use these only when intended_for_kids is TRUE):
- Genre explicitly contains: "Children", "Kids", "Juvenile", "Picture Book", "Board Book", "Chapter Book"
- Publisher is children's-focused: Scholastic, Random House Children's, Little Golden Books
- Description mentions: "ages 3-8", "grades K-3", "bedtime", "for kids", "young readers"
- Known children's series (for-kids): Curious George, Pete the Cat, Berenstain Bears, Clifford, Magic Tree House, Junie B. Jones, Diary of a Wimpy Kid, Dog Man, Captain Underpants, Narnia, Nancy Drew, Hardy Boys
- Known teen/YA series (for-teens): Percy Jackson, Harry Potter, Wings of Fire, Warriors, Hunger Games, Divergent, Maze Runner, Twilight

AGE CATEGORIES (pick ONE):
- "Children's 0-2" - Board books, baby books
- "Children's 3-5" - Picture books, preschool
- "Children's 6-8" - Early readers, easy chapter books
- "Children's 9-12" - Middle grade, chapter books
- "Teen 13-17" - Young adult with teen themes
- "Young Adult" - Mature YA, ages 16-25
- "Adult" - Default for all adult fiction/non-fiction

CONTENT RATINGS:
- "G" - All ages, wholesome
- "PG" - Mild peril, some conflict
- "PG-13" - Teen themes, some violence/romance
- "R" - Adult content, explicit material

NOT-FOR-KIDS EXAMPLES (all → "Adult" + not-for-kids):
- The Talisman (Stephen King) — adult horror/fantasy, young protagonist
- It (Stephen King) — adult horror, child protagonists
- Room (Emma Donoghue) — adult literary fiction, child narrator
- To Kill a Mockingbird — adult classic, child narrator
- Ender's Game — often shelved adult sci-fi despite young protagonist
- "How to Talk to Your Kids About Sex" — parenting guide
- Any book by: Stephen King, Dean Koontz, Cormac McCarthy, Thomas Harris → Adult

RULES:
1. FIRST determine intended_for_kids (Step 1) — this drives everything
2. If intended_for_kids is false → age_category MUST be "Adult" or "Young Adult", NEVER children's
3. Only use children's categories when the book is genuinely PUBLISHED FOR children
4. A child protagonist alone is NEVER sufficient evidence for "for-kids"
5. Author reputation matters: known adult-fiction authors → Adult unless explicitly a children's book

REQUIRED TAGS:
Age tag (ONE): age-childrens, age-middle-grade, age-teens, age-young-adult, age-adult
Content tag (ONE): rated-g, rated-pg, rated-pg13, rated-r
Reading age (ONE): age-rec-0, age-rec-3, age-rec-6, age-rec-8, age-rec-10, age-rec-12, age-rec-14, age-rec-16, age-rec-18
Audience tag (ONE): for-kids, for-teens, for-ya, not-for-kids
  - for-kids = Children's books (ages 0-12), meant to be read BY children
  - for-teens = Teen/YA books (ages 13-17), meant to be read BY teenagers (Hunger Games, Divergent, Percy Jackson for older readers)
  - for-ya = Young Adult/New Adult crossover (ages 16-25), mature YA themes
  - not-for-kids = Adult books — even if clean, even if has young protagonist

RETURN ONLY VALID JSON:
{
  "age_category": "Children's 6-8",
  "min_age": 6,
  "content_rating": "G",
  "age_tags": ["age-childrens", "rated-g", "age-rec-6", "for-kids"],
  "intended_for_kids": true,
  "confidence": "high",
  "reasoning": "EVIDENCE: Genres include 'Children's Books'. Series 'Magic Tree House' is known children's series for ages 6-9."
}
"#;

/// Resolve age rating by fetching from APIs and synthesizing with GPT
pub async fn resolve_age_rating(
    config: &Config,
    input: &AgeRatingInput,
) -> Result<AgeRatingOutput, String> {
    // Check cache first
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    input.title.to_lowercase().trim().hash(&mut h);
    input.author.to_lowercase().trim().hash(&mut h);
    let cache_key = format!("age_rating_{}", h.finish());
    if let Some(cached) = crate::cache::get::<AgeRatingOutput>(&cache_key) {
        println!("   📦 Using cached age rating for '{}'", input.title);
        return Ok(cached);
    }

    println!("\n   ════════════════════════════════════════════════════════");
    println!("   🎯 AGE RATING RESOLVER (API + GPT Synthesis)");
    println!("   ════════════════════════════════════════════════════════");
    println!("   📖 Title: '{}'", input.title);
    println!("   ✍️  Author: '{}'", input.author);
    if let Some(ref series) = input.series {
        println!("   📚 Series: '{}'", series);
    }
    println!("   📋 Current genres: {:?}", input.genres);

    // Step 1: Fetch from all connected APIs
    println!("\n   📡 Fetching from custom providers...");
    let api_results = search_custom_providers(config, &input.title, &input.author).await;

    // Step 2: Aggregate all the data
    let aggregated = aggregate_for_age_rating(input, &api_results);
    println!("   📊 Aggregated {} genre entries from {} sources",
        aggregated.all_genres.len(), aggregated.sources.len());

    // Step 3: Check if we can determine age without GPT (obvious cases)
    if let Some(quick_result) = try_quick_determination(&aggregated) {
        println!("   ⚡ Quick determination: {} ({})",
            quick_result.age_category, quick_result.confidence);
        let _ = crate::cache::set(&cache_key, &quick_result);
        return Ok(quick_result);
    }

    // Step 4: Use GPT to synthesize
    let api_key = config
        .openai_api_key
        .as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("No OpenAI API key configured")?;

    println!("   🤖 Calling GPT for synthesis...");
    let result = synthesize_with_gpt(api_key, &aggregated).await?;
    let _ = crate::cache::set(&cache_key, &result);
    Ok(result)
}

/// Aggregated data for age determination
struct AggregatedAgeData {
    title: String,
    author: String,
    series: Option<String>,
    all_genres: Vec<String>,
    all_descriptions: Vec<String>,
    publishers: Vec<String>,
    sources: Vec<String>,
}

/// Aggregate data from input and API results
fn aggregate_for_age_rating(
    input: &AgeRatingInput,
    api_results: &[CustomProviderResult],
) -> AggregatedAgeData {
    let mut all_genres: Vec<String> = input.genres.clone();
    let mut all_descriptions: Vec<String> = Vec::new();
    let mut publishers: Vec<String> = Vec::new();
    let mut sources: Vec<String> = vec!["existing_metadata".to_string()];

    if let Some(ref desc) = input.description {
        all_descriptions.push(desc.clone());
    }
    if let Some(ref pub_name) = input.publisher {
        publishers.push(pub_name.clone());
    }

    for result in api_results {
        sources.push(result.provider_name.clone());

        // Add genres (deduplicated)
        for genre in &result.genres {
            let normalized = genre.trim().to_string();
            if !normalized.is_empty() && !all_genres.iter().any(|g| g.eq_ignore_ascii_case(&normalized)) {
                all_genres.push(normalized);
            }
        }

        // Add description
        if let Some(ref desc) = result.description {
            if !desc.is_empty() {
                all_descriptions.push(desc.clone());
            }
        }

        // Add publisher
        if let Some(ref pub_name) = result.publisher {
            if !pub_name.is_empty() && !publishers.iter().any(|p| p.eq_ignore_ascii_case(pub_name)) {
                publishers.push(pub_name.clone());
            }
        }
    }

    AggregatedAgeData {
        title: input.title.clone(),
        author: input.author.clone(),
        series: input.series.clone(),
        all_genres,
        all_descriptions,
        publishers,
        sources,
    }
}

/// Try to determine age without GPT for obvious cases
fn try_quick_determination(data: &AggregatedAgeData) -> Option<AgeRatingOutput> {
    let genres_lower: Vec<String> = data.all_genres.iter()
        .map(|g| g.to_lowercase())
        .collect();

    // Check for explicit children's indicators
    let has_picture_book = genres_lower.iter().any(|g|
        g.contains("picture book") || g.contains("board book")
    );
    let has_early_reader = genres_lower.iter().any(|g|
        g.contains("early reader") || g.contains("easy reader") ||
        g.contains("beginning reader")
    );
    let has_middle_grade = genres_lower.iter().any(|g|
        g.contains("middle grade") || g.contains("middle-grade")
    );
    let has_childrens = genres_lower.iter().any(|g|
        g.contains("children") || g.contains("juvenile") || g.contains("kids")
    );
    let has_ya = genres_lower.iter().any(|g|
        g.contains("young adult") || g == "ya" || g.contains("teen fiction") ||
        g.contains("teen & young adult")
    );
    let has_adult_content = genres_lower.iter().any(|g|
        g.contains("erotica") || g.contains("erotic") ||
        g.contains("dark romance") || g.contains("adult romance")
    );

    // Check descriptions for age mentions
    let desc_lower: String = data.all_descriptions.iter()
        .map(|d| d.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let has_age_mention_children = desc_lower.contains("ages 3") ||
        desc_lower.contains("ages 4") ||
        desc_lower.contains("ages 5") ||
        desc_lower.contains("ages 6") ||
        desc_lower.contains("ages 7") ||
        desc_lower.contains("ages 8") ||
        desc_lower.contains("ages 2-") ||
        desc_lower.contains("ages 3-") ||
        desc_lower.contains("ages 4-") ||
        desc_lower.contains("ages 5-") ||
        desc_lower.contains("for kids") ||
        desc_lower.contains("for children") ||
        desc_lower.contains("young readers") ||
        desc_lower.contains("bedtime stor") ||
        desc_lower.contains("read-aloud") ||
        desc_lower.contains("preschool") ||
        desc_lower.contains("kindergarten");

    // Known children's series (extensive list)
    let series_lower = data.series.as_ref().map(|s| s.to_lowercase());
    let is_known_childrens_series = series_lower.as_ref().map_or(false, |s| {
        s.contains("magic tree house") ||
        s.contains("junie b") ||
        s.contains("diary of a wimpy kid") ||
        s.contains("dog man") ||
        s.contains("captain underpants") ||
        s.contains("geronimo stilton") ||
        s.contains("the bad guys") ||
        s.contains("dork diaries") ||
        s.contains("big nate") ||
        s.contains("curious george") ||
        s.contains("pete the cat") ||
        s.contains("elephant & piggie") ||
        s.contains("elephant and piggie") ||
        s.contains("fly guy") ||
        s.contains("little bear") ||
        s.contains("frog and toad") ||
        s.contains("henry and mudge") ||
        s.contains("amelia bedelia") ||
        s.contains("cam jansen") ||
        s.contains("boxcar children") ||
        s.contains("encyclopedia brown") ||
        s.contains("hardy boys") ||
        s.contains("nancy drew") ||
        s.contains("berenstain bears") ||
        s.contains("clifford") ||
        s.contains("arthur") ||
        s.contains("franklin") ||
        s.contains("little critter") ||
        s.contains("biscuit") ||
        s.contains("fancy nancy") ||
        s.contains("pinkalicious") ||
        s.contains("llama llama") ||
        s.contains("corduroy") ||
        s.contains("madeline") ||
        s.contains("babar") ||
        s.contains("miffy") ||
        s.contains("maisy") ||
        s.contains("spot") ||
        s.contains("goodnight moon") ||
        s.contains("very hungry caterpillar") ||
        s.contains("eric carle") ||
        s.contains("dr. seuss") ||
        s.contains("dr seuss") ||
        s.contains("cat in the hat") ||
        s.contains("beginner books") ||
        s.contains("i can read") ||
        s.contains("step into reading") ||
        s.contains("ready-to-read") ||
        s.contains("little golden book")
    });

    let is_known_mg_series = series_lower.as_ref().map_or(false, |s| {
        s.contains("percy jackson") ||
        s.contains("harry potter") ||
        s.contains("wings of fire") ||
        s.contains("warriors") ||
        s.contains("keeper of the lost cities") ||
        s.contains("land of stories") ||
        s.contains("rangers apprentice") ||
        s.contains("redwall") ||
        s.contains("narnia") ||
        s.contains("chronicles of narnia") ||
        s.contains("spiderwick")
    });

    let is_known_ya_series = series_lower.as_ref().map_or(false, |s| {
        s.contains("hunger games") ||
        s.contains("divergent") ||
        s.contains("maze runner") ||
        s.contains("twilight") ||
        s.contains("mortal instruments") ||
        s.contains("throne of glass")
    });

    // Picture books / Board books
    if has_picture_book {
        return Some(AgeRatingOutput {
            age_category: "Children's 3-5".to_string(),
            min_age: Some(3),
            content_rating: "G".to_string(),
            age_tags: vec![
                "age-childrens".to_string(),
                "rated-g".to_string(),
                "age-rec-3".to_string(),
                "for-kids".to_string(),
            ],
            confidence: "high".to_string(),
            reasoning: "Genre indicates picture book/board book".to_string(),
            sources_used: data.sources.clone(),
            intended_for_kids: true,
        });
    }

    // Known children's series (6-8) OR description mentions children's ages
    if is_known_childrens_series || has_early_reader || has_age_mention_children {
        return Some(AgeRatingOutput {
            age_category: "Children's 6-8".to_string(),
            min_age: Some(6),
            content_rating: "G".to_string(),
            age_tags: vec![
                "age-childrens".to_string(),
                "rated-g".to_string(),
                "age-rec-6".to_string(),
                "for-kids".to_string(),
            ],
            confidence: "high".to_string(),
            reasoning: format!("Children's indicator found - series: {:?}, desc_has_age_mention: {}",
                data.series.as_deref().unwrap_or("N/A"), has_age_mention_children),
            sources_used: data.sources.clone(),
            intended_for_kids: true,
        });
    }

    // Middle grade
    if has_middle_grade || is_known_mg_series {
        return Some(AgeRatingOutput {
            age_category: "Children's 9-12".to_string(),
            min_age: Some(9),
            content_rating: "PG".to_string(),
            age_tags: vec![
                "age-middle-grade".to_string(),
                "rated-pg".to_string(),
                "age-rec-10".to_string(),
                "for-kids".to_string(),
            ],
            confidence: "high".to_string(),
            reasoning: "Middle grade genre or known middle grade series".to_string(),
            sources_used: data.sources.clone(),
            intended_for_kids: true,
        });
    }

    // Young adult / Teen
    if has_ya || is_known_ya_series {
        return Some(AgeRatingOutput {
            age_category: "Teen 13-17".to_string(),
            min_age: Some(13),
            content_rating: "PG-13".to_string(),
            age_tags: vec![
                "age-teens".to_string(),
                "rated-pg13".to_string(),
                "age-rec-14".to_string(),
                "for-teens".to_string(),
            ],
            confidence: "high".to_string(),
            reasoning: "Young adult genre or known YA series".to_string(),
            sources_used: data.sources.clone(),
            intended_for_kids: false,
        });
    }

    // Children's (generic) - but not middle grade or YA
    if has_childrens && !has_middle_grade && !has_ya {
        return Some(AgeRatingOutput {
            age_category: "Children's 6-8".to_string(),
            min_age: Some(6),
            content_rating: "G".to_string(),
            age_tags: vec![
                "age-childrens".to_string(),
                "rated-g".to_string(),
                "age-rec-6".to_string(),
                "for-kids".to_string(),
            ],
            confidence: "medium".to_string(),
            reasoning: "Generic children's genre detected".to_string(),
            sources_used: data.sources.clone(),
            intended_for_kids: true,
        });
    }

    // Explicit adult content
    if has_adult_content {
        return Some(AgeRatingOutput {
            age_category: "Adult".to_string(),
            min_age: Some(18),
            content_rating: "R".to_string(),
            age_tags: vec![
                "age-adult".to_string(),
                "rated-r".to_string(),
                "age-rec-18".to_string(),
                "not-for-kids".to_string(),
            ],
            confidence: "high".to_string(),
            reasoning: "Adult/erotic content genre detected".to_string(),
            sources_used: data.sources.clone(),
            intended_for_kids: false,
        });
    }

    // Can't determine quickly - need GPT
    None
}

/// Use GPT to synthesize age rating from aggregated data
async fn synthesize_with_gpt(
    api_key: &str,
    data: &AggregatedAgeData,
) -> Result<AgeRatingOutput, String> {
    // Build user prompt with all aggregated data
    let mut prompt = format!(
        "Determine the age rating for this book:\n\n\
        TITLE: \"{}\"\n\
        AUTHOR: \"{}\"\n",
        data.title, data.author
    );

    if let Some(ref series) = data.series {
        prompt.push_str(&format!("SERIES: \"{}\"\n", series));
    }

    prompt.push_str(&format!("\nGENRES FROM ALL SOURCES:\n{}\n",
        data.all_genres.join(", ")));

    if !data.publishers.is_empty() {
        prompt.push_str(&format!("\nPUBLISHERS: {}\n", data.publishers.join(", ")));
    }

    if !data.all_descriptions.is_empty() {
        prompt.push_str("\nDESCRIPTIONS:\n");
        for (i, desc) in data.all_descriptions.iter().take(2).enumerate() {
            // Truncate long descriptions
            let truncated: String = desc.chars().take(400).collect();
            prompt.push_str(&format!("{}. {}\n", i + 1, truncated));
        }
    }

    prompt.push_str(&format!("\nDATA SOURCES: {}\n", data.sources.join(", ")));
    prompt.push_str("\nAnalyze all this data and return your age rating JSON.");

    // Call GPT (regular call, no web search)
    let request_body = serde_json::json!({
        "model": crate::scanner::processor::preferred_model(),
        "messages": [
            {
                "role": "system",
                "content": AGE_RATING_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "max_tokens": 800,
        "temperature": 0.3,
        "response_format": { "type": "json_object" }
    });

    let client = crate::cache::shared_client();

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("GPT request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GPT returned {}: {}", status, body));
    }

    let response_json: serde_json::Value = response.json().await
        .map_err(|e| format!("Failed to parse GPT response: {}", e))?;

    let content = response_json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("No content in GPT response")?;

    parse_gpt_response(content, &data.sources)
}

/// Parse GPT's JSON response
fn parse_gpt_response(content: &str, sources: &[String]) -> Result<AgeRatingOutput, String> {
    // Try to extract JSON if wrapped in markdown
    let json_str = if content.contains("```json") {
        content
            .split("```json")
            .nth(1)
            .and_then(|s| s.split("```").next())
            .unwrap_or(content)
            .trim()
    } else if content.contains("```") {
        content
            .split("```")
            .nth(1)
            .unwrap_or(content)
            .trim()
    } else {
        content.trim()
    };

    match serde_json::from_str::<GptAgeResponse>(json_str) {
        Ok(parsed) => {
            println!("   ✅ Age category: {}", parsed.age_category);
            println!("   🎬 Content rating: {}", parsed.content_rating);
            println!("   💡 Confidence: {}", parsed.confidence.as_deref().unwrap_or("medium"));

            let intended_for_kids = parsed.intended_for_kids.unwrap_or(false);
            let mut age_tags = ensure_required_tags(&parsed.age_tags);
            // Ensure audience intent tag is present
            let has_audience_tag = age_tags.iter().any(|t|
                t == "for-kids" || t == "for-teens" || t == "for-ya" || t == "not-for-kids"
            );
            if !has_audience_tag {
                let audience_tag = match parsed.age_category.as_str() {
                    c if c.starts_with("Children") => "for-kids",
                    "Teen 13-17" => "for-teens",
                    "Young Adult" => "for-ya",
                    _ => "not-for-kids",
                };
                age_tags.push(audience_tag.to_string());
            }
            Ok(AgeRatingOutput {
                age_category: parsed.age_category,
                min_age: parsed.min_age,
                content_rating: parsed.content_rating,
                age_tags,
                confidence: parsed.confidence.unwrap_or_else(|| "medium".to_string()),
                reasoning: parsed.reasoning.unwrap_or_default(),
                sources_used: sources.to_vec(),
                intended_for_kids,
            })
        }
        Err(e) => {
            println!("   ⚠️ Failed to parse GPT response: {}", e);
            println!("   📝 Raw: {}", json_str);

            // Return error instead of guessing - let caller handle it
            Err(format!("Failed to parse GPT age rating response: {}. Raw: {}", e, json_str))
        }
    }
}

/// Ensure we have all required tag categories (public wrapper for consolidated module)
pub fn ensure_required_tags_pub(tags: &[String]) -> Vec<String> {
    ensure_required_tags(tags)
}

/// Ensure we have all required tag categories
fn ensure_required_tags(tags: &[String]) -> Vec<String> {
    let mut result = tags.to_vec();

    // Check for age tag
    let has_age = tags.iter().any(|t|
        t.starts_with("age-childrens") ||
        t.starts_with("age-middle-grade") ||
        t.starts_with("age-teens") ||
        t.starts_with("age-young-adult") ||
        t.starts_with("age-adult")
    );
    if !has_age {
        result.push("age-adult".to_string());
    }

    // Check for content rating
    let has_rating = tags.iter().any(|t| t.starts_with("rated-"));
    if !has_rating {
        result.push("rated-pg".to_string());
    }

    // Check for age recommendation
    let has_rec = tags.iter().any(|t| t.starts_with("age-rec-"));
    if !has_rec {
        result.push("age-rec-16".to_string());
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ensure_required_tags() {
        let tags = vec!["age-childrens".to_string()];
        let result = ensure_required_tags(&tags);

        assert!(result.contains(&"age-childrens".to_string()));
        assert!(result.iter().any(|t| t.starts_with("rated-")));
        assert!(result.iter().any(|t| t.starts_with("age-rec-")));
    }
}
