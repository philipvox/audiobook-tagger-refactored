use serde::{Serialize, Deserialize};
use anyhow::Result;
use std::collections::HashMap;

// =============================================================================
// TAXONOMY: Genres & Tags for Secret Library
// Based on /root/TAXONOMY.md on server
// =============================================================================

/// Primary GENRES for audiobook categorization (1-3 per book)
/// These are the main browsing categories
pub const APPROVED_GENRES: &[&str] = &[
    // Fiction Genres
    "Literary Fiction",
    "Contemporary Fiction",
    "Historical Fiction",
    "Classics",
    "Mystery",
    "Thriller",
    "Crime",
    "Horror",
    "Romance",
    "Fantasy",
    "Science Fiction",
    "Western",
    "Adventure",
    "Humor",
    "Satire",
    "Women's Fiction",
    "LGBTQ+ Fiction",
    "Short Stories",
    "Anthology",

    // Non-Fiction Genres
    "Biography",
    "Autobiography",
    "Memoir",
    "History",
    "True Crime",
    "Science",
    "Popular Science",
    "Psychology",
    "Self-Help",
    "Business",
    "Personal Finance",
    "Health & Wellness",
    "Philosophy",
    "Religion & Spirituality",
    "Politics",
    "Essays",
    "Journalism",
    "Travel",
    "Food & Cooking",
    "Nature",
    "Sports",
    "Music",
    "Art",
    "Education",
    "Parenting & Family",
    "Relationships",
    "Non-Fiction",

    // Audience Categories
    "Young Adult",
    "Middle Grade",
    "Children's",
    "New Adult",
    "Adult",

    // Children's Age-Specific (for detailed categorization)
    "Children's 0-2",
    "Children's 3-5",
    "Children's 6-8",
    "Children's 9-12",
    "Teen 13-17",

    // Format (Optional)
    "Audiobook Original",
    "Full Cast Production",
    "Dramatized",
    "Podcast Fiction",
];

/// TAGS - Descriptive metadata (5-15 per book, lowercase-hyphenated)
pub const APPROVED_TAGS: &[&str] = &[
    // Sub-Genre: Mystery & Thriller
    "cozy-mystery", "police-procedural", "legal-thriller", "medical-thriller",
    "techno-thriller", "spy", "domestic-thriller", "noir", "hardboiled",
    "amateur-sleuth", "locked-room", "whodunit", "heist", "cold-case", "forensic",

    // Sub-Genre: Romance
    "rom-com", "contemporary-romance", "historical-romance", "paranormal-romance",
    "fantasy-romance", "romantasy", "dark-romance", "clean-romance", "sports-romance",
    "military-romance", "royal-romance", "billionaire-romance", "small-town-romance",
    "holiday-romance", "workplace-romance",

    // Sub-Genre: Fantasy
    "epic-fantasy", "urban-fantasy", "dark-fantasy", "high-fantasy", "low-fantasy",
    "sword-and-sorcery", "portal-fantasy", "cozy-fantasy", "grimdark",
    "progression-fantasy", "cultivation", "litrpg", "gamelit", "mythic-fantasy",
    "gaslamp-fantasy", "fairy-tale-retelling",

    // Sub-Genre: Science Fiction
    "space-opera", "dystopian", "post-apocalyptic", "cyberpunk", "biopunk",
    "steampunk", "hard-sci-fi", "soft-sci-fi", "military-sci-fi", "time-travel",
    "first-contact", "alien-invasion", "climate-fiction", "alternate-history",
    "near-future",

    // Sub-Genre: Horror
    "gothic", "supernatural", "cosmic-horror", "psychological-horror", "folk-horror",
    "body-horror", "slasher", "haunted-house", "creature-feature", "occult",
    "southern-gothic",

    // Mood Tags
    "adventurous", "atmospheric", "bittersweet", "cathartic", "cozy", "dark",
    "emotional", "feel-good", "funny", "haunting", "heartbreaking", "heartwarming",
    "hopeful", "inspiring", "intense", "lighthearted", "melancholic", "mysterious",
    "nostalgic", "reflective", "romantic", "sad", "suspenseful", "tense",
    "thought-provoking", "unsettling", "uplifting", "whimsical",

    // Pacing Tags
    "fast-paced", "slow-burn", "medium-paced", "page-turner", "unputdownable",
    "leisurely", "action-packed",

    // Style Tags
    "character-driven", "plot-driven", "dialogue-heavy", "descriptive", "lyrical",
    "sparse-prose", "unreliable-narrator", "multiple-pov", "dual-timeline",
    "epistolary", "first-person", "third-person", "nonlinear",

    // Romance Tropes
    "enemies-to-lovers", "friends-to-lovers", "strangers-to-lovers", "second-chance",
    "forced-proximity", "fake-relationship", "marriage-of-convenience",
    "forbidden-love", "love-triangle", "grumpy-sunshine", "opposites-attract",
    "he-falls-first", "she-falls-first", "only-one-bed", "age-gap", "boss-employee",
    "single-parent", "secret-identity", "arranged-marriage", "mutual-pining",

    // General Story Tropes
    "found-family", "chosen-one", "reluctant-hero", "antihero", "morally-grey",
    "villain-origin", "redemption-arc", "revenge", "quest", "survival", "underdog",
    "fish-out-of-water", "hidden-identity", "mistaken-identity", "rags-to-riches",
    "mentor-figure", "prophecy", "coming-of-age", "self-discovery", "starting-over",

    // Creature/Being Tags
    "vampires", "werewolves", "shifters", "fae", "witches", "demons", "angels",
    "ghosts", "dragons", "mermaids", "gods", "monsters", "aliens", "zombies",
    "psychics", "magic-users", "immortals",

    // Setting Tags
    "small-town", "big-city", "rural", "coastal", "island", "cabin", "castle",
    "palace", "academy", "college", "high-school", "office", "hospital",
    "courtroom", "military-base", "space-station", "spaceship", "forest",
    "desert", "mountains", "arctic", "tropical",

    // Historical Period Tags
    "regency", "victorian", "medieval", "ancient", "renaissance", "tudor", "viking",
    "1920s", "1950s", "1960s", "1970s", "1980s", "wwi", "wwii", "civil-war",

    // Theme Tags
    "family", "friendship", "grief", "healing", "identity", "justice", "love",
    "loyalty", "power", "sacrifice", "survival", "trauma", "war", "class", "race",
    "gender", "disability", "mental-health", "addiction", "faith", "forgiveness",
    "hope", "loss", "marriage", "divorce", "aging", "death",

    // Content Level Tags
    "clean", "fade-to-black", "mild-steam", "steamy", "explicit",
    "low-violence", "moderate-violence", "graphic-violence",
    "clean-language", "mild-language", "strong-language",

    // Audiobook-Specific: Production
    "full-cast", "single-narrator", "dual-narrators", "author-narrated",
    "celebrity-narrator", "dramatized", "sound-effects",

    // Audiobook-Specific: Narrator Voice
    "male-narrator", "female-narrator", "multiple-narrators",
    "great-character-voices", "soothing-narrator",

    // Audiobook-Specific: Listening Experience
    "good-for-commute", "good-for-sleep", "good-for-roadtrip",
    "requires-focus", "easy-listening", "great-reread",

    // Audiobook-Specific: Length
    "under-5-hours", "5-10-hours", "10-15-hours", "15-20-hours", "over-20-hours",

    // Series Tags
    "standalone", "in-series", "duology", "trilogy", "long-series",

    // Age Rating Tags
    "age-childrens", "age-middle-grade", "age-teens", "age-young-adult", "age-adult",

    // Audience Intent Tags
    "for-kids", "for-teens", "for-ya", "not-for-kids",

    // Content Rating Tags (movie-style)
    "rated-g", "rated-pg", "rated-pg13", "rated-r", "rated-x",

    // Reading Age Recommendation Tags
    "age-rec-all", "age-rec-0", "age-rec-3", "age-rec-4", "age-rec-6", "age-rec-8", "age-rec-10",
    "age-rec-12", "age-rec-14", "age-rec-16", "age-rec-18",

    // Award/Recognition Tags
    "bestseller", "award-winner", "critically-acclaimed", "debut", "classic",
    "cult-favorite",
];

/// Genre aliases - maps alternative names to approved genres
fn get_genre_aliases() -> HashMap<&'static str, &'static str> {
    let mut map = HashMap::new();

    // Common fiction aliases
    map.insert("sci-fi", "Science Fiction");
    map.insert("scifi", "Science Fiction");
    map.insert("sf", "Science Fiction");
    map.insert("literary", "Literary Fiction");
    map.insert("general fiction", "Literary Fiction");
    map.insert("fiction", "Literary Fiction");

    // Non-fiction aliases
    map.insert("nonfiction", "Non-Fiction");
    map.insert("non fiction", "Non-Fiction");
    map.insert("bio", "Biography");
    map.insert("autobio", "Autobiography");
    map.insert("auto-biography", "Autobiography");
    map.insert("memoirs", "Memoir");
    map.insert("personal development", "Self-Help");
    map.insert("self improvement", "Self-Help");
    map.insert("self help", "Self-Help");

    // Age-specific mappings
    map.insert("ya", "Young Adult");
    map.insert("young-adult", "Young Adult");
    map.insert("ya fiction", "Young Adult");
    map.insert("teen fiction", "Young Adult");
    map.insert("teen", "Young Adult");
    map.insert("children", "Children's");
    map.insert("kids", "Children's");
    map.insert("juvenile", "Children's");
    map.insert("juvenile fiction", "Children's");
    map.insert("picture book", "Children's 3-5");
    map.insert("picture books", "Children's 3-5");
    map.insert("early reader", "Children's 6-8");
    map.insert("early readers", "Children's 6-8");
    map.insert("chapter book", "Children's 6-8");
    map.insert("chapter books", "Children's 6-8");
    map.insert("middle grade", "Middle Grade");
    map.insert("middle-grade", "Middle Grade");
    map.insert("mg", "Middle Grade");

    // Thriller subgenres
    map.insert("suspense", "Thriller");
    map.insert("suspense thriller", "Thriller");
    map.insert("action thriller", "Thriller");
    map.insert("psychological thriller", "Thriller");

    // Romance subgenres (map to Romance genre, tags handle subgenre)
    map.insert("romantic suspense", "Romance");
    map.insert("contemporary romance", "Romance");
    map.insert("historical romance", "Romance");
    map.insert("paranormal romance", "Romance");
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

    // Fantasy subgenres
    map.insert("epic fantasy", "Fantasy");
    map.insert("high fantasy", "Fantasy");
    map.insert("dark fantasy", "Fantasy");
    map.insert("urban fantasy", "Fantasy");
    map.insert("sword and sorcery", "Fantasy");
    map.insert("fairytale", "Fantasy");
    map.insert("fairy tale", "Fantasy");

    // Science Fiction subgenres
    map.insert("space opera", "Science Fiction");
    map.insert("hard sci-fi", "Science Fiction");
    map.insert("cyberpunk", "Science Fiction");
    map.insert("steampunk", "Science Fiction");
    map.insert("military sci-fi", "Science Fiction");
    map.insert("dystopian", "Science Fiction");
    map.insert("post-apocalyptic", "Science Fiction");

    // Other mappings
    map.insert("audiobook", ""); // Skip - not a genre
    map.insert("unabridged", ""); // Skip - not a genre
    map.insert("adult fiction", "Literary Fiction");
    map.insert("inspirational", "Religion & Spirituality");
    map.insert("faith", "Religion & Spirituality");
    map.insert("christian", "Religion & Spirituality");
    map.insert("christian fiction", "Religion & Spirituality");
    map.insert("spirituality", "Religion & Spirituality");
    map.insert("cooking & food", "Food & Cooking");
    map.insert("food & drink", "Food & Cooking");
    map.insert("cookbook", "Food & Cooking");
    map.insert("health & fitness", "Health & Wellness");
    map.insert("health & wellness", "Health & Wellness");
    map.insert("health", "Health & Wellness");
    map.insert("wellness", "Health & Wellness");
    map.insert("mind body spirit", "Religion & Spirituality");
    map.insert("new age", "Religion & Spirituality");
    map.insert("true story", "Non-Fiction");
    map.insert("based on true story", "Non-Fiction");

    map
}

/// Tag aliases - maps alternative tag names to approved tags
fn get_tag_aliases() -> HashMap<&'static str, &'static str> {
    let mut map = HashMap::new();

    // Common tag variations
    map.insert("enemies to lovers", "enemies-to-lovers");
    map.insert("friends to lovers", "friends-to-lovers");
    map.insert("slow burn", "slow-burn");
    map.insert("found family", "found-family");
    map.insert("coming of age", "coming-of-age");
    map.insert("small town", "small-town");
    map.insert("page turner", "page-turner");
    map.insert("fast paced", "fast-paced");
    map.insert("character driven", "character-driven");
    map.insert("plot driven", "plot-driven");
    map.insert("thought provoking", "thought-provoking");
    map.insert("feel good", "feel-good");
    map.insert("heart warming", "heartwarming");
    map.insert("heart breaking", "heartbreaking");

    // Length variations
    map.insert("short", "under-5-hours");
    map.insert("medium", "10-15-hours");
    map.insert("long", "over-20-hours");

    map
}

/// Map a genre string to an approved genre
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
        if mapped.is_empty() {
            return None; // Explicitly skip this genre
        }
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

/// Map a tag string to an approved tag
pub fn map_tag(tag: &str) -> Option<String> {
    let normalized = tag.trim().to_lowercase().replace(' ', "-");

    // Check exact match
    for approved in APPROVED_TAGS {
        if *approved == normalized {
            return Some(approved.to_string());
        }
    }

    // Try aliases
    let aliases = get_tag_aliases();
    if let Some(&mapped) = aliases.get(tag.trim().to_lowercase().as_str()) {
        return Some(mapped.to_string());
    }

    // Partial match
    for approved in APPROVED_TAGS {
        if normalized.contains(approved) || approved.contains(&normalized.as_str()) {
            return Some(approved.to_string());
        }
    }

    None
}

/// Enforce genre policy: max 3 genres, prioritized, no duplicates
pub fn enforce_genre_policy_basic(genres: &[String]) -> Vec<String> {
    let mut mapped: Vec<String> = genres
        .iter()
        .filter_map(|g| map_genre_basic(g))
        .collect();

    // Remove duplicates while preserving order
    let mut seen = std::collections::HashSet::new();
    mapped.retain(|g| seen.insert(g.clone()));

    // Priority sorting: specific genres first, broad categories last
    let broad_genres = ["Non-Fiction", "Adult", "Literary Fiction"];
    let age_genres = ["Children's", "Young Adult", "Teen", "Middle Grade", "New Adult",
                      "Children's 0-2", "Children's 3-5", "Children's 6-8",
                      "Children's 9-12", "Teen 13-17"];

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

    // If empty, don't force a default - let caller decide
    mapped
}

/// Enforce tag policy: max 15 tags, normalized, no duplicates
pub fn enforce_tag_policy(tags: &[String]) -> Vec<String> {
    let mut mapped: Vec<String> = tags
        .iter()
        .filter_map(|t| map_tag(t))
        .collect();

    // Remove duplicates while preserving order
    let mut seen = std::collections::HashSet::new();
    mapped.retain(|t| seen.insert(t.clone()));

    // Take top 15
    mapped.truncate(15);

    mapped
}

// =============================================================================
// DNA Tag Passthrough
// =============================================================================

/// Check if a tag is a DNA tag (dna: prefix)
/// DNA tags bypass normal validation and have no limit
pub fn is_dna_tag(tag: &str) -> bool {
    tag.starts_with("dna:")
}

/// Enforce tag policy with DNA tag support
/// - Standard tags: validated, normalized, limited to 15
/// - DNA tags: pass through unchanged, no limit
pub fn enforce_tag_policy_with_dna(tags: &[String]) -> Vec<String> {
    // Partition into standard and DNA tags
    let (standard, dna): (Vec<_>, Vec<_>) = tags.iter()
        .cloned()
        .partition(|t| !is_dna_tag(t));

    // Apply standard policy to regular tags (15-tag limit)
    let mut result = enforce_tag_policy(&standard);

    // Add DNA tags without validation or limit
    result.extend(dna);

    result
}

/// Split combined genre strings into individual genres
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
pub fn enforce_genre_policy_with_split(genres: &[String]) -> Vec<String> {
    let split_genres = split_combined_genres(genres);
    enforce_genre_policy_basic(&split_genres)
}

// =============================================================================
// Length Tag Detection
// =============================================================================

/// Get length tag based on duration in minutes
pub fn get_length_tag(duration_minutes: u32) -> &'static str {
    match duration_minutes {
        0..=299 => "under-5-hours",      // < 5 hours
        300..=599 => "5-10-hours",        // 5-10 hours
        600..=899 => "10-15-hours",       // 10-15 hours
        900..=1199 => "15-20-hours",      // 15-20 hours
        _ => "over-20-hours",             // 20+ hours
    }
}

/// Get length tag from duration in seconds
pub fn get_length_tag_from_seconds(duration_seconds: f64) -> &'static str {
    get_length_tag((duration_seconds / 60.0) as u32)
}

// =============================================================================
// AGE RATING AND CONTENT RATING DETERMINATION
// =============================================================================

/// Age rating categories
pub const AGE_RATINGS: &[&str] = &["Childrens", "Teens", "Young Adult", "Adult"];

/// Content rating categories (similar to movie ratings)
pub const CONTENT_RATINGS: &[&str] = &["G", "PG", "PG-13", "R", "X"];

/// Determine age rating based on genres and other metadata
/// Returns: "Childrens", "Teens", "Young Adult", or "Adult"
pub fn determine_age_rating(
    genres: &[String],
    title: Option<&str>,
    series: Option<&str>,
    description: Option<&str>,
) -> Option<String> {
    let genres_lower: Vec<String> = genres.iter().map(|g| g.to_lowercase()).collect();

    // Check for children's age-specific genres first
    for genre in &genres_lower {
        // Children's 0-2, 3-5, 6-8, 9-12 all map to "Childrens"
        if genre.starts_with("children's") || genre.starts_with("childrens") {
            return Some("Childrens".to_string());
        }
        // Teen 13-17 maps to "Teens"
        if genre.contains("teen 13-17") || genre == "teen" {
            return Some("Teens".to_string());
        }
        // Young Adult
        if genre.contains("young adult") || genre == "ya" {
            return Some("Young Adult".to_string());
        }
    }

    // Check for keywords in genres
    for genre in &genres_lower {
        if genre.contains("picture book") || genre.contains("bedtime") ||
           genre.contains("nursery") || genre.contains("board book") {
            return Some("Childrens".to_string());
        }
        if genre.contains("middle grade") {
            return Some("Childrens".to_string());
        }
        if genre.contains("new adult") {
            return Some("Young Adult".to_string());
        }
    }

    // Check title and series for children's indicators
    if let Some(t) = title {
        let t_lower = t.to_lowercase();
        if t_lower.contains("for kids") || t_lower.contains("children's") {
            return Some("Childrens".to_string());
        }
    }

    // Check description for age indicators
    if let Some(desc) = description {
        let desc_lower = desc.to_lowercase();
        if desc_lower.contains("picture book") || desc_lower.contains("ages 3-5") ||
           desc_lower.contains("ages 4-8") || desc_lower.contains("for children") ||
           desc_lower.contains("bedtime stor") {
            return Some("Childrens".to_string());
        }
        if desc_lower.contains("young readers") || desc_lower.contains("ages 8-12") ||
           desc_lower.contains("middle grade") {
            return Some("Childrens".to_string());
        }
        if desc_lower.contains("young adult") || desc_lower.contains("ya novel") ||
           desc_lower.contains("teen readers") {
            return Some("Teens".to_string());
        }
    }

    // Check for adult content indicators in genres
    for genre in &genres_lower {
        if genre.contains("erotica") || genre.contains("erotic") {
            return Some("Adult".to_string());
        }
        if genre.contains("romance") || genre.contains("thriller") ||
           genre.contains("horror") || genre.contains("crime") ||
           genre.contains("mystery") || genre.contains("suspense") {
            // These are typically adult genres
            return Some("Adult".to_string());
        }
    }

    // Default to None if we can't determine
    None
}

/// Determine content rating based on genres, tags, explicit flag, and description
/// Returns: "G", "PG", "PG-13", "R", or "X"
pub fn determine_content_rating(
    genres: &[String],
    tags: &[String],
    explicit: Option<bool>,
    description: Option<&str>,
    age_rating: Option<&str>,
) -> Option<String> {
    // If explicitly marked, that takes precedence
    if explicit == Some(true) {
        return Some("R".to_string());
    }

    let genres_lower: Vec<String> = genres.iter().map(|g| g.to_lowercase()).collect();
    let tags_lower: Vec<String> = tags.iter().map(|t| t.to_lowercase().replace(' ', "-")).collect();

    // Check for X-rated content (erotica)
    for genre in &genres_lower {
        if genre.contains("erotica") || genre.contains("erotic romance") {
            return Some("X".to_string());
        }
    }
    for tag in &tags_lower {
        if tag == "explicit" || tag == "erotica" || tag.contains("adult-content") {
            return Some("X".to_string());
        }
    }

    // Check for R-rated content
    for tag in &tags_lower {
        if tag == "steamy" || tag == "spicy" || tag.contains("graphic-violence") ||
           tag.contains("dark-themes") || tag == "gore" {
            return Some("R".to_string());
        }
    }
    for genre in &genres_lower {
        if genre.contains("dark romance") || genre.contains("horror") {
            return Some("R".to_string());
        }
    }

    // Check description for mature content
    if let Some(desc) = description {
        let desc_lower = desc.to_lowercase();
        if desc_lower.contains("explicit") || desc_lower.contains("steamy") ||
           desc_lower.contains("graphic violence") || desc_lower.contains("adult content") {
            return Some("R".to_string());
        }
        if desc_lower.contains("mature themes") || desc_lower.contains("not for children") {
            return Some("PG-13".to_string());
        }
    }

    // Check for PG-13 content
    for tag in &tags_lower {
        if tag == "mild-steam" || tag.contains("some-violence") ||
           tag == "intense" || tag == "suspenseful" {
            return Some("PG-13".to_string());
        }
    }
    for genre in &genres_lower {
        if genre.contains("thriller") || genre.contains("suspense") ||
           genre.contains("crime") || genre.contains("mystery") {
            return Some("PG-13".to_string());
        }
    }

    // Check for PG content
    for tag in &tags_lower {
        if tag == "clean" || tag == "fade-to-black" || tag == "low-violence" ||
           tag == "family-friendly" {
            return Some("PG".to_string());
        }
    }

    // Based on age rating
    if let Some(age) = age_rating {
        match age {
            "Childrens" => return Some("G".to_string()),
            "Teens" => return Some("PG".to_string()),
            "Young Adult" => return Some("PG-13".to_string()),
            "Adult" => return Some("PG-13".to_string()), // Default for adult, not necessarily R
            _ => {}
        }
    }

    // Check for G-rated (children's content)
    for genre in &genres_lower {
        if genre.starts_with("children") || genre.contains("picture book") ||
           genre.contains("bedtime") {
            return Some("G".to_string());
        }
    }

    // Default: if we have children's genres, G; otherwise None
    None
}

/// Get both age_rating and content_rating, also returning them as tags
pub fn determine_ratings_with_tags(
    genres: &[String],
    tags: &[String],
    explicit: Option<bool>,
    title: Option<&str>,
    series: Option<&str>,
    description: Option<&str>,
) -> (Option<String>, Option<String>, Vec<String>) {
    let age_rating = determine_age_rating(genres, title, series, description);
    let content_rating = determine_content_rating(
        genres,
        tags,
        explicit,
        description,
        age_rating.as_deref(),
    );

    // Build rating tags
    let mut rating_tags = Vec::new();

    if let Some(ref age) = age_rating {
        // Add age rating as a tag (lowercase, hyphenated)
        let age_tag = match age.as_str() {
            "Childrens" => "age-childrens",
            "Teens" => "age-teens",
            "Young Adult" => "age-young-adult",
            "Adult" => "age-adult",
            _ => "",
        };
        if !age_tag.is_empty() {
            rating_tags.push(age_tag.to_string());
        }
    }

    if let Some(ref rating) = content_rating {
        // Add content rating as a tag
        let rating_tag = match rating.as_str() {
            "G" => "rated-g",
            "PG" => "rated-pg",
            "PG-13" => "rated-pg13",
            "R" => "rated-r",
            "X" => "rated-x",
            _ => "",
        };
        if !rating_tag.is_empty() {
            rating_tags.push(rating_tag.to_string());
        }
    }

    (age_rating, content_rating, rating_tags)
}

// =============================================================================
// Structs for metadata processing (kept for compatibility)
// =============================================================================

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

// =============================================================================
// Validation helpers
// =============================================================================

/// Check if a genre is in the approved list
pub fn is_approved_genre(genre: &str) -> bool {
    let normalized = genre.trim().to_lowercase();
    APPROVED_GENRES.iter().any(|g| g.to_lowercase() == normalized)
}

/// Check if a tag is in the approved list
pub fn is_approved_tag(tag: &str) -> bool {
    let normalized = tag.trim().to_lowercase().replace(' ', "-");
    APPROVED_TAGS.iter().any(|t| *t == normalized)
}

/// Get all approved genres as a Vec
pub fn get_all_genres() -> Vec<String> {
    APPROVED_GENRES.iter().map(|s| s.to_string()).collect()
}

/// Get all approved tags as a Vec
pub fn get_all_tags() -> Vec<String> {
    APPROVED_TAGS.iter().map(|s| s.to_string()).collect()
}

/// Required age rating tags (must have ONE of these)
const AGE_RATING_TAGS: &[&str] = &["age-childrens", "age-middle-grade", "age-teens", "age-young-adult", "age-adult"];

/// Required content rating tags (must have ONE of these)
const CONTENT_RATING_TAGS: &[&str] = &["rated-g", "rated-pg", "rated-pg13", "rated-r", "rated-x"];

/// Required reading age recommendation tags (must have ONE of these)
const READING_AGE_TAGS: &[&str] = &[
    "age-rec-all", "age-rec-4", "age-rec-6", "age-rec-8", "age-rec-10",
    "age-rec-12", "age-rec-14", "age-rec-16", "age-rec-18"
];

/// Check if tags are "complete" - have all required rating tags
/// Returns true if tags include at least one of each:
/// - Age rating (age-childrens, age-teens, age-young-adult, age-adult)
/// - Content rating (rated-g, rated-pg, rated-pg13, rated-r, rated-x)
/// - Reading age recommendation (age-rec-all, age-rec-4, etc.)
pub fn are_tags_complete(tags: &[String]) -> bool {
    let has_age_rating = tags.iter().any(|t| AGE_RATING_TAGS.contains(&t.as_str()));
    let has_content_rating = tags.iter().any(|t| CONTENT_RATING_TAGS.contains(&t.as_str()));
    let has_reading_age = tags.iter().any(|t| READING_AGE_TAGS.contains(&t.as_str()));

    has_age_rating && has_content_rating && has_reading_age
}

/// Get a summary of which required tags are missing
pub fn get_missing_tag_categories(tags: &[String]) -> Vec<&'static str> {
    let mut missing = Vec::new();

    if !tags.iter().any(|t| AGE_RATING_TAGS.contains(&t.as_str())) {
        missing.push("age rating");
    }
    if !tags.iter().any(|t| CONTENT_RATING_TAGS.contains(&t.as_str())) {
        missing.push("content rating");
    }
    if !tags.iter().any(|t| READING_AGE_TAGS.contains(&t.as_str())) {
        missing.push("reading age");
    }

    missing
}
