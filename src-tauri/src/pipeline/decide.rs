// src-tauri/src/pipeline/decide.rs
// DECIDE stage - GPT resolves conflicts and produces unified metadata

use crate::config::Config;
use crate::pipeline::context::format_series_context;
use crate::pipeline::types::{AggregatedBookData, ResolvedMetadata, ResolvedSeries, SourceData};
use serde::Deserialize;

/// GPT system prompt for metadata resolution
pub const GPT_SYSTEM_PROMPT: &str = r#"
You are an audiobook metadata specialist. Analyze metadata from multiple sources and return the best, most accurate result.

══════════════════════════════════════════════════════════════════════════════
SERIES VALIDATION - CRITICAL
══════════════════════════════════════════════════════════════════════════════

### STEP 1: REJECT THESE AS SERIES (return series_name: null)

**Author names as series (VERY COMMON ERROR - these are NOT series):**
Dr. Seuss, Eric Carle, Leo Lionni, Jan Brett, William Steig, Arnold Lobel,
Tomie dePaola, Robert McCloskey, Ezra Jack Keats, Kevin Henkes, Mo Willems,
Sandra Boynton, Audrey Wood, Don Wood, Audrey and Don Wood, Roald Dahl,
Beatrix Potter, Maurice Sendak, Cynthia Rylant, Ludwig Bemelmans, H. A. Rey,
Bernard Waber, Russell Hoban, Mercer Mayer, Syd Hoff, P. D. Eastman,
James Marshall, Mary Ann Hoberman, Judi Barrett, Judith Viorst, Peggy Rathmann,
Jan Slepian and Ann Seidler, Wanda Gág, Kathi Appelt, Simms Taback,
Sam McBratney, Iza Trapani, Joyce Dunbar, Stephanie Calmenson,
Nadine Bernard Westcott, Paul Galdone, Rosemary Wells, Marjorie Weinman Sharmat,
Eric Carle's Very, The World of Beatrix Potter

**Publisher/imprint names (NOT series):**
Beginner Books, Bright and Early Books, Chartwell Deluxe Editions,
Penguin Classics, Audible Originals, Voices Leveled Library,
Voices Leveled Library Readers, Smart Summaries, Read With Highlight,
Read With Highlights, Rebus Read-Along Stories, Bloom's Modern Critical Interpretations

**Generic categories (NOT series):**
Memoir, Chapter, Parenting, Fiction, Novel, Collection, Anthology,
Biography, Self-Help, Education, Poetry, Picture Book, Board Book

**Garbage values:**
none, null, N/A, Unknown, or null, Test, Jag Badalnare Granth

**Foreign language (for English books):**
Petits Meurtres, Petits Meurtres Français, Collection (French),
Sammlung, Reihe (German), Dizisi, Serisi, Kitaplari (Turkish)

### STEP 2: VERIFY SERIES-AUTHOR OWNERSHIP

If series doesn't match author, return series_name: null.

| Series | ONLY valid author(s) |
|--------|----------------------|
| Inspector Banks, Alan Banks, DCI Banks | Peter Robinson |
| Adam Dalgliesh | P. D. James |
| Hercule Poirot, Miss Marple | Agatha Christie |
| Inspector Rebus | Ian Rankin |
| Harry Hole | Jo Nesbø |
| Cormoran Strike | Robert Galbraith |
| Inspector Gamache, Chief Inspector Gamache | Louise Penny |
| Roy Grace | Peter James |
| D.D. Warren, Detective D.D. Warren | Lisa Gardner |
| Dublin Murder Squad | Tana French |
| Tony Hill & Carol Jordan | Val McDermid |
| Inspector Karen Pirie | Val McDermid |
| Slough House | Mick Herron |
| Peter Diamond | Peter Lovesey |
| Joseph O'Loughlin | Michael Robotham |
| Frieda Klein | Nicci French |
| Department Q | Jussi Adler-Olsen |
| Maeve Kerrigan | Jane Casey |
| Simon Serrailler | Susan Hill |
| Detective Erika Foster | Robert Bryndza |
| Inspector Van Veeteren | Håkan Nesser |
| Detective Sean Duffy | Adrian McKinty |
| Discworld | Terry Pratchett |
| Dresden Files | Jim Butcher |
| Cradle | Will Wight |
| Harry Potter | J. K. Rowling |
| The Expanse | James S. A. Corey |
| Throne of Glass, A Court of Thorns and Roses, Crescent City | Sarah J. Maas |
| Zodiac Academy | Caroline Peckham, Susanne Valenti |
| King's Dark Tidings | Kel Kade |
| Dungeon Crawler Carl | Matt Dinniman |
| Mark of the Fool | J. M. Clarke |
| Lightbringer | Brent Weeks |
| Red Rising, Red Rising Saga | Pierce Brown |
| First Law, First Law World | Joe Abercrombie |
| The Kingkiller Chronicle | Patrick Rothfuss |
| The Dark Tower | Stephen King |
| Amelia Bedelia, Amelia Bedelia & Friends | Peggy Parish, Herman Parish |
| Curious George | H. A. Rey, Margret Rey |
| Magic Tree House, Magic Tree House: Merlin Missions | Mary Pope Osborne |
| Little Bear | Else Holmelund Minarik |
| Henry and Mudge, Mr. Putter & Tabby, Cobble Street Cousins | Cynthia Rylant |
| Froggy | Jonathan London |
| Franklin, Franklin the Turtle | Paulette Bourgeois |
| Madeline | Ludwig Bemelmans |
| Strega Nona | Tomie dePaola |
| Danny and the Dinosaur | Syd Hoff |
| Mouse | Kevin Henkes |
| Five Little Monkeys | Eileen Christelow |
| Chicka Chicka | Bill Martin Jr. |
| Frances, Frances the Badger | Russell Hoban |
| George and Martha | James Marshall |
| Caps for Sale | Esphyr Slobodkina |
| Lyle, Lyle the Crocodile | Bernard Waber |
| If You Give... | Laura Numeroff |
| Miss Nelson | James Marshall, Harry Allard |
| Sheep | Nancy Shaw |
| Harold | Crockett Johnson |
| Jesse Bear | Nancy White Carlstrom |
| Moonbear | Frank Asch |
| Little Critter | Mercer Mayer |
| Cloudy with a Chance of Meatballs | Judi Barrett |

### STEP 3: NORMALIZE SERIES NAMES

| Variants → | Canonical Name |
|------------|----------------|
| Charlotte & Thomas Pitt, Charlotte and Thomas Pitt, Charlotte and Thomas Pitt Mysteries, The Charlotte and Thomas Pitt, The Charlotte and Thomas Pitt Novels, Thomas Pitt Mysteries | Thomas Pitt |
| Chief Inspector Armand Gamache, Chief Inspector Gamache, Chief Inspector Gamache Mysteries, Gamache | Inspector Gamache |
| The Dresden Files | Dresden Files |
| Mr. Putter and Tabby | Mr. Putter & Tabby |
| Tony Hill and Carol Jordan | Tony Hill & Carol Jordan |
| D.I. Kim Stone | DI Kim Stone |
| D.I. Lottie Parker | DI Lottie Parker |
| D.I. Nikki Galena | DI Nikki Galena |
| D.I. Amy Winter | DI Amy Winter |
| Henry & Mudge | Henry and Mudge |
| Magic Tree House Merlin Mission, Magic Tree House Merlin Missions, Magic Tree House "Merlin Missions" | Magic Tree House: Merlin Missions |
| Outlander (Gabaldon) | Outlander |
| The Expanse (Chronological) | The Expanse |
| Discworld - Death, Discworld - Witches, Discworld - Rincewind, Discworld - Tiffany Aching, Discworld - Industrial Revolution | Discworld |
| The Complete Arkangel Shakespeare, Arkangel Shakespeare | Arkangel Shakespeare |
| A Song of Ice and Fire, Game of Thrones | A Song of Ice and Fire |
| Gentleman Bastard, The Gentleman Bastard Sequence, Gentleman Bastard Sequence | Gentleman Bastard |
| The Hunger Games | Hunger Games |
| The Dark Tower | Dark Tower |
| Red Rising, Red Rising Saga | Red Rising |
| The First Law, First Law World | First Law |
| Franklin the Turtle | Franklin |
| Frances the Badger | Frances |
| Lyle the Crocodile | Lyle |
| Curious George Original Adventures | Curious George |
| The Kindred's Curse Saga, Kindred's Curse Saga | Kindred's Curse |

### STEP 4: SEQUENCE RULES

- Integer for main entries: 1, 2, 3
- Decimal for novellas/interstitials: 0.5, 1.5, 2.5
- null if unknown or anthology
- Return as STRING: "1", "2", "0.5"

══════════════════════════════════════════════════════════════════════════════
AUTHOR NORMALIZATION
══════════════════════════════════════════════════════════════════════════════

**REJECT as author (use "Unknown"):**
Charles River Editors, Pimsleur, The Great Courses, The Princeton Review,
Various Authors, Anonymous, Unknown, PhD, MD, Recorded Books, BBC

**NORMALIZE initials (add spaces and periods):**
J.K. Rowling → J. K. Rowling
JK Rowling → J. K. Rowling
C.S. Lewis → C. S. Lewis
P.D. James → P. D. James
J.R.R. Tolkien → J. R. R. Tolkien
M.C. Beaton → M. C. Beaton
George R.R. Martin → George R. R. Martin
J.M. Clarke → J. M. Clarke
B.A. Paris → B. A. Paris
LJ Andrews → L. J. Andrews

**NORMALIZE diacritics:**
Arnaldur Indridason → Arnaldur Indriðason
Jo Nesbo → Jo Nesbø
Asa Larsson → Åsa Larsson
Hakan Nesser → Håkan Nesser
Jorn Lier Horst → Jørn Lier Horst

**NORMALIZE variants:**
Dr Seuss → Dr. Seuss
Octavia Butler → Octavia E. Butler
John Le Carré → John le Carré
Tomie Depaola → Tomie dePaola

══════════════════════════════════════════════════════════════════════════════
GENRE RULES - MAP TO THESE EXACT GENRES ONLY
══════════════════════════════════════════════════════════════════════════════

**Fiction Genres (use these exact names):**
Literary Fiction, Contemporary Fiction, Historical Fiction, Classics,
Mystery, Thriller, Crime, Horror, Romance, Fantasy, Science Fiction,
Western, Adventure, Humor, Satire, Women's Fiction, LGBTQ+ Fiction,
Short Stories, Anthology

**Non-Fiction Genres:**
Biography, Autobiography, Memoir, History, True Crime, Science,
Popular Science, Psychology, Self-Help, Business, Personal Finance,
Health & Wellness, Philosophy, Religion & Spirituality, Politics,
Essays, Journalism, Travel, Food & Cooking, Nature, Sports, Music, Art,
Education, Parenting & Family, Relationships, Non-Fiction

**Age-Specific Genres (for children's books):**
Children's 0-2, Children's 3-5, Children's 6-8, Children's 9-12,
Teen 13-17, Young Adult, Middle Grade, New Adult, Adult

**Format Genres:**
Audiobook Original, Full Cast Production, Dramatized, Podcast Fiction

**RULES:**
- Return 1-3 genres, most specific first
- For children's books, ALWAYS use age-specific (e.g., "Children's 6-8")
- NEVER use generic "Children's" or "Young Adult" alone
- Map input genres to these exact approved names

══════════════════════════════════════════════════════════════════════════════
TAGS - Use lowercase-hyphenated format (5-15 per book)
══════════════════════════════════════════════════════════════════════════════

NOTE: Do NOT include age-related tags (age-childrens, age-adult, rated-pg, age-rec-*, etc.)
Age rating is handled separately by a dedicated system that uses API data.

**Select tags from these categories:**

**Sub-genre tags:**
cozy-mystery, police-procedural, legal-thriller, domestic-thriller, spy, noir, whodunit, heist,
rom-com, historical-romance, paranormal-romance, dark-romance, clean-romance, small-town-romance,
epic-fantasy, urban-fantasy, dark-fantasy, cozy-fantasy, grimdark, portal-fantasy, fairy-tale-retelling, progression-fantasy, litrpg,
space-opera, dystopian, post-apocalyptic, cyberpunk, time-travel, first-contact, alternate-history,
gothic, supernatural, psychological-horror, folk-horror, haunted-house, cosmic-horror

**Mood tags:**
atmospheric, cozy, dark, emotional, funny, heartbreaking, heartwarming, hopeful, inspiring,
mysterious, romantic, suspenseful, thought-provoking, whimsical

**Pacing tags:**
fast-paced, slow-burn, page-turner, action-packed, easy-listening

**Style tags:**
character-driven, plot-driven, unreliable-narrator, multiple-pov, dual-timeline, first-person

**Romance trope tags:**
enemies-to-lovers, friends-to-lovers, second-chance, forced-proximity,
fake-relationship, forbidden-love, grumpy-sunshine, only-one-bed

**Story trope tags:**
found-family, chosen-one, reluctant-hero, antihero, morally-grey,
redemption-arc, revenge, quest, survival, underdog, coming-of-age

**Creature tags:**
vampires, werewolves, fae, witches, dragons, ghosts, aliens, magic-users

**Setting tags:**
small-town, big-city, academy, college, castle, spaceship, forest

**Period tags:**
regency, victorian, medieval, 1920s, wwii, civil-war

**Theme tags:**
family, friendship, grief, healing, identity, justice, loyalty, mental-health, trauma, faith

**Series tags:**
standalone, in-series, trilogy, duology, long-series

**Audiobook tags:**
under-5-hours, 5-10-hours, 10-15-hours, 15-20-hours, over-20-hours,
full-cast, author-narrated, great-character-voices

**Recognition tags:**
bestseller, award-winner, debut, classic

**Content tags:**
clean, fade-to-black, steamy, explicit, low-violence, graphic-violence

══════════════════════════════════════════════════════════════════════════════
THEMES AND TROPES
══════════════════════════════════════════════════════════════════════════════

**THEMES** (3-5): Abstract concepts the book explores
Examples: Redemption, Found Family, Coming of Age, Power and Corruption,
Identity, Loss and Grief, Good vs Evil, Survival, Love and Sacrifice

**TROPES** (3-5): Storytelling patterns and conventions
Examples: Chosen One, Mentor Figure, Dark Lord, Hidden Heir, Quest,
Reluctant Hero, Love Triangle, Fish Out of Water, Training Montage,
Unreliable Narrator, Detective Protagonist, Locked Room Mystery

══════════════════════════════════════════════════════════════════════════════
DESCRIPTION CLEANING
══════════════════════════════════════════════════════════════════════════════

When returning "description":
- REMOVE promotional text like "New York Times bestseller", "Over X copies sold"
- REMOVE narrator/author announcements like "Read by...", "Narrated by..."
- REMOVE series announcements like "Book X in the Y series"
- REMOVE review quotes and blurbs
- KEEP only the actual plot/content description
- EXTRACT narrator name to the "narrator" field if mentioned
- Return null if no actual description content remains

══════════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT - STRICT JSON
══════════════════════════════════════════════════════════════════════════════

Return ONLY this JSON structure - no markdown, no explanation:

{
  "title": "Book Title",
  "subtitle": "Subtitle" or null,
  "author": "Primary Author",
  "authors": ["Author 1", "Author 2"],
  "narrator": "Primary Narrator" or null,
  "narrators": ["Narrator 1"],
  "series_name": "Canonical Series Name" or null,
  "series_sequence": "1" or null,
  "genres": ["Genre 1", "Genre 2"],
  "tags": ["tag-1", "tag-2", "tag-3"],
  "description": "Clean description without promotions" or null,
  "publisher": "Publisher" or null,
  "year": "2023" or null,
  "language": "English" or null,
  "themes": ["Theme 1", "Theme 2", "Theme 3"],
  "tropes": ["Trope 1", "Trope 2", "Trope 3"],
  "confidence": "high" | "medium" | "low",
  "reasoning": "Brief explanation of decisions"
}

Rules:
- null for unknown (never empty string "")
- series_sequence as STRING: "1", "2", "0.5"
- ONE series only (the primary/main series)
- tags in lowercase-hyphenated format
- genres from APPROVED list only
- description cleaned of promotional content
- UTF-8 encoding
"#;

// Responses API structures for GPT-5 models

/// Response from Responses API
#[derive(Deserialize, Debug)]
struct ResponsesApiResponse {
    #[serde(default)]
    output: Vec<OutputItem>,
    /// Top-level output_text field (simpler format)
    output_text: Option<String>,
}

#[derive(Deserialize, Debug)]
struct OutputItem {
    content: Option<Vec<ContentItem>>,
    #[serde(rename = "type")]
    item_type: String,
}

#[derive(Deserialize, Debug)]
struct ContentItem {
    text: Option<String>,
    #[serde(rename = "type")]
    content_type: String,
}

/// Resolve metadata conflicts using GPT-5-nano via Responses API
pub async fn resolve_with_gpt(
    config: &Config,
    data: &AggregatedBookData,
) -> Result<ResolvedMetadata, String> {
    let api_key = config
        .openai_api_key
        .as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("No OpenAI API key configured")?;

    let user_prompt = build_user_prompt(data);

    // Build Responses API request body for GPT-5-nano
    let request_body = serde_json::json!({
        "model": crate::scanner::processor::preferred_model(),
        "input": [
            {
                "role": "developer",
                "content": GPT_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": user_prompt
            }
        ],
        "max_output_tokens": 4000,
        "reasoning": {
            "effort": "low"
        },
        "text": {
            "format": {
                "type": "json_object"
            }
        }
    });

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/responses")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("GPT request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GPT returned status {}: {}", status, body));
    }

    let response_text = response.text().await
        .map_err(|e| format!("Failed to read GPT response: {}", e))?;

    // Parse Responses API format
    let result: ResponsesApiResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse Responses API response: {}. Raw: {}", e, &response_text[..response_text.len().min(500)]))?;

    // Extract text content - first try top-level output_text, then nested format
    let content = if let Some(ref text) = result.output_text {
        text.trim().to_string()
    } else {
        result.output.iter()
            .filter(|item| item.item_type == "message")
            .filter_map(|item| item.content.as_ref())
            .flatten()
            .filter(|c| c.content_type == "output_text" || c.content_type == "text")
            .filter_map(|c| c.text.as_ref())
            .next()
            .ok_or_else(|| format!("No text content in Responses API response. Raw: {}", &response_text[..response_text.len().min(500)]))?
            .trim()
            .to_string()
    };

    // Parse GPT's JSON response
    parse_gpt_response(&content)
}

/// Build the user prompt with all source data
fn build_user_prompt(data: &AggregatedBookData) -> String {
    let mut prompt = String::from("Analyze these metadata sources and return unified metadata:\n\n");

    // Add each source
    for (i, source) in data.sources.iter().enumerate() {
        prompt.push_str(&format!(
            "SOURCE {} ({}, confidence: {}):\n",
            i + 1,
            source.source,
            source.confidence
        ));
        prompt.push_str(&format_source_data(source));
        prompt.push('\n');
    }

    // Add series context if available
    if !data.series_context.is_empty() {
        prompt.push_str(&format_series_context(&data.series_context));
        prompt.push('\n');
    }

    prompt.push_str("\nReturn the unified metadata JSON.\n");

    prompt
}

/// Format source data for the prompt
fn format_source_data(source: &SourceData) -> String {
    let mut output = String::new();

    if let Some(ref title) = source.title {
        output.push_str(&format!("  Title: {}\n", title));
    }
    if let Some(ref subtitle) = source.subtitle {
        output.push_str(&format!("  Subtitle: {}\n", subtitle));
    }
    if !source.authors.is_empty() {
        output.push_str(&format!("  Authors: {}\n", source.authors.join(", ")));
    }
    if !source.narrators.is_empty() {
        output.push_str(&format!("  Narrators: {}\n", source.narrators.join(", ")));
    }
    if !source.series.is_empty() {
        output.push_str("  Series:\n");
        for s in &source.series {
            let seq = s.sequence.as_deref().unwrap_or("?");
            output.push_str(&format!("    - {} #{}\n", s.name, seq));
        }
    }
    if !source.genres.is_empty() {
        output.push_str(&format!("  Genres: {}\n", source.genres.join(", ")));
    }
    if let Some(ref desc) = source.description {
        // Truncate long descriptions (use chars() for proper UTF-8 handling)
        let truncated: String = desc.chars().take(500).collect();
        let truncated = if truncated.len() < desc.len() {
            format!("{}...", truncated)
        } else {
            truncated
        };
        output.push_str(&format!("  Description: {}\n", truncated));
    }
    if let Some(ref publisher) = source.publisher {
        output.push_str(&format!("  Publisher: {}\n", publisher));
    }
    if let Some(ref year) = source.year {
        output.push_str(&format!("  Year: {}\n", year));
    }
    if let Some(ref language) = source.language {
        output.push_str(&format!("  Language: {}\n", language));
    }

    output
}

/// Parse GPT's JSON response into ResolvedMetadata
fn parse_gpt_response(content: &str) -> Result<ResolvedMetadata, String> {
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

    let parsed: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("Invalid JSON from GPT: {}", e))?;

    Ok(ResolvedMetadata {
        title: parsed
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string(),
        subtitle: parsed
            .get("subtitle")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        author: parsed
            .get("author")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string(),
        authors: extract_string_array(&parsed, "authors"),
        narrator: parsed
            .get("narrator")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        narrators: extract_string_array(&parsed, "narrators"),
        series: extract_single_series(&parsed),
        genres: extract_string_array(&parsed, "genres"),
        tags: extract_string_array(&parsed, "tags"),
        description: parsed
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        publisher: parsed
            .get("publisher")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        year: parsed
            .get("year")
            .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string()))),
        language: parsed
            .get("language")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        themes: extract_string_array(&parsed, "themes"),
        tropes: extract_string_array(&parsed, "tropes"),
        reasoning: parsed
            .get("reasoning")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

fn extract_string_array(data: &serde_json::Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Extract single series from flat format (series_name, series_sequence)
/// Falls back to old array format for backward compatibility
fn extract_single_series(data: &serde_json::Value) -> Vec<ResolvedSeries> {
    // Try new flat format first: series_name and series_sequence
    if let Some(name) = data.get("series_name").and_then(|v| v.as_str()) {
        if !name.is_empty() {
            let sequence = data.get("series_sequence")
                .and_then(|s| s.as_str().map(|v| v.to_string()).or_else(|| s.as_f64().map(|n| n.to_string())));
            return vec![ResolvedSeries {
                name: name.to_string(),
                sequence,
                is_primary: true,
                is_subseries_of: None,
            }];
        }
    }

    // Also check "series" as string (alternative flat format)
    if let Some(name) = data.get("series").and_then(|v| v.as_str()) {
        if !name.is_empty() {
            let sequence = data.get("sequence")
                .and_then(|s| s.as_str().map(|v| v.to_string()).or_else(|| s.as_f64().map(|n| n.to_string())));
            return vec![ResolvedSeries {
                name: name.to_string(),
                sequence,
                is_primary: true,
                is_subseries_of: None,
            }];
        }
    }

    // Fall back to old array format for backward compatibility
    data.get("series")
        .and_then(|v| v.as_array())
        .map(|arr| {
            // Only take the first (primary) series
            arr.iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(|n| n.as_str())?;
                    Some(ResolvedSeries {
                        name: name.to_string(),
                        sequence: item
                            .get("sequence")
                            .and_then(|s| s.as_str().map(|v| v.to_string()).or_else(|| s.as_f64().map(|n| n.to_string()))),
                        is_primary: true,
                        is_subseries_of: None,
                    })
                })
                .take(1)  // Only take first series
                .collect()
        })
        .unwrap_or_default()
}

/// Fallback resolution when GPT is unavailable
pub fn fallback_resolution(data: &AggregatedBookData) -> ResolvedMetadata {
    // Sort sources by confidence (highest first)
    let mut sources = data.sources.clone();
    sources.sort_by(|a, b| b.confidence.cmp(&a.confidence));

    // Take best values from each source
    let title = sources
        .iter()
        .find_map(|s| s.title.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let subtitle = sources.iter().find_map(|s| s.subtitle.clone());

    let authors: Vec<String> = sources
        .iter()
        .find(|s| !s.authors.is_empty())
        .map(|s| s.authors.clone())
        .unwrap_or_default();

    let author = authors.first().cloned().unwrap_or_else(|| "Unknown".to_string());

    let narrators: Vec<String> = sources
        .iter()
        .find(|s| !s.narrators.is_empty())
        .map(|s| s.narrators.clone())
        .unwrap_or_default();

    let narrator = narrators.first().cloned();

    // Get the SINGLE best series from highest confidence source
    // Prefer series with sequence number
    let single_series: Vec<ResolvedSeries> = sources
        .iter()
        .flat_map(|s| s.series.iter())
        .filter(|s| !is_invalid_series(&s.name))  // Filter out known bad series
        .max_by(|a, b| {
            // Prefer entries with sequence
            match (&a.sequence, &b.sequence) {
                (Some(_), None) => std::cmp::Ordering::Greater,
                (None, Some(_)) => std::cmp::Ordering::Less,
                _ => std::cmp::Ordering::Equal,
            }
        })
        .map(|se| ResolvedSeries {
            name: normalize_series_name(&se.name),
            sequence: se.sequence.clone(),
            is_primary: true,
            is_subseries_of: None,
        })
        .into_iter()
        .collect();

    // Collect genres, deduplicate
    let mut genres: Vec<String> = sources
        .iter()
        .flat_map(|s| s.genres.clone())
        .collect();
    genres.sort();
    genres.dedup();
    genres.truncate(5);

    let description = sources.iter().find_map(|s| s.description.clone());
    let publisher = sources.iter().find_map(|s| s.publisher.clone());
    let year = sources.iter().find_map(|s| s.year.clone());
    let language = sources.iter().find_map(|s| s.language.clone());

    ResolvedMetadata {
        title,
        subtitle,
        author,
        authors,
        narrator,
        narrators,
        series: single_series,
        genres,
        tags: vec![],    // Fallback doesn't extract tags
        description,
        publisher,
        year,
        language,
        themes: vec![],  // Fallback doesn't extract themes
        tropes: vec![],  // Fallback doesn't extract tropes
        reasoning: Some("Fallback: Used highest confidence source values".to_string()),
    }
}

/// Check if a series name is invalid (should be rejected)
fn is_invalid_series(name: &str) -> bool {
    let lower = name.to_lowercase();
    
    // Invalid patterns
    const INVALID_SERIES: &[&str] = &[
        // Author names as series
        "dr. seuss", "dr seuss", "eric carle", "leo lionni", "jan brett",
        "william steig", "arnold lobel", "tomie depaola", "robert mccloskey",
        "ezra jack keats", "kevin henkes", "mo willems", "sandra boynton",
        "audrey wood", "don wood", "audrey and don wood", "roald dahl",
        "beatrix potter", "maurice sendak", "cynthia rylant", "ludwig bemelmans",
        "h. a. rey", "bernard waber", "russell hoban", "mercer mayer",
        "syd hoff", "p. d. eastman", "james marshall", "mary ann hoberman",
        "judi barrett", "judith viorst", "peggy rathmann", "wanda gág",
        "jan slepian and ann seidler", "eric carle's very", "the world of beatrix potter",
        // Publisher/imprint names
        "beginner books", "bright and early books", "chartwell deluxe editions",
        "penguin classics", "audible originals", "voices leveled library",
        "smart summaries", "read with highlight", "rebus read-along stories",
        // Generic categories
        "memoir", "chapter", "parenting", "fiction", "novel", "collection",
        "anthology", "biography", "self-help", "education", "poetry",
        // Garbage
        "none", "null", "n/a", "unknown", "or null", "test", "jag badalnare granth",
        // Foreign language
        "petits meurtres", "petits meurtres français",
    ];
    
    INVALID_SERIES.iter().any(|&invalid| lower.contains(invalid))
}

/// Normalize series name to canonical form
fn normalize_series_name(name: &str) -> String {
    let lower = name.to_lowercase();
    
    // Canonical mappings
    let normalized = match lower.as_str() {
        s if s.contains("charlotte") && s.contains("thomas pitt") => "Thomas Pitt",
        s if s.contains("chief inspector") && s.contains("gamache") => "Inspector Gamache",
        "the dresden files" => "Dresden Files",
        "mr. putter and tabby" => "Mr. Putter & Tabby",
        "tony hill and carol jordan" => "Tony Hill & Carol Jordan",
        "d.i. kim stone" => "DI Kim Stone",
        "d.i. lottie parker" => "DI Lottie Parker",
        "d.i. nikki galena" => "DI Nikki Galena",
        "henry & mudge" => "Henry and Mudge",
        s if s.contains("magic tree house") && s.contains("merlin") => "Magic Tree House: Merlin Missions",
        "outlander (gabaldon)" => "Outlander",
        s if s.starts_with("the expanse") => "The Expanse",
        s if s.starts_with("discworld") => "Discworld",
        "the complete arkangel shakespeare" | "arkangel shakespeare" => "Arkangel Shakespeare",
        "game of thrones" => "A Song of Ice and Fire",
        s if s.contains("gentleman bastard") => "Gentleman Bastard",
        "the hunger games" => "Hunger Games",
        "the dark tower" => "Dark Tower",
        s if s.contains("red rising") => "Red Rising",
        s if s.contains("first law") => "First Law",
        "franklin the turtle" => "Franklin",
        "frances the badger" => "Frances",
        "lyle the crocodile" => "Lyle",
        "curious george original adventures" => "Curious George",
        s if s.contains("kindred's curse") => "Kindred's Curse",
        _ => return name.to_string(),  // Return original if no mapping
    };
    
    normalized.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::types::SeriesEntry;

    #[test]
    fn test_fallback_resolution() {
        let data = AggregatedBookData {
            id: "test".to_string(),
            sources: vec![
                SourceData {
                    source: "low".to_string(),
                    confidence: 50,
                    title: Some("Low Title".to_string()),
                    authors: vec!["Low Author".to_string()],
                    series: vec![SeriesEntry::new("Series A".to_string(), None)],
                    ..Default::default()
                },
                SourceData {
                    source: "high".to_string(),
                    confidence: 90,
                    title: Some("High Title".to_string()),
                    authors: vec!["High Author".to_string()],
                    series: vec![SeriesEntry::new("Series B".to_string(), Some("1".to_string()))],
                    ..Default::default()
                },
            ],
            series_context: vec![],
        };

        let resolved = fallback_resolution(&data);

        // Should use high confidence values
        assert_eq!(resolved.title, "High Title");
        assert_eq!(resolved.author, "High Author");
        // Should have only ONE series (the best one with sequence)
        assert_eq!(resolved.series.len(), 1);
        assert_eq!(resolved.series[0].name, "Series B"); // Has sequence, so preferred
        assert_eq!(resolved.series[0].sequence, Some("1".to_string()));
    }

    #[test]
    fn test_fallback_rejects_invalid_series() {
        let data = AggregatedBookData {
            id: "test".to_string(),
            sources: vec![
                SourceData {
                    source: "source".to_string(),
                    confidence: 90,
                    title: Some("Test Book".to_string()),
                    authors: vec!["Dr. Seuss".to_string()],
                    series: vec![
                        SeriesEntry::new("Dr. Seuss".to_string(), Some("1".to_string())),  // Invalid - author as series
                        SeriesEntry::new("Beginner Books".to_string(), None),  // Invalid - publisher
                    ],
                    ..Default::default()
                },
            ],
            series_context: vec![],
        };

        let resolved = fallback_resolution(&data);

        // Should reject both invalid series
        assert!(resolved.series.is_empty());
    }

    #[test]
    fn test_fallback_normalizes_series() {
        let data = AggregatedBookData {
            id: "test".to_string(),
            sources: vec![
                SourceData {
                    source: "source".to_string(),
                    confidence: 90,
                    title: Some("Test Book".to_string()),
                    authors: vec!["Anne Perry".to_string()],
                    series: vec![SeriesEntry::new("Charlotte & Thomas Pitt".to_string(), Some("1".to_string()))],
                    ..Default::default()
                },
            ],
            series_context: vec![],
        };

        let resolved = fallback_resolution(&data);

        assert_eq!(resolved.series.len(), 1);
        assert_eq!(resolved.series[0].name, "Thomas Pitt");  // Normalized
    }

    #[test]
    fn test_parse_gpt_response() {
        let json = r#"{
            "title": "Test Book",
            "subtitle": "A Test",
            "author": "Test Author",
            "authors": ["Test Author", "Co-Author"],
            "narrator": "Test Narrator",
            "narrators": ["Test Narrator"],
            "series_name": "Test Series",
            "series_sequence": "1",
            "genres": ["Fantasy", "Adventure"],
            "description": "A test book",
            "publisher": "Test Pub",
            "year": "2023",
            "language": "English",
            "themes": ["Redemption", "Found Family"],
            "tropes": ["Chosen One", "Quest"],
            "confidence": "high",
            "reasoning": "Test reasoning"
        }"#;

        let result = parse_gpt_response(json).unwrap();

        assert_eq!(result.title, "Test Book");
        assert_eq!(result.subtitle, Some("A Test".to_string()));
        assert_eq!(result.author, "Test Author");
        assert_eq!(result.authors.len(), 2);
        assert_eq!(result.narrator, Some("Test Narrator".to_string()));
        assert_eq!(result.series.len(), 1);
        assert_eq!(result.series[0].name, "Test Series");
        assert_eq!(result.series[0].sequence, Some("1".to_string()));
        assert!(result.series[0].is_primary);
        assert_eq!(result.genres, vec!["Fantasy", "Adventure"]);
        assert_eq!(result.themes, vec!["Redemption", "Found Family"]);
        assert_eq!(result.tropes, vec!["Chosen One", "Quest"]);
    }

    #[test]
    fn test_parse_gpt_response_with_markdown() {
        let response = r#"```json
{
    "title": "Test",
    "author": "Author",
    "authors": [],
    "narrators": [],
    "series_name": null,
    "genres": []
}
```"#;

        let result = parse_gpt_response(response).unwrap();
        assert_eq!(result.title, "Test");
        assert!(result.series.is_empty());
    }

    #[test]
    fn test_parse_gpt_response_backward_compat() {
        // Test old array format still works
        let json = r#"{
            "title": "Test Book",
            "author": "Test Author",
            "authors": [],
            "narrators": [],
            "series": [
                {"name": "Old Format Series", "sequence": "2"}
            ],
            "genres": []
        }"#;

        let result = parse_gpt_response(json).unwrap();
        assert_eq!(result.series.len(), 1);
        assert_eq!(result.series[0].name, "Old Format Series");
        assert_eq!(result.series[0].sequence, Some("2".to_string()));
    }

    #[test]
    fn test_format_source_data() {
        let source = SourceData {
            source: "test".to_string(),
            confidence: 90,
            title: Some("Test Title".to_string()),
            authors: vec!["Author 1".to_string(), "Author 2".to_string()],
            series: vec![SeriesEntry::new("Test Series".to_string(), Some("1".to_string()))],
            genres: vec!["Fantasy".to_string()],
            ..Default::default()
        };

        let formatted = format_source_data(&source);

        assert!(formatted.contains("Title: Test Title"));
        assert!(formatted.contains("Authors: Author 1, Author 2"));
        assert!(formatted.contains("Test Series #1"));
        assert!(formatted.contains("Genres: Fantasy"));
    }

    #[test]
    fn test_is_invalid_series() {
        // Should reject
        assert!(is_invalid_series("Dr. Seuss"));
        assert!(is_invalid_series("Beginner Books"));
        assert!(is_invalid_series("Memoir"));
        assert!(is_invalid_series("or null"));
        assert!(is_invalid_series("Eric Carle's Very"));
        assert!(is_invalid_series("The World of Beatrix Potter"));
        
        // Should accept
        assert!(!is_invalid_series("Harry Potter"));
        assert!(!is_invalid_series("Discworld"));
        assert!(!is_invalid_series("Inspector Gamache"));
    }

    #[test]
    fn test_normalize_series_name() {
        assert_eq!(normalize_series_name("Charlotte & Thomas Pitt"), "Thomas Pitt");
        assert_eq!(normalize_series_name("Charlotte and Thomas Pitt"), "Thomas Pitt");
        assert_eq!(normalize_series_name("Chief Inspector Armand Gamache"), "Inspector Gamache");
        assert_eq!(normalize_series_name("The Dresden Files"), "Dresden Files");
        assert_eq!(normalize_series_name("D.I. Kim Stone"), "DI Kim Stone");
        assert_eq!(normalize_series_name("Henry & Mudge"), "Henry and Mudge");
        assert_eq!(normalize_series_name("Magic Tree House Merlin Missions"), "Magic Tree House: Merlin Missions");
        assert_eq!(normalize_series_name("Discworld - Death"), "Discworld");
        assert_eq!(normalize_series_name("Game of Thrones"), "A Song of Ice and Fire");
        
        // Unknown series should pass through unchanged
        assert_eq!(normalize_series_name("Some Unknown Series"), "Some Unknown Series");
    }
}