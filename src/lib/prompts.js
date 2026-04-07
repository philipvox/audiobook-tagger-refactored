// src/lib/prompts.js
// GPT/Claude prompt construction for audiobook metadata enrichment.
// Ported from gpt_consolidated.rs — same prompts, same format.
// Static instruction blocks exported as constants for Settings page customization.

/**
 * Safely serialize a value for inclusion in AI prompts.
 */
function safe(value) {
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(String(value));
}

// ============================================================================
// DEFAULT INSTRUCTION BLOCKS — editable via Settings > Prompt Customization
// ============================================================================

/** System prompt for all audiobook metadata operations. */
export const SYSTEM_PROMPT = 'You extract audiobook metadata. Return ONLY valid JSON, no markdown. Be concise.';

/** Classification instructions (genres, tags, age rating, themes, tropes). */
export const DEFAULT_CLASSIFICATION_INSTRUCTIONS = `═══ SECTION 1: GENRES (1-3 max) ═══
Select from this APPROVED list ONLY:
Literary Fiction, Contemporary Fiction, Historical Fiction, Classics, Mystery, Thriller, Crime, Horror, Romance, Fantasy, Science Fiction, Western, Adventure, Humor, Satire, Women's Fiction, LGBTQ+ Fiction, Short Stories, Anthology, Biography, Autobiography, Memoir, History, True Crime, Science, Popular Science, Psychology, Self-Help, Business, Personal Finance, Health & Wellness, Philosophy, Religion & Spirituality, Politics, Essays, Journalism, Travel, Food & Cooking, Nature, Sports, Music, Art, Education, Parenting & Family, Relationships, Non-Fiction, Young Adult, Middle Grade, Children's, New Adult, Adult, Children's 0-2, Children's 3-5, Children's 6-8, Children's 9-12, Teen 13-17, Audiobook Original, Full Cast Production, Dramatized, Podcast Fiction

CRITICAL RULES:
- Max 3 genres. Specific genres first, broad categories last.
- "Young Adult" and "Teen 13-17" are ONLY for books published in the YA section.
- An adult novel with a young protagonist is NOT YA. Stephen King's The Talisman → Fantasy + Adventure, NOT YA.
- Ender's Game → Science Fiction (NOT YA). To Kill a Mockingbird → Classics (NOT YA).
- Do NOT use genres not in this list.

═══ SECTION 2: TAGS (5-15) ═══
Select from these approved tags ONLY (lowercase-hyphenated):
Sub-genre: cozy-mystery, police-procedural, legal-thriller, medical-thriller, spy, domestic-thriller, noir, hardboiled, heist, whodunit, rom-com, contemporary-romance, historical-romance, paranormal-romance, dark-romance, clean-romance, epic-fantasy, urban-fantasy, dark-fantasy, sword-and-sorcery, cozy-fantasy, grimdark, progression-fantasy, litrpg, space-opera, dystopian, post-apocalyptic, cyberpunk, hard-sci-fi, time-travel, first-contact, gothic, supernatural, cosmic-horror, psychological-horror, folk-horror, haunted-house, southern-gothic
Mood: atmospheric, bittersweet, cozy, dark, emotional, feel-good, funny, haunting, heartwarming, hopeful, intense, lighthearted, melancholic, mysterious, nostalgic, suspenseful, tense, thought-provoking, unsettling, uplifting, whimsical
Pacing: fast-paced, slow-burn, medium-paced, page-turner, unputdownable, action-packed
Style: character-driven, plot-driven, dialogue-heavy, lyrical, unreliable-narrator, multiple-pov, dual-timeline, first-person, nonlinear
Tropes: enemies-to-lovers, friends-to-lovers, second-chance, forced-proximity, found-family, chosen-one, reluctant-hero, antihero, morally-grey, redemption-arc, revenge, quest, survival, coming-of-age, self-discovery
Creatures: vampires, werewolves, fae, witches, ghosts, dragons, aliens, zombies
Setting: small-town, big-city, rural, coastal, academy, space-station, castle, palace, forest, desert, mountains
Themes: family, friendship, grief, healing, identity, justice, love, loyalty, power, sacrifice, survival, trauma, war, mental-health, faith, forgiveness
Content: clean, fade-to-black, mild-steam, steamy, explicit, low-violence, moderate-violence, graphic-violence
Audio: full-cast, single-narrator, dual-narrators, great-character-voices, easy-listening, requires-focus, good-for-commute
Length: under-5-hours, 5-10-hours, 10-15-hours, 15-20-hours, over-20-hours
Series: standalone, in-series, trilogy, long-series
Age: age-childrens, age-middle-grade, age-teens, age-young-adult, age-adult
Rating: rated-g, rated-pg, rated-pg13, rated-r
Audience: for-kids, for-teens, for-ya, not-for-kids
Age-rec: age-rec-all, age-rec-0, age-rec-3, age-rec-6, age-rec-8, age-rec-10, age-rec-12, age-rec-14, age-rec-16, age-rec-18
Awards: bestseller, award-winner, critically-acclaimed, debut, classic, cult-favorite

Required: at least one sub-genre, one mood, one length tag, one series tag, one age tag, one rating tag.

═══ SECTION 3: AGE RATING ═══
Determine:
- intended_for_kids: true ONLY for children's books (Magic Tree House, Diary of a Wimpy Kid, Dog Man)
  FALSE for teen/YA/adult books. FALSE for adult authors (Stephen King). FALSE even if young protagonist.
- age_category: "Children's 0-2" | "Children's 3-5" | "Children's 6-8" | "Children's 9-12" | "Teen 13-17" | "Young Adult" | "Adult"
- content_rating: "G" | "PG" | "PG-13" | "R"

═══ SECTION 4: THEMES & TROPES ═══
- themes: 3-5 abstract concepts (Redemption, Found Family, Coming of Age, Power and Corruption, Identity, Loss and Grief, Good vs Evil, Survival, Love and Sacrifice)
- tropes: 3-5 story patterns (Chosen One, Mentor Figure, Dark Lord, Hidden Heir, Quest, Reluctant Hero, Love Triangle, Fish Out of Water, Unreliable Narrator)`;

/** Description validation/cleaning rules (when description exists). */
export const DEFAULT_DESCRIPTION_VALIDATE_RULES = `STEP 1 - VALIDATE: Check for these problems:
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
- Must work as standalone introduction for new readers`;

/** Description generation rules (when no description exists). */
export const DEFAULT_DESCRIPTION_GENERATE_RULES = `RULES:
1. Write 2-3 sentences summarizing the book's premise
2. Third person, present tense
3. Be factual — only include what you know about this book
4. Target 150-250 characters
5. Focus on plot/premise, not praise
6. If you don't know this book well, write a generic but accurate description based on the genre`;

/** Tag assignment instructions (approved list + rules). */
export const DEFAULT_TAG_INSTRUCTIONS = `═══ APPROVED TAG LIST ═══
Sub-genre: cozy-mystery, police-procedural, legal-thriller, medical-thriller, techno-thriller, spy, domestic-thriller, noir, hardboiled, amateur-sleuth, locked-room, whodunit, heist, cold-case, forensic, rom-com, contemporary-romance, historical-romance, paranormal-romance, fantasy-romance, romantasy, dark-romance, clean-romance, sports-romance, military-romance, royal-romance, billionaire-romance, small-town-romance, holiday-romance, workplace-romance, epic-fantasy, urban-fantasy, dark-fantasy, high-fantasy, low-fantasy, sword-and-sorcery, portal-fantasy, cozy-fantasy, grimdark, progression-fantasy, cultivation, litrpg, gamelit, mythic-fantasy, gaslamp-fantasy, fairy-tale-retelling, space-opera, dystopian, post-apocalyptic, cyberpunk, biopunk, steampunk, hard-sci-fi, soft-sci-fi, military-sci-fi, time-travel, first-contact, alien-invasion, climate-fiction, alternate-history, near-future, gothic, supernatural, cosmic-horror, psychological-horror, folk-horror, body-horror, slasher, haunted-house, creature-feature, occult, southern-gothic
Mood: adventurous, atmospheric, bittersweet, cathartic, cozy, dark, emotional, feel-good, funny, haunting, heartbreaking, heartwarming, hopeful, inspiring, intense, lighthearted, melancholic, mysterious, nostalgic, reflective, romantic, sad, suspenseful, tense, thought-provoking, unsettling, uplifting, whimsical
Pacing: fast-paced, slow-burn, medium-paced, page-turner, unputdownable, leisurely, action-packed
Style: character-driven, plot-driven, dialogue-heavy, descriptive, lyrical, sparse-prose, unreliable-narrator, multiple-pov, dual-timeline, epistolary, first-person, third-person, nonlinear
Romance-tropes: enemies-to-lovers, friends-to-lovers, strangers-to-lovers, second-chance, forced-proximity, fake-relationship, marriage-of-convenience, forbidden-love, love-triangle, grumpy-sunshine, opposites-attract, he-falls-first, she-falls-first, only-one-bed, age-gap, boss-employee, single-parent, secret-identity, arranged-marriage, mutual-pining
Story-tropes: found-family, chosen-one, reluctant-hero, antihero, morally-grey, villain-origin, redemption-arc, revenge, quest, survival, underdog, fish-out-of-water, hidden-identity, mistaken-identity, rags-to-riches, mentor-figure, prophecy, coming-of-age, self-discovery, starting-over
Creatures: vampires, werewolves, shifters, fae, witches, demons, angels, ghosts, dragons, mermaids, gods, monsters, aliens, zombies, psychics, magic-users, immortals
Setting: small-town, big-city, rural, coastal, island, cabin, castle, palace, academy, college, high-school, office, hospital, courtroom, military-base, space-station, spaceship, forest, desert, mountains, arctic, tropical
Historical: regency, victorian, medieval, ancient, renaissance, tudor, viking, 1920s, 1950s, 1960s, 1970s, 1980s, wwi, wwii, civil-war
Themes: family, friendship, grief, healing, identity, justice, love, loyalty, power, sacrifice, survival, trauma, war, class, race, gender, disability, mental-health, addiction, faith, forgiveness, hope, loss, marriage, divorce, aging, death
Content: clean, fade-to-black, mild-steam, steamy, explicit, low-violence, moderate-violence, graphic-violence, clean-language, mild-language, strong-language
Audio: full-cast, single-narrator, dual-narrators, author-narrated, celebrity-narrator, dramatized, sound-effects, male-narrator, female-narrator, multiple-narrators, great-character-voices, soothing-narrator, good-for-commute, good-for-sleep, good-for-roadtrip, requires-focus, easy-listening, great-reread
Length: under-5-hours, 5-10-hours, 10-15-hours, 15-20-hours, over-20-hours
Series: standalone, in-series, duology, trilogy, long-series
Age: age-childrens, age-middle-grade, age-teens, age-young-adult, age-adult
Audience: for-kids, for-teens, for-ya, not-for-kids
Rating: rated-g, rated-pg, rated-pg13, rated-r, rated-x
Age-rec: age-rec-all, age-rec-0, age-rec-3, age-rec-4, age-rec-6, age-rec-8, age-rec-10, age-rec-12, age-rec-14, age-rec-16, age-rec-18
Awards: bestseller, award-winner, critically-acclaimed, debut, classic, cult-favorite

═══ RULES ═══
- Select 12-20 tags covering ALL of these categories: sub-genre (1-3), mood (2-3), pacing (1), style (1-2), tropes (2-3), themes (2-3), content level (1-2), audio production (1), length (1), series status (1), age (1), rating (1), age-rec (1)
- Use ONLY tags from the list above
- Include ONE length tag based on duration
- Include ONE series tag (standalone or in-series/trilogy/long-series)
- Include ONE age tag, ONE rating tag, and ONE age-rec tag
- Include at least one content level tag (violence OR language)
- Include at least one audio production tag`;

// ============================================================================
// PROMPT BUILDERS — use config overrides when available
// ============================================================================

/**
 * Build the metadata resolution prompt (Call A).
 * Resolves: title, subtitle, author, series, sequence, narrator.
 */
export function buildMetadataPrompt(input) {
  let context = '';

  if (input.filename) context += `Filename: ${safe(input.filename)}\n`;
  if (input.folder_name) context += `Folder name: ${safe(input.folder_name)}\n`;
  if (input.folder_path) context += `Folder path: ${safe(input.folder_path)}\n`;
  context += `Current title: ${safe(input.current_title)}\n`;
  context += `Current author: ${safe(input.current_author)}\n`;
  if (input.current_subtitle) context += `Current subtitle: ${safe(input.current_subtitle)}\n`;
  if (input.current_series) context += `Current series: ${safe(input.current_series)}\n`;
  if (input.current_sequence) context += `Current sequence: ${safe(input.current_sequence)}\n`;

  const hasAudible = input.audible_title || input.audible_series;
  if (hasAudible) {
    context += '\n--- Audible/ABS Data ---\n';
    if (input.audible_title) context += `Audible title: ${safe(input.audible_title)}\n`;
    if (input.audible_author) context += `Audible author: ${safe(input.audible_author)}\n`;
    if (input.audible_subtitle) context += `Audible subtitle: ${safe(input.audible_subtitle)}\n`;
    if (input.audible_series) context += `Audible series: ${safe(input.audible_series)}\n`;
    if (input.audible_sequence) context += `Audible sequence: ${safe(input.audible_sequence)}\n`;
  }

  const hasFolderData = input.folder_author || input.folder_series;
  if (hasFolderData) {
    context += '\n--- Parsed Folder Structure (RELIABLE) ---\n';
    if (input.folder_author) context += `Folder author: ${safe(input.folder_author)}\n`;
    if (input.folder_series) context += `Folder series: ${safe(input.folder_series)}\n`;
    if (input.folder_sequence) context += `Folder sequence: ${safe(input.folder_sequence)}\n`;
  }

  if (input.known_author_series?.length > 0) {
    context += '\n--- Author\'s Known Series (USE FOR CONSISTENCY) ---\n';
    for (const series of input.known_author_series) {
      context += `- ${safe(series)}\n`;
    }
  }

  return `Resolve ALL metadata for this audiobook in ONE pass. Determine the correct title, subtitle, author, series, and sequence.

${context}

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
- Folder series is HIGHLY RELIABLE — trust it unless clearly wrong
- Use folder_sequence if Audible/current sequence is missing
- Prequels: sequence 0 or 0.5; Novellas between books: decimals (2.5)
- null ONLY if truly standalone (no folder series, no Audible series, no "Book N" in title)

═══ NARRATOR ═══
- If embedded in filename ("read by Frank Muller") → extract
- Otherwise null

═══ CONFIDENCE ═══
- 90-100: Very confident, multiple sources agree
- 70-89: Confident, folder structure is clear
- 50-69: Low confidence, best guess

Return ONLY valid JSON:
{"title":"Book Title","author":"Author Name","subtitle":null,"series":null,"sequence":null,"narrator":null,"confidence":90,"notes":"brief explanation"}`;
}

/**
 * Build the classification prompt (Call B).
 * @param {object} book - Book metadata
 * @param {object|null} externalData - External provider data
 * @param {string|null} customInstructions - Override for the instruction block
 */
export function buildClassificationPrompt(book, externalData = null, customInstructions = null) {
  let context = `Title: ${safe(book.title)}`;
  if (book.author) context += `\nAuthor: ${safe(book.author)}`;
  if (book.subtitle) context += `\nSubtitle: ${safe(book.subtitle)}`;
  if (book.series) context += `\nSeries: ${safe(book.series)}`;
  if (book.sequence) context += `\nBook #: ${safe(book.sequence)}`;
  if (book.description) context += `\nDescription: ${safe(book.description.substring(0, 500))}`;
  if (book.narrator) context += `\nNarrator: ${safe(book.narrator)}`;
  if (book.published_year || book.year) context += `\nYear: ${book.published_year || book.year}`;
  if (book.publisher) context += `\nPublisher: ${safe(book.publisher)}`;

  if (externalData) {
    if (externalData.genres?.length > 0) {
      context += `\n\n--- External Sources ---`;
      context += `\nGenres from providers: ${externalData.genres.join(', ')}`;
    }
    if (externalData.tags?.length > 0) {
      context += `\nTags from providers: ${externalData.tags.join(', ')}`;
    }
    if (externalData.description && !book.description) {
      context += `\nDescription from providers: ${safe(externalData.description.substring(0, 500))}`;
    }
  }

  const instructions = customInstructions || DEFAULT_CLASSIFICATION_INSTRUCTIONS;

  return `Classify this audiobook into genres, tags, age rating, themes, and tropes.

${context}

${instructions}

Return ONLY valid JSON:
{"genres":["Genre1","Genre2"],"tags":["tag-1","tag-2"],"age_rating":{"intended_for_kids":false,"age_category":"Adult","content_rating":"PG-13"},"themes":["Theme1","Theme2"],"tropes":["Trope1","Trope2"]}`;
}

/**
 * Build the description processing prompt (Call C).
 * @param {object} book - Book metadata
 * @param {string|null} customValidateRules - Override validate rules
 * @param {string|null} customGenerateRules - Override generate rules
 */
export function buildDescriptionPrompt(book, customValidateRules = null, customGenerateRules = null) {
  const hasDescription = book.description && book.description.length > 50;
  const genres = book.genres?.length > 0 ? book.genres.join(', ') : 'unknown';

  if (hasDescription) {
    const rules = customValidateRules || DEFAULT_DESCRIPTION_VALIDATE_RULES;
    return `Analyze and process this audiobook description.

BOOK INFO:
Title: ${safe(book.title)}
Author: ${safe(book.author)}
Genres: ${genres}

EXISTING DESCRIPTION:
${safe(book.description)}

${rules}

Return ONLY valid JSON:
{"description":"the final clean description","action":"kept|rewritten","reason":"brief reason"}`;
  }

  const rules = customGenerateRules || DEFAULT_DESCRIPTION_GENERATE_RULES;
  return `Write a brief audiobook description for ${safe(book.title)} by ${safe(book.author)}.
${book.subtitle ? `Subtitle: ${safe(book.subtitle)}` : ''}
${book.series ? `Series: ${safe(book.series)} #${book.sequence || '?'}` : ''}
Genre: ${genres}

${rules}

Return ONLY valid JSON:
{"description":"your generated description","action":"generated","reason":"no existing description"}`;
}

/**
 * System prompt for BookDNA generation.
 */
export const BOOK_DNA_SYSTEM_PROMPT = `You are a book analyst creating a structured "DNA fingerprint" for audiobooks.
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
  "comp_vibes": ["grimdark-heist", "medieval-noir"],
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
GUIDELINES
══════════════════════════════════════════════════════════════════════════════

LENGTH (based on duration): short (<5h), medium (5-12h), long (12-20h), epic (20+h)
PACING: slow (contemplative), measured, moderate, fast, breakneck (non-stop action)
SHELVES (1-3 ONLY from list): cozy-fantasy, epic-fantasy, dark-fantasy, urban-fantasy, portal-fantasy, fairy-tale-retelling, mythic-fantasy, sword-and-sorcery, grimdark-fantasy, romantic-fantasy, hard-sci-fi, space-opera, cyberpunk, dystopian, post-apocalyptic, first-contact, time-travel, cli-fi, military-sci-fi, biopunk, cozy-mystery, detective-noir, police-procedural, psychological-thriller, legal-thriller, medical-thriller, spy-thriller, cat-and-mouse-thriller, domestic-suspense, locked-room-mystery, gothic-horror, cosmic-horror, supernatural-horror, folk-horror, psychological-horror, slasher, contemporary-romance, historical-romance, paranormal-romance, romantic-comedy, dark-romance, romantasy, small-town-romance, second-chance-romance, literary-fiction, book-club-fiction, family-saga, coming-of-age, campus-novel, satire, southern-gothic, magical-realism, upmarket-fiction, experimental-fiction, historical-fiction, alternate-history, historical-mystery, wartime-fiction, regency, medieval, memoir, true-crime, popular-science, history-narrative, self-help, biography, essay-collection, investigative-journalism, travel-narrative, nature-writing, middle-grade-adventure, ya-dystopian, ya-fantasy, ya-contemporary, superhero-fiction, litrpg, progression-fantasy, western, afrofuturism, solarpunk, new-weird
THEMES (2-4 ONLY from list): identity, belonging, power, corruption, redemption, sacrifice, love, loss, grief, hope, survival, freedom, justice, revenge, forgiveness, family, friendship, loyalty, betrayal, truth, deception, memory, mortality, faith, doubt, ambition, obsession, isolation, connection, duty, honor, class, prejudice, resilience, transformation, innocence, coming-of-age, war, trauma, healing, nature-vs-nurture, technology-vs-humanity, colonialism, rebellion, legacy, fate-vs-free-will, good-vs-evil, self-discovery, addiction, motherhood
TROPES (2-5 ONLY from list): chosen-one, found-family, enemies-to-lovers, slow-burn, love-triangle, unreliable-narrator, heist, locked-room, fish-out-of-water, dark-lord, hidden-heir, mentor-figure, reluctant-hero, antihero, training-arc, tournament, quest, prophecy, time-loop, secret-society, body-swap, amnesia, fake-relationship, forced-proximity, grumpy-sunshine, only-one-bed, dual-timeline, revenge-plot, rags-to-riches, fall-from-grace, morally-grey-protagonist, forbidden-love, star-crossed-lovers, road-trip, survival-situation, haunted-house, final-girl, whodunit, red-herring, cold-case, undercover, prison-escape, last-stand, first-contact, culture-clash, portal, dystopian-resistance, ai-uprising, generation-ship, monster-hunt
RELATIONSHIP FOCUS (1-2): friendship, romance, mentor-student, rivals, family, human-nonhuman, none
NARRATOR PERFORMANCE (1-2): theatrical, character-voices, understated, conversational, documentary
SPECTRUMS (ALL 7 required, -5 to +5): dark-light, serious-funny, plot-character, simple-complex, action-contemplative, intimate-epic-scope, world-density
MOODS (2-3 with intensity 1-10): thrills, drama, romance, horror, mystery, wonder, melancholy, hope, tension, humor, adventure, dread, nostalgia, awe, unease, warmth, fury, propulsive, cozy
COMP AUTHORS (1-2, lowercase-hyphenated): Similar authors
COMP VIBES (5-8, lowercase-hyphenated): Mix of short vibes and "X-meets-Y" mashups
VIOLENCE/INTIMACY (0-5), AUDIO FRIENDLINESS/RE-LISTEN VALUE (0-5)

RULES:
- Use ONLY values from provided lists for shelves, themes, tropes, relationship_focus, narrator_performance
- All strings lowercase-hyphenated
- Spectrum values are SIGNED integers (-5 to +5). Negative = left side of label.
- Return ONLY valid JSON, no explanation`;

/**
 * Compact DNA system prompt for local AI — fewer fields, smaller output.
 * Drops: comp_vibes, spectrums, moods, narrator_performance, comp_authors (verbose/low-value for local).
 * Keeps: core dimensions, shelves, tropes, themes, ratings.
 */
export const BOOK_DNA_SYSTEM_PROMPT_COMPACT = `You analyze audiobook DNA. Return ONLY valid JSON.

{
  "length": "short|medium|long|epic",
  "pacing": "slow|measured|moderate|fast|breakneck",
  "structure": "linear|nonlinear|multiple-timeline|frame-story|epistolary",
  "pov": "first-person|close-third|omniscient-third|multiple-pov",
  "series_position": "standalone|series-start|mid-series|series-end",
  "setting": "urban|rural|fantasy-world|historical|space-station|small-town|multiple-settings",
  "ending_type": "hea|hfn|bittersweet|ambiguous|open|tragic|cathartic",
  "humor_type": "dry-wit|absurdist|dark-comedy|satirical|cozy-banter|none",
  "stakes_level": "personal|local|national|global|cosmic",
  "protagonist_count": "solo|duo|ensemble",
  "prose_style": "sparse|conversational|lyrical|dense",
  "series_dependency": "fully-standalone|works-standalone|needs-prior|must-start-at-one",
  "production": "single-voice|dual-narrator|full-cast|dramatized",
  "audio_friendliness": 4,
  "re_listen_value": 3,
  "violence_level": 2,
  "intimacy_level": 1,
  "shelves": ["epic-fantasy"],
  "tropes": ["quest", "found-family"],
  "themes": ["survival", "loyalty"],
  "relationship_focus": ["friendship"]
}

RULES: Use lowercase-hyphenated strings. Shelves 1-3, tropes 2-4, themes 2-3. Ratings 0-5. Return ONLY JSON.`;

/**
 * Build the user prompt for DNA generation.
 */
export function buildDnaPrompt(book) {
  let prompt = `Generate a BookDNA fingerprint for:\n\nTitle: ${safe(book.title)}\nAuthor: ${safe(book.author)}\n`;

  if (book.description) {
    prompt += `Description: ${safe(book.description.substring(0, 800))}\n`;
  }
  if (book.genres?.length > 0) {
    prompt += `Genres: ${book.genres.join(', ')}\n`;
  }
  if (book.tags?.length > 0) {
    prompt += `Tags: ${book.tags.join(', ')}\n`;
  }
  if (book.narrator) {
    prompt += `Narrator: ${safe(book.narrator)}\n`;
  }
  if (book.duration) {
    const hours = Math.floor(book.duration / 3600);
    const mins = Math.floor((book.duration % 3600) / 60);
    prompt += `Duration: ${hours}h ${mins}m\n`;
  }
  if (book.series) {
    prompt += `Series: ${safe(book.series)}`;
    if (book.sequence) prompt += ` #${book.sequence}`;
    prompt += `\n`;
  }
  if (book.year || book.published_year) {
    prompt += `Published: ${book.year || book.published_year}\n`;
  }

  prompt += `\nReturn the DNA JSON.`;
  return prompt;
}
