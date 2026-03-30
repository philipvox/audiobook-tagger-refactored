// src-tauri/src/gpt_consolidated.rs
//
// Consolidated GPT calls — replaces 15+ individual GPT calls with 3 core calls:
//   Call A: resolve_metadata — title + subtitle + author + series + sequence in ONE call
//   Call B: classify_book — genres + tags + age rating + book DNA in ONE call
//   Call C: process_description — validate + clean/generate description in ONE call
//   Call D: Publication Year (kept separate — needs gpt-4o for accuracy)

use serde::{Deserialize, Serialize};
use crate::scanner::processor::call_gpt_api;
use crate::book_dna::BookDNA;
use crate::age_rating_resolver::AgeRatingOutput;

// =============================================================================
// Call A: Metadata Resolution (title + subtitle + author + series + sequence)
// Replaces: #5 clean_title, #8 title_resolver, #9 series_resolver,
//           #10 subtitle_lookup, #11 author_lookup, #13 series_cleanup
// =============================================================================

/// Input for metadata resolution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveMetadataInput {
    pub id: String,
    /// Raw filename (e.g., "01 - The Eye of the World (Unabridged).m4b")
    pub filename: Option<String>,
    /// Folder name (e.g., "Robert Jordan - Wheel of Time 01")
    pub folder_name: Option<String>,
    /// Full folder path
    pub folder_path: Option<String>,
    /// Current metadata fields
    pub current_title: String,
    pub current_author: String,
    pub current_subtitle: Option<String>,
    pub current_series: Option<String>,
    pub current_sequence: Option<String>,
    /// Audible/ABS data if available
    pub audible_title: Option<String>,
    pub audible_author: Option<String>,
    pub audible_subtitle: Option<String>,
    pub audible_series: Option<String>,
    pub audible_sequence: Option<String>,

    // Pre-parsed from folder structure (populated by classify.rs before GPT call)
    #[serde(default)]
    pub folder_author: Option<String>,
    #[serde(default)]
    pub folder_series: Option<String>,
    #[serde(default)]
    pub folder_sequence: Option<String>,

    // Cross-book consistency (other series names used for this author in batch)
    #[serde(default)]
    pub known_author_series: Vec<String>,

    // Dominant series for this author (most common series, used as fallback)
    #[serde(default)]
    pub dominant_author_series: Option<String>,
}

/// Output from metadata resolution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveMetadataOutput {
    pub title: String,
    pub author: String,
    pub subtitle: Option<String>,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub narrator: Option<String>,
    pub confidence: u8,
    pub notes: Option<String>,
}

/// GPT response for metadata resolution
#[derive(Debug, Deserialize)]
struct GptMetadataResponse {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    series: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_string")]
    sequence: Option<String>,
    #[serde(default)]
    narrator: Option<String>,
    #[serde(default)]
    confidence: Option<u8>,
    #[serde(default)]
    notes: Option<String>,
}

/// Deserialize sequence that could be string or number
fn deserialize_opt_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where D: serde::Deserializer<'de> {
    let val: serde_json::Value = serde::Deserialize::deserialize(deserializer)?;
    match val {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(s) if s.is_empty() => Ok(None),
        serde_json::Value::String(s) => Ok(Some(s)),
        serde_json::Value::Number(n) => Ok(Some(n.to_string())),
        _ => Ok(None),
    }
}

/// Resolve all core metadata in ONE GPT call
/// Replaces: clean_title_with_gpt + resolve_title_with_gpt + resolve_series_with_abs_and_gpt
///           + fix_subtitles_batch GPT portion + fix_authors_batch GPT portion + clean_series_with_gpt
pub async fn resolve_metadata(
    input: &ResolveMetadataInput,
    api_key: &str,
) -> Result<ResolveMetadataOutput, String> {
    // Build prompt with all available context
    let mut context = String::new();

    if let Some(ref filename) = input.filename {
        context.push_str(&format!("Filename: \"{}\"\n", filename));
    }
    if let Some(ref folder) = input.folder_name {
        context.push_str(&format!("Folder name: \"{}\"\n", folder));
    }
    if let Some(ref path) = input.folder_path {
        context.push_str(&format!("Folder path: \"{}\"\n", path));
    }
    context.push_str(&format!("Current title: \"{}\"\n", input.current_title));
    context.push_str(&format!("Current author: \"{}\"\n", input.current_author));
    if let Some(ref sub) = input.current_subtitle {
        context.push_str(&format!("Current subtitle: \"{}\"\n", sub));
    }
    if let Some(ref series) = input.current_series {
        context.push_str(&format!("Current series: \"{}\"\n", series));
    }
    if let Some(ref seq) = input.current_sequence {
        context.push_str(&format!("Current sequence: \"{}\"\n", seq));
    }

    // Add Audible data if available
    let has_audible = input.audible_title.is_some() || input.audible_series.is_some();
    if has_audible {
        context.push_str("\n--- Audible/ABS Data ---\n");
        if let Some(ref t) = input.audible_title {
            context.push_str(&format!("Audible title: \"{}\"\n", t));
        }
        if let Some(ref a) = input.audible_author {
            context.push_str(&format!("Audible author: \"{}\"\n", a));
        }
        if let Some(ref s) = input.audible_subtitle {
            context.push_str(&format!("Audible subtitle: \"{}\"\n", s));
        }
        if let Some(ref s) = input.audible_series {
            context.push_str(&format!("Audible series: \"{}\"\n", s));
        }
        if let Some(ref s) = input.audible_sequence {
            context.push_str(&format!("Audible sequence: \"{}\"\n", s));
        }
    }

    // Add parsed folder structure if available
    let has_folder_data = input.folder_author.is_some() || input.folder_series.is_some();
    if has_folder_data {
        context.push_str("\n--- Parsed Folder Structure (RELIABLE) ---\n");
        if let Some(ref author) = input.folder_author {
            context.push_str(&format!("Folder author: \"{}\"\n", author));
        }
        if let Some(ref series) = input.folder_series {
            context.push_str(&format!("Folder series: \"{}\"\n", series));
        }
        if let Some(ref seq) = input.folder_sequence {
            context.push_str(&format!("Folder sequence: \"{}\"\n", seq));
        }
    }

    // Add known series for this author (for consistency)
    if !input.known_author_series.is_empty() {
        context.push_str("\n--- Author's Known Series (USE FOR CONSISTENCY) ---\n");
        for series in &input.known_author_series {
            context.push_str(&format!("- \"{}\"\n", series));
        }
    }

    let prompt = format!(
r#"Resolve ALL metadata for this audiobook in ONE pass. Determine the correct title, subtitle, author, series, and sequence.

{context}

═══ TITLE RULES ═══
- Clean up: remove "01 -" prefixes, "(Unabridged)", "(Audiobook)", "[Audio]", quality markers
- "Winter of the Ice Wizard" not "01 - Winter of the Ice Wizard (Unabridged)"
- Folder path is MORE RELIABLE than corrupted tags for author/title
- If title is generic ("Books", "Audiobook", "Track") → use folder name
- If author equals series name (author="Magic Tree House") → extract real author from path

═══ SUBTITLE RULES ═══
- Look for official subtitle: "A Hamish Macbeth Mystery", "Book One of the Dune Chronicles"
- Check Audible data first
- Series indicator subtitles: "A [Series] Novel", "Book [N] of [Series]"
- If no subtitle exists and it's not a series book, use null
- "A Novel", "A Memoir", "A Thriller" are acceptable genre subtitles

═══ AUTHOR RULES ═══
- Use canonical author name: "J.R.R. Tolkien" not "JRR Tolkien"
- For co-authors: "Stephen King, Peter Straub"
- Prefer Folder author > Audible author > current_author
- If folder_author looks valid (has first+last name), trust it

═══ SERIES RULES (CRITICAL — CONSISTENCY FIRST) ═══
- If "Author's Known Series" is provided, use EXACTLY that series name
- "The Stormlight Archive" and "Stormlight Archive" are NOT the same — pick the one in Known Series
- Folder series is HIGHLY RELIABLE — trust it unless clearly wrong
- Use folder_sequence if Audible/current sequence is missing
- Audible series is useful but can have variations — normalize to match Known Series
- Prequels: sequence 0 or 0.5; Novellas between books: decimals (2.5)
- null ONLY if truly standalone (no folder series, no Audible series, no "Book N" in title)
- Sub-series vs parent: prefer parent unless sub-series is well-known (e.g., "Discworld - Death" → "Discworld")

═══ NARRATOR ═══
- If embedded in filename ("read by Frank Muller") → extract
- Otherwise null

═══ CONFIDENCE ═══
- 90-100: Very confident, multiple sources agree
- 70-89: Confident, folder structure is clear
- 50-69: Low confidence, best guess
- Below 50: Very uncertain

Return ONLY valid JSON:
{{"title":"Book Title","author":"Author Name","subtitle":null,"series":null,"sequence":null,"narrator":null,"confidence":90,"notes":"brief explanation"}}"#,
        context = context
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(25),
        call_gpt_api(&prompt, api_key, &crate::scanner::processor::preferred_model(), 1500)
    ).await;

    match result {
        Ok(Ok(response)) => {
            match serde_json::from_str::<GptMetadataResponse>(extract_json(&response)) {
                Ok(parsed) => {
                    let mut output = ResolveMetadataOutput {
                        title: parsed.title.filter(|s| !s.is_empty()).unwrap_or_else(|| input.current_title.clone()),
                        author: parsed.author.filter(|s| !s.is_empty()).unwrap_or_else(|| input.current_author.clone()),
                        subtitle: parsed.subtitle.filter(|s| !s.is_empty()),
                        series: parsed.series.filter(|s| !s.is_empty() && s.to_lowercase() != "null"),
                        sequence: parsed.sequence.filter(|s| !s.is_empty() && s.to_lowercase() != "null"),
                        narrator: parsed.narrator.filter(|s| !s.is_empty()),
                        confidence: parsed.confidence.unwrap_or(75),
                        notes: parsed.notes,
                    };

                    // Post-GPT validation: ensure series consistency
                    validate_series_consistency(&mut output, input);

                    Ok(output)
                },
                Err(e) => Err(format!("Failed to parse metadata response: {}. Raw: {}", e, &response[..response.len().min(300)])),
            }
        }
        Ok(Err(e)) => Err(format!("Metadata resolution GPT error: {}", e)),
        Err(_) => Err("Metadata resolution timed out".to_string()),
    }
}

/// Post-GPT validation: ensure series name matches author's existing series
/// and fill in sequence from folder if missing
fn validate_series_consistency(result: &mut ResolveMetadataOutput, input: &ResolveMetadataInput) {
    // If GPT returned a series, check if it matches any known series for this author
    if let Some(ref series) = result.series.clone() {
        // Collect all similar series names (including the current one)
        let mut similar_series: Vec<String> = vec![series.clone()];
        for known in &input.known_author_series {
            if series_names_match(series, known) {
                if !similar_series.contains(known) {
                    similar_series.push(known.clone());
                }
            }
        }

        // If we have multiple similar names, pick the canonical one
        if similar_series.len() > 1 {
            if let Some(canonical) = find_canonical_series_name(&similar_series) {
                if &canonical != series {
                    println!("   🔧 Series normalized: \"{}\" → \"{}\" (from {} variants)",
                             series, canonical, similar_series.len());
                    result.series = Some(canonical.clone());
                    let note = format!("Series normalized from {} variants to: {}",
                                       similar_series.len(), canonical);
                    result.notes = Some(match &result.notes {
                        Some(existing) => format!("{}. {}", existing, note),
                        None => note,
                    });
                }
            }
        } else if similar_series.len() == 1 {
            // GPT returned a series that doesn't match any known series for this author
            // Only override if:
            // 1. Audible had no series data (GPT was guessing)
            // 2. GPT's series shares significant words with the dominant (likely a variant)
            let audible_has_series = input.audible_series.as_ref().map(|s| !s.is_empty()).unwrap_or(false);

            if !audible_has_series {
                if let Some(ref dominant) = input.dominant_author_series {
                    // Check if GPT's series shares significant words with dominant
                    // (e.g., "Tudor Court" shares "Tudor" with "Plantagenet and Tudor Novels")
                    if series_share_significant_words(series, dominant) {
                        println!("   🔧 Series override: \"{}\" → \"{}\" (related to dominant, Audible had no data)",
                                 series, dominant);
                        result.series = Some(dominant.clone());
                        let note = format!("Series overridden to author's dominant series: {} (related variant, Audible had no series data)", dominant);
                        result.notes = Some(match &result.notes {
                            Some(existing) => format!("{}. {}", existing, note),
                            None => note,
                        });
                    }
                    // If series is completely unrelated, keep GPT's series - might be a different series by same author
                }
            }
        }
    }

    // If GPT returned no sequence but folder has one, use folder sequence
    if result.sequence.is_none() {
        if let Some(ref folder_seq) = input.folder_sequence {
            println!("   🔧 Sequence from folder: {}", folder_seq);
            result.sequence = Some(folder_seq.clone());
        }
    }

    // If GPT returned no series but folder has one, use folder series
    if result.series.is_none() {
        if let Some(ref folder_series) = input.folder_series {
            // Collect all similar series from known author series
            let mut similar_series: Vec<String> = vec![folder_series.clone()];
            for known in &input.known_author_series {
                if series_names_match(folder_series, known) {
                    if !similar_series.contains(known) {
                        similar_series.push(known.clone());
                    }
                }
            }

            // Pick canonical name
            let series_to_use = find_canonical_series_name(&similar_series)
                .unwrap_or_else(|| folder_series.clone());
            println!("   🔧 Series from folder: {}", series_to_use);
            result.series = Some(series_to_use);
        }
    }

    // NOTE: We intentionally do NOT add a fallback to use dominant_author_series when
    // GPT returned no series. If GPT thinks the book is standalone, respect that.
    // The dominant series override only applies when GPT guessed a related series variant
    // but Audible had no data to validate that guess.
}

/// Normalize a series name for comparison
/// Strips: articles, common suffixes (novels, series, books), parenthetical content
pub fn normalize_series_name(s: &str) -> String {
    let mut result = s.to_lowercase();

    // Remove parenthetical content: (abridged), (unabridged), (complete), etc.
    if let Some(paren_start) = result.find('(') {
        result = result[..paren_start].to_string();
    }

    // Trim and remove leading articles
    result = result.trim().to_string();
    for article in &["the ", "a ", "an "] {
        if result.starts_with(article) {
            result = result[article.len()..].to_string();
        }
    }

    // Remove trailing common suffixes
    let suffixes = [" novels", " novel", " series", " books", " book", " collection", " saga", " chronicles", " trilogy", " duology"];
    for suffix in &suffixes {
        if result.ends_with(suffix) {
            result = result[..result.len() - suffix.len()].to_string();
        }
    }

    // Remove extra whitespace and punctuation
    result = result.replace(&['-', ':', ',', '.', '\'', '"', '!', '?'][..], " ");
    result = result.split_whitespace().collect::<Vec<_>>().join(" ");

    result
}

/// Calculate similarity between two strings (0.0 to 1.0)
fn string_similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    // Check substring containment
    if a.contains(b) || b.contains(a) {
        let shorter = a.len().min(b.len()) as f64;
        let longer = a.len().max(b.len()) as f64;
        return shorter / longer;
    }

    // Simple word overlap similarity
    let a_words: std::collections::HashSet<_> = a.split_whitespace().collect();
    let b_words: std::collections::HashSet<_> = b.split_whitespace().collect();

    let intersection = a_words.intersection(&b_words).count() as f64;
    let union = a_words.union(&b_words).count() as f64;

    if union == 0.0 {
        return 0.0;
    }

    intersection / union  // Jaccard similarity
}

/// Check if two series names are essentially the same
/// Uses aggressive normalization and fuzzy matching
pub fn series_names_match(a: &str, b: &str) -> bool {
    let norm_a = normalize_series_name(a);
    let norm_b = normalize_series_name(b);

    // Exact match after normalization
    if norm_a == norm_b {
        return true;
    }

    // One contains the other (after normalization)
    if norm_a.contains(&norm_b) || norm_b.contains(&norm_a) {
        // But only if the shorter one is at least 60% of the longer
        let shorter = norm_a.len().min(norm_b.len());
        let longer = norm_a.len().max(norm_b.len());
        if shorter as f64 / longer as f64 >= 0.6 {
            return true;
        }
    }

    // High word similarity (>= 70% Jaccard)
    let similarity = string_similarity(&norm_a, &norm_b);
    if similarity >= 0.7 {
        return true;
    }

    false
}

/// Check if two series names share at least one significant word
/// Used to detect related series variants (e.g., "Tudor Court" and "Plantagenet and Tudor Novels" share "Tudor")
/// Ignores common filler words like articles, "and", "of", etc.
fn series_share_significant_words(a: &str, b: &str) -> bool {
    let stopwords: std::collections::HashSet<&str> = [
        "the", "a", "an", "and", "of", "in", "on", "at", "to", "for",
        "novels", "novel", "series", "books", "book", "collection",
        "saga", "chronicles", "trilogy", "duology", "volume", "vol",
    ].iter().cloned().collect();

    let a_words: std::collections::HashSet<String> = a
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3 && !stopwords.contains(w))
        .map(|s| s.to_string())
        .collect();

    let b_words: std::collections::HashSet<String> = b
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3 && !stopwords.contains(w))
        .map(|s| s.to_string())
        .collect();

    // Check if they share at least one significant word
    !a_words.is_disjoint(&b_words)
}

/// Find the canonical (best) series name from a list of similar names
/// Prefers: longer names, names with "The", names without parentheses
pub fn find_canonical_series_name(series_names: &[String]) -> Option<String> {
    if series_names.is_empty() {
        return None;
    }
    if series_names.len() == 1 {
        return Some(series_names[0].clone());
    }

    // Score each name
    let mut scored: Vec<(i32, &String)> = series_names.iter().map(|name| {
        let mut score = 0i32;

        // Prefer longer names (more complete)
        score += name.len() as i32;

        // Prefer names starting with "The"
        if name.to_lowercase().starts_with("the ") {
            score += 20;
        }

        // Penalize names with parentheses (abridged, etc.)
        if name.contains('(') {
            score -= 50;
        }

        // Prefer names with common suffixes (more formal)
        let lower = name.to_lowercase();
        if lower.ends_with(" novels") || lower.ends_with(" series") {
            score += 10;
        }

        (score, name)
    }).collect();

    // Sort by score descending
    scored.sort_by(|a, b| b.0.cmp(&a.0));

    Some(scored[0].1.clone())
}

// =============================================================================
// Call B: Book Classification (genres + tags + age rating + DNA)
// =============================================================================

/// Input for consolidated classification
#[derive(Debug, Clone, Serialize)]
pub struct ClassifyInput {
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub genres: Vec<String>,
    pub duration_minutes: Option<u32>,
    pub narrator: Option<String>,
    pub series_name: Option<String>,
    pub series_sequence: Option<String>,
    pub year: Option<String>,
    pub publisher: Option<String>,
}

/// Output from consolidated classification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyOutput {
    pub genres: Vec<String>,
    pub tags: Vec<String>,
    pub age_rating: AgeRatingOutput,
    pub dna: BookDNA,
    pub themes: Vec<String>,
    pub tropes: Vec<String>,
}

/// GPT response structure for classification
#[derive(Debug, Deserialize)]
struct GptClassifyResponse {
    #[serde(default)]
    genres: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,

    // Age rating fields
    #[serde(default)]
    age_category: Option<String>,
    #[serde(default)]
    min_age: Option<u8>,
    #[serde(default)]
    content_rating: Option<String>,
    #[serde(default)]
    age_tags: Vec<String>,
    #[serde(default)]
    intended_for_kids: Option<bool>,
    #[serde(default)]
    age_confidence: Option<String>,
    #[serde(default)]
    age_reasoning: Option<String>,

    // DNA fields
    #[serde(default)]
    dna: Option<serde_json::Value>,

    // Themes/tropes
    #[serde(default)]
    themes: Vec<String>,
    #[serde(default)]
    tropes: Vec<String>,
}

/// System prompt for consolidated classification
const CLASSIFY_SYSTEM_PROMPT: &str = r#"
You are an audiobook classification specialist. Analyze the book metadata and return a comprehensive classification covering genres, tags, age rating, and DNA fingerprint.

══════════════════════════════════════════════════════════════════════════════
SECTION 1: GENRES — Map to approved list only (1-3 genres)
══════════════════════════════════════════════════════════════════════════════

APPROVED GENRES:

FICTION: Literary Fiction, Contemporary Fiction, Historical Fiction, Classics, Mystery, Thriller, Crime, Horror, Romance, Fantasy, Science Fiction, Western, Adventure, Humor, Satire, Women's Fiction, LGBTQ+ Fiction, Short Stories, Anthology

NON-FICTION: Biography, Autobiography, Memoir, History, True Crime, Science, Popular Science, Psychology, Self-Help, Business, Personal Finance, Health & Wellness, Philosophy, Religion & Spirituality, Politics, Essays, Journalism, Travel, Food & Cooking, Nature, Sports, Music, Art, Education, Parenting & Family, Relationships, Non-Fiction

AGE-SPECIFIC (ONLY for books actually published/marketed for that age group):
Children's 0-2, Children's 3-5, Children's 6-8, Children's 9-12, Middle Grade, Teen 13-17, Young Adult, New Adult, Adult

CRITICAL GENRE RULES:
- "Young Adult" and "Teen 13-17" are ONLY for books PUBLISHED IN the YA/teen section (Hunger Games, Divergent, Twilight)
- An adult novel with a young protagonist is NOT "Young Adult" — it's whatever adult genre fits (Fantasy, Horror, etc.)
- Stephen King's The Talisman → Fantasy + Adventure (NOT Young Adult, despite 12-year-old hero)
- Ender's Game → Science Fiction (NOT Young Adult)
- To Kill a Mockingbird → Classics (NOT Young Adult)

FORMAT: Audiobook Original, Full Cast Production, Dramatized, Podcast Fiction

Rules: 1-3 genres, most specific first. Only use age-specific genres for books genuinely published for that audience.

══════════════════════════════════════════════════════════════════════════════
SECTION 2: TAGS — Select 5-15 from taxonomy (lowercase-hyphenated)
══════════════════════════════════════════════════════════════════════════════

SUB-GENRE: cozy-mystery, police-procedural, legal-thriller, domestic-thriller, spy, noir, whodunit, heist, rom-com, historical-romance, paranormal-romance, dark-romance, clean-romance, small-town-romance, epic-fantasy, urban-fantasy, dark-fantasy, cozy-fantasy, grimdark, portal-fantasy, fairy-tale-retelling, progression-fantasy, litrpg, space-opera, dystopian, post-apocalyptic, cyberpunk, time-travel, first-contact, alternate-history, gothic, supernatural, psychological-horror, folk-horror, haunted-house, cosmic-horror

MOOD: atmospheric, cozy, dark, emotional, funny, heartbreaking, heartwarming, hopeful, inspiring, mysterious, romantic, suspenseful, thought-provoking, whimsical

PACING: fast-paced, slow-burn, page-turner, action-packed, easy-listening

STYLE: character-driven, plot-driven, unreliable-narrator, multiple-pov, dual-timeline, first-person

ROMANCE TROPES: enemies-to-lovers, friends-to-lovers, second-chance, forced-proximity, fake-relationship, forbidden-love, grumpy-sunshine, only-one-bed

STORY TROPES: found-family, chosen-one, reluctant-hero, antihero, morally-grey, redemption-arc, revenge, quest, survival, underdog, coming-of-age

CREATURES: vampires, werewolves, fae, witches, dragons, ghosts, aliens, magic-users

SETTING: small-town, big-city, academy, college, castle, spaceship, forest

PERIOD: regency, victorian, medieval, 1920s, wwii, civil-war

THEME: family, friendship, grief, healing, identity, justice, loyalty, mental-health, trauma, faith

SERIES: standalone, in-series, trilogy, duology, long-series

AUDIOBOOK: under-5-hours, 5-10-hours, 10-15-hours, 15-20-hours, over-20-hours, full-cast, author-narrated, great-character-voices

RECOGNITION: bestseller, award-winner, debut, classic

CONTENT: clean, fade-to-black, steamy, explicit, low-violence, graphic-violence

REQUIRED: Include at least one sub-genre tag, one mood tag, one length tag, one series tag.
Do NOT include age-related tags here (those go in age_tags).

══════════════════════════════════════════════════════════════════════════════
SECTION 3: AGE RATING
══════════════════════════════════════════════════════════════════════════════

FIRST determine the AUDIENCE — who is this book published for?
- intended_for_kids = true ONLY for children's books (ages 0-12): Magic Tree House, Diary of a Wimpy Kid, Dog Man, Pete the Cat
- intended_for_kids = false for EVERYTHING ELSE: teen, YA, adult, non-fiction, parenting books
- Teen/YA books (Hunger Games, Divergent, Harry Potter) are NOT "for kids" — they get for-teens or for-ya tags
- A young protagonist does NOT make a book "for kids" (The Talisman, It, Room, Ender's Game → all false)
- Known adult authors (Stephen King, Dean Koontz, Cormac McCarthy) → always false
- CRITICAL: If intended_for_kids is false → age_category MUST NOT be a Children's category

AGE CATEGORIES: "Children's 0-2", "Children's 3-5", "Children's 6-8", "Children's 9-12", "Teen 13-17", "Young Adult", "Adult"
- Use children's categories ONLY when intended_for_kids is true
- "Adult" is the default for fiction/non-fiction written for adult audiences

CONTENT RATINGS: "G" (all ages), "PG" (mild peril), "PG-13" (teen themes), "R" (adult)

AGE TAGS (include all 4 types):
- Age: age-childrens, age-middle-grade, age-teens, age-young-adult, age-adult
- Content: rated-g, rated-pg, rated-pg13, rated-r
- Recommendation: age-rec-0, age-rec-3, age-rec-6, age-rec-8, age-rec-10, age-rec-12, age-rec-14, age-rec-16, age-rec-18
- Audience: for-kids (children 0-12), for-teens (13-17), for-ya (16-25 crossover), not-for-kids (adult)

══════════════════════════════════════════════════════════════════════════════
SECTION 4: BOOK DNA FINGERPRINT
══════════════════════════════════════════════════════════════════════════════

Return a "dna" object with these fields:
- length: "short" (<5h) | "medium" (5-12h) | "long" (12-20h) | "epic" (20h+)
- pacing: "slow" | "measured" | "moderate" | "fast" | "breakneck"
- structure: "linear" | "flashback" | "non-linear" | "frame-narrative" | "parallel" | "epistolary" | "stream-of-consciousness"
- pov: "first-person" | "close-third" | "omniscient-third" | "multiple-pov" | "second"
- series_position: "standalone" | "series-start" | "mid-series" | "series-end"
- pub_era: "classic" (<1950) | "mid-century" (1950-80) | "modern" (1980-2010) | "contemporary" (2010+)
- setting: "urban" | "suburban" | "rural" | "wilderness" | "space-station" | "fantasy-world" | "historical" | "post-apocalyptic"
- ending_type: "hea" | "hfn" | "bittersweet" | "ambiguous" | "open" | "tragic" | "cathartic"
- opening_energy: "low" | "medium" | "high" (emotional brightness at start)
- ending_energy: "low" | "medium" | "high" (emotional brightness at end)
- humor_type: "dry-wit" | "absurdist" | "dark-comedy" | "satirical" | "cozy-banter" | "physical" | "none"
- stakes_level: "personal" | "local" | "national" | "global" | "cosmic"
- protagonist_count: "solo" | "duo" | "ensemble" | "omniscient-many"
- prose_style: "sparse" | "conversational" | "lyrical" | "dense" | "journalistic"
- series_dependency: "fully-standalone" | "works-standalone" | "needs-prior" | "must-start-at-one"
- production: "single-voice" | "dual-narrator" | "full-cast" | "dramatized"
- narrator_performance: ["theatrical", "character-voices"] (1-2 from: theatrical, character-voices, understated, conversational, documentary)
- audio_friendliness: 0-5 (how easy to follow aurally, 5=perfect for audio)
- re_listen_value: 0-5 (rewards repeat listens, 5=fundamentally different on re-listen)
- violence_level: 0-5 (0=none, 5=extremely graphic)
- intimacy_level: 0-5 (0=none, 5=erotica-level)
- tropes: ["heist", "found-family"] (2-5)
- themes: ["loyalty", "identity"] (2-4)
- relationship_focus: ["friendship", "rivals"] (1-2 from: friendship, romance, mentor-student, rivals, family, human-nonhuman, none)
- shelves: ["epic-fantasy", "grimdark-fantasy"] (1-3 from: cozy-fantasy, epic-fantasy, dark-fantasy, urban-fantasy, portal-fantasy, fairy-tale-retelling, mythic-fantasy, sword-and-sorcery, grimdark-fantasy, romantic-fantasy, hard-sci-fi, space-opera, cyberpunk, dystopian, post-apocalyptic, first-contact, time-travel, cli-fi, military-sci-fi, biopunk, cozy-mystery, detective-noir, police-procedural, psychological-thriller, legal-thriller, medical-thriller, spy-thriller, cat-and-mouse-thriller, domestic-suspense, locked-room-mystery, gothic-horror, cosmic-horror, supernatural-horror, folk-horror, psychological-horror, slasher, contemporary-romance, historical-romance, paranormal-romance, romantic-comedy, dark-romance, romantasy, small-town-romance, second-chance-romance, literary-fiction, book-club-fiction, family-saga, coming-of-age, campus-novel, satire, southern-gothic, magical-realism, upmarket-fiction, experimental-fiction, historical-fiction, alternate-history, historical-mystery, wartime-fiction, regency, medieval, memoir, true-crime, popular-science, history-narrative, self-help, biography, essay-collection, investigative-journalism, travel-narrative, nature-writing, middle-grade-adventure, ya-dystopian, ya-fantasy, ya-contemporary, superhero-fiction, litrpg, progression-fantasy, western, afrofuturism, solarpunk, new-weird)
- comp_authors: ["joe-abercrombie"] (1-2 similar authors, lowercase-hyphenated)
- comp_vibes: ["game-of-thrones-meets-peaky-blinders", "grimdark-heist", "medieval-noir"] (3-5 evocative descriptions, lowercase-hyphenated)
- spectrums: ALWAYS return ALL 7: [{"dimension": "dark-light", "value": -3}, {"dimension": "serious-funny", "value": -2}, {"dimension": "plot-character", "value": 1}, {"dimension": "simple-complex", "value": 2}, {"dimension": "action-contemplative", "value": -1}, {"dimension": "intimate-epic-scope", "value": 3}, {"dimension": "world-density", "value": 2}] (value -5 to +5, use full range)
- moods: [{"mood": "tension", "intensity": 8}] (2-3, intensity 1-10, from: thrills, drama, romance, horror, mystery, wonder, melancholy, hope, tension, humor, adventure, dread, nostalgia, awe, unease, warmth, fury, propulsive, cozy)

Omit DNA fields you can't determine (null).

══════════════════════════════════════════════════════════════════════════════
SECTION 5: THEMES & TROPES (top-level, separate from DNA)
══════════════════════════════════════════════════════════════════════════════

THEMES (3-5): Abstract concepts — Redemption, Found Family, Coming of Age, Power and Corruption, Identity, Loss and Grief, Good vs Evil, Survival, Love and Sacrifice

TROPES (3-5): Story patterns — Chosen One, Mentor Figure, Dark Lord, Hidden Heir, Quest, Reluctant Hero, Love Triangle, Fish Out of Water, Unreliable Narrator, Detective Protagonist

══════════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT — Return ONLY this JSON, no markdown:
══════════════════════════════════════════════════════════════════════════════

{
  "genres": ["Genre 1", "Genre 2"],
  "tags": ["tag-1", "tag-2", "tag-3"],
  "age_category": "Adult",
  "min_age": 16,
  "content_rating": "PG-13",
  "age_tags": ["age-adult", "rated-pg13", "age-rec-16", "not-for-kids"],
  "intended_for_kids": false,
  "age_confidence": "high",
  "age_reasoning": "Brief reasoning",
  "dna": {
    "length": "long",
    "pacing": "fast",
    "structure": "linear",
    "pov": "first-person",
    "series_position": "series-start",
    "pub_era": "modern",
    "setting": "urban",
    "ending_type": "bittersweet",
    "opening_energy": "medium",
    "ending_energy": "high",
    "humor_type": "dark-comedy",
    "stakes_level": "global",
    "protagonist_count": "solo",
    "prose_style": "conversational",
    "series_dependency": "series-start",
    "production": "single-voice",
    "narrator_performance": ["theatrical", "character-voices"],
    "audio_friendliness": 3,
    "re_listen_value": 4,
    "violence_level": 3,
    "intimacy_level": 1,
    "tropes": ["heist", "found-family"],
    "themes": ["loyalty", "identity"],
    "relationship_focus": ["friendship"],
    "shelves": ["epic-fantasy", "grimdark-fantasy"],
    "comp_authors": ["joe-abercrombie"],
    "comp_vibes": ["game-of-thrones-meets-peaky-blinders", "grimdark-heist", "medieval-noir"],
    "spectrums": [{"dimension": "dark-light", "value": -3}, {"dimension": "serious-funny", "value": -2}, {"dimension": "plot-character", "value": 1}, {"dimension": "simple-complex", "value": 2}, {"dimension": "action-contemplative", "value": -1}, {"dimension": "intimate-epic-scope", "value": 3}, {"dimension": "world-density", "value": 2}],
    "moods": [{"mood": "tension", "intensity": 8}, {"mood": "propulsive", "intensity": 7}]
  },
  "themes": ["Redemption", "Found Family"],
  "tropes": ["Chosen One", "Quest"]
}
"#;

/// Classify a book in one consolidated GPT call
/// Replaces: cleanup_genres_with_gpt + assign_tags_with_gpt + resolve_age_rating + generate_dna
pub async fn classify_book(
    input: &ClassifyInput,
    api_key: &str,
    force_fresh: bool,
) -> Result<ClassifyOutput, String> {
    // Check cache
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    input.title.to_lowercase().trim().hash(&mut h);
    input.author.to_lowercase().trim().hash(&mut h);
    "classify_v1".hash(&mut h);
    let cache_key = format!("classify_{}", h.finish());

    if !force_fresh {
        if let Some(cached) = crate::cache::get::<ClassifyOutput>(&cache_key) {
            println!("   📦 Using cached classification for '{}'", input.title);
            return Ok(cached);
        }
    } else {
        println!("   🔄 Force fresh classification for '{}'", input.title);
    }

    // Build user prompt — embed system prompt since call_gpt_api uses a generic system prompt
    let mut prompt = format!(
        "{}\n\n═══ BOOK TO CLASSIFY ═══\n\n\
         Title: {}\n\
         Author: {}\n",
        CLASSIFY_SYSTEM_PROMPT, input.title, input.author
    );

    if let Some(ref desc) = input.description {
        let truncated: String = desc.chars().take(800).collect();
        prompt.push_str(&format!("Description: {}\n", truncated));
    }

    if !input.genres.is_empty() {
        prompt.push_str(&format!("Current Genres: {}\n", input.genres.join(", ")));
    }

    if let Some(ref narrator) = input.narrator {
        prompt.push_str(&format!("Narrator: {}\n", narrator));
    }

    if let Some(minutes) = input.duration_minutes {
        let hours = minutes / 60;
        let mins = minutes % 60;
        prompt.push_str(&format!("Duration: {}h {}m\n", hours, mins));
    }

    if let Some(ref series) = input.series_name {
        prompt.push_str(&format!("Series: {}", series));
        if let Some(ref seq) = input.series_sequence {
            prompt.push_str(&format!(" #{}", seq));
        }
        prompt.push('\n');
    }

    if let Some(ref year) = input.year {
        prompt.push_str(&format!("Published: {}\n", year));
    }

    if let Some(ref publisher) = input.publisher {
        prompt.push_str(&format!("Publisher: {}\n", publisher));
    }

    prompt.push_str("\nReturn the classification JSON.");

    // Use gpt-4o-mini for classification (same as individual calls used)
    let response = call_gpt_api(&prompt, api_key, &crate::scanner::processor::preferred_model(), 3000).await
        .map_err(|e| format!("Classification GPT error: {}", e))?;

    let parsed = parse_classify_response(&response, &input)?;

    // Cache the result
    let _ = crate::cache::set(&cache_key, &parsed);

    Ok(parsed)
}

/// Parse the classification GPT response
fn parse_classify_response(response: &str, input: &ClassifyInput) -> Result<ClassifyOutput, String> {
    // Handle markdown wrapping
    let json_str = extract_json(response);

    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Invalid classification JSON: {}. Raw: {}", e, &response[..response.len().min(500)]))?;

    // Extract genres (validated against approved list)
    let raw_genres = extract_string_array(&parsed, "genres");
    let genres: Vec<String> = raw_genres
        .into_iter()
        .filter(|g| crate::genres::APPROVED_GENRES.iter().any(|a| a.eq_ignore_ascii_case(g)))
        .map(|g| {
            crate::genres::APPROVED_GENRES
                .iter()
                .find(|a| a.eq_ignore_ascii_case(&g))
                .map(|a| a.to_string())
                .unwrap_or(g)
        })
        .collect();

    // Extract tags (validated against approved list)
    let raw_tags = extract_string_array(&parsed, "tags");
    let tags: Vec<String> = raw_tags
        .into_iter()
        .filter(|t| crate::genres::APPROVED_TAGS.contains(&t.as_str()))
        .collect();

    // Extract age rating
    let intended_for_kids = parsed.get("intended_for_kids").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut age_tags = extract_string_array(&parsed, "age_tags");
    // Ensure for-kids/not-for-kids tag
    if !age_tags.iter().any(|t| t == "for-kids" || t == "not-for-kids") {
        age_tags.push(if intended_for_kids { "for-kids".to_string() } else { "not-for-kids".to_string() });
    }
    // Ensure required age tag categories
    age_tags = crate::age_rating_resolver::ensure_required_tags_pub(&age_tags);

    let age_rating = AgeRatingOutput {
        age_category: parsed.get("age_category").and_then(|v| v.as_str()).unwrap_or("Adult").to_string(),
        min_age: parsed.get("min_age").and_then(|v| v.as_u64()).map(|n| n as u8),
        content_rating: parsed.get("content_rating").and_then(|v| v.as_str()).unwrap_or("PG").to_string(),
        age_tags,
        confidence: parsed.get("age_confidence").and_then(|v| v.as_str()).unwrap_or("medium").to_string(),
        reasoning: parsed.get("age_reasoning").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        sources_used: vec!["gpt_consolidated".to_string()],
        intended_for_kids,
    };

    // Extract DNA
    let dna = if let Some(dna_val) = parsed.get("dna") {
        parse_dna_from_value(dna_val)
    } else {
        BookDNA::default()
    };

    let themes = extract_string_array(&parsed, "themes");
    let tropes = extract_string_array(&parsed, "tropes");

    Ok(ClassifyOutput {
        genres,
        tags,
        age_rating,
        dna,
        themes,
        tropes,
    })
}

// =============================================================================
// Call C: Description Processing (validate + clean/generate)
// =============================================================================

/// Output from consolidated description processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DescriptionOutput {
    /// Whether the existing description was valid
    pub was_valid: bool,
    /// Reason if invalid
    pub invalid_reason: Option<String>,
    /// The final description (cleaned or generated)
    pub description: String,
    /// Whether the description was generated from scratch
    pub was_generated: bool,
}

/// Process a description in one consolidated GPT call
/// Replaces: validate_description_matches_book + fix_description_with_gpt
pub async fn process_description(
    title: &str,
    author: &str,
    genres: &[String],
    existing_description: Option<&str>,
    api_key: &str,
) -> Result<DescriptionOutput, String> {
    let genres_str = if genres.is_empty() { "Unknown".to_string() } else { genres.join(", ") };

    let prompt = if let Some(desc) = existing_description {
        if desc.trim().len() < 50 {
            // Too short — generate from scratch
            build_generate_prompt(title, author, &genres_str)
        } else {
            // Validate and fix in one call
            build_validate_and_fix_prompt(title, author, &genres_str, desc)
        }
    } else {
        // No description — generate from scratch
        build_generate_prompt(title, author, &genres_str)
    };

    let response = call_gpt_api(&prompt, api_key, &crate::scanner::processor::preferred_model(), 800).await
        .map_err(|e| format!("Description GPT error: {}", e))?;

    parse_description_response(&response, existing_description.is_none())
}

fn build_validate_and_fix_prompt(title: &str, author: &str, genres: &str, description: &str) -> String {
    format!(
r#"Analyze and process this audiobook description.

BOOK INFO:
Title: "{title}"
Author: {author}
Genres: {genres}

EXISTING DESCRIPTION:
{description}

STEP 1 - VALIDATE: Check for these problems:
- WRONG BOOK: Description is about a different book
- GARBAGE: Placeholder, encoding errors, HTML, copy-paste errors
- PROMOTIONAL ONLY: No actual content about the book
- IN MEDIAS RES: Starts mid-story assuming reader knows previous books

STEP 2 - FIX OR REPLACE:
If valid: Clean it (remove HTML, promotional text, "Narrated by..." lines, review quotes). Keep core plot summary. Fix "in medias res" by adding context.
If invalid: Generate a new description from your knowledge of this book.

RULES:
- Target 150-300 characters
- Third person, present tense
- Focus on plot/premise, not praise
- Must work as standalone introduction for new readers

Return ONLY JSON:
{{"was_valid": true/false, "invalid_reason": "reason or null", "description": "the final clean description", "was_generated": false}}"#,
        title = title, author = author, genres = genres, description = description
    )
}

fn build_generate_prompt(title: &str, author: &str, genres: &str) -> String {
    format!(
r#"Write a brief audiobook description for "{title}" by {author}.
Genre: {genres}

RULES:
1. Write 2-3 sentences summarizing the book's premise
2. Third person, present tense
3. Be factual — only include what you know about this book
4. Target 150-250 characters
5. Focus on plot/premise, not praise
6. If you don't know this book well, write a generic but accurate description based on the genre

Return ONLY JSON:
{{"was_valid": false, "invalid_reason": "no existing description", "description": "your generated description", "was_generated": true}}"#,
        title = title, author = author, genres = genres
    )
}

fn parse_description_response(response: &str, no_existing: bool) -> Result<DescriptionOutput, String> {
    let json_str = extract_json(response);

    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
        let description = parsed.get("description")
            .and_then(|v| v.as_str())
            .or_else(|| parsed.get("text").and_then(|v| v.as_str()))
            .or_else(|| parsed.get("content").and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .to_string();

        if description.len() < 50 {
            return Err("Generated description too short".to_string());
        }

        Ok(DescriptionOutput {
            was_valid: parsed.get("was_valid").and_then(|v| v.as_bool()).unwrap_or(!no_existing),
            invalid_reason: parsed.get("invalid_reason").and_then(|v| v.as_str()).map(|s| s.to_string()),
            description,
            was_generated: parsed.get("was_generated").and_then(|v| v.as_bool()).unwrap_or(no_existing),
        })
    } else {
        // GPT returned plain text instead of JSON — treat as description
        let cleaned = response.trim().trim_matches('"').trim();
        if cleaned.len() >= 50 {
            Ok(DescriptionOutput {
                was_valid: !no_existing,
                invalid_reason: None,
                description: cleaned.to_string(),
                was_generated: no_existing,
            })
        } else {
            Err("Failed to parse description response".to_string())
        }
    }
}

// =============================================================================
// Helpers
// =============================================================================

/// Extract JSON from potentially markdown-wrapped response
fn extract_json(content: &str) -> &str {
    let content = content.trim();
    if content.contains("```json") {
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
        content
    }
}

fn extract_string_array(data: &serde_json::Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|item| item.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

/// Parse DNA from a JSON Value into BookDNA struct
fn parse_dna_from_value(val: &serde_json::Value) -> BookDNA {
    use crate::book_dna::*;

    fn parse_enum<T: for<'de> serde::Deserialize<'de>>(data: &serde_json::Value, key: &str) -> Option<T> {
        data.get(key).and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    BookDNA {
        length: parse_enum(val, "length"),
        pacing: parse_enum(val, "pacing"),
        structure: parse_enum(val, "structure"),
        pov: parse_enum(val, "pov"),
        series_position: parse_enum(val, "series_position"),
        pub_era: parse_enum(val, "pub_era"),
        setting: parse_enum(val, "setting"),
        ending_type: parse_enum(val, "ending_type"),
        opening_energy: parse_enum(val, "opening_energy"),
        ending_energy: parse_enum(val, "ending_energy"),
        humor_type: parse_enum(val, "humor_type"),
        stakes_level: parse_enum(val, "stakes_level"),
        protagonist_count: parse_enum(val, "protagonist_count"),
        prose_style: parse_enum(val, "prose_style"),
        series_dependency: parse_enum(val, "series_dependency"),
        production: parse_enum(val, "production"),
        narrator_performance: extract_string_array(val, "narrator_performance"),
        audio_friendliness: val.get("audio_friendliness").and_then(|v| v.as_u64()).map(|v| (v as u8).min(5)),
        re_listen_value: val.get("re_listen_value").and_then(|v| v.as_u64()).map(|v| (v as u8).min(5)),
        violence_level: val.get("violence_level").and_then(|v| v.as_u64()).map(|v| (v as u8).min(5)),
        intimacy_level: val.get("intimacy_level").and_then(|v| v.as_u64()).map(|v| (v as u8).min(5)),
        tropes: extract_string_array(val, "tropes"),
        themes: extract_string_array(val, "themes"),
        relationship_focus: extract_string_array(val, "relationship_focus"),
        shelves: extract_string_array(val, "shelves"),
        comp_authors: extract_string_array(val, "comp_authors"),
        comp_vibes: extract_string_array(val, "comp_vibes"),
        spectrums: val.get("spectrums")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|item| {
                let dimension = item.get("dimension")?.as_str()?.to_string();
                let value = item.get("value")?.as_i64()? as i8;
                Some(SpectrumValue { dimension, value })
            }).collect())
            .unwrap_or_default(),
        moods: val.get("moods")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|item| {
                let mood = item.get("mood")?.as_str()?.to_string();
                let intensity = item.get("intensity")?.as_u64()? as u8;
                Some(MoodIntensity { mood, intensity })
            }).collect())
            .unwrap_or_default(),
    }
}
