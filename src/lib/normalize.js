// Text normalization utilities for audiobook metadata
// Ported from src-tauri/src/normalize.rs

// Words that should remain lowercase in titles (unless first/last word)
const LOWERCASE_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "for", "yet", "so",
  "at", "by", "in", "of", "on", "to", "up", "as", "is", "it",
  "if", "be", "vs", "via", "de", "la", "le", "el", "en", "et",
]);

// Common junk suffixes to remove from titles
const JUNK_SUFFIXES = [
  "(Unabridged)",
  "[Unabridged]",
  "(Abridged)",
  "[Abridged]",
  "(Audiobook)",
  "[Audiobook]",
  "- Audiobook Edition",
  "- Audiobook",
  "- Unabridged Edition",
  "- Unabridged",
  "Audiobook Edition",
  "Unabridged Edition",
  "(Retail)",
  "[Retail]",
  "(MP3)",
  "[MP3]",
  "(M4B)",
  "[M4B]",
  "320kbps",
  "256kbps",
  "128kbps",
  "64kbps",
  "(HQ)",
  "[HQ]",
  "(Complete)",
  "[Complete]",
  "(Full Cast)",
  "[Full Cast]",
];

// Prefixes that indicate narration info in titles
const NARRATOR_PREFIXES = [
  "Read by",
  "Narrated by",
  "Performed by",
  "With",
];

// Known acronyms that should stay uppercase
const KNOWN_ACRONYMS = new Set([
  // Organizations/standards
  "NASA", "FBI", "CIA", "MIT", "BBC", "CNN", "HBO", "NBA", "NFL", "MLB",
  "NCAA", "NATO", "UN", "EU", "UK", "USA", "IBM", "AT&T", "NYPD", "LAPD",
  // Technical
  "AI", "API", "CEO", "CFO", "CTO", "PhD", "MD", "DNA", "RNA", "HIV",
  "AIDS", "PTSD", "ADHD", "IQ", "EQ", "GPS", "TV", "DVD", "CD", "PC",
  "VR", "AR", "IoT", "SaaS", "PDF", "USB", "HTML", "CSS", "SQL",
  // Common in titles
  "WWII", "WWI", "WWIII", "NYC", "LA", "DC", "SF",
]);

/**
 * Capitalize the first letter of a word.
 * @param {string} word
 * @returns {string}
 */
function capitalizeFirst(word) {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Check if a word looks like a proper noun (mixed case, e.g. "iPhone", "McDonald").
 * @param {string} word
 * @returns {boolean}
 */
function looksLikeProperNoun(word) {
  if (word.length < 2) return false;

  const hasLowercase = /[a-z]/.test(word);
  const hasUppercaseAfterFirst = /.[A-Z]/.test(word);

  return hasLowercase && hasUppercaseAfterFirst;
}

/**
 * Check if a word looks like a known acronym (all caps, 2-4 chars).
 * @param {string} word
 * @returns {boolean}
 */
function looksLikeAcronym(word) {
  if (word.length < 2 || word.length > 4) return false;
  if (!/^[A-Z0-9]+$/.test(word)) return false;
  return KNOWN_ACRONYMS.has(word);
}

/**
 * Capitalize a name part, handling initials like "j.r.r." or "j.k."
 * @param {string} word
 * @returns {string}
 */
function capitalizeNamePart(word) {
  if (word.includes(".")) {
    return word
      .split(".")
      .map((part) => (part === "" ? "" : capitalizeFirst(part)))
      .join(".");
  }
  return capitalizeFirst(word);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Convert a title to proper title case.
 *
 * Preserves acronyms (NASA, FBI) and mixed-case proper nouns (iPhone, McDonald).
 * Keeps articles/prepositions lowercase when they are not the first or last word.
 *
 * @param {string} str - The title string to convert.
 * @returns {string} The title-cased string.
 *
 * @example
 * toTitleCase("the lord of the rings")  // "The Lord of the Rings"
 * toTitleCase("A TALE OF TWO CITIES")   // "A Tale of Two Cities"
 */
export function toTitleCase(str) {
  const words = str.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  return words
    .map((word, i) => {
      const isFirst = i === 0;
      const isLast = i === words.length - 1;

      // Preserve acronyms and proper nouns
      if (looksLikeProperNoun(word) || looksLikeAcronym(word)) {
        return word;
      }

      const lower = word.toLowerCase();

      if ((isFirst || isLast) || !LOWERCASE_WORDS.has(lower)) {
        return capitalizeFirst(lower);
      }
      return lower;
    })
    .join(" ");
}

/**
 * Remove junk suffixes from a title.
 *
 * Strips things like "(Unabridged)", "[Audiobook]", "320kbps", etc.
 *
 * @param {string} title
 * @returns {string}
 *
 * @example
 * removeJunkSuffixes("The Hobbit (Unabridged)")       // "The Hobbit"
 * removeJunkSuffixes("1984 [Audiobook] 320kbps")       // "1984"
 */
export function removeJunkSuffixes(title) {
  let result = title;

  for (const suffix of JUNK_SUFFIXES) {
    const suffixLower = suffix.toLowerCase();
    // Loop to remove repeated occurrences
    let changed = true;
    while (changed) {
      const lower = result.toLowerCase();
      const pos = lower.lastIndexOf(suffixLower);
      if (pos !== -1) {
        result = (result.slice(0, pos) + result.slice(pos + suffix.length)).trim();
      } else {
        changed = false;
      }
    }
  }

  // Remove trailing dashes
  result = result.replace(/[-\u2013]+\s*$/, "").trim();

  return result;
}

/**
 * Remove series information from a title.
 *
 * Strips patterns like "(Wheel of Time #1)", "Book 1", "Vol. 3", etc.
 *
 * @param {string} title
 * @returns {string}
 *
 * @example
 * stripSeriesFromTitle("The Eye of the World (Wheel of Time #1)")  // "The Eye of the World"
 * stripSeriesFromTitle("Harry Potter, Book 1")                      // "Harry Potter"
 */
export function stripSeriesFromTitle(title) {
  let result = title;

  // Pattern: (Series Name #N) or (Series Name, Book N)
  result = result.replace(/\s*\([^)]+(?:#\d+|Book\s*\d+|Vol\.?\s*\d+)\s*\)\s*$/, "");

  // Pattern: [Series Name #N]
  result = result.replace(/\s*\[[^\]]+(?:#\d+|Book\s*\d+|Vol\.?\s*\d+)\s*\]\s*$/, "");

  // Pattern: Title, Book N or Title Book N
  result = result.replace(/,?\s*Book\s*\d+\s*$/, "");

  // Pattern: Title, Vol. N or Title, Volume N
  result = result.replace(/,?\s*Vol\.?\s*\d+\s*$/, "");
  result = result.replace(/,?\s*Volume\s*\d+\s*$/, "");

  // Pattern: Title #N at end
  result = result.replace(/\s*#\d+\s*$/, "");

  return result.trim();
}

/**
 * Extract subtitle from a title that contains both.
 *
 * Splits on `:` or ` - ` / ` \u2013 ` / ` \u2014 ` separators.
 * Ignores narrator credits after the separator.
 *
 * @param {string} title
 * @returns {{ title: string, subtitle: string | null }}
 *
 * @example
 * extractSubtitle("Dune: The Desert Planet")
 * // { title: "Dune", subtitle: "The Desert Planet" }
 *
 * extractSubtitle("Simple Title")
 * // { title: "Simple Title", subtitle: null }
 */
export function extractSubtitle(title) {
  // Check for colon separator
  const colonPos = title.indexOf(":");
  if (colonPos !== -1) {
    const mainTitle = title.slice(0, colonPos).trim();
    const subtitle = title.slice(colonPos + 1).trim();
    if (subtitle.length > 2) {
      return { title: mainTitle, subtitle };
    }
  }

  // Check for dash/em-dash separator
  const separators = [" - ", " \u2013 ", " \u2014 "];
  for (const sep of separators) {
    const pos = title.indexOf(sep);
    if (pos !== -1) {
      const mainTitle = title.slice(0, pos).trim();
      const subtitle = title.slice(pos + sep.length).trim();

      // Only treat as subtitle if substantial and not a narrator credit
      if (
        subtitle.length > 2 &&
        !NARRATOR_PREFIXES.some((p) =>
          subtitle.toLowerCase().startsWith(p.toLowerCase())
        )
      ) {
        return { title: mainTitle, subtitle };
      }
    }
  }

  return { title, subtitle: null };
}

/**
 * Clean an author name.
 *
 * - Removes "Written by", "by" prefixes
 * - Converts "Last, First" to "First Last"
 * - Title-cases name parts while preserving initials (J.R.R.) and particles (de, van)
 *
 * @param {string} name
 * @returns {string}
 *
 * @example
 * cleanAuthorName("written by Stephen King")  // "Stephen King"
 * cleanAuthorName("tolkien, j.r.r.")          // "J.R.R. Tolkien"
 */
export function cleanAuthorName(name) {
  let result = name.trim();

  // Remove common prefixes (case-insensitive) - check longest first
  const prefixes = ["written by: ", "written by ", "author: ", "by: ", "by "];
  for (const prefix of prefixes) {
    if (result.toLowerCase().startsWith(prefix)) {
      result = result.slice(prefix.length).trim();
      break;
    }
  }

  // Remove quotes
  result = result.replace(/^["']|["']$/g, "").trim();

  // Handle "Last, First" format -> "First Last"
  const commaPos = result.indexOf(",");
  if (commaPos !== -1) {
    const lastName = result.slice(0, commaPos).trim();
    const firstName = result.slice(commaPos + 1).trim();

    const suffixes = ["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "phd", "md"];
    if (!suffixes.includes(firstName.toLowerCase())) {
      result = `${firstName} ${lastName}`;
    }
  }

  // Title-case name parts, handling initials and particles
  const particles = new Set([
    "de", "van", "von", "la", "le", "da", "di", "del",
    "jr.", "sr.", "ii", "iii", "iv",
  ]);

  const words = result.split(/\s+/).map((w) => {
    const lower = w.toLowerCase();
    if (particles.has(lower)) {
      return w;
    }
    return capitalizeNamePart(lower);
  });

  return words.join(" ");
}

/**
 * Clean a narrator name.
 *
 * Removes "Narrated by", "Read by", "Performed by" prefixes,
 * then applies the same cleaning rules as author names.
 *
 * @param {string} name
 * @returns {string}
 *
 * @example
 * cleanNarratorName("Narrated by Jim Dale")  // "Jim Dale"
 * cleanNarratorName("Read by: Kate Reading")  // "Kate Reading"
 */
export function cleanNarratorName(name) {
  let result = name.trim();

  // Remove common prefixes - check longest first
  const prefixes = [
    "narrated by: ", "narrated by ",
    "performed by: ", "performed by ",
    "read by: ", "read by ",
    "narrator: ",
  ];
  for (const prefix of prefixes) {
    if (result.toLowerCase().startsWith(prefix)) {
      result = result.slice(prefix.length).trim();
      break;
    }
  }

  // Apply same cleaning as author
  return cleanAuthorName(result);
}

/**
 * Validate and extract a year value (1900-2099).
 *
 * Accepts a plain year string or extracts a 4-digit year from a larger string.
 * Returns null if no valid year can be found.
 *
 * @param {string} str
 * @returns {string | null}
 *
 * @example
 * validateYear("2020")              // "2020"
 * validateYear("Released in 2015")  // "2015"
 * validateYear("1800")              // null (too old)
 * validateYear("invalid")           // null
 */
export function validateYear(str) {
  const trimmed = str.trim();

  // Try to parse as a plain number
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && String(num) === trimmed && num >= 1900 && num <= 2099) {
    return String(num);
  }

  // Try to extract a 4-digit year from the string
  const match = trimmed.match(/(19|20)\d{2}/);
  if (match) {
    return match[0];
  }

  return null;
}

// =============================================================================
// Additional utilities (ported for completeness)
// =============================================================================

/**
 * Strip leading track/chapter numbers from titles.
 *
 * @param {string} title
 * @returns {string}
 *
 * @example
 * stripLeadingTrackNumber("01 - Chapter One")     // "Chapter One"
 * stripLeadingTrackNumber("Track 05 - Title")      // "Title"
 */
export function stripLeadingTrackNumber(title) {
  let result = title.trim();

  // Pattern: "1 - Title", "01 - Title", "1. Title", "01. Title"
  let m = result.match(/^(?:\d{1,3})\s*[-\u2013.]\s*(.+)$/);
  if (m) {
    result = m[1].trim();
  }

  // Pattern: "Track 1 - Title", "Chapter 1 - Title", "Part 1 - Title"
  m = result.match(/^(?:track|chapter|part|ch\.?|disc|cd)\s*\d+\s*[-\u2013:]\s*(.+)$/i);
  if (m) {
    result = m[1].trim();
  }

  return result;
}

/**
 * Strip common track/file-derived suffixes from titles.
 *
 * @param {string} title
 * @returns {string}
 */
export function stripTrackSuffixes(title) {
  let result = title;

  const trackSuffixes = [
    ": Opening Credits", ": Opening", ": Closing Credits", ": Credits",
    " - Opening Credits", " - Opening", " - Closing Credits", " - Credits",
    ": Track 1", ": Chapter 1", ": Part 1", ": Intro",
    " - Track 1", " - Chapter 1", " - Part 1", " - Intro",
    ": Prologue", ": Epilogue", " - Prologue", " - Epilogue",
  ];

  for (const suffix of trackSuffixes) {
    if (result.toLowerCase().endsWith(suffix.toLowerCase())) {
      result = result.slice(0, result.length - suffix.length).trim();
      break;
    }
  }

  // Pattern: "(Part N of M)" or "(Track N of M)"
  result = result.replace(/\s*\(\s*(?:part|track|disc|cd)\s*\d+\s*(?:of\s*\d+)?\s*\)\s*$/i, "");

  // Pattern: ": Track N" or " - Track N" at end
  result = result.replace(/[:\s-]+(?:track|chapter|part|opening|closing|credits|intro|prologue|epilogue)\s*\d*\s*$/i, "");

  return result.trim();
}

/**
 * Full title normalization pipeline.
 *
 * 1. Strip leading track numbers
 * 2. Strip track-derived suffixes
 * 3. Remove junk suffixes (Unabridged, Audiobook, etc.)
 * 4. Remove series info
 * 5. Apply title case
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  let result = stripLeadingTrackNumber(title);
  result = stripTrackSuffixes(result);
  result = removeJunkSuffixes(result);
  result = stripSeriesFromTitle(result);
  result = toTitleCase(result);
  return result.trim();
}

/**
 * Clean a title (without series stripping).
 *
 * @param {string} title
 * @returns {string}
 */
export function cleanTitle(title) {
  let result = stripLeadingTrackNumber(title);
  result = stripTrackSuffixes(result);
  result = removeJunkSuffixes(result);
  result = toTitleCase(result);
  return result.trim();
}

/**
 * Validate an author name. Returns false for obviously invalid names.
 *
 * @param {string} author
 * @returns {boolean}
 */
export function isValidAuthor(author) {
  const lower = author.toLowerCase().trim();

  const invalid = [
    "unknown", "unknown author", "various", "various authors",
    "n/a", "na", "none", "author", "audiobook", "narrator",
  ];
  if (invalid.includes(lower)) return false;
  if (!/[a-zA-Z]/.test(author)) return false;
  if (author.length < 2) return false;

  return true;
}

/**
 * Normalize a description: strip HTML, decode entities, collapse whitespace.
 *
 * @param {string} description
 * @param {number} [maxLength] - Optional max length (truncates at sentence/word boundary).
 * @returns {string}
 */
export function normalizeDescription(description, maxLength) {
  let result = description;

  // Remove HTML tags
  result = result.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  result = result
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "");

  // Normalize whitespace
  result = result.replace(/\s+/g, " ").trim();

  // Optionally truncate
  if (maxLength != null && result.length > maxLength) {
    const sentenceEnd = result.lastIndexOf(". ", maxLength);
    if (sentenceEnd !== -1) {
      result = result.slice(0, sentenceEnd + 1);
    } else {
      const wordEnd = result.lastIndexOf(" ", maxLength);
      if (wordEnd !== -1) {
        result = result.slice(0, wordEnd) + "...";
      } else {
        result = result.slice(0, maxLength) + "...";
      }
    }
  }

  return result;
}
