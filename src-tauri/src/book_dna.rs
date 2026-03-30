// src-tauri/src/book_dna.rs
// BookDNA v3 - Structured book fingerprints for intelligent recommendations
// v3 adds: ending type, emotional arc, humor type, stakes, prose style,
//          protagonist count, series dependency, relationship focus,
//          content spectrums, audio friendliness, narrator performance,
//          re-listen value, expanded spectrums/moods/comp-vibes

use serde::{Deserialize, Serialize};

// =============================================================================
// Validation Constants — Fixed lists for constrained categories
// =============================================================================

pub const VALID_SHELVES: &[&str] = &[
    // Fantasy
    "cozy-fantasy", "epic-fantasy", "dark-fantasy", "urban-fantasy", "portal-fantasy",
    "fairy-tale-retelling", "mythic-fantasy", "sword-and-sorcery", "grimdark-fantasy", "romantic-fantasy",
    // Science Fiction
    "hard-sci-fi", "space-opera", "cyberpunk", "dystopian", "post-apocalyptic",
    "first-contact", "time-travel", "cli-fi", "military-sci-fi", "biopunk",
    // Mystery/Thriller
    "cozy-mystery", "detective-noir", "police-procedural", "psychological-thriller", "legal-thriller",
    "medical-thriller", "spy-thriller", "cat-and-mouse-thriller", "domestic-suspense", "locked-room-mystery",
    // Horror
    "gothic-horror", "cosmic-horror", "supernatural-horror", "folk-horror", "psychological-horror", "slasher",
    // Romance
    "contemporary-romance", "historical-romance", "paranormal-romance", "romantic-comedy",
    "dark-romance", "romantasy", "small-town-romance", "second-chance-romance",
    // Literary/General
    "literary-fiction", "book-club-fiction", "family-saga", "coming-of-age", "campus-novel",
    "satire", "southern-gothic", "magical-realism", "upmarket-fiction", "experimental-fiction",
    // Historical
    "historical-fiction", "alternate-history", "historical-mystery", "wartime-fiction", "regency", "medieval",
    // Nonfiction
    "memoir", "true-crime", "popular-science", "history-narrative", "self-help",
    "biography", "essay-collection", "investigative-journalism", "travel-narrative", "nature-writing",
    // Other
    "middle-grade-adventure", "ya-dystopian", "ya-fantasy", "ya-contemporary",
    "superhero-fiction", "litrpg", "progression-fantasy", "western", "afrofuturism", "solarpunk", "new-weird",
];

pub const VALID_THEMES: &[&str] = &[
    "identity", "belonging", "power", "corruption", "redemption", "sacrifice", "love", "loss",
    "grief", "hope", "survival", "freedom", "justice", "revenge", "forgiveness", "family",
    "friendship", "loyalty", "betrayal", "truth", "deception", "memory", "mortality", "faith",
    "doubt", "ambition", "obsession", "isolation", "connection", "duty", "honor", "class",
    "prejudice", "resilience", "transformation", "innocence", "coming-of-age", "war", "trauma",
    "healing", "nature-vs-nurture", "technology-vs-humanity", "colonialism", "rebellion", "legacy",
    "fate-vs-free-will", "good-vs-evil", "self-discovery", "addiction", "motherhood",
];

pub const VALID_TROPES: &[&str] = &[
    "chosen-one", "found-family", "enemies-to-lovers", "slow-burn", "love-triangle",
    "unreliable-narrator", "heist", "locked-room", "fish-out-of-water", "dark-lord",
    "hidden-heir", "mentor-figure", "reluctant-hero", "antihero", "training-arc",
    "tournament", "quest", "prophecy", "time-loop", "secret-society", "body-swap",
    "amnesia", "fake-relationship", "forced-proximity", "grumpy-sunshine", "only-one-bed",
    "dual-timeline", "revenge-plot", "rags-to-riches", "fall-from-grace",
    "morally-grey-protagonist", "forbidden-love", "star-crossed-lovers", "road-trip",
    "survival-situation", "haunted-house", "final-girl", "whodunit", "red-herring",
    "cold-case", "undercover", "prison-escape", "last-stand", "first-contact",
    "culture-clash", "portal", "dystopian-resistance", "ai-uprising", "generation-ship", "monster-hunt",
];

pub const VALID_RELATIONSHIP_FOCUS: &[&str] = &[
    "friendship", "romance", "mentor-student", "rivals", "family", "human-nonhuman", "none",
];

pub const VALID_NARRATOR_PERFORMANCE: &[&str] = &[
    "theatrical", "character-voices", "understated", "conversational", "documentary",
];

pub const REQUIRED_SPECTRUMS: &[&str] = &[
    "dark-light", "serious-funny", "plot-character", "simple-complex",
    "action-contemplative", "intimate-epic-scope", "world-density",
];

// =============================================================================
// BookDNA Schema — Enums
// =============================================================================

/// Length classification
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Length {
    Short,   // < 5 hours
    Medium,  // 5-12 hours
    Long,    // 12-20 hours
    Epic,    // 20+ hours
}

/// Pacing classification
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pacing {
    Slow,
    Measured,
    Moderate,
    Fast,
    Breakneck,
}

/// Narrative structure
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Structure {
    Linear,
    Nonlinear,
    MultipleTimeline,
    FrameStory,
    Epistolary,
    ReverseChronological,
}

/// Point of view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PointOfView {
    FirstPerson,
    CloseThird,
    OmniscientThird,
    MultiplePov,
    Second,
}

/// Series position
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SeriesPosition {
    Standalone,
    SeriesStart,
    MidSeries,
    SeriesEnd,
}

/// Publication era
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PubEra {
    Classic,      // pre-1950
    MidCentury,   // 1950-1980
    Modern,       // 1980-2010
    Contemporary, // 2010+
}

/// Production type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Production {
    SingleVoice,
    DualNarrator,
    FullCast,
    Dramatized,
}

/// Setting type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Setting {
    Urban,
    Suburban,
    Rural,
    Wilderness,
    SpaceStation,
    Spaceship,
    FantasyWorld,
    Historical,
    PostApocalyptic,
    Underwater,
    Underground,
    School,
    Military,
    SmallTown,
    MultipleSettings,
    SecondaryWorld,
    CityState,
    Arctic,
    Desert,
    Tropical,
}

// --- v3 new enums ---

/// Ending type — how the story resolves emotionally
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EndingType {
    Hea,         // happily ever after
    Hfn,         // happy for now
    Bittersweet,
    Ambiguous,
    Open,
    Tragic,
    Cathartic,
}

/// Emotional energy level (low/medium/high)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmotionalEnergy {
    Low,
    Medium,
    High,
}

/// Humor type — what kind of funny
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HumorType {
    DryWit,
    Absurdist,
    DarkComedy,
    Satirical,
    CozyBanter,
    Physical,
    None,
}

/// Stakes level — scope of consequences
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StakesLevel {
    Personal,
    Local,
    National,
    Global,
    Cosmic,
}

/// Protagonist count
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProtagonistCount {
    Solo,
    Duo,
    Ensemble,
    OmniscientMany,
}

/// Prose style
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProseStyle {
    Sparse,
    Conversational,
    Lyrical,
    Dense,
    Journalistic,
}

/// Series dependency — can you start here?
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SeriesDependency {
    FullyStandalone,
    WorksStandalone,
    NeedsPrior,
    MustStartAtOne,
}

// --- Shared value types ---

/// A spectrum value with a dimension and intensity (-5 to +5)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpectrumValue {
    pub dimension: String,  // e.g., "dark-light", "action-contemplative"
    pub value: i8,          // -5 to +5
}

/// A mood with intensity (1-10)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoodIntensity {
    pub mood: String,
    pub intensity: u8,  // 1-10
}

// =============================================================================
// Complete BookDNA v3 fingerprint
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookDNA {
    // --- Core attributes (single value) ---
    pub length: Option<Length>,
    pub pacing: Option<Pacing>,
    pub structure: Option<Structure>,
    pub pov: Option<PointOfView>,
    pub series_position: Option<SeriesPosition>,
    pub pub_era: Option<PubEra>,
    pub setting: Option<Setting>,

    // --- v3: New single-value dimensions ---
    pub ending_type: Option<EndingType>,
    pub opening_energy: Option<EmotionalEnergy>,
    pub ending_energy: Option<EmotionalEnergy>,
    pub humor_type: Option<HumorType>,
    pub stakes_level: Option<StakesLevel>,
    pub protagonist_count: Option<ProtagonistCount>,
    pub prose_style: Option<ProseStyle>,
    pub series_dependency: Option<SeriesDependency>,

    // --- Audiobook-specific ---
    pub production: Option<Production>,
    pub narrator_performance: Vec<String>,  // 1-2 from VALID_NARRATOR_PERFORMANCE
    pub audio_friendliness: Option<u8>,     // 0-5: how easy to follow aurally
    pub re_listen_value: Option<u8>,        // 0-5: rewards repeat listens

    // --- Content spectrums (0-5 scale) ---
    pub violence_level: Option<u8>,   // 0=none, 5=extremely graphic
    pub intimacy_level: Option<u8>,   // 0=none, 5=extremely graphic

    // --- Shelf (1-3 from fixed list) ---
    pub shelves: Vec<String>,

    // --- Comparables ---
    pub comp_authors: Vec<String>,   // 1-2 similar authors
    pub comp_vibes: Vec<String>,     // 3-5 evocative "X-meets-Y" phrases

    // --- Constrained multi-value lists ---
    pub tropes: Vec<String>,
    pub themes: Vec<String>,
    pub relationship_focus: Vec<String>,  // 1-2 from VALID_RELATIONSHIP_FOCUS

    // --- Spectrum values — 7 fixed dimensions ---
    pub spectrums: Vec<SpectrumValue>,

    // --- Mood intensities (1-10 scale, 2-3 per book) ---
    pub moods: Vec<MoodIntensity>,
}

impl Default for BookDNA {
    fn default() -> Self {
        Self {
            length: None,
            pacing: None,
            structure: None,
            pov: None,
            series_position: None,
            pub_era: None,
            setting: None,
            ending_type: None,
            opening_energy: None,
            ending_energy: None,
            humor_type: None,
            stakes_level: None,
            protagonist_count: None,
            prose_style: None,
            series_dependency: None,
            production: None,
            narrator_performance: vec![],
            audio_friendliness: None,
            re_listen_value: None,
            violence_level: None,
            intimacy_level: None,
            shelves: vec![],
            comp_authors: vec![],
            comp_vibes: vec![],
            tropes: vec![],
            themes: vec![],
            relationship_focus: vec![],
            spectrums: vec![],
            moods: vec![],
        }
    }
}

// =============================================================================
// GPT Prompt for BookDNA v3 Generation
// =============================================================================

pub const BOOK_DNA_PROMPT: &str = r#"
You are a book analyst creating a structured "DNA fingerprint" for audiobooks.
Analyze the provided book metadata and generate a detailed DNA profile.

══════════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT - Return ONLY this JSON structure
══════════════════════════════════════════════════════════════════════════════

{
  "length": "short" | "medium" | "long" | "epic",
  "pacing": "slow" | "measured" | "moderate" | "fast" | "breakneck",
  "structure": "linear" | "nonlinear" | "multiple-timeline" | "frame-story" | "epistolary" | "reverse-chronological",
  "pov": "first-person" | "close-third" | "omniscient-third" | "multiple-pov" | "second",
  "series_position": "standalone" | "series-start" | "mid-series" | "series-end",
  "pub_era": "classic" | "mid-century" | "modern" | "contemporary",
  "setting": "urban" | "suburban" | "rural" | "wilderness" | "space-station" | "spaceship" | "fantasy-world" | "historical" | "post-apocalyptic" | "underwater" | "underground" | "school" | "military" | "small-town" | "multiple-settings" | "secondary-world" | "city-state" | "arctic" | "desert" | "tropical",

  "ending_type": "hea" | "hfn" | "bittersweet" | "ambiguous" | "open" | "tragic" | "cathartic",
  "opening_energy": "low" | "medium" | "high",
  "ending_energy": "low" | "medium" | "high",
  "humor_type": "dry-wit" | "absurdist" | "dark-comedy" | "satirical" | "cozy-banter" | "physical" | "none",
  "stakes_level": "personal" | "local" | "national" | "global" | "cosmic",
  "protagonist_count": "solo" | "duo" | "ensemble" | "omniscient-many",
  "prose_style": "sparse" | "conversational" | "lyrical" | "dense" | "journalistic",
  "series_dependency": "fully-standalone" | "works-standalone" | "needs-prior" | "must-start-at-one",

  "production": "single-voice" | "dual-narrator" | "full-cast" | "dramatized",
  "narrator_performance": ["theatrical", "character-voices"],
  "audio_friendliness": 4,
  "re_listen_value": 3,

  "violence_level": 2,
  "intimacy_level": 1,

  "shelves": ["epic-fantasy", "grimdark-fantasy"],
  "comp_authors": ["joe-abercrombie", "mark-lawrence"],
  "comp_vibes": ["grimdark-heist", "medieval-noir", "game-of-thrones-meets-peaky-blinders", "the-name-of-the-wind-meets-the-lies-of-locke-lamora", "dark-political-intrigue"],

  "tropes": ["morally-grey-protagonist", "found-family"],
  "themes": ["power", "corruption", "loyalty"],
  "relationship_focus": ["friendship", "rivals"],

  "spectrums": [
    {"dimension": "dark-light", "value": -4},
    {"dimension": "serious-funny", "value": -3},
    {"dimension": "plot-character", "value": 1},
    {"dimension": "simple-complex", "value": 3},
    {"dimension": "action-contemplative", "value": -2},
    {"dimension": "intimate-epic-scope", "value": 4},
    {"dimension": "world-density", "value": 3}
  ],

  "moods": [
    {"mood": "tension", "intensity": 8},
    {"mood": "drama", "intensity": 7},
    {"mood": "propulsive", "intensity": 6}
  ]
}

══════════════════════════════════════════════════════════════════════════════
CORE ATTRIBUTE GUIDELINES
══════════════════════════════════════════════════════════════════════════════

LENGTH (based on duration if provided):
- short: Under 5 hours
- medium: 5-12 hours
- long: 12-20 hours
- epic: Over 20 hours

PACING:
- slow: Contemplative, literary pace
- measured: Deliberate but engaging
- moderate: Balanced action and development
- fast: Quick plot progression
- breakneck: Non-stop action

STRUCTURE:
- linear: Chronological storytelling
- nonlinear: Timeline jumps throughout
- multiple-timeline: Distinct parallel timelines (past/present, multiple eras)
- frame-story: Story within a story
- epistolary: Letters, documents, recordings, found footage
- reverse-chronological: Events told backward

POV:
- first-person: "I" narrator
- close-third: Third person, single POV
- omniscient-third: Third person, knows all
- multiple-pov: Alternating perspectives
- second: "You" narrator (rare)

SERIES POSITION:
- standalone: Complete story, no series
- series-start: First book, introduces world
- mid-series: Middle of series
- series-end: Final book of series

══════════════════════════════════════════════════════════════════════════════
NEW DIMENSIONS (v3)
══════════════════════════════════════════════════════════════════════════════

ENDING TYPE — How does the story resolve emotionally?
- hea: Happily ever after. All major threads resolved positively.
- hfn: Happy for now. Positive but with acknowledged uncertainty ahead.
- bittersweet: Mix of joy and sorrow. Victory at a cost.
- ambiguous: Deliberately unclear resolution. Reader decides.
- open: Story continues, no definitive resolution. Sequel-dependent.
- tragic: Devastating outcome. Main character(s) lose.
- cathartic: Painful journey that ends in earned emotional release.

EMOTIONAL ARC — Tracks the emotional trajectory, not just a snapshot.
- opening_energy: The emotional brightness at the start.
  low = dark, oppressive, bleak opening
  medium = neutral, everyday, grounded opening
  high = bright, exciting, hopeful opening
- ending_energy: The emotional brightness at the end.
  low = dark, devastating, hopeless ending
  medium = bittersweet, mixed, grounded ending
  high = triumphant, hopeful, warm ending
Examples:
  "Dark but hopeful": opening=low, ending=high
  "Dark and hopeless": opening=low, ending=low
  "Bright to devastating": opening=high, ending=low
  "Steadily uplifting": opening=medium, ending=high

HUMOR TYPE — What kind of funny, if any?
- dry-wit: Understated, clever. Pratchett, Austen.
- absurdist: Surreal, logic-defying. Adams, Fforde.
- dark-comedy: Humor from grim situations. Vonnegut, Palahniuk.
- satirical: Social/political commentary through humor. Heller, Swift.
- cozy-banter: Warm, witty character dialogue. Evanovich, Heyer.
- physical: Slapstick, situational comedy. Wodehouse.
- none: Not a humorous book.

STAKES LEVEL — What's at risk?
- personal: One person's life, relationships, identity
- local: A town, community, small group
- national: A country, kingdom, large organization
- global: The world, all of humanity
- cosmic: Reality itself, multiple dimensions, existence

PROTAGONIST COUNT:
- solo: Single main character
- duo: Two central characters (buddy cop, romance pair)
- ensemble: 3-6 main characters with roughly equal weight
- omniscient-many: Large cast, no single protagonist

PROSE STYLE:
- sparse: Short sentences, minimal description. Hemingway, McCarthy.
- conversational: Natural, voice-driven. Casual but purposeful.
- lyrical: Rich imagery, rhythm, poetic language. Rothfuss, Morrison.
- dense: Heavy exposition, technical, packed with information.
- journalistic: Clean, factual, reporter-like. Common in nonfiction.

SERIES DEPENDENCY — Can you start here?
- fully-standalone: No series, or standalone novel in a shared universe
- works-standalone: Part of series but self-contained, fine entry point
- needs-prior: References prior books, better with context
- must-start-at-one: Won't make sense without reading from book 1

RELATIONSHIP FOCUS — 1-2 from this list:
friendship, romance, mentor-student, rivals, family, human-nonhuman, none
What kind of central relationship drives the emotional core? Different from
tropes — "found-family" is a trope, "friendship" as the emotional center is
the relationship focus.

══════════════════════════════════════════════════════════════════════════════
AUDIOBOOK-SPECIFIC DIMENSIONS
══════════════════════════════════════════════════════════════════════════════

NARRATOR PERFORMANCE — 1-2 from this list:
theatrical, character-voices, understated, conversational, documentary
- theatrical: Big, dramatic delivery. Full emotional range.
- character-voices: Distinct voices for each character. Voice-actor style.
- understated: Subtle, restrained. Lets the text do the work.
- conversational: Natural, like being told a story by a friend.
- documentary: Measured, informative. Common in nonfiction.
Infer from narrator reputation + genre + production type. A thriller with a
known voice-actor narrator is likely theatrical + character-voices.

AUDIO FRIENDLINESS — 0 to 5. How easy is this to follow as audio?
- 0: Near-impossible aurally (heavy footnotes, maps required, appendices)
- 1: Challenging (huge named cast, complex timelines, visual elements)
- 2: Moderate difficulty (multiple POVs, some complexity)
- 3: Average audiobook experience
- 4: Audio-friendly (straightforward, clear narrator, easy to follow)
- 5: Perfect for audio (single POV, conversational, great at 1.5x speed)
Consider: cast size, timeline complexity, visual/map dependencies,
footnotes, chapter structure, prose density.

RE-LISTEN VALUE — 0 to 5. Does this reward a second listen?
- 0: No re-listen value (straightforward mystery, answer known)
- 1: Minor details you might catch
- 2: Some foreshadowing or layers
- 3: Noticeably better on re-listen
- 4: Rich layers, unreliable narrator reveals, hidden clues
- 5: Fundamentally different experience on re-listen

══════════════════════════════════════════════════════════════════════════════
CONTENT SPECTRUMS — Scored dimensions (0-5)
══════════════════════════════════════════════════════════════════════════════

violence_level: 0=none, 1=mild/implied, 2=moderate, 3=significant,
  4=graphic, 5=extremely graphic/sustained
intimacy_level: 0=none, 1=kissing/fade-to-black, 2=moderate/sensual,
  3=explicit scenes, 4=frequent explicit, 5=erotica-level

══════════════════════════════════════════════════════════════════════════════
SHELVES — Pick 1-3 from this list ONLY
══════════════════════════════════════════════════════════════════════════════

cozy-fantasy, epic-fantasy, dark-fantasy, urban-fantasy, portal-fantasy, fairy-tale-retelling, mythic-fantasy, sword-and-sorcery, grimdark-fantasy, romantic-fantasy, hard-sci-fi, space-opera, cyberpunk, dystopian, post-apocalyptic, first-contact, time-travel, cli-fi, military-sci-fi, biopunk, cozy-mystery, detective-noir, police-procedural, psychological-thriller, legal-thriller, medical-thriller, spy-thriller, cat-and-mouse-thriller, domestic-suspense, locked-room-mystery, gothic-horror, cosmic-horror, supernatural-horror, folk-horror, psychological-horror, slasher, contemporary-romance, historical-romance, paranormal-romance, romantic-comedy, dark-romance, romantasy, small-town-romance, second-chance-romance, literary-fiction, book-club-fiction, family-saga, coming-of-age, campus-novel, satire, southern-gothic, magical-realism, upmarket-fiction, experimental-fiction, historical-fiction, alternate-history, historical-mystery, wartime-fiction, regency, medieval, memoir, true-crime, popular-science, history-narrative, self-help, biography, essay-collection, investigative-journalism, travel-narrative, nature-writing, middle-grade-adventure, ya-dystopian, ya-fantasy, ya-contemporary, superhero-fiction, litrpg, progression-fantasy, western, afrofuturism, solarpunk, new-weird

══════════════════════════════════════════════════════════════════════════════
THEMES — Pick 2-4 from this list ONLY
══════════════════════════════════════════════════════════════════════════════

identity, belonging, power, corruption, redemption, sacrifice, love, loss, grief, hope, survival, freedom, justice, revenge, forgiveness, family, friendship, loyalty, betrayal, truth, deception, memory, mortality, faith, doubt, ambition, obsession, isolation, connection, duty, honor, class, prejudice, resilience, transformation, innocence, coming-of-age, war, trauma, healing, nature-vs-nurture, technology-vs-humanity, colonialism, rebellion, legacy, fate-vs-free-will, good-vs-evil, self-discovery, addiction, motherhood

══════════════════════════════════════════════════════════════════════════════
TROPES — Pick 2-5 from this list ONLY
══════════════════════════════════════════════════════════════════════════════

chosen-one, found-family, enemies-to-lovers, slow-burn, love-triangle, unreliable-narrator, heist, locked-room, fish-out-of-water, dark-lord, hidden-heir, mentor-figure, reluctant-hero, antihero, training-arc, tournament, quest, prophecy, time-loop, secret-society, body-swap, amnesia, fake-relationship, forced-proximity, grumpy-sunshine, only-one-bed, dual-timeline, revenge-plot, rags-to-riches, fall-from-grace, morally-grey-protagonist, forbidden-love, star-crossed-lovers, road-trip, survival-situation, haunted-house, final-girl, whodunit, red-herring, cold-case, undercover, prison-escape, last-stand, first-contact, culture-clash, portal, dystopian-resistance, ai-uprising, generation-ship, monster-hunt

══════════════════════════════════════════════════════════════════════════════
SPECTRUMS — Return ALL 7 dimensions (required)
══════════════════════════════════════════════════════════════════════════════

Scale: -5 to +5. You MUST return all seven:
- dark-light: -5=grimdark/bleak, 0=neutral, +5=lighthearted/whimsical
- serious-funny: -5=somber/weighty, 0=neutral, +5=comedic/absurd
- plot-character: -5=pure plot-driven, 0=balanced, +5=pure character-study
- simple-complex: -5=straightforward/accessible, 0=moderate, +5=intricate/dense
- action-contemplative: -5=wall-to-wall action, 0=balanced, +5=entirely internal/reflective
- intimate-epic-scope: -5=one person's small personal story, 0=moderate, +5=world/civilization-scale events
- world-density: -5=grounded real world/minimal worldbuilding, 0=moderate, +5=immersive dense worldbuilding

USE THE FULL RANGE. Do not default everything to -2 or 0. Examples:
- A cozy mystery: dark-light=3, serious-funny=2, plot-character=-2, simple-complex=-2, action-contemplative=1, intimate-epic-scope=-3, world-density=-3
- Grimdark fantasy: dark-light=-5, serious-funny=-4, plot-character=0, simple-complex=3, action-contemplative=-2, intimate-epic-scope=3, world-density=4
- A comedy memoir: dark-light=3, serious-funny=4, plot-character=4, simple-complex=-1, action-contemplative=3, intimate-epic-scope=-4, world-density=-5
- Hard sci-fi: dark-light=-1, serious-funny=-3, plot-character=-3, simple-complex=5, action-contemplative=2, intimate-epic-scope=4, world-density=5
- Literary fiction: dark-light=0, serious-funny=-2, plot-character=4, simple-complex=3, action-contemplative=4, intimate-epic-scope=-2, world-density=-2
- Cormac McCarthy: plot-character=1, action-contemplative=3 (plot-driven AND contemplative)
- Gone Girl: plot-character=2, action-contemplative=-3 (character-driven AND propulsive)

══════════════════════════════════════════════════════════════════════════════
MOODS — Pick 2-3 with intensity 1-10
══════════════════════════════════════════════════════════════════════════════

Available moods: thrills, drama, romance, horror, mystery, wonder, melancholy, hope, tension, humor, adventure, dread, nostalgia, awe, unease, warmth, fury, propulsive, cozy

USE THE FULL 1-10 RANGE. Calibration guide:
- 1-2: Barely present, faint undertone
- 3-4: Noticeable but not dominant
- 5-6: Significant presence, shapes the experience
- 7-8: Major force in the book
- 9-10: Defining characteristic, overwhelming presence

Examples:
- A cozy mystery: mystery:7, warmth:6, cozy:8
- A grimdark epic: dread:8, tension:9, drama:6
- A romantic comedy: humor:8, romance:7, warmth:5
- A literary novel about grief: melancholy:9, hope:3, drama:5
- A horror thriller: dread:9, tension:8, horror:7
- A fast-paced thriller: propulsive:9, tension:8, thrills:7
- A cozy fantasy: cozy:8, wonder:6, warmth:7

══════════════════════════════════════════════════════════════════════════════
COMPARABLES
══════════════════════════════════════════════════════════════════════════════

comp_authors: 1-2 well-known authors whose style or tone is similar (lowercase-hyphenated)
  e.g. "joe-abercrombie", "agatha-christie", "brandon-sanderson"

comp_vibes: 5-8 evocative vibe descriptions (lowercase-hyphenated). Include BOTH types:
  TYPE A — Short descriptive vibes (2-3 per book):
    e.g. "grimdark-heist", "medieval-noir", "cozy-hogwarts-for-adults", "emotional-gut-punch"
  TYPE B — "X-meets-Y" mashups where BOTH sides are multi-word references (3-5 per book):
    e.g. "game-of-thrones-meets-peaky-blinders", "lord-of-the-rings-meets-the-road",
         "breaking-bad-meets-fantasy", "pride-and-prejudice-meets-bridget-jones"
    BOTH sides of "meets" MUST be recognizable works, authors, or multi-word descriptions.
    Single-word sides like "horror-meets-romance" do NOT count as Type B.
  More vibes = richer clustering. Be creative and specific.

COMP-VIBE / COMP-AUTHOR SELF-REFERENCE RULE (CRITICAL):
  The comp-vibe and comp-author tags must reference OTHER works and authors
  that this book resembles — NEVER the book's own title, series, or author.
  If the book IS a Discworld novel, "discworld-meets-X" is FORBIDDEN.
  If the author IS Terry Pratchett, "terry-pratchett" is FORBIDDEN as a comp-author.
  Always compare outward to different authors and different works.

══════════════════════════════════════════════════════════════════════════════
RULES
══════════════════════════════════════════════════════════════════════════════

- shelves, themes, tropes: ONLY use values from the provided lists above
- relationship_focus: 1-2 from the provided list ONLY
- narrator_performance: 1-2 from the provided list ONLY
- spectrums: ALWAYS return ALL 7 dimensions, use the full -5 to +5 range
- moods: Return exactly 2-3, use the full 1-10 range
- comp_authors: 1-2 authors, lowercase-hyphenated
- comp_vibes: 5-8 descriptions (mix of short vibes AND "X-meets-Y" mashups), lowercase-hyphenated
- violence_level and intimacy_level: 0-5 integer
- audio_friendliness and re_listen_value: 0-5 integer
- Omit fields you can't determine (return null)
- All string values MUST be lowercase-hyphenated (e.g. "found-family", NOT "Found-Family" or "Found Family")
- Spectrum values are SIGNED integers from -5 to +5. NEGATIVE means the LEFT side of the label. Example: dark-light uses NEGATIVE for dark books (e.g. grimdark = -4 or -5), POSITIVE for light books (e.g. cozy = +3 or +4). Do NOT use positive values for dark books.
- Return ONLY valid JSON, no explanation
"#;

// =============================================================================
// DNA Generation
// =============================================================================

/// Input data for DNA generation
#[derive(Debug, Clone, Serialize)]
pub struct DnaInput {
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub genres: Vec<String>,
    pub tags: Vec<String>,
    pub narrator: Option<String>,
    pub duration_minutes: Option<u32>,
    pub series_name: Option<String>,
    pub series_sequence: Option<String>,
    pub year: Option<String>,
}

/// Response from Responses API
#[derive(Deserialize, Debug)]
struct ResponsesApiResponse {
    #[serde(default)]
    output: Vec<OutputItem>,
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

/// Generate BookDNA using GPT-5-nano
pub async fn generate_dna(
    config: &crate::config::Config,
    input: &DnaInput,
) -> Result<BookDNA, String> {
    // Check cache first
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    input.title.to_lowercase().trim().hash(&mut h);
    input.author.to_lowercase().trim().hash(&mut h);
    let cache_key = format!("dna_v3_{}", h.finish());
    if let Some(cached) = crate::cache::get::<BookDNA>(&cache_key) {
        return Ok(cached);
    }

    let api_key = config
        .openai_api_key
        .as_ref()
        .filter(|k| !k.is_empty())
        .ok_or("No OpenAI API key configured")?;

    // Build user prompt
    let user_prompt = build_dna_prompt(input);

    // Build Responses API request
    let request_body = serde_json::json!({
        "model": crate::scanner::processor::preferred_model(),
        "input": [
            {
                "role": "developer",
                "content": BOOK_DNA_PROMPT
            },
            {
                "role": "user",
                "content": user_prompt
            }
        ],
        "max_output_tokens": 3000,
        "reasoning": {
            "effort": "low"
        },
        "text": {
            "format": {
                "type": "json_object"
            }
        }
    });

    let client = crate::cache::shared_client();
    let response = client
        .post(format!("{}/v1/responses", crate::scanner::processor::preferred_base_url()))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("DNA generation request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GPT returned status {}: {}", status, body));
    }

    let response_text = response.text().await
        .map_err(|e| format!("Failed to read GPT response: {}", e))?;

    // Parse Responses API format
    let result: ResponsesApiResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse Responses API: {}. Raw: {}", e, &response_text[..response_text.len().min(500)]))?;

    // Extract text content
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
            .ok_or("No text content in response")?
            .trim()
            .to_string()
    };

    // Parse JSON response
    let mut dna = parse_dna_response(&content)?;
    // Validate: strip self-referential comp-vibes and comp-authors
    strip_self_referential_comps(&mut dna, &input.title, &input.author, input.series_name.as_deref());
    // Cache the cleaned result
    let _ = crate::cache::set(&cache_key, &dna);
    Ok(dna)
}

/// Build the user prompt with book metadata
fn build_dna_prompt(input: &DnaInput) -> String {
    let mut prompt = format!(
        "Generate a BookDNA fingerprint for:\n\n\
         Title: {}\n\
         Author: {}\n",
        input.title, input.author
    );

    if let Some(ref desc) = input.description {
        let truncated: String = desc.chars().take(800).collect();
        prompt.push_str(&format!("Description: {}\n", truncated));
    }

    if !input.genres.is_empty() {
        prompt.push_str(&format!("Genres: {}\n", input.genres.join(", ")));
    }

    if !input.tags.is_empty() {
        prompt.push_str(&format!("Tags: {}\n", input.tags.join(", ")));
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

    prompt.push_str("\nReturn the DNA JSON.");
    prompt
}

// =============================================================================
// Response Parsing
// =============================================================================

/// Parse GPT's JSON response into BookDNA
fn parse_dna_response(content: &str) -> Result<BookDNA, String> {
    // Handle markdown wrapping
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

    // --- Constrained lists with validation ---
    let slugify = |s: String| -> String {
        s.to_lowercase().replace(' ', "-").replace('_', "-")
    };

    let raw_themes = extract_string_array(&parsed, "themes");

    let shelves = extract_string_array(&parsed, "shelves")
        .into_iter()
        .map(slugify)
        .filter(|s| VALID_SHELVES.contains(&s.as_str()))
        .collect::<Vec<_>>();

    let themes = raw_themes
        .into_iter()
        .map(slugify)
        .filter(|t| VALID_THEMES.contains(&t.as_str()))
        .collect::<Vec<_>>();

    let tropes = extract_string_array(&parsed, "tropes")
        .into_iter()
        .map(slugify)
        .filter(|t| VALID_TROPES.contains(&t.as_str()))
        .collect::<Vec<_>>();

    let relationship_focus = extract_string_array(&parsed, "relationship_focus")
        .into_iter()
        .map(slugify)
        .filter(|r| VALID_RELATIONSHIP_FOCUS.contains(&r.as_str()))
        .collect::<Vec<_>>();

    let narrator_performance = extract_string_array(&parsed, "narrator_performance")
        .into_iter()
        .map(slugify)
        .filter(|n| VALID_NARRATOR_PERFORMANCE.contains(&n.as_str()))
        .collect::<Vec<_>>();

    // --- Spectrums: ensure all 7 required dimensions ---
    let mut spectrums = extract_spectrums(&parsed);
    for required in REQUIRED_SPECTRUMS {
        if !spectrums.iter().any(|s| s.dimension == *required) {
            spectrums.push(SpectrumValue {
                dimension: required.to_string(),
                value: 0,
            });
        }
    }
    spectrums.retain(|s| REQUIRED_SPECTRUMS.contains(&s.dimension.as_str()));
    for s in &mut spectrums {
        s.value = s.value.clamp(-5, 5);
    }

    // --- Moods: clamp intensity ---
    let mut moods = extract_moods(&parsed);
    for m in &mut moods {
        m.intensity = m.intensity.clamp(1, 10);
    }

    // --- Scored dimensions (0-5): extract and clamp ---
    let violence_level = extract_u8_field(&parsed, "violence_level").map(|v| v.min(5));
    let intimacy_level = extract_u8_field(&parsed, "intimacy_level").map(|v| v.min(5));
    let audio_friendliness = extract_u8_field(&parsed, "audio_friendliness").map(|v| v.min(5));
    let re_listen_value = extract_u8_field(&parsed, "re_listen_value").map(|v| v.min(5));

    Ok(BookDNA {
        // Core attributes
        length: parse_enum_field(&parsed, "length"),
        pacing: parse_enum_field(&parsed, "pacing"),
        structure: parse_enum_field(&parsed, "structure"),
        pov: parse_enum_field(&parsed, "pov"),
        series_position: parse_enum_field(&parsed, "series_position"),
        pub_era: parse_enum_field(&parsed, "pub_era"),
        setting: parse_enum_field(&parsed, "setting"),
        // v3 new enums
        ending_type: parse_enum_field(&parsed, "ending_type"),
        opening_energy: parse_enum_field(&parsed, "opening_energy"),
        ending_energy: parse_enum_field(&parsed, "ending_energy"),
        humor_type: parse_enum_field(&parsed, "humor_type"),
        stakes_level: parse_enum_field(&parsed, "stakes_level"),
        protagonist_count: parse_enum_field(&parsed, "protagonist_count"),
        prose_style: parse_enum_field(&parsed, "prose_style"),
        series_dependency: parse_enum_field(&parsed, "series_dependency"),
        // Audiobook-specific
        production: parse_enum_field(&parsed, "production"),
        narrator_performance,
        audio_friendliness,
        re_listen_value,
        // Content spectrums
        violence_level,
        intimacy_level,
        // Lists
        shelves,
        comp_authors: extract_string_array(&parsed, "comp_authors").into_iter().map(slugify).collect(),
        comp_vibes: extract_string_array(&parsed, "comp_vibes").into_iter().map(slugify).collect(),
        tropes,
        themes,
        relationship_focus,
        spectrums,
        moods,
    })
}

fn parse_enum_field<T: for<'de> serde::Deserialize<'de>>(
    data: &serde_json::Value,
    key: &str,
) -> Option<T> {
    data.get(key)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
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

fn extract_u8_field(data: &serde_json::Value, key: &str) -> Option<u8> {
    data.get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as u8)
}

fn extract_spectrums(data: &serde_json::Value) -> Vec<SpectrumValue> {
    data.get("spectrums")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let dimension = item.get("dimension")?.as_str()?.to_string();
                    let value = item.get("value")?.as_i64()? as i8;
                    Some(SpectrumValue { dimension, value })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_moods(data: &serde_json::Value) -> Vec<MoodIntensity> {
    data.get("moods")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let mood = item.get("mood")?.as_str()?.to_lowercase().replace(' ', "-").replace('_', "-");
                    let intensity = item.get("intensity")?.as_u64()? as u8;
                    Some(MoodIntensity { mood, intensity })
                })
                .collect()
        })
        .unwrap_or_default()
}

// =============================================================================
// Self-Referential Comp Validation
// =============================================================================

/// Normalize a string to lowercase slug words for comparison.
/// "Terry Pratchett" -> ["terry", "pratchett"]
/// "The Lord of the Rings" -> ["the", "lord", "of", "the", "rings"]
fn normalize_to_words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != ' ', " ")
        .split_whitespace()
        .map(|w| w.to_string())
        .collect()
}

/// Normalize a name to a slug for direct comparison.
/// "Terry Pratchett" -> "terry-pratchett"
fn normalize_to_slug(s: &str) -> String {
    s.to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != ' ', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

/// Check if a slug contains any meaningful word from a reference string.
/// Skips common stop words that would cause false positives.
fn slug_contains_reference(slug: &str, reference_words: &[String]) -> bool {
    const STOP_WORDS: &[&str] = &[
        "the", "a", "an", "of", "and", "in", "on", "at", "to", "for",
        "is", "it", "my", "no", "or", "be", "by", "as", "do", "if",
        "so", "up", "but", "not", "with", "from", "that", "this",
    ];

    let slug_lower = slug.to_lowercase();
    for word in reference_words {
        if word.len() < 3 { continue; }
        if STOP_WORDS.contains(&word.as_str()) { continue; }
        // Check if the word appears as a component in the slug
        // "discworld" in "discworld-meets-noir" -> true
        // "pratchett" in "terry-pratchett" -> true
        if slug_lower.contains(word.as_str()) {
            return true;
        }
    }
    false
}

/// Strip self-referential comp-vibes and comp-authors from a BookDNA.
/// Removes any comp-vibe that references the book's own title, author, or series.
/// Removes any comp-author that matches the book's own author.
pub fn strip_self_referential_comps(
    dna: &mut BookDNA,
    title: &str,
    author: &str,
    series_name: Option<&str>,
) {
    let title_words = normalize_to_words(title);
    let author_words = normalize_to_words(author);
    let author_slug = normalize_to_slug(author);
    let series_words = series_name.map(|s| normalize_to_words(s)).unwrap_or_default();

    // Filter comp_vibes: split on "-meets-" and check each half
    dna.comp_vibes.retain(|vibe| {
        let parts: Vec<&str> = if vibe.contains("-meets-") {
            vibe.split("-meets-").collect()
        } else {
            vec![vibe.as_str()]
        };

        for part in &parts {
            if slug_contains_reference(part, &title_words) { return false; }
            if slug_contains_reference(part, &author_words) { return false; }
            if !series_words.is_empty() && slug_contains_reference(part, &series_words) {
                return false;
            }
        }
        true
    });

    // Filter comp_authors: check if slug matches book's own author
    dna.comp_authors.retain(|comp| {
        let comp_slug = comp.to_lowercase();
        // Direct slug match
        if comp_slug == author_slug { return false; }
        // Check if the author's significant words appear in the comp
        if slug_contains_reference(&comp_slug, &author_words) { return false; }
        true
    });
}

// =============================================================================
// Cache Migration — Clean self-referential comps from cached DNA entries
// =============================================================================

/// Result of a cache migration run
#[derive(Debug, Clone, serde::Serialize)]
pub struct DnaCacheMigrationResult {
    pub total_entries: usize,
    pub cleaned_entries: usize,
    pub comp_vibes_removed: usize,
    pub comp_authors_removed: usize,
    pub errors: usize,
}

/// Migrate all cached DNA entries: strip self-referential comp-vibes/comp-authors.
/// No GPT calls — purely local validation. Fast and free.
///
/// Because the cache key is a hash of title+author (no series), we can't recover
/// the original book metadata from the key alone. The caller must provide a list
/// of (title, author, series_name) tuples that correspond to their library.
/// Any cached DNA entry whose key matches a provided book will be validated.
///
/// For entries with no matching book metadata provided, they're skipped (no way
/// to know what's self-referential without the original title/author).
pub fn migrate_cached_dna(
    books: &[(String, String, Option<String>)],  // (title, author, series_name)
) -> DnaCacheMigrationResult {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut total = 0usize;
    let mut cleaned = 0usize;
    let mut vibes_removed = 0usize;
    let mut authors_removed = 0usize;
    let mut errors = 0usize;

    // Build a map from cache_key -> (title, author, series)
    let mut key_to_book: std::collections::HashMap<String, (&str, &str, Option<&str>)> =
        std::collections::HashMap::new();

    for (title, author, series) in books {
        let mut h = DefaultHasher::new();
        title.to_lowercase().trim().hash(&mut h);
        author.to_lowercase().trim().hash(&mut h);
        let cache_key = format!("dna_v3_{}", h.finish());
        key_to_book.insert(cache_key, (title.as_str(), author.as_str(), series.as_deref()));
    }

    // Scan all dna_v3_ entries in the cache
    let entries = crate::cache::scan_prefix("dna_v3_");
    total = entries.len();

    for (key, bytes) in entries {
        let book_info = match key_to_book.get(&key) {
            Some(info) => info,
            None => continue, // No metadata available for this entry, skip
        };

        let mut dna: BookDNA = match bincode::deserialize(&bytes) {
            Ok(d) => d,
            Err(_) => { errors += 1; continue; }
        };

        let vibes_before = dna.comp_vibes.len();
        let authors_before = dna.comp_authors.len();

        strip_self_referential_comps(&mut dna, book_info.0, book_info.1, book_info.2);

        let vibes_after = dna.comp_vibes.len();
        let authors_after = dna.comp_authors.len();
        let vibes_delta = vibes_before - vibes_after;
        let authors_delta = authors_before - authors_after;

        if vibes_delta > 0 || authors_delta > 0 {
            vibes_removed += vibes_delta;
            authors_removed += authors_delta;
            cleaned += 1;
            if let Err(_) = crate::cache::set(&key, &dna) {
                errors += 1;
            }
        }
    }

    DnaCacheMigrationResult {
        total_entries: total,
        cleaned_entries: cleaned,
        comp_vibes_removed: vibes_removed,
        comp_authors_removed: authors_removed,
        errors,
    }
}

// =============================================================================
// Tag Conversion
// =============================================================================

/// Convert BookDNA to dna: prefixed tags
pub fn dna_to_tags(dna: &BookDNA) -> Vec<String> {
    let mut tags = Vec::new();

    // --- Core single-value enums ---
    if let Some(ref v) = dna.length {
        tags.push(format!("dna:length:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.pacing {
        tags.push(format!("dna:pacing:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.structure {
        tags.push(format!("dna:structure:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.pov {
        tags.push(format!("dna:pov:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.series_position {
        tags.push(format!("dna:series-position:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.pub_era {
        tags.push(format!("dna:pub-era:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.setting {
        tags.push(format!("dna:setting:{}", serde_variant_name(v)));
    }

    // --- v3 new single-value enums ---
    if let Some(ref v) = dna.ending_type {
        tags.push(format!("dna:ending:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.opening_energy {
        tags.push(format!("dna:opening-energy:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.ending_energy {
        tags.push(format!("dna:ending-energy:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.humor_type {
        tags.push(format!("dna:humor:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.stakes_level {
        tags.push(format!("dna:stakes:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.protagonist_count {
        tags.push(format!("dna:protagonist:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.prose_style {
        tags.push(format!("dna:prose:{}", serde_variant_name(v)));
    }
    if let Some(ref v) = dna.series_dependency {
        tags.push(format!("dna:series-dependency:{}", serde_variant_name(v)));
    }

    // --- Audiobook-specific ---
    if let Some(ref v) = dna.production {
        tags.push(format!("dna:production:{}", serde_variant_name(v)));
    }
    for perf in &dna.narrator_performance {
        tags.push(format!("dna:narrator-performance:{}", perf));
    }
    if let Some(v) = dna.audio_friendliness {
        tags.push(format!("dna:audio-friendliness:{}", v));
    }
    if let Some(v) = dna.re_listen_value {
        tags.push(format!("dna:re-listen-value:{}", v));
    }

    // --- Content spectrums ---
    if let Some(v) = dna.violence_level {
        tags.push(format!("dna:violence-level:{}", v));
    }
    if let Some(v) = dna.intimacy_level {
        tags.push(format!("dna:intimacy-level:{}", v));
    }

    // --- Shelves ---
    for shelf in &dna.shelves {
        tags.push(format!("dna:shelf:{}", shelf));
    }

    // --- Comparables ---
    for author in &dna.comp_authors {
        tags.push(format!("dna:comp-author:{}", author));
    }
    for vibe in &dna.comp_vibes {
        tags.push(format!("dna:comp-vibe:{}", vibe));
    }

    // --- Tropes, themes, relationship focus ---
    for trope in &dna.tropes {
        tags.push(format!("dna:trope:{}", trope));
    }
    for theme in &dna.themes {
        tags.push(format!("dna:theme:{}", theme));
    }
    for rel in &dna.relationship_focus {
        tags.push(format!("dna:relationship:{}", rel));
    }

    // --- Spectrum values ---
    for spectrum in &dna.spectrums {
        tags.push(format!("dna:spectrum:{}:{}", spectrum.dimension, spectrum.value));
    }

    // --- Mood intensities ---
    for mood in &dna.moods {
        tags.push(format!("dna:mood:{}:{}", mood.mood, mood.intensity));
    }

    tags
}

/// Helper to get serde variant name (lowercase/kebab-case)
fn serde_variant_name<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value)
        .unwrap_or_default()
        .trim_matches('"')
        .to_string()
}

// =============================================================================
// Tag Merging
// =============================================================================

/// Check if a tag is a DNA tag
pub fn is_dna_tag(tag: &str) -> bool {
    tag.starts_with("dna:")
}

/// Merge DNA tags with existing tags
/// - Keeps all non-DNA tags unchanged
/// - Replaces ALL existing DNA tags with new DNA tags
pub fn merge_dna_tags(existing: &[String], new_dna_tags: &[String]) -> Vec<String> {
    let mut result: Vec<String> = existing
        .iter()
        .filter(|t| !is_dna_tag(t))
        .cloned()
        .collect();

    result.extend(new_dna_tags.iter().cloned());

    result
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dna_to_tags_v3() {
        let dna = BookDNA {
            length: Some(Length::Long),
            pacing: Some(Pacing::Fast),
            structure: Some(Structure::MultipleTimeline),
            pov: Some(PointOfView::CloseThird),
            series_position: Some(SeriesPosition::SeriesStart),
            pub_era: Some(PubEra::Contemporary),
            setting: Some(Setting::Urban),
            ending_type: Some(EndingType::Bittersweet),
            opening_energy: Some(EmotionalEnergy::Low),
            ending_energy: Some(EmotionalEnergy::High),
            humor_type: Some(HumorType::DarkComedy),
            stakes_level: Some(StakesLevel::Global),
            protagonist_count: Some(ProtagonistCount::Ensemble),
            prose_style: Some(ProseStyle::Lyrical),
            series_dependency: Some(SeriesDependency::NeedsPrior),
            production: Some(Production::SingleVoice),
            narrator_performance: vec!["theatrical".to_string(), "character-voices".to_string()],
            audio_friendliness: Some(3),
            re_listen_value: Some(4),
            violence_level: Some(3),
            intimacy_level: Some(1),
            shelves: vec!["epic-fantasy".to_string(), "grimdark-fantasy".to_string()],
            comp_authors: vec!["joe-abercrombie".to_string()],
            comp_vibes: vec![
                "game-of-thrones-meets-peaky-blinders".to_string(),
                "grimdark-heist".to_string(),
                "medieval-noir".to_string(),
            ],
            tropes: vec!["heist".to_string(), "found-family".to_string()],
            themes: vec!["loyalty".to_string(), "power".to_string()],
            relationship_focus: vec!["friendship".to_string(), "rivals".to_string()],
            spectrums: vec![
                SpectrumValue { dimension: "dark-light".to_string(), value: -3 },
                SpectrumValue { dimension: "serious-funny".to_string(), value: -2 },
                SpectrumValue { dimension: "plot-character".to_string(), value: 1 },
                SpectrumValue { dimension: "simple-complex".to_string(), value: 3 },
                SpectrumValue { dimension: "action-contemplative".to_string(), value: -2 },
                SpectrumValue { dimension: "intimate-epic-scope".to_string(), value: 4 },
                SpectrumValue { dimension: "world-density".to_string(), value: 3 },
            ],
            moods: vec![
                MoodIntensity { mood: "tension".to_string(), intensity: 8 },
                MoodIntensity { mood: "propulsive".to_string(), intensity: 7 },
            ],
        };

        let tags = dna_to_tags(&dna);

        // Core attributes
        assert!(tags.contains(&"dna:length:long".to_string()));
        assert!(tags.contains(&"dna:pacing:fast".to_string()));
        assert!(tags.contains(&"dna:structure:multiple-timeline".to_string()));
        assert!(tags.contains(&"dna:pov:close-third".to_string()));
        assert!(tags.contains(&"dna:series-position:series-start".to_string()));

        // v3 new dimensions
        assert!(tags.contains(&"dna:ending:bittersweet".to_string()));
        assert!(tags.contains(&"dna:opening-energy:low".to_string()));
        assert!(tags.contains(&"dna:ending-energy:high".to_string()));
        assert!(tags.contains(&"dna:humor:dark-comedy".to_string()));
        assert!(tags.contains(&"dna:stakes:global".to_string()));
        assert!(tags.contains(&"dna:protagonist:ensemble".to_string()));
        assert!(tags.contains(&"dna:prose:lyrical".to_string()));
        assert!(tags.contains(&"dna:series-dependency:needs-prior".to_string()));

        // Audiobook-specific
        assert!(tags.contains(&"dna:narrator-performance:theatrical".to_string()));
        assert!(tags.contains(&"dna:narrator-performance:character-voices".to_string()));
        assert!(tags.contains(&"dna:audio-friendliness:3".to_string()));
        assert!(tags.contains(&"dna:re-listen-value:4".to_string()));

        // Content spectrums
        assert!(tags.contains(&"dna:violence-level:3".to_string()));
        assert!(tags.contains(&"dna:intimacy-level:1".to_string()));

        // Lists
        assert!(tags.contains(&"dna:shelf:epic-fantasy".to_string()));
        assert!(tags.contains(&"dna:shelf:grimdark-fantasy".to_string()));
        assert!(tags.contains(&"dna:comp-author:joe-abercrombie".to_string()));
        assert!(tags.contains(&"dna:comp-vibe:grimdark-heist".to_string()));
        assert!(tags.contains(&"dna:comp-vibe:medieval-noir".to_string()));
        assert!(tags.contains(&"dna:trope:heist".to_string()));
        assert!(tags.contains(&"dna:theme:loyalty".to_string()));
        assert!(tags.contains(&"dna:relationship:friendship".to_string()));
        assert!(tags.contains(&"dna:relationship:rivals".to_string()));

        // Spectrums (7 total)
        assert!(tags.contains(&"dna:spectrum:dark-light:-3".to_string()));
        assert!(tags.contains(&"dna:spectrum:action-contemplative:-2".to_string()));
        assert!(tags.contains(&"dna:spectrum:intimate-epic-scope:4".to_string()));
        assert!(tags.contains(&"dna:spectrum:world-density:3".to_string()));

        // Moods
        assert!(tags.contains(&"dna:mood:tension:8".to_string()));
        assert!(tags.contains(&"dna:mood:propulsive:7".to_string()));

        // Old v2 tags should not appear
        assert!(!tags.iter().any(|t| t.starts_with("dna:vibe:")));
        assert!(!tags.iter().any(|t| t.starts_with("dna:narrator-style:")));
    }

    #[test]
    fn test_is_dna_tag() {
        assert!(is_dna_tag("dna:length:long"));
        assert!(is_dna_tag("dna:shelf:epic-fantasy"));
        assert!(is_dna_tag("dna:ending:bittersweet"));
        assert!(is_dna_tag("dna:narrator-performance:theatrical"));
        assert!(is_dna_tag("dna:audio-friendliness:4"));
        assert!(is_dna_tag("dna:violence-level:2"));
        assert!(is_dna_tag("dna:relationship:friendship"));
        assert!(!is_dna_tag("fast-paced"));
        assert!(!is_dna_tag("fantasy"));
    }

    #[test]
    fn test_merge_dna_tags_v3() {
        let existing = vec![
            "fast-paced".to_string(),
            "fantasy".to_string(),
            "dna:length:short".to_string(),
            "dna:narrator-style:subtle".to_string(),  // old v2 tag
            "dna:vibe:old-vibe".to_string(),           // old v1 tag
        ];

        let new_dna = vec![
            "dna:length:long".to_string(),
            "dna:shelf:epic-fantasy".to_string(),
            "dna:ending:bittersweet".to_string(),
            "dna:narrator-performance:theatrical".to_string(),
        ];

        let result = merge_dna_tags(&existing, &new_dna);

        // Non-DNA preserved
        assert!(result.contains(&"fast-paced".to_string()));
        assert!(result.contains(&"fantasy".to_string()));
        // New DNA present
        assert!(result.contains(&"dna:length:long".to_string()));
        assert!(result.contains(&"dna:ending:bittersweet".to_string()));
        assert!(result.contains(&"dna:narrator-performance:theatrical".to_string()));
        // All old DNA tags removed
        assert!(!result.contains(&"dna:length:short".to_string()));
        assert!(!result.contains(&"dna:narrator-style:subtle".to_string()));
        assert!(!result.contains(&"dna:vibe:old-vibe".to_string()));
    }

    #[test]
    fn test_valid_lists_sizes() {
        assert_eq!(VALID_SHELVES.len(), 81);
        assert_eq!(VALID_THEMES.len(), 50);
        assert_eq!(VALID_TROPES.len(), 50);
        assert_eq!(REQUIRED_SPECTRUMS.len(), 7);
        assert_eq!(VALID_RELATIONSHIP_FOCUS.len(), 7);
        assert_eq!(VALID_NARRATOR_PERFORMANCE.len(), 5);
    }

    #[test]
    fn test_default_dna_has_empty_vecs() {
        let dna = BookDNA::default();
        assert!(dna.narrator_performance.is_empty());
        assert!(dna.relationship_focus.is_empty());
        assert!(dna.comp_vibes.is_empty());
        assert!(dna.audio_friendliness.is_none());
        assert!(dna.violence_level.is_none());
        assert!(dna.ending_type.is_none());
    }

    #[test]
    fn test_strip_self_referential_comp_vibes() {
        let mut dna = BookDNA::default();
        dna.comp_vibes = vec![
            "discworld-meets-peaky-blinders".to_string(),  // self-ref (series)
            "game-of-thrones-meets-pratchett".to_string(), // self-ref (author)
            "hogwarts-meets-heist".to_string(),            // clean
            "grimdark-noir".to_string(),                   // clean
        ];
        dna.comp_authors = vec![
            "terry-pratchett".to_string(),   // self-ref (own author)
            "joe-abercrombie".to_string(),    // clean
        ];

        strip_self_referential_comps(
            &mut dna,
            "Guards! Guards!",
            "Terry Pratchett",
            Some("Discworld"),
        );

        assert_eq!(dna.comp_vibes, vec![
            "hogwarts-meets-heist".to_string(),
            "grimdark-noir".to_string(),
        ]);
        assert_eq!(dna.comp_authors, vec![
            "joe-abercrombie".to_string(),
        ]);
    }

    #[test]
    fn test_strip_self_ref_title_in_vibe() {
        let mut dna = BookDNA::default();
        dna.comp_vibes = vec![
            "lord-of-the-rings-meets-narnia".to_string(),  // self-ref (title words)
            "narnia-meets-earthsea".to_string(),           // clean
        ];

        strip_self_referential_comps(
            &mut dna,
            "The Lord of the Rings",
            "J.R.R. Tolkien",
            None,
        );

        // "lord" and "rings" are significant words from the title
        assert_eq!(dna.comp_vibes, vec![
            "narnia-meets-earthsea".to_string(),
        ]);
    }

    #[test]
    fn test_strip_self_ref_no_series() {
        let mut dna = BookDNA::default();
        dna.comp_vibes = vec![
            "cozy-hogwarts-for-adults".to_string(),
            "dark-academia-thriller".to_string(),
        ];
        dna.comp_authors = vec![
            "agatha-christie".to_string(),
        ];

        // No series, author doesn't match, title doesn't match
        strip_self_referential_comps(
            &mut dna,
            "The Secret History",
            "Donna Tartt",
            None,
        );

        // Everything should survive
        assert_eq!(dna.comp_vibes.len(), 2);
        assert_eq!(dna.comp_authors.len(), 1);
    }

    #[test]
    fn test_strip_self_ref_author_variant() {
        let mut dna = BookDNA::default();
        dna.comp_authors = vec![
            "brandon-sanderson".to_string(),  // self-ref
            "patrick-rothfuss".to_string(),   // clean
        ];

        strip_self_referential_comps(
            &mut dna,
            "Mistborn",
            "Brandon Sanderson",
            Some("Mistborn"),
        );

        assert_eq!(dna.comp_authors, vec!["patrick-rothfuss".to_string()]);
        // "mistborn" in comp_vibes would also be caught but we didn't add any
    }

    #[test]
    fn test_stop_words_dont_false_positive() {
        let mut dna = BookDNA::default();
        dna.comp_vibes = vec![
            "the-dark-tower-meets-narnia".to_string(),   // "the" is stop word — shouldn't match on "the"
            "gothic-noir-for-adults".to_string(),
        ];

        // Book title has "The" — but "the" is a stop word, shouldn't cause removal
        strip_self_referential_comps(
            &mut dna,
            "The Name of the Wind",
            "Patrick Rothfuss",
            Some("The Kingkiller Chronicle"),
        );

        // "wind" from title is significant and NOT in any comp-vibe, so both survive.
        // "name" IS significant and 3+ chars, appears in title but not in vibes.
        // "kingkiller" from series would match if it appeared.
        assert_eq!(dna.comp_vibes.len(), 2);
    }
}
