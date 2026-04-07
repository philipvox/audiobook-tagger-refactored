// Genre and tag taxonomy for Secret Library audiobook categorization
// Ported from src-tauri/src/genres.rs

// =============================================================================
// TAXONOMY: Genres & Tags for Secret Library
// Based on /root/TAXONOMY.md on server
// =============================================================================

/**
 * Primary GENRES for audiobook categorization (1-3 per book).
 * These are the main browsing categories.
 * @type {string[]}
 */
export const APPROVED_GENRES = [
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

/**
 * TAGS - Descriptive metadata (5-15 per book, lowercase-hyphenated).
 * @type {string[]}
 */
export const APPROVED_TAGS = [
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

/**
 * Genre aliases - maps alternative names to approved genres.
 * Keys are lowercase. A value of "" means the genre should be skipped entirely.
 * @type {Map<string, string>}
 */
export const GENRE_ALIASES = new Map([
  // Common fiction aliases
  ["sci-fi", "Science Fiction"],
  ["scifi", "Science Fiction"],
  ["sf", "Science Fiction"],
  ["literary", "Literary Fiction"],
  ["general fiction", "Literary Fiction"],
  ["fiction", "Literary Fiction"],

  // Non-fiction aliases
  ["nonfiction", "Non-Fiction"],
  ["non fiction", "Non-Fiction"],
  ["bio", "Biography"],
  ["autobio", "Autobiography"],
  ["auto-biography", "Autobiography"],
  ["memoirs", "Memoir"],
  ["personal development", "Self-Help"],
  ["self improvement", "Self-Help"],
  ["self help", "Self-Help"],

  // Age-specific mappings
  ["ya", "Young Adult"],
  ["young-adult", "Young Adult"],
  ["ya fiction", "Young Adult"],
  ["teen fiction", "Young Adult"],
  ["teen", "Young Adult"],
  ["children", "Children's"],
  ["kids", "Children's"],
  ["juvenile", "Children's"],
  ["juvenile fiction", "Children's"],
  ["picture book", "Children's 3-5"],
  ["picture books", "Children's 3-5"],
  ["early reader", "Children's 6-8"],
  ["early readers", "Children's 6-8"],
  ["chapter book", "Children's 6-8"],
  ["chapter books", "Children's 6-8"],
  ["middle grade", "Middle Grade"],
  ["middle-grade", "Middle Grade"],
  ["mg", "Middle Grade"],

  // Thriller subgenres
  ["suspense", "Thriller"],
  ["suspense thriller", "Thriller"],
  ["action thriller", "Thriller"],
  ["psychological thriller", "Thriller"],

  // Romance subgenres (map to Romance genre, tags handle subgenre)
  ["romantic suspense", "Romance"],
  ["contemporary romance", "Romance"],
  ["historical romance", "Romance"],
  ["paranormal romance", "Romance"],
  ["romantic comedy", "Romance"],

  // Mystery subgenres
  ["cozy mystery", "Mystery"],
  ["detective", "Mystery"],
  ["police procedural", "Mystery"],
  ["whodunit", "Mystery"],
  ["noir", "Mystery"],

  // Horror subgenres
  ["supernatural horror", "Horror"],
  ["psychological horror", "Horror"],
  ["dark fiction", "Horror"],
  ["ghost story", "Horror"],

  // Fantasy subgenres
  ["epic fantasy", "Fantasy"],
  ["high fantasy", "Fantasy"],
  ["dark fantasy", "Fantasy"],
  ["urban fantasy", "Fantasy"],
  ["sword and sorcery", "Fantasy"],
  ["fairytale", "Fantasy"],
  ["fairy tale", "Fantasy"],

  // Science Fiction subgenres
  ["space opera", "Science Fiction"],
  ["hard sci-fi", "Science Fiction"],
  ["cyberpunk", "Science Fiction"],
  ["steampunk", "Science Fiction"],
  ["military sci-fi", "Science Fiction"],
  ["dystopian", "Science Fiction"],
  ["post-apocalyptic", "Science Fiction"],

  // Other mappings
  ["audiobook", ""],           // Skip - not a genre
  ["unabridged", ""],          // Skip - not a genre
  ["adult fiction", "Literary Fiction"],
  ["inspirational", "Religion & Spirituality"],
  ["faith", "Religion & Spirituality"],
  ["christian", "Religion & Spirituality"],
  ["christian fiction", "Religion & Spirituality"],
  ["spirituality", "Religion & Spirituality"],
  ["cooking & food", "Food & Cooking"],
  ["food & drink", "Food & Cooking"],
  ["cookbook", "Food & Cooking"],
  ["health & fitness", "Health & Wellness"],
  ["health & wellness", "Health & Wellness"],
  ["health", "Health & Wellness"],
  ["wellness", "Health & Wellness"],
  ["mind body spirit", "Religion & Spirituality"],
  ["new age", "Religion & Spirituality"],
  ["true story", "Non-Fiction"],
  ["based on true story", "Non-Fiction"],
]);

/**
 * Tag aliases - maps alternative tag names to approved tags.
 * Keys are lowercase (spaces, not hyphens).
 * @type {Map<string, string>}
 */
export const TAG_ALIASES = new Map([
  // Common tag variations
  ["enemies to lovers", "enemies-to-lovers"],
  ["friends to lovers", "friends-to-lovers"],
  ["slow burn", "slow-burn"],
  ["found family", "found-family"],
  ["coming of age", "coming-of-age"],
  ["small town", "small-town"],
  ["page turner", "page-turner"],
  ["fast paced", "fast-paced"],
  ["character driven", "character-driven"],
  ["plot driven", "plot-driven"],
  ["thought provoking", "thought-provoking"],
  ["feel good", "feel-good"],
  ["heart warming", "heartwarming"],
  ["heart breaking", "heartbreaking"],

  // Length variations
  ["short", "under-5-hours"],
  ["medium", "10-15-hours"],
  ["long", "over-20-hours"],
]);

// Pre-built sets for fast lookups
const _approvedGenresLower = new Map(
  APPROVED_GENRES.map((g) => [g.toLowerCase(), g])
);
const _approvedTagsSet = new Set(APPROVED_TAGS);

// =============================================================================
// Public API
// =============================================================================

/**
 * Normalize a tag string: lowercase, trim, replace spaces with hyphens.
 *
 * @param {string} tag
 * @returns {string}
 */
export function normalizeTag(tag) {
  return tag.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Map a genre string to an approved genre.
 *
 * Tries (in order): exact match, alias lookup, partial/substring match.
 * Returns null if no match is found or the genre should be skipped.
 *
 * @param {string} genre
 * @returns {string | null}
 */
export function mapGenre(genre) {
  const normalized = genre.trim().toLowerCase();

  // Skip empty or obviously bad values
  if (!normalized || normalized === "audiobook" || normalized === "audio book" || normalized === "unabridged") {
    return null;
  }

  // Exact match (case-insensitive)
  const exactMatch = _approvedGenresLower.get(normalized);
  if (exactMatch) return exactMatch;

  // Try aliases
  const aliased = GENRE_ALIASES.get(normalized);
  if (aliased !== undefined) {
    return aliased === "" ? null : aliased;
  }

  // Partial match - if the genre contains an approved genre or vice versa
  for (const [approvedLower, approved] of _approvedGenresLower) {
    if (normalized.includes(approvedLower) || approvedLower.includes(normalized)) {
      return approved;
    }
  }

  return null;
}

/**
 * Map a tag string to an approved tag.
 *
 * Normalizes to lowercase-hyphenated form, then tries exact match,
 * alias lookup, and partial/substring match.
 *
 * @param {string} tag
 * @returns {string | null}
 */
export function mapTag(tag) {
  const normalized = tag.trim().toLowerCase().replace(/ /g, "-");

  // Exact match
  if (_approvedTagsSet.has(normalized)) {
    return normalized;
  }

  // Try aliases (aliases use space-separated keys)
  const aliased = TAG_ALIASES.get(tag.trim().toLowerCase());
  if (aliased) return aliased;

  // Partial match
  for (const approved of APPROVED_TAGS) {
    if (normalized.includes(approved) || approved.includes(normalized)) {
      return approved;
    }
  }

  return null;
}

/**
 * Enforce genre policy: map, deduplicate, sort (specific first, broad last), max 3.
 *
 * @param {string[]} genres
 * @returns {string[]}
 */
export function enforceGenrePolicy(genres) {
  // Map and filter
  const mapped = genres
    .map((g) => mapGenre(g))
    .filter((g) => g !== null);

  // Deduplicate preserving order
  const seen = new Set();
  const unique = [];
  for (const g of mapped) {
    if (!seen.has(g)) {
      seen.add(g);
      unique.push(g);
    }
  }

  // Priority sorting: specific genres first, broad categories last
  const broadGenres = new Set(["Non-Fiction", "Adult", "Literary Fiction"]);
  const ageGenres = new Set([
    "Children's", "Young Adult", "Teen", "Middle Grade", "New Adult",
    "Children's 0-2", "Children's 3-5", "Children's 6-8",
    "Children's 9-12", "Teen 13-17",
  ]);

  unique.sort((a, b) => {
    const aIsBroad = broadGenres.has(a);
    const bIsBroad = broadGenres.has(b);
    const aIsAge = ageGenres.has(a);
    const bIsAge = ageGenres.has(b);

    // Broad genres go last
    if (aIsBroad && !bIsBroad) return 1;
    if (bIsBroad && !aIsBroad) return -1;

    // Age genres go second-to-last
    if (aIsAge && !bIsAge && !bIsBroad) return 1;
    if (bIsAge && !aIsAge && !aIsBroad) return -1;

    return 0;
  });

  // Take top 3
  return unique.slice(0, 3);
}

/**
 * Enforce tag policy: map, deduplicate, max 15.
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
export function enforceTagPolicy(tags) {
  const mapped = tags
    .map((t) => mapTag(t))
    .filter((t) => t !== null);

  // Deduplicate preserving order
  const seen = new Set();
  const unique = [];
  for (const t of mapped) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }

  return unique.slice(0, 15);
}

/**
 * Check if a tag is a DNA tag (dna: prefix).
 * DNA tags bypass normal validation and have no limit.
 *
 * @param {string} tag
 * @returns {boolean}
 */
export function isDnaTag(tag) {
  return tag.startsWith("dna:");
}

/**
 * Enforce tag policy with DNA tag support.
 * - Standard tags: validated, normalized, limited to 15
 * - DNA tags: pass through unchanged, no limit
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
export function enforceTagPolicyWithDna(tags) {
  const standard = [];
  const dna = [];

  for (const t of tags) {
    if (isDnaTag(t)) {
      dna.push(t);
    } else {
      standard.push(t);
    }
  }

  const result = enforceTagPolicy(standard);
  result.push(...dna);
  return result;
}

/**
 * Split combined genre strings into individual genres.
 * Handles " / ", ", ", and " & " separators.
 *
 * @param {string[]} genres
 * @returns {string[]}
 */
export function splitCombinedGenres(genres) {
  const result = [];

  for (const genre of genres) {
    const trimmed = genre.trim();

    if (trimmed.includes(" / ")) {
      // Google Books hierarchical format: "Fiction / Thrillers / Suspense"
      for (const part of trimmed.split(" / ")) {
        const cleaned = part.trim();
        if (cleaned) result.push(cleaned);
      }
    } else if (trimmed.includes(", ")) {
      // Comma-separated: "Suspense, Crime Thrillers"
      for (const part of trimmed.split(", ")) {
        const cleaned = part.trim();
        if (cleaned) result.push(cleaned);
      }
    } else if (trimmed.includes(" & ")) {
      // Ampersand-separated: "Mystery & Thriller"
      for (const part of trimmed.split(" & ")) {
        const cleaned = part.trim();
        if (cleaned) result.push(cleaned);
      }
    } else if (trimmed) {
      result.push(trimmed);
    }
  }

  // Deduplicate (case-insensitive) preserving order
  const seen = new Set();
  return result.filter((g) => {
    const key = g.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Enforce genre policy with automatic splitting of combined genres.
 *
 * @param {string[]} genres
 * @returns {string[]}
 */
export function enforceGenrePolicyWithSplit(genres) {
  const split = splitCombinedGenres(genres);
  return enforceGenrePolicy(split);
}

/**
 * Get length tag based on duration in minutes.
 *
 * @param {number} durationMinutes
 * @returns {string}
 */
export function getLengthTag(durationMinutes) {
  if (durationMinutes < 300) return "under-5-hours";
  if (durationMinutes < 600) return "5-10-hours";
  if (durationMinutes < 900) return "10-15-hours";
  if (durationMinutes < 1200) return "15-20-hours";
  return "over-20-hours";
}

/**
 * Get length tag from duration in seconds.
 *
 * @param {number} durationSeconds
 * @returns {string}
 */
export function getLengthTagFromSeconds(durationSeconds) {
  return getLengthTag(Math.floor(durationSeconds / 60));
}

/**
 * Check if a genre is in the approved list.
 *
 * @param {string} genre
 * @returns {boolean}
 */
export function isApprovedGenre(genre) {
  return _approvedGenresLower.has(genre.trim().toLowerCase());
}

/**
 * Check if a tag is in the approved list.
 *
 * @param {string} tag
 * @returns {boolean}
 */
export function isApprovedTag(tag) {
  const normalized = tag.trim().toLowerCase().replace(/ /g, "-");
  return _approvedTagsSet.has(normalized);
}

/**
 * Check if tags are "complete" - have all required rating tags.
 *
 * @param {string[]} tags
 * @returns {boolean}
 */
export function areTagsComplete(tags) {
  const ageRatingTags = ["age-childrens", "age-middle-grade", "age-teens", "age-young-adult", "age-adult"];
  const contentRatingTags = ["rated-g", "rated-pg", "rated-pg13", "rated-r", "rated-x"];
  const readingAgeTags = [
    "age-rec-all", "age-rec-4", "age-rec-6", "age-rec-8", "age-rec-10",
    "age-rec-12", "age-rec-14", "age-rec-16", "age-rec-18",
  ];

  const hasAge = tags.some((t) => ageRatingTags.includes(t));
  const hasContent = tags.some((t) => contentRatingTags.includes(t));
  const hasReadingAge = tags.some((t) => readingAgeTags.includes(t));

  return hasAge && hasContent && hasReadingAge;
}

/**
 * Get a summary of which required tag categories are missing.
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
export function getMissingTagCategories(tags) {
  const ageRatingTags = ["age-childrens", "age-middle-grade", "age-teens", "age-young-adult", "age-adult"];
  const contentRatingTags = ["rated-g", "rated-pg", "rated-pg13", "rated-r", "rated-x"];
  const readingAgeTags = [
    "age-rec-all", "age-rec-4", "age-rec-6", "age-rec-8", "age-rec-10",
    "age-rec-12", "age-rec-14", "age-rec-16", "age-rec-18",
  ];

  const missing = [];
  if (!tags.some((t) => ageRatingTags.includes(t))) missing.push("age rating");
  if (!tags.some((t) => contentRatingTags.includes(t))) missing.push("content rating");
  if (!tags.some((t) => readingAgeTags.includes(t))) missing.push("reading age");
  return missing;
}
