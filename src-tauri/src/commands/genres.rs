// src-tauri/src/commands/genres.rs
// Genre and Tag cleanup/normalization commands

use serde::{Deserialize, Serialize};
use crate::genres::{
    enforce_genre_policy_with_split,
    enforce_tag_policy,
    map_tag,
    get_length_tag_from_seconds,
    APPROVED_GENRES,
    APPROVED_TAGS,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct GenreCleanupRequest {
    pub groups: Vec<GenreCleanupGroup>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenreCleanupGroup {
    pub id: String,
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub genres: Vec<String>,
    pub tags: Option<Vec<String>>,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct GenreCleanupResult {
    pub id: String,
    pub original_genres: Vec<String>,
    pub cleaned_genres: Vec<String>,
    pub original_tags: Vec<String>,
    pub cleaned_tags: Vec<String>,
    pub changed: bool,
}

#[derive(Debug, Serialize)]
pub struct GenreCleanupResponse {
    pub results: Vec<GenreCleanupResult>,
    pub total_cleaned: usize,
    pub total_unchanged: usize,
}

/// Clean and normalize genres AND tags for a list of book groups
/// This is a quick operation that just applies genre/tag policy rules
#[tauri::command]
pub async fn cleanup_genres(request: GenreCleanupRequest) -> Result<GenreCleanupResponse, String> {
    println!("🧹 Genre/Tag cleanup for {} books", request.groups.len());

    let mut results = Vec::new();
    let mut total_cleaned = 0;
    let mut total_unchanged = 0;

    for group in request.groups {
        // Filter out empty genres
        let non_empty_genres: Vec<String> = group.genres
            .iter()
            .filter(|g| !g.trim().is_empty())
            .cloned()
            .collect();

        // Apply genre normalization (age detection now handled by GPT pipeline)
        let cleaned_genres = enforce_genre_policy_with_split(&non_empty_genres);

        // Process tags
        let original_tags = group.tags.clone().unwrap_or_default();
        let mut cleaned_tags = enforce_tag_policy(&original_tags);

        // Add length tag if duration is available and not already present
        if let Some(duration) = group.duration_seconds {
            let length_tag = get_length_tag_from_seconds(duration).to_string();
            if !cleaned_tags.iter().any(|t| t.contains("-hours")) {
                cleaned_tags.push(length_tag);
            }
        }

        // Check if changed
        let genres_changed = cleaned_genres != non_empty_genres;
        let tags_changed = cleaned_tags != original_tags;
        let changed = genres_changed || tags_changed;

        if changed {
            total_cleaned += 1;
            if genres_changed {
                println!("   📚 {} : genres {:?} → {:?}", group.title, group.genres, cleaned_genres);
            }
            if tags_changed {
                println!("   🏷️  {} : tags {:?} → {:?}", group.title, original_tags, cleaned_tags);
            }
        } else {
            total_unchanged += 1;
        }

        results.push(GenreCleanupResult {
            id: group.id,
            original_genres: group.genres,
            cleaned_genres,
            original_tags,
            cleaned_tags,
            changed,
        });
    }

    println!("🧹 Cleanup complete: {} cleaned, {} unchanged", total_cleaned, total_unchanged);

    Ok(GenreCleanupResponse {
        results,
        total_cleaned,
        total_unchanged,
    })
}

/// Normalize a single set of genres (local, no ABS)
/// Note: Age-specific genre detection is now handled by the GPT pipeline
#[tauri::command]
pub fn normalize_genres_local(
    genres: Vec<String>,
    _title: Option<String>,
    _series: Option<String>,
    _author: Option<String>,
) -> Vec<String> {
    // Filter out empty genres
    let non_empty: Vec<String> = genres
        .iter()
        .filter(|g| !g.trim().is_empty())
        .cloned()
        .collect();

    // Apply genre normalization (age detection now handled by GPT pipeline)
    enforce_genre_policy_with_split(&non_empty)
}

/// Normalize a single set of tags (local, no ABS)
#[tauri::command]
pub fn normalize_tags_local(
    tags: Vec<String>,
    duration_seconds: Option<f64>,
) -> Vec<String> {
    let mut cleaned = enforce_tag_policy(&tags);

    // Add length tag if duration is available
    if let Some(duration) = duration_seconds {
        let length_tag = get_length_tag_from_seconds(duration).to_string();
        if !cleaned.iter().any(|t| t.contains("-hours")) {
            cleaned.push(length_tag);
        }
    }

    cleaned
}

/// Get the approved genres list
#[tauri::command]
pub fn get_approved_genres() -> Vec<String> {
    APPROVED_GENRES
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Get the approved tags list
#[tauri::command]
pub fn get_approved_tags() -> Vec<String> {
    APPROVED_TAGS
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Map a single tag to approved tag (or None if not recognized)
#[tauri::command]
pub fn map_single_tag(tag: String) -> Option<String> {
    map_tag(&tag)
}

/// Get tags grouped by category for UI display
#[tauri::command]
pub fn get_tags_by_category() -> std::collections::HashMap<String, Vec<String>> {
    let mut categories: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();

    // Sub-Genre tags
    categories.insert("Mystery & Thriller".to_string(), vec![
        "cozy-mystery", "police-procedural", "legal-thriller", "medical-thriller",
        "techno-thriller", "spy", "domestic-thriller", "noir", "hardboiled",
        "amateur-sleuth", "locked-room", "whodunit", "heist", "cold-case", "forensic"
    ].into_iter().map(String::from).collect());

    categories.insert("Romance".to_string(), vec![
        "rom-com", "contemporary-romance", "historical-romance", "paranormal-romance",
        "fantasy-romance", "romantasy", "dark-romance", "clean-romance", "sports-romance",
        "military-romance", "royal-romance", "billionaire-romance", "small-town-romance",
        "holiday-romance", "workplace-romance"
    ].into_iter().map(String::from).collect());

    categories.insert("Fantasy".to_string(), vec![
        "epic-fantasy", "urban-fantasy", "dark-fantasy", "high-fantasy", "low-fantasy",
        "sword-and-sorcery", "portal-fantasy", "cozy-fantasy", "grimdark",
        "progression-fantasy", "cultivation", "litrpg", "gamelit", "mythic-fantasy",
        "gaslamp-fantasy", "fairy-tale-retelling"
    ].into_iter().map(String::from).collect());

    categories.insert("Science Fiction".to_string(), vec![
        "space-opera", "dystopian", "post-apocalyptic", "cyberpunk", "biopunk",
        "steampunk", "hard-sci-fi", "soft-sci-fi", "military-sci-fi", "time-travel",
        "first-contact", "alien-invasion", "climate-fiction", "alternate-history", "near-future"
    ].into_iter().map(String::from).collect());

    categories.insert("Horror".to_string(), vec![
        "gothic", "supernatural", "cosmic-horror", "psychological-horror", "folk-horror",
        "body-horror", "slasher", "haunted-house", "creature-feature", "occult", "southern-gothic"
    ].into_iter().map(String::from).collect());

    categories.insert("Mood".to_string(), vec![
        "adventurous", "atmospheric", "bittersweet", "cathartic", "cozy", "dark",
        "emotional", "feel-good", "funny", "haunting", "heartbreaking", "heartwarming",
        "hopeful", "inspiring", "intense", "lighthearted", "melancholic", "mysterious",
        "nostalgic", "reflective", "romantic", "sad", "suspenseful", "tense",
        "thought-provoking", "unsettling", "uplifting", "whimsical"
    ].into_iter().map(String::from).collect());

    categories.insert("Pacing".to_string(), vec![
        "fast-paced", "slow-burn", "medium-paced", "page-turner", "unputdownable",
        "leisurely", "action-packed"
    ].into_iter().map(String::from).collect());

    categories.insert("Style".to_string(), vec![
        "character-driven", "plot-driven", "dialogue-heavy", "descriptive", "lyrical",
        "sparse-prose", "unreliable-narrator", "multiple-pov", "dual-timeline",
        "epistolary", "first-person", "third-person", "nonlinear"
    ].into_iter().map(String::from).collect());

    categories.insert("Romance Tropes".to_string(), vec![
        "enemies-to-lovers", "friends-to-lovers", "strangers-to-lovers", "second-chance",
        "forced-proximity", "fake-relationship", "marriage-of-convenience",
        "forbidden-love", "love-triangle", "grumpy-sunshine", "opposites-attract",
        "he-falls-first", "she-falls-first", "only-one-bed", "age-gap", "boss-employee",
        "single-parent", "secret-identity", "arranged-marriage", "mutual-pining"
    ].into_iter().map(String::from).collect());

    categories.insert("Story Tropes".to_string(), vec![
        "found-family", "chosen-one", "reluctant-hero", "antihero", "morally-grey",
        "villain-origin", "redemption-arc", "revenge", "quest", "survival", "underdog",
        "fish-out-of-water", "hidden-identity", "mistaken-identity", "rags-to-riches",
        "mentor-figure", "prophecy", "coming-of-age", "self-discovery", "starting-over"
    ].into_iter().map(String::from).collect());

    categories.insert("Creatures".to_string(), vec![
        "vampires", "werewolves", "shifters", "fae", "witches", "demons", "angels",
        "ghosts", "dragons", "mermaids", "gods", "monsters", "aliens", "zombies",
        "psychics", "magic-users", "immortals"
    ].into_iter().map(String::from).collect());

    categories.insert("Setting".to_string(), vec![
        "small-town", "big-city", "rural", "coastal", "island", "cabin", "castle",
        "palace", "academy", "college", "high-school", "office", "hospital",
        "courtroom", "military-base", "space-station", "spaceship", "forest",
        "desert", "mountains", "arctic", "tropical"
    ].into_iter().map(String::from).collect());

    categories.insert("Historical Period".to_string(), vec![
        "regency", "victorian", "medieval", "ancient", "renaissance", "tudor", "viking",
        "1920s", "1950s", "1960s", "1970s", "1980s", "wwi", "wwii", "civil-war"
    ].into_iter().map(String::from).collect());

    categories.insert("Theme".to_string(), vec![
        "family", "friendship", "grief", "healing", "identity", "justice", "love",
        "loyalty", "power", "sacrifice", "survival", "trauma", "war", "class", "race",
        "gender", "disability", "mental-health", "addiction", "faith", "forgiveness",
        "hope", "loss", "marriage", "divorce", "aging", "death"
    ].into_iter().map(String::from).collect());

    categories.insert("Content Level".to_string(), vec![
        "clean", "fade-to-black", "mild-steam", "steamy", "explicit",
        "low-violence", "moderate-violence", "graphic-violence",
        "clean-language", "mild-language", "strong-language"
    ].into_iter().map(String::from).collect());

    categories.insert("Audiobook Production".to_string(), vec![
        "full-cast", "single-narrator", "dual-narrators", "author-narrated",
        "celebrity-narrator", "dramatized", "sound-effects"
    ].into_iter().map(String::from).collect());

    categories.insert("Narrator".to_string(), vec![
        "male-narrator", "female-narrator", "multiple-narrators",
        "great-character-voices", "soothing-narrator"
    ].into_iter().map(String::from).collect());

    categories.insert("Listening".to_string(), vec![
        "good-for-commute", "good-for-sleep", "good-for-roadtrip",
        "requires-focus", "easy-listening", "great-reread"
    ].into_iter().map(String::from).collect());

    categories.insert("Length".to_string(), vec![
        "under-5-hours", "5-10-hours", "10-15-hours", "15-20-hours", "over-20-hours"
    ].into_iter().map(String::from).collect());

    categories.insert("Series".to_string(), vec![
        "standalone", "series-starter", "series-continuation", "series-finale",
        "duology", "trilogy", "long-series", "companion-novel", "spinoff",
        "interconnected-standalones"
    ].into_iter().map(String::from).collect());

    categories.insert("Recognition".to_string(), vec![
        "bestseller", "award-winner", "critically-acclaimed", "debut", "classic", "cult-favorite"
    ].into_iter().map(String::from).collect());

    categories
}

// =============================================================================
// GPT-POWERED GENRE CLEANUP
// =============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct GptGenreRequest {
    pub id: String,
    pub title: String,
    pub author: String,
    pub genres: Vec<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GptGenreResult {
    pub id: String,
    pub title: String,
    pub original_genres: Vec<String>,
    pub cleaned_genres: Vec<String>,
    pub changed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GptGenreResponse {
    pub results: Vec<GptGenreResult>,
    pub total_cleaned: usize,
    pub total_unchanged: usize,
    pub total_failed: usize,
}

/// Clean genres using GPT analysis for smarter categorization
#[tauri::command]
pub async fn cleanup_genres_with_gpt(
    books: Vec<GptGenreRequest>,
    config: crate::config::Config,
) -> Result<GptGenreResponse, String> {
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    println!("🤖 GPT Genre Cleanup for {} books", books.len());

    let mut results = Vec::new();
    let mut total_cleaned = 0;
    let mut total_unchanged = 0;
    let mut total_failed = 0;

    // Process in batches with concurrency
    use futures::stream::{self, StreamExt};

    let api_key_clone = api_key.clone();
    let book_futures: Vec<_> = books.into_iter().map(|book| {
        let api_key = api_key_clone.clone();
        async move {
            match crate::scanner::processor::cleanup_genres_with_gpt(
                &book.title,
                &book.author,
                &book.genres,
                book.description.as_deref(),
                &api_key,
            ).await {
                Ok(cleaned_genres) => {
                    let changed = cleaned_genres != book.genres;
                    if changed {
                        println!("   ✅ {} : {:?} → {:?}", book.title, book.genres, cleaned_genres);
                    }
                    GptGenreResult {
                        id: book.id,
                        title: book.title,
                        original_genres: book.genres,
                        cleaned_genres,
                        changed,
                        error: None,
                    }
                }
                Err(e) => {
                    println!("   ❌ {} : {}", book.title, e);
                    GptGenreResult {
                        id: book.id,
                        title: book.title.clone(),
                        original_genres: book.genres.clone(),
                        cleaned_genres: book.genres,
                        changed: false,
                        error: Some(e),
                    }
                }
            }
        }
    }).collect();

    let stream_results: Vec<_> = stream::iter(book_futures)
        .buffer_unordered(25) // Process 25 books concurrently (GPT-4o-mini has high rate limits)
        .collect()
        .await;

    for result in stream_results {
        if result.error.is_some() {
            total_failed += 1;
        } else if result.changed {
            total_cleaned += 1;
        } else {
            total_unchanged += 1;
        }
        results.push(result);
    }

    println!("🤖 GPT Genre Cleanup complete: {} cleaned, {} unchanged, {} failed",
        total_cleaned, total_unchanged, total_failed);

    Ok(GptGenreResponse {
        results,
        total_cleaned,
        total_unchanged,
        total_failed,
    })
}

// =============================================================================
// GPT-POWERED TAG ASSIGNMENT
// =============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct GptTagRequest {
    pub id: String,
    pub title: String,
    pub author: String,
    pub genres: Vec<String>,
    pub description: Option<String>,
    pub duration_minutes: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct GptTagResult {
    pub id: String,
    pub title: String,
    pub suggested_tags: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GptTagResponse {
    pub results: Vec<GptTagResult>,
    pub total_success: usize,
    pub total_failed: usize,
}

/// Assign tags to books using GPT analysis
/// This sends book metadata to GPT and gets back intelligent tag suggestions
#[tauri::command]
pub async fn assign_tags_with_gpt(
    books: Vec<GptTagRequest>,
    config: crate::config::Config,
) -> Result<GptTagResponse, String> {
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    println!("🤖 GPT Tag Assignment for {} books", books.len());

    let mut results = Vec::new();
    let mut total_success = 0;
    let mut total_failed = 0;

    // Process books with concurrency limit
    use futures::stream::{self, StreamExt};

    let api_key_clone = api_key.clone();
    let book_futures: Vec<_> = books.into_iter().map(|book| {
        let api_key = api_key_clone.clone();
        async move {
            let result = crate::scanner::processor::assign_tags_with_gpt(
                &book.title,
                &book.author,
                &book.genres,
                book.description.as_deref(),
                book.duration_minutes,
                &api_key,
            ).await;

            (book.id, book.title, result)
        }
    }).collect();

    let stream_results: Vec<_> = stream::iter(book_futures)
        .buffer_unordered(25) // Process 25 books concurrently (GPT-4o-mini has high rate limits)
        .collect()
        .await;

    for (id, title, result) in stream_results {
        match result {
            Ok(tags) => {
                println!("   ✅ {} : {:?}", title, tags);
                total_success += 1;
                results.push(GptTagResult {
                    id,
                    title,
                    suggested_tags: tags,
                    error: None,
                });
            }
            Err(e) => {
                println!("   ❌ {} : {}", title, e);
                total_failed += 1;
                results.push(GptTagResult {
                    id,
                    title,
                    suggested_tags: vec![],
                    error: Some(e),
                });
            }
        }
    }

    println!("🤖 GPT Tag Assignment complete: {} success, {} failed", total_success, total_failed);

    Ok(GptTagResponse {
        results,
        total_success,
        total_failed,
    })
}

/// Assign tags to a single book using GPT (for individual review)
#[tauri::command]
pub async fn assign_tags_single(
    title: String,
    author: String,
    genres: Vec<String>,
    description: Option<String>,
    duration_minutes: Option<u32>,
    config: crate::config::Config,
) -> Result<Vec<String>, String> {
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured")?;

    crate::scanner::processor::assign_tags_with_gpt(
        &title,
        &author,
        &genres,
        description.as_deref(),
        duration_minutes,
        api_key,
    ).await
}

// =============================================================================
// GPT-POWERED DESCRIPTION FIXING
// =============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct DescriptionFixRequest {
    pub id: String,
    pub title: String,
    pub author: String,
    pub genres: Vec<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DescriptionFixResult {
    pub id: String,
    pub title: String,
    pub original_description: Option<String>,
    pub new_description: Option<String>,
    pub was_bad: bool,
    pub fixed: bool,
    pub mismatch_reason: Option<String>,      // Why description was flagged (wrong book, garbage)
    pub extracted_narrator: Option<String>,   // Narrator extracted from "read by" patterns
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DescriptionFixResponse {
    pub results: Vec<DescriptionFixResult>,
    pub total_fixed: usize,
    pub total_skipped: usize,
    pub total_failed: usize,
}

/// Check and fix descriptions for books using GPT
/// Only fixes descriptions that are bad (missing, short, HTML, promotional)
/// If force=true, re-fetches descriptions for ALL books regardless of current state
#[tauri::command]
pub async fn fix_descriptions_with_gpt(
    books: Vec<DescriptionFixRequest>,
    config: crate::config::Config,
    force: Option<bool>,
) -> Result<DescriptionFixResponse, String> {
    let force = force.unwrap_or(false);
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    println!("📝 Description Fix for {} books (force={})", books.len(), force);

    let mut results = Vec::new();
    let mut total_fixed = 0;
    let mut total_skipped = 0;
    let mut total_failed = 0;

    // Process in batches
    use futures::stream::{self, StreamExt};

    let api_key_clone = api_key.clone();
    let book_futures: Vec<_> = books.into_iter().map(|book| {
        let api_key = api_key_clone.clone();
        let force = force;
        async move {
            // First, extract narrator from description (always do this, even for good descriptions)
            let extracted_narrator = book.description.as_deref()
                .and_then(crate::scanner::processor::extract_narrator_from_description);

            if let Some(ref narrator) = extracted_narrator {
                println!("   🎤 {} : extracted narrator '{}'", book.title, narrator);
            }

            // Track mismatch reason for reporting
            let mut mismatch_reason: Option<String> = None;

            // FORCE MODE: Skip all validation and just re-fetch
            if force {
                println!("   🔄 {} : FORCE mode - re-fetching description (skipping validation)", book.title);
                mismatch_reason = Some("Force refresh requested".to_string());
            } else {
                // Normal mode: Check basic quality issues (too short, HTML, repetition)
                let basic_bad = crate::scanner::processor::is_description_bad(book.description.as_deref());

                // If description exists and passes basic checks, validate with GPT that it matches the book
                let was_bad = if !basic_bad && book.description.is_some() {
                    let desc = book.description.as_deref().unwrap_or("");
                    // Validate with GPT - check if description is for wrong book or garbage
                    match crate::scanner::processor::validate_description_matches_book(
                        desc,
                        &book.title,
                        &book.author,
                        &api_key,
                    ).await {
                        Ok((is_valid, reason)) => {
                            if !is_valid {
                                println!("   ⚠️  {} : description mismatch - {}", book.title, reason);
                                mismatch_reason = Some(reason);
                                true
                            } else {
                                false
                            }
                        }
                        Err(e) => {
                            println!("   ⚠️  {} : validation error - {}", book.title, e);
                            // On validation error, assume description is OK but continue
                            false
                        }
                    }
                } else {
                    // Basic check failed, mark as bad
                    if basic_bad && book.description.is_some() {
                        mismatch_reason = Some("Description is too short, contains HTML, or has quality issues".to_string());
                    } else if book.description.is_none() {
                        mismatch_reason = Some("No description".to_string());
                    }
                    basic_bad || book.description.is_none()
                };

                // Skip if description is good (not forcing)
                if !was_bad {
                    return DescriptionFixResult {
                        id: book.id,
                        title: book.title,
                        original_description: book.description,
                        new_description: None,
                        was_bad: false,
                        fixed: false,
                        mismatch_reason: None,
                        extracted_narrator,
                        error: None,
                    };
                }
            }

            // Try to fix it (either force mode or description was bad)
            match crate::scanner::processor::fix_description_with_gpt(
                &book.title,
                &book.author,
                &book.genres,
                book.description.as_deref(),
                &api_key,
            ).await {
                Ok(new_desc) => {
                    println!("   ✅ {} : fixed description", book.title);
                    DescriptionFixResult {
                        id: book.id,
                        title: book.title,
                        original_description: book.description,
                        new_description: Some(new_desc),
                        was_bad: true,
                        fixed: true,
                        mismatch_reason,
                        extracted_narrator,
                        error: None,
                    }
                }
                Err(e) => {
                    println!("   ❌ {} : {}", book.title, e);
                    DescriptionFixResult {
                        id: book.id,
                        title: book.title,
                        original_description: book.description,
                        new_description: None,
                        was_bad: true,
                        fixed: false,
                        mismatch_reason,
                        extracted_narrator,
                        error: Some(e),
                    }
                }
            }
        }
    }).collect();

    let stream_results: Vec<_> = stream::iter(book_futures)
        .buffer_unordered(25)
        .collect()
        .await;

    for result in stream_results {
        if !result.was_bad {
            total_skipped += 1;
        } else if result.fixed {
            total_fixed += 1;
        } else {
            total_failed += 1;
        }
        results.push(result);
    }

    println!("📝 Description Fix complete: {} fixed, {} skipped (already good), {} failed",
        total_fixed, total_skipped, total_failed);

    Ok(DescriptionFixResponse {
        results,
        total_fixed,
        total_skipped,
        total_failed,
    })
}

// =============================================================================
// GPT-POWERED TITLE CLEANUP
// =============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct TitleCleanupRequest {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub narrator: Option<String>,
    pub series: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TitleCleanupResult {
    pub id: String,
    pub original_title: String,
    pub clean_title: String,
    pub extracted_subtitle: Option<String>,
    pub extracted_author: Option<String>,
    pub extracted_narrator: Option<String>,
    pub extracted_series: Option<String>,
    pub extracted_sequence: Option<String>,
    pub extracted_year: Option<String>,
    pub changed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TitleCleanupResponse {
    pub results: Vec<TitleCleanupResult>,
    pub total_cleaned: usize,
    pub total_unchanged: usize,
    pub total_failed: usize,
}

/// Clean messy book titles using GPT
/// Extracts embedded metadata (narrator, author, series, year) and returns clean title
#[tauri::command]
pub async fn clean_titles_with_gpt(
    books: Vec<TitleCleanupRequest>,
    config: crate::config::Config,
) -> Result<TitleCleanupResponse, String> {
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    println!("🧹 Title Cleanup for {} books", books.len());

    let mut results = Vec::new();
    let mut total_cleaned = 0;
    let mut total_unchanged = 0;
    let mut total_failed = 0;

    // Process in batches
    use futures::stream::{self, StreamExt};

    let api_key_clone = api_key.clone();
    let book_futures: Vec<_> = books.into_iter().map(|book| {
        let api_key = api_key_clone.clone();
        async move {
            // Skip if title looks clean already (no special chars, reasonable length)
            let needs_cleanup = book.title.contains(" - ")
                || book.title.contains("(")
                || book.title.contains("[")
                || book.title.to_lowercase().contains("read by")
                || book.title.to_lowercase().contains("narrated by")
                || book.title.to_lowercase().contains("unabr")
                || book.title.chars().take(5).all(|c| c.is_ascii_digit() || c == ' ' || c == '-');

            if !needs_cleanup {
                return TitleCleanupResult {
                    id: book.id,
                    original_title: book.title.clone(),
                    clean_title: book.title,
                    extracted_subtitle: None,
                    extracted_author: None,
                    extracted_narrator: None,
                    extracted_series: None,
                    extracted_sequence: None,
                    extracted_year: None,
                    changed: false,
                    error: None,
                };
            }

            match crate::scanner::processor::clean_title_with_gpt(
                &book.title,
                book.author.as_deref(),
                book.narrator.as_deref(),
                book.series.as_deref(),
                &api_key,
            ).await {
                Ok(result) => {
                    let changed = result.clean_title != book.title;
                    if changed {
                        println!("   ✅ \"{}\" → \"{}\"", book.title, result.clean_title);
                    }
                    TitleCleanupResult {
                        id: book.id,
                        original_title: book.title,
                        clean_title: result.clean_title,
                        extracted_subtitle: result.extracted_subtitle,
                        extracted_author: result.extracted_author,
                        extracted_narrator: result.extracted_narrator,
                        extracted_series: result.extracted_series,
                        extracted_sequence: result.extracted_sequence,
                        extracted_year: result.extracted_year,
                        changed,
                        error: None,
                    }
                }
                Err(e) => {
                    println!("   ❌ {} : {}", book.title, e);
                    TitleCleanupResult {
                        id: book.id,
                        original_title: book.title.clone(),
                        clean_title: book.title,
                        extracted_subtitle: None,
                        extracted_author: None,
                        extracted_narrator: None,
                        extracted_series: None,
                        extracted_sequence: None,
                        extracted_year: None,
                        changed: false,
                        error: Some(e),
                    }
                }
            }
        }
    }).collect();

    let stream_results: Vec<_> = stream::iter(book_futures)
        .buffer_unordered(25)
        .collect()
        .await;

    for result in stream_results {
        if result.error.is_some() {
            total_failed += 1;
        } else if result.changed {
            total_cleaned += 1;
        } else {
            total_unchanged += 1;
        }
        results.push(result);
    }

    println!("🧹 Title Cleanup complete: {} cleaned, {} unchanged, {} failed",
        total_cleaned, total_unchanged, total_failed);

    Ok(TitleCleanupResponse {
        results,
        total_cleaned,
        total_unchanged,
        total_failed,
    })
}

// =============================================================================
// GPT-POWERED SUBTITLE LOOKUP
// =============================================================================

/// Check if a subtitle is "good" (valid, meaningful, and appropriate)
fn is_good_subtitle(subtitle: &str, title: &str, author: &str) -> bool {
    let s = subtitle.trim();
    let s_lower = s.to_lowercase();
    let title_lower = title.to_lowercase();
    let author_lower = author.to_lowercase();

    // Too short (less than 3 chars) is bad
    if s.len() < 3 {
        return false;
    }

    // Too long (more than 150 chars) is suspicious
    if s.len() > 150 {
        return false;
    }

    // Reject placeholder/garbage values
    let bad_values = [
        "null", "none", "n/a", "na", "unknown", "subtitle", "tbd", "tba",
        "undefined", "untitled", "no subtitle", "(none)", "-", "--", "...",
    ];
    if bad_values.contains(&s_lower.as_str()) {
        return false;
    }

    // Reject if subtitle is the same as title (shouldn't repeat)
    if s_lower == title_lower {
        return false;
    }

    // Reject if subtitle IS the author name
    if s_lower == author_lower {
        return false;
    }

    // Reject if it's just the title with minor changes
    if title_lower.contains(&s_lower) || s_lower.contains(&title_lower) {
        // Exception: series indicators like "A Novel" are OK even if title contains "Novel"
        let is_series_indicator = s_lower.starts_with("a ") ||
            s_lower.starts_with("an ") ||
            s_lower.starts_with("the ") ||
            s_lower.contains(" book ") ||
            s_lower.contains(" novel") ||
            s_lower.contains(" mystery") ||
            s_lower.contains(" series");
        if !is_series_indicator {
            return false;
        }
    }

    // Reject if it looks like HTML or code
    if s.contains('<') || s.contains('>') || s.contains('{') || s.contains('}') {
        return false;
    }

    // Reject if it's mostly numbers
    let alpha_count = s.chars().filter(|c| c.is_alphabetic()).count();
    if alpha_count < s.len() / 2 {
        return false;
    }

    // Reject common bad patterns
    let bad_patterns = [
        "read by", "narrated by", "performed by", "audiobook", "unabridged",
        "abridged", "audio edition", "mp3", "download", "©", "copyright",
        "all rights", "http://", "https://", "www.", ".com", ".org",
    ];
    for pattern in &bad_patterns {
        if s_lower.contains(pattern) {
            return false;
        }
    }

    // Good subtitle patterns (positive signals)
    let good_patterns = [
        "a novel", "a memoir", "a thriller", "a mystery", "an investigation",
        "book one", "book two", "book 1", "book 2", "volume",
        "or ", "and other", "the ", "a ", "an ",
    ];
    let has_good_pattern = good_patterns.iter().any(|p| s_lower.contains(p));

    // If it has a good pattern, it's definitely good
    if has_good_pattern {
        return true;
    }

    // Otherwise, accept if it's a reasonable length and not obviously bad
    s.len() >= 5 && s.len() <= 100
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SubtitleFixRequest {
    pub id: String,
    pub title: String,
    pub author: String,
    pub current_subtitle: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SubtitleFixResult {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub source: Option<String>,
    pub fixed: bool,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SubtitleFixResponse {
    pub results: Vec<SubtitleFixResult>,
    pub total_fixed: usize,
    pub total_skipped: usize,
    pub total_failed: usize,
}

/// Fix/fetch subtitles for books using Audible + GPT
/// Tries Audible first (most reliable), then GPT as fallback
#[tauri::command]
pub async fn fix_subtitles_batch(
    books: Vec<SubtitleFixRequest>,
    config: crate::config::Config,
    force: Option<bool>,
) -> Result<SubtitleFixResponse, String> {
    let force = force.unwrap_or(false);
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    println!("📖 Subtitle Fix for {} books (force={})", books.len(), force);

    let mut results = Vec::new();
    let mut total_fixed = 0;
    let mut total_skipped = 0;
    let mut total_failed = 0;

    use futures::stream::{self, StreamExt};

    let api_key_clone = api_key.clone();
    let config_clone = config.clone();
    let book_futures: Vec<_> = books.into_iter().map(|book| {
        let api_key = api_key_clone.clone();
        let config = config_clone.clone();
        async move {
            // Check if current subtitle is good
            let current_is_good = book.current_subtitle.as_ref()
                .map(|s| is_good_subtitle(s, &book.title, &book.author))
                .unwrap_or(false);

            // Skip if already has a GOOD subtitle and not forcing
            if !force && current_is_good {
                println!("   ⏭️  {} : already has good subtitle '{}', skipping",
                    book.title, book.current_subtitle.as_deref().unwrap_or(""));
                return SubtitleFixResult {
                    id: book.id,
                    title: book.title,
                    subtitle: book.current_subtitle,
                    source: None,
                    fixed: false,
                    skipped: true,
                    error: None,
                };
            }

            // Log why we're fetching
            if force {
                println!("   🔄 {} : FORCE mode - re-fetching subtitle", book.title);
            } else if book.current_subtitle.is_some() && !current_is_good {
                println!("   ⚠️  {} : current subtitle '{}' is low quality, fetching better one",
                    book.title, book.current_subtitle.as_deref().unwrap_or(""));
            }

            // Try ABS metadata search first (Audible, Google, iTunes via ABS API)
            println!("   🔍 {} : searching via ABS APIs for subtitle...", book.title);
            if let Some(abs_result) = crate::abs_search::search_metadata_waterfall(&config, &book.title, &book.author).await {
                // Found a result, check for subtitle
                if let Some(ref subtitle) = abs_result.subtitle {
                    if !subtitle.is_empty() && is_good_subtitle(subtitle, &book.title, &book.author) {
                        println!("   ✅ {} : found subtitle from ABS: '{}'", book.title, subtitle);
                        return SubtitleFixResult {
                            id: book.id,
                            title: book.title,
                            subtitle: Some(subtitle.clone()),
                            source: Some("ABS".to_string()),
                            fixed: true,
                            skipped: false,
                            error: None,
                        };
                    }
                }
                println!("   ℹ️  {} : ABS found book but no good subtitle, trying GPT...", book.title);
            } else {
                println!("   ℹ️  {} : no ABS results, trying GPT...", book.title);
            }

            // Step 1: Try GPT lookup for existing subtitle
            let lookup_prompt = format!(
r#"Does the book "{}" by {} have an official subtitle?

Check your knowledge for official subtitles from publishers, Goodreads, Amazon, etc.

Common subtitle patterns:
- Series indicator: "A Hamish Macbeth Mystery", "An Inspector Gamache Novel"
- Descriptive: "A Novel", "A Memoir", "A Thriller"
- Sequential: "Book One of the Dune Chronicles"

Return the OFFICIAL subtitle if one exists, or null if none.

Return ONLY valid JSON:
{{"subtitle": "Official Subtitle" or null, "found": true/false}}"#,
                book.title, book.author
            );

            let mut found_subtitle: Option<String> = None;
            let mut subtitle_source: Option<String> = None;

            // Try lookup first
            if let Ok(response) = crate::scanner::processor::call_gpt_api(&lookup_prompt, &api_key, &crate::scanner::processor::preferred_model(), 200).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&response) {
                    if let Some(subtitle) = parsed.get("subtitle").and_then(|v| v.as_str()) {
                        if !subtitle.is_empty() && subtitle.to_lowercase() != "null" {
                            println!("   ✅ {} : found official subtitle from GPT: '{}'", book.title, subtitle);
                            found_subtitle = Some(subtitle.to_string());
                            subtitle_source = Some("GPT-Lookup".to_string());
                        }
                    }
                }
            }

            // Step 2: If no official subtitle found, generate an appropriate one
            if found_subtitle.is_none() {
                println!("   🤖 {} : no official subtitle, generating one...", book.title);

                let generate_prompt = format!(
r#"Generate an appropriate subtitle for this audiobook:

Title: "{}"
Author: {}

Rules for generating subtitles:
1. For mystery/detective series: "A [Character Name] Mystery" or "A [Series Name] Novel"
2. For thrillers: "A Thriller" or "A [Character] Thriller"
3. For fantasy/sci-fi series: "[Series Name] Book [N]" or "A [World] Novel"
4. For literary fiction: "A Novel"
5. For memoirs/biography: "A Memoir" or "A Life"
6. For romance: "A [Subgenre] Romance"

The subtitle should:
- Be concise (2-6 words typically)
- Match the book's genre and tone
- Sound professional like a real publisher subtitle
- NOT repeat the title or author name

Generate a fitting subtitle for this book.

Return ONLY valid JSON:
{{"subtitle": "Generated Subtitle", "reasoning": "brief explanation"}}"#,
                    book.title, book.author
                );

                if let Ok(response) = crate::scanner::processor::call_gpt_api(&generate_prompt, &api_key, &crate::scanner::processor::preferred_model(), 300).await {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&response) {
                        if let Some(subtitle) = parsed.get("subtitle").and_then(|v| v.as_str()) {
                            if !subtitle.is_empty() && subtitle.to_lowercase() != "null" {
                                // Validate the generated subtitle
                                if is_good_subtitle(subtitle, &book.title, &book.author) {
                                    println!("   ✨ {} : generated subtitle: '{}'", book.title, subtitle);
                                    found_subtitle = Some(subtitle.to_string());
                                    subtitle_source = Some("GPT-Generated".to_string());
                                } else {
                                    println!("   ⚠️  {} : generated subtitle '{}' failed validation", book.title, subtitle);
                                }
                            }
                        }
                    }
                }
            }

            // Return result
            if let Some(subtitle) = found_subtitle {
                SubtitleFixResult {
                    id: book.id,
                    title: book.title,
                    subtitle: Some(subtitle),
                    source: subtitle_source,
                    fixed: true,
                    skipped: false,
                    error: None,
                }
            } else {
                println!("   ℹ️  {} : could not find or generate subtitle", book.title);
                SubtitleFixResult {
                    id: book.id,
                    title: book.title,
                    subtitle: None,
                    source: None,
                    fixed: false,
                    skipped: false,
                    error: None,
                }
            }
        }
    }).collect();

    let stream_results: Vec<_> = stream::iter(book_futures)
        .buffer_unordered(50)  // Lower concurrency for Audible rate limits
        .collect()
        .await;

    for result in stream_results {
        if result.error.is_some() {
            total_failed += 1;
        } else if result.skipped {
            total_skipped += 1;
        } else if result.fixed {
            total_fixed += 1;
        } else {
            total_skipped += 1;  // No subtitle found counts as skipped
        }
        results.push(result);
    }

    println!("📖 Subtitle Fix complete: {} fixed, {} skipped, {} failed",
        total_fixed, total_skipped, total_failed);

    Ok(SubtitleFixResponse {
        results,
        total_fixed,
        total_skipped,
        total_failed,
    })
}

// =============================================================================
// GPT-POWERED AUTHOR FIX
// =============================================================================

/// Check if an author name is "good" (valid, properly formatted)
fn is_good_author(author: &str, title: &str) -> bool {
    let a = author.trim();
    let a_lower = a.to_lowercase();
    let title_lower = title.to_lowercase();

    // Too short (less than 2 chars) is bad
    if a.len() < 2 {
        return false;
    }

    // Too long (more than 100 chars) is suspicious
    if a.len() > 100 {
        return false;
    }

    // Reject placeholder/garbage values
    let bad_values = [
        "unknown", "unknown author", "various", "various authors", "n/a", "na",
        "null", "none", "author", "audiobook", "narrator", "reader",
        "undefined", "tbd", "tba", "-", "--", "...", "anonymous",
    ];
    if bad_values.contains(&a_lower.as_str()) {
        return false;
    }

    // Reject if author is same as title (common error)
    if a_lower == title_lower {
        return false;
    }

    // Reject if it looks like a series name (contains "series", "book", etc.)
    let series_indicators = [
        " series", " trilogy", " saga", " chronicles", " collection",
        " book ", " volume ", " vol ", "#", "book 1", "book 2",
    ];
    for indicator in &series_indicators {
        if a_lower.contains(indicator) {
            return false;
        }
    }

    // Reject if it looks like HTML or code
    if a.contains('<') || a.contains('>') || a.contains('{') || a.contains('}') {
        return false;
    }

    // Reject if mostly numbers
    let alpha_count = a.chars().filter(|c| c.is_alphabetic()).count();
    if alpha_count < a.len() / 2 {
        return false;
    }

    // Reject common bad patterns
    let bad_patterns = [
        "http://", "https://", "www.", ".com", ".org", ".net",
        "©", "copyright", "all rights", "published by", "narrated by",
        "read by", "performed by", "audiobook", "unabridged",
    ];
    for pattern in &bad_patterns {
        if a_lower.contains(pattern) {
            return false;
        }
    }

    // Check for reasonable author name structure
    // Should have at least one space (first + last name) or be a single known name
    let word_count = a.split_whitespace().count();
    if word_count == 0 {
        return false;
    }

    // Single word names are OK for some authors (Madonna, Voltaire, etc.)
    // but flag as potentially suspicious if very short
    if word_count == 1 && a.len() < 4 {
        return false;
    }

    // Names with more than 5 words are suspicious (might be title/description)
    if word_count > 5 {
        return false;
    }

    true
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthorFixRequest {
    pub id: String,
    pub title: String,
    pub current_author: String,
    pub narrator: Option<String>,
    pub series: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthorFixResult {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub source: Option<String>,
    pub fixed: bool,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthorFixResponse {
    pub results: Vec<AuthorFixResult>,
    pub total_fixed: usize,
    pub total_skipped: usize,
    pub total_failed: usize,
}

/// Fix/fetch authors for books using ABS APIs + GPT
#[tauri::command]
pub async fn fix_authors_batch(
    books: Vec<AuthorFixRequest>,
    config: crate::config::Config,
    force: Option<bool>,
) -> Result<AuthorFixResponse, String> {
    let force = force.unwrap_or(false);
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    println!("✍️  Author Fix for {} books (force={})", books.len(), force);

    let mut results = Vec::new();
    let mut total_fixed = 0;
    let mut total_skipped = 0;
    let mut total_failed = 0;

    use futures::stream::{self, StreamExt};

    let api_key_clone = api_key.clone();
    let config_clone = config.clone();
    let book_futures: Vec<_> = books.into_iter().map(|book| {
        let api_key = api_key_clone.clone();
        let config = config_clone.clone();
        async move {
            // Check if current author is good
            let current_is_good = is_good_author(&book.current_author, &book.title);

            // Skip if already has a GOOD author and not forcing
            if !force && current_is_good {
                println!("   ⏭️  {} : already has good author '{}', skipping",
                    book.title, book.current_author);
                return AuthorFixResult {
                    id: book.id,
                    title: book.title,
                    author: Some(book.current_author),
                    source: None,
                    fixed: false,
                    skipped: true,
                    error: None,
                };
            }

            // Log why we're fetching
            if force {
                println!("   🔄 {} : FORCE mode - re-fetching author", book.title);
            } else {
                println!("   ⚠️  {} : current author '{}' is invalid, fetching correct one",
                    book.title, book.current_author);
            }

            // Try ABS metadata search first (Audible, Google, iTunes via ABS API)
            println!("   🔍 {} : searching via ABS APIs for author...", book.title);
            if let Some(abs_result) = crate::abs_search::search_metadata_waterfall(&config, &book.title, &book.current_author).await {
                // Found a result, check for author
                if let Some(ref author) = abs_result.author {
                    if !author.is_empty() && is_good_author(author, &book.title) {
                        println!("   ✅ {} : found author from ABS: '{}'", book.title, author);
                        return AuthorFixResult {
                            id: book.id,
                            title: book.title,
                            author: Some(author.clone()),
                            source: Some("ABS".to_string()),
                            fixed: true,
                            skipped: false,
                            error: None,
                        };
                    }
                }
                println!("   ℹ️  {} : ABS found book but no good author, trying GPT...", book.title);
            } else {
                println!("   ℹ️  {} : no ABS results, trying GPT...", book.title);
            }

            // Step 2: Try GPT lookup for correct author
            let lookup_prompt = format!(
r#"Who is the author of the book "{}"?

Current (possibly wrong) author: "{}"
{}{}

Return the CORRECT author name. Use the standard format:
- "First Last" (e.g., "Stephen King")
- "First Middle Last" if commonly used (e.g., "George R. R. Martin")
- For multiple authors: "Author One, Author Two"

Return ONLY valid JSON:
{{"author": "Correct Author Name", "confidence": 0-100}}"#,
                book.title,
                book.current_author,
                book.narrator.as_ref().map(|n| format!("Narrator: {}\n", n)).unwrap_or_default(),
                book.series.as_ref().map(|s| format!("Series: {}\n", s)).unwrap_or_default()
            );

            if let Ok(response) = crate::scanner::processor::call_gpt_api(&lookup_prompt, &api_key, &crate::scanner::processor::preferred_model(), 200).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&response) {
                    if let Some(author) = parsed.get("author").and_then(|v| v.as_str()) {
                        if !author.is_empty() && author.to_lowercase() != "null" && is_good_author(author, &book.title) {
                            println!("   ✅ {} : found author from GPT: '{}'", book.title, author);
                            return AuthorFixResult {
                                id: book.id,
                                title: book.title,
                                author: Some(author.to_string()),
                                source: Some("GPT".to_string()),
                                fixed: true,
                                skipped: false,
                                error: None,
                            };
                        }
                    }
                }
            }

            // Could not find author
            println!("   ❌ {} : could not find correct author", book.title);
            AuthorFixResult {
                id: book.id,
                title: book.title,
                author: None,
                source: None,
                fixed: false,
                skipped: false,
                error: Some("Could not determine correct author".to_string()),
            }
        }
    }).collect();

    let stream_results: Vec<_> = stream::iter(book_futures)
        .buffer_unordered(50)
        .collect()
        .await;

    for result in stream_results {
        if result.error.is_some() {
            total_failed += 1;
        } else if result.skipped {
            total_skipped += 1;
        } else if result.fixed {
            total_fixed += 1;
        } else {
            total_failed += 1;
        }
        results.push(result);
    }

    println!("✍️  Author Fix complete: {} fixed, {} skipped, {} failed",
        total_fixed, total_skipped, total_failed);

    Ok(AuthorFixResponse {
        results,
        total_fixed,
        total_skipped,
        total_failed,
    })
}

// =============================================================================
// Year Fixing (Original Publication Year)
// =============================================================================

/// Check if a year looks valid
fn is_valid_year(year: &str) -> bool {
    if let Ok(y) = year.parse::<i32>() {
        // Reasonable range: 1800 to current year
        y >= 1800 && y <= 2030
    } else {
        false
    }
}

/// Source date with confidence
#[derive(Debug, Clone)]
struct SourceDate {
    year: i32,
    date: String,
    source: String,
}

/// Result from multi-source lookup
enum MultiSourceResult {
    /// Sources agree - use this date
    Confirmed { year: String, date: String, source: String },
    /// Only one source found
    SingleSource { year: String, date: String, source: String },
    /// Sources disagree - includes the conflicting years for GPT to resolve
    Conflict { years: Vec<i32> },
    /// No sources found anything
    NotFound,
}

/// Build a MultiSourceResult from pre-fetched year data (from gather phase)
fn build_multi_source_from_prefetched(book: &YearFixRequest) -> MultiSourceResult {
    let mut found_dates: Vec<SourceDate> = Vec::new();

    if let Some(ref year_str) = book.ol_year {
        if let Ok(year) = year_str.parse::<i32>() {
            let date = book.ol_date.clone().unwrap_or_else(|| format!("{}-01-01", year));
            println!("      📚 Open Library (pre-fetched): {}", year);
            found_dates.push(SourceDate { year, date, source: "OpenLibrary".to_string() });
        }
    }

    if let Some(ref year_str) = book.gb_year {
        if let Ok(year) = year_str.parse::<i32>() {
            let date = book.gb_date.clone().unwrap_or_else(|| format!("{}-01-01", year));
            println!("      📖 Google Books (pre-fetched): {}", year);
            found_dates.push(SourceDate { year, date, source: "GoogleBooks".to_string() });
        }
    }

    if let Some(ref year_str) = book.provider_year {
        if let Ok(year) = year_str.parse::<i32>() {
            let date = format!("{}-01-01", year);
            println!("      🔌 Custom Provider (pre-fetched): {}", year);
            found_dates.push(SourceDate { year, date, source: "CustomProvider".to_string() });
        }
    }

    if found_dates.is_empty() {
        return MultiSourceResult::NotFound;
    }

    if found_dates.len() == 1 {
        let d = &found_dates[0];
        return MultiSourceResult::SingleSource {
            year: d.year.to_string(),
            date: d.date.clone(),
            source: d.source.clone(),
        };
    }

    let years: Vec<i32> = found_dates.iter().map(|d| d.year).collect();
    let min_year = *years.iter().min().unwrap();
    let max_year = *years.iter().max().unwrap();

    if max_year - min_year <= 2 {
        let best = found_dates.iter()
            .find(|d| d.source == "OpenLibrary")
            .unwrap_or(&found_dates[0]);
        return MultiSourceResult::Confirmed {
            year: best.year.to_string(),
            date: best.date.clone(),
            source: format!("{} (confirmed)", best.source),
        };
    }

    MultiSourceResult::Conflict { years }
}

/// Look up publication dates from multiple sources and cross-reference
async fn lookup_publication_date_multi(title: &str, author: &str) -> MultiSourceResult {
    let mut found_dates: Vec<SourceDate> = Vec::new();

    // Parallel fetch from all sources
    let (ol_result, gb_result) = tokio::join!(
        lookup_open_library_inner(title, author),
        lookup_google_books_inner(title, author)
    );

    if let Some((year, date)) = ol_result {
        println!("      📚 Open Library: {}", year);
        found_dates.push(SourceDate { year, date, source: "OpenLibrary".to_string() });
    }

    if let Some((year, date)) = gb_result {
        println!("      📖 Google Books: {}", year);
        found_dates.push(SourceDate { year, date, source: "GoogleBooks".to_string() });
    }

    if found_dates.is_empty() {
        return MultiSourceResult::NotFound;
    }

    // If only one source, use it
    if found_dates.len() == 1 {
        let d = &found_dates[0];
        return MultiSourceResult::SingleSource {
            year: d.year.to_string(),
            date: d.date.clone(),
            source: d.source.clone(),
        };
    }

    // Multiple sources - check if they agree (within 2 years)
    let years: Vec<i32> = found_dates.iter().map(|d| d.year).collect();
    let min_year = *years.iter().min().unwrap();
    let max_year = *years.iter().max().unwrap();

    if max_year - min_year <= 2 {
        // Sources agree - prefer Open Library as it tracks first_publish_year
        let best = found_dates.iter()
            .find(|d| d.source == "OpenLibrary")
            .unwrap_or(&found_dates[0]);
        println!("      ✓ Sources agree (~{})", best.year);
        return MultiSourceResult::Confirmed {
            year: best.year.to_string(),
            date: best.date.clone(),
            source: format!("{} (confirmed)", best.source),
        };
    }

    // Sources disagree significantly - return conflict for GPT to resolve
    println!("      ⚠️  Sources disagree: {:?} - using GPT to verify", years);
    MultiSourceResult::Conflict { years }
}

/// Look up from Open Library API (public for gather.rs)
pub async fn lookup_open_library_pub(title: &str, author: &str) -> Option<(i32, String)> {
    lookup_open_library_inner(title, author).await
}

/// Look up from Open Library API
async fn lookup_open_library_inner(title: &str, author: &str) -> Option<(i32, String)> {
    let client = reqwest::Client::new();

    let query = format!("{} {}", title, author);
    let url = format!(
        "https://openlibrary.org/search.json?q={}&fields=title,author_name,first_publish_year,publish_date&limit=5",
        urlencoding::encode(&query)
    );

    // Retry up to 3 times with backoff for rate limiting
    let mut json: Option<serde_json::Value> = None;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
        }
        match client.get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .send().await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(j) = resp.json::<serde_json::Value>().await {
                    json = Some(j);
                    break;
                }
            }
            Ok(resp) if resp.status() == 429 => {
                println!("      ⏳ Open Library rate limited, retrying...");
                continue;
            }
            _ => continue,
        }
    }
    let json = json?;

    let author_lower = author.to_lowercase();
    // Extract individual author last names for matching (e.g. "Stephen King, Peter Straub" → ["king", "straub"])
    let query_author_parts: Vec<&str> = author_lower
        .split(|c: char| c == ',' || c == '&' || c == ';')
        .flat_map(|part| part.trim().split_whitespace().last())
        .collect();

    if let Some(docs) = json.get("docs").and_then(|d| d.as_array()) {
        for doc in docs {
            let doc_title = doc.get("title").and_then(|t| t.as_str()).unwrap_or("");
            let title_lower = title.to_lowercase();
            let doc_title_lower = doc_title.to_lowercase();

            // Title fuzzy match
            if !doc_title_lower.contains(&title_lower) && !title_lower.contains(&doc_title_lower) {
                let title_words: std::collections::HashSet<_> = title_lower.split_whitespace().collect();
                let doc_words: std::collections::HashSet<_> = doc_title_lower.split_whitespace().collect();
                let overlap = title_words.intersection(&doc_words).count();
                if overlap < 2 {
                    continue;
                }
            }

            // Author validation — at least one author last name must match
            let doc_authors = doc.get("author_name")
                .and_then(|a| a.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
                .unwrap_or_default();
            let doc_authors_lower: String = doc_authors.join(" ").to_lowercase();

            let author_match = query_author_parts.iter().any(|part| doc_authors_lower.contains(part));
            if !author_match && !doc_authors.is_empty() {
                println!("      📚 Open Library: skipping '{}' by {:?} (author mismatch with '{}')",
                    doc_title, doc_authors, author);
                continue;
            }

            if let Some(year) = doc.get("first_publish_year").and_then(|y| y.as_i64()) {
                let year_i32 = year as i32;
                if year_i32 >= 1800 && year_i32 <= 2030 {
                    println!("      📚 Open Library: matched '{}' by {:?} → {}",
                        doc_title, doc_authors, year_i32);
                    let full_date = format!("{}-01-01", year_i32);
                    return Some((year_i32, full_date));
                }
            }
        }
    }

    None
}

/// Look up from Google Books API (public for gather.rs)
pub async fn lookup_google_books_pub(title: &str, author: &str) -> Option<(i32, String)> {
    lookup_google_books_inner(title, author).await
}

/// Look up from Google Books API
async fn lookup_google_books_inner(title: &str, author: &str) -> Option<(i32, String)> {
    let client = reqwest::Client::new();

    let query = format!("intitle:{} inauthor:{}", title, author);
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&maxResults=10&orderBy=relevance",
        urlencoding::encode(&query)
    );

    // Retry up to 3 times with backoff for rate limiting
    let mut json: Option<serde_json::Value> = None;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
        }
        match client.get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .send().await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(j) = resp.json::<serde_json::Value>().await {
                    json = Some(j);
                    break;
                }
            }
            Ok(resp) if resp.status() == 429 => {
                println!("      ⏳ Google Books rate limited, retrying...");
                continue;
            }
            _ => continue,
        }
    }
    let json = json?;

    let author_lower = author.to_lowercase();
    let query_author_parts: Vec<&str> = author_lower
        .split(|c: char| c == ',' || c == '&' || c == ';')
        .flat_map(|part| part.trim().split_whitespace().last())
        .collect();

    // Track earliest year found
    let mut earliest: Option<(i32, String)> = None;

    if let Some(items) = json.get("items").and_then(|i| i.as_array()) {
        for item in items {
            let volume = match item.get("volumeInfo") {
                Some(v) => v,
                None => continue,
            };

            let doc_title = volume.get("title").and_then(|t| t.as_str()).unwrap_or("");
            let title_lower = title.to_lowercase();
            let doc_title_lower = doc_title.to_lowercase();

            // Title fuzzy match
            if !doc_title_lower.contains(&title_lower) && !title_lower.contains(&doc_title_lower) {
                let title_words: std::collections::HashSet<_> = title_lower.split_whitespace().collect();
                let doc_words: std::collections::HashSet<_> = doc_title_lower.split_whitespace().collect();
                let overlap = title_words.intersection(&doc_words).count();
                if overlap < 2 {
                    continue;
                }
            }

            // Author validation
            let doc_authors = volume.get("authors")
                .and_then(|a| a.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
                .unwrap_or_default();
            let doc_authors_lower: String = doc_authors.join(" ").to_lowercase();

            let author_match = query_author_parts.iter().any(|part| doc_authors_lower.contains(part));
            if !author_match && !doc_authors.is_empty() {
                continue;
            }

            if let Some(pub_date) = volume.get("publishedDate").and_then(|d| d.as_str()) {
                let (year_str, full_date) = parse_google_date(pub_date);
                if let Ok(year_int) = year_str.parse::<i32>() {
                    if year_int >= 1800 && year_int <= 2030 {
                        if earliest.is_none() || year_int < earliest.as_ref().unwrap().0 {
                            earliest = Some((year_int, full_date));
                        }
                    }
                }
            }
        }
    }

    earliest
}

/// Parse various date formats into ISO format
fn parse_date_string(date_str: &str, year: &str) -> String {
    // Try to parse formats like "May 1, 1985", "1985-05-01", "1985", etc.
    let trimmed = date_str.trim();

    // Already ISO format
    if trimmed.len() == 10 && trimmed.chars().nth(4) == Some('-') {
        return trimmed.to_string();
    }

    // Just year
    if trimmed.len() == 4 && trimmed.chars().all(|c| c.is_ascii_digit()) {
        return format!("{}-01-01", trimmed);
    }

    // Try parsing common formats - just use year-01-01 for simplicity
    format!("{}-01-01", year)
}

/// Parse Google Books date format (YYYY, YYYY-MM, or YYYY-MM-DD)
fn parse_google_date(date_str: &str) -> (String, String) {
    let parts: Vec<&str> = date_str.split('-').collect();
    match parts.len() {
        1 => (parts[0].to_string(), format!("{}-01-01", parts[0])),
        2 => (parts[0].to_string(), format!("{}-{}-01", parts[0], parts[1])),
        _ => (parts[0].to_string(), date_str.to_string()),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct YearFixRequest {
    pub id: String,
    pub title: String,
    pub author: String,
    pub current_year: Option<String>,
    pub series: Option<String>,
    pub description: Option<String>,
    /// Pre-fetched Open Library year (from gather phase)
    #[serde(default)]
    pub ol_year: Option<String>,
    /// Pre-fetched Open Library date (from gather phase)
    #[serde(default)]
    pub ol_date: Option<String>,
    /// Pre-fetched Google Books year (from gather phase)
    #[serde(default)]
    pub gb_year: Option<String>,
    /// Pre-fetched Google Books date (from gather phase)
    #[serde(default)]
    pub gb_date: Option<String>,
    /// Pre-fetched year from custom providers like Goodreads (from gather phase)
    #[serde(default)]
    pub provider_year: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct YearFixResult {
    pub id: String,
    pub title: String,
    pub year: Option<String>,
    pub pub_date: Option<String>,  // Full ISO date like "1945-11-26"
    pub pub_tag: Option<String>,   // DNA tag like "pub-1945-11-26"
    pub source: Option<String>,
    pub fixed: bool,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct YearFixResponse {
    pub results: Vec<YearFixResult>,
    pub total_fixed: usize,
    pub total_skipped: usize,
    pub total_failed: usize,
}

/// Fix/fetch original publication years for books using ABS APIs + GPT
#[tauri::command]
pub async fn fix_years_batch(
    books: Vec<YearFixRequest>,
    config: crate::config::Config,
    force: Option<bool>,
) -> Result<YearFixResponse, String> {
    use futures::stream::{self, StreamExt};

    let force = force.unwrap_or(false);
    let api_key = config.openai_api_key.as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("OpenAI API key not configured. Go to Settings to add it.")?;

    println!("📅 Year Fix for {} books (force={})", books.len(), force);

    let mut results = Vec::new();
    let mut total_fixed = 0;
    let mut total_skipped = 0;
    let mut total_failed = 0;

    let config_clone = config.clone();

    let book_futures: Vec<_> = books.into_iter().map(|book| {
        let api_key = api_key.clone();
        let config = config_clone.clone();

        async move {
            // Check if current year is valid and we're not forcing
            if !force {
                if let Some(ref year) = book.current_year {
                    if is_valid_year(year) {
                        println!("   ⏭️  {} : year '{}' is valid, skipping", book.title, year);
                        let date = format!("{}-01-01", year);
                        return YearFixResult {
                            id: book.id,
                            title: book.title,
                            year: Some(year.clone()),
                            pub_date: Some(date.clone()),
                            pub_tag: Some(format!("pub-{}", date)),
                            source: None,
                            fixed: false,
                            skipped: true,
                            error: None,
                        };
                    }
                }
            }

            // Step 1: Use pre-fetched data if available, otherwise search APIs
            let api_result = if book.ol_year.is_some() || book.gb_year.is_some() || book.provider_year.is_some() {
                println!("   📡 {} : using pre-fetched year data", book.title);
                build_multi_source_from_prefetched(&book)
            } else {
                println!("   🔍 {} : searching book databases...", book.title);
                lookup_publication_date_multi(&book.title, &book.author).await
            };

            // Always pass API results as hints to GPT for verification
            let api_hint = match &api_result {
                MultiSourceResult::Confirmed { year, source, .. } => {
                    format!("\nAPI SOURCES SUGGEST YEAR {} (from {}). Verify this is the ORIGINAL first publication, NOT an audiobook release, reprint, or new edition.\n", year, source)
                }
                MultiSourceResult::SingleSource { year, source, .. } => {
                    format!("\nAPI SOURCE SUGGESTS YEAR {} (from {}). Verify this is the ORIGINAL first publication, NOT an audiobook release, reprint, or new edition.\n", year, source)
                }
                MultiSourceResult::Conflict { years } => {
                    format!("\nAPI SOURCES FOUND THESE YEARS (may be wrong): {:?}\nVerify which is the ORIGINAL publication, not a reprint.\n", years)
                }
                MultiSourceResult::NotFound => String::new(),
            };

            // Step 2: Always use GPT to verify — APIs often return audiobook/reprint dates
            println!("   🤖 {} : GPT verification...", book.title);

            // Build description snippet if available
            let desc_snippet = book.description.as_ref()
                .filter(|d| d.len() > 20)
                .map(|d| {
                    let snippet: String = d.chars().take(200).collect();
                    format!("Description: {}\n", snippet)
                })
                .unwrap_or_default();

            let lookup_prompt = format!(
r#"You are a librarian and book historian. Find the ORIGINAL FIRST publication date for this book.

Title: "{}"
Author: {}
{}{}{}
═══════════════════════════════════════════════════════════════════
TASK: Find when this book was FIRST published ANYWHERE in the world
═══════════════════════════════════════════════════════════════════

STEP 1 - Identify the book:
- What type of book is this? (children's picture book, novel, non-fiction, etc.)
- When was the author active? (this bounds the possible publication date)
- Was this originally published in another language?

STEP 2 - Find the ORIGINAL publication:
- The FIRST edition in the ORIGINAL language
- If translated, find the original language version date
- If it's a series book, find when THIS specific book was first published

STEP 3 - Verify you're not returning:
❌ Audiobook release date (often 2010s-2020s for older books)
❌ Reprint or new edition date
❌ Anniversary edition date (10th, 25th, 50th anniversary)
❌ Paperback release (hardcover usually comes first)
❌ US publication date when original was UK/Europe (use earliest)
❌ Kindle/ebook release date
❌ Illustrated edition date
❌ Movie tie-in edition date

EXAMPLES OF CORRECT ANSWERS:
Children's Books:
- "Goodnight Moon" by Margaret Wise Brown = 1947
- "Where the Wild Things Are" by Maurice Sendak = 1963
- "The Very Hungry Caterpillar" by Eric Carle = 1969
- "Corduroy" by Don Freeman = 1968
- "Madeline" by Ludwig Bemelmans = 1939
- "Curious George" by H.A. Rey = 1941
- "The Snowy Day" by Ezra Jack Keats = 1962
- "Strega Nona" by Tomie dePaola = 1975

Spanish/European Children's Books:
- Books by Maria Claret = typically 1980s-1990s (Spanish author)
- "Maisy" by Lucy Cousins = 1990
- "Miffy" by Dick Bruna = 1955 (Dutch original)
- "Babar" by Jean de Brunhoff = 1931 (French original)
- "Tintin" by Hergé = 1929 (Belgian/French original)

Classics:
- "Pride and Prejudice" by Jane Austen = 1813
- "1984" by George Orwell = 1949
- "The Hobbit" by J.R.R. Tolkien = 1937
- "Charlotte's Web" by E.B. White = 1952

AUTHOR LIFESPAN SANITY CHECK:
- If the author died in 1990, the book cannot be from 2023
- If the author was born in 1950, the book is unlikely from 1920
- Children's book authors from Spain/Europe in the 1980s-90s = look for 1980s-1990s dates

Return ONLY this JSON (no other text):
{{"date": "YYYY-MM-DD", "year": "YYYY", "confidence": 0-100}}

Use YYYY-01-01 if exact month/day unknown. Confidence should be:
- 90-100: You know this book well
- 70-89: Fairly certain based on author/era
- 50-69: Educated guess based on context
- Below 50: Uncertain, might be wrong"#,
                book.title,
                book.author,
                book.series.as_ref().map(|s| format!("Series: {}\n", s)).unwrap_or_default(),
                desc_snippet,
                api_hint
            );

            match crate::scanner::processor::call_gpt_api(&lookup_prompt, &api_key, &crate::scanner::processor::preferred_model(), 2000).await {
                Ok(response) => {
                    println!("   📝 {} : GPT raw response: {}", book.title, &response[..response.len().min(200)]);

                    // If truncated JSON, try to salvage year via regex
                    let json_to_parse = if response.starts_with('{') && !response.ends_with('}') {
                        println!("   ⚠️  {} : GPT response truncated, attempting salvage", book.title);
                        if let Some(cap) = regex::Regex::new(r#""year"\s*:\s*"?(\d{4})"?"#).ok().and_then(|re| re.captures(&response)) {
                            let year = cap.get(1).unwrap().as_str();
                            // Also try to extract date
                            let date = regex::Regex::new(r#""date"\s*:\s*"(\d{4}-\d{2}-\d{2})""#).ok()
                                .and_then(|re| re.captures(&response))
                                .map(|c| c.get(1).unwrap().as_str().to_string())
                                .unwrap_or_else(|| format!("{}-01-01", year));
                            format!(r#"{{"year":"{}","date":"{}","confidence":75}}"#, year, date)
                        } else {
                            response.clone()
                        }
                    } else {
                        response.clone()
                    };

                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_to_parse) {
                        // Handle year as string OR number (gpt-5-nano often returns numbers)
                        let year_str = parsed.get("year")
                            .and_then(|v| {
                                v.as_str().map(|s| s.to_string())
                                    .or_else(|| v.as_i64().map(|n| n.to_string()))
                                    .or_else(|| v.as_f64().map(|n| (n as i64).to_string()))
                            });

                        // Handle confidence as number or string
                        let confidence = parsed.get("confidence")
                            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                            .unwrap_or(0);

                        // Handle date as string
                        let date_str = parsed.get("date")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        if let Some(ref year_str) = year_str {
                            if is_valid_year(year_str) {
                                let gpt_year: i32 = year_str.parse().unwrap_or(0);
                                let pub_date = date_str.unwrap_or_else(|| format!("{}-01-01", year_str));

                                // If not forcing and book already has a year, check if GPT's year is close
                                if !force {
                                    if let Some(ref current) = book.current_year {
                                        if let Ok(current_year) = current.parse::<i32>() {
                                            let diff = (gpt_year - current_year).abs();
                                            if diff <= 2 {
                                                println!("   ⏭️  {} : GPT says {} but current {} is close enough, keeping current",
                                                    book.title, year_str, current);
                                                let current_date = format!("{}-01-01", current);
                                                return YearFixResult {
                                                    id: book.id,
                                                    title: book.title,
                                                    year: Some(current.clone()),
                                                    pub_date: Some(current_date.clone()),
                                                    pub_tag: Some(format!("pub-{}", current_date)),
                                                    source: None,
                                                    fixed: false,
                                                    skipped: true,
                                                    error: None,
                                                };
                                            }
                                        }
                                    }
                                }

                                if confidence >= 50 {
                                    println!("   ✅ {} : found original date {} from GPT (confidence: {}%)", book.title, pub_date, confidence);
                                    return YearFixResult {
                                        id: book.id,
                                        title: book.title,
                                        year: Some(year_str.to_string()),
                                        pub_date: Some(pub_date.clone()),
                                        pub_tag: Some(format!("pub-{}", pub_date)),
                                        source: Some("GPT".to_string()),
                                        fixed: true,
                                        skipped: false,
                                        error: None,
                                    };
                                } else {
                                    println!("   ⚠️  {} : GPT date {} has low confidence ({}%), skipping", book.title, pub_date, confidence);
                                }
                            } else {
                                println!("   ⚠️  {} : GPT returned invalid year '{}'", book.title, year_str);
                            }
                        } else {
                            println!("   ⚠️  {} : GPT response missing 'year' field: {}", book.title, &response[..response.len().min(200)]);
                        }
                    } else {
                        println!("   ⚠️  {} : GPT returned non-JSON: {}", book.title, &response[..response.len().min(200)]);
                    }
                }
                Err(e) => {
                    println!("   ⚠️  {} : GPT API call failed: {}", book.title, e);
                }
            }

            // Could not find year
            println!("   ❌ {} : could not find original publication date", book.title);
            YearFixResult {
                id: book.id,
                title: book.title,
                year: None,
                pub_date: None,
                pub_tag: None,
                source: None,
                fixed: false,
                skipped: false,
                error: Some("Could not determine original publication date".to_string()),
            }
        }
    }).collect();

    let stream_results: Vec<_> = stream::iter(book_futures)
        .buffer_unordered(10)  // Low concurrency — Open Library & Google Books rate-limit aggressively
        .collect()
        .await;

    for result in stream_results {
        if result.error.is_some() {
            total_failed += 1;
        } else if result.skipped {
            total_skipped += 1;
        } else if result.fixed {
            total_fixed += 1;
        } else {
            total_failed += 1;
        }
        results.push(result);
    }

    println!("📅 Year Fix complete: {} fixed, {} skipped, {} failed",
        total_fixed, total_skipped, total_failed);

    Ok(YearFixResponse {
        results,
        total_fixed,
        total_skipped,
        total_failed,
    })
}
