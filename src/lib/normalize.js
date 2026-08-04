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
  "(Unabridged Edition)",
  "(Unabridged Audiobook)",
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
  if (word.length < 2 || word.length > 6) return false;
  if (!/^[A-Z0-9&]+$/.test(word)) return false;
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

// Name particles that keep their given casing (usually lowercase) instead of
// being title-cased, e.g. "Ludwig van Beethoven", "Vincent van Gogh".
const NAME_PARTICLES = new Set([
  "de", "van", "von", "la", "le", "da", "di", "del",
  "jr.", "sr.", "ii", "iii", "iv",
]);

// Suffixes whose canonical casing isn't just "capitalize the first letter" -
// applied regardless of the input's original casing so "phd"/"PHD"/"PhD" all
// normalize to the same "PhD".
const SUFFIX_CANONICAL_CASE = new Map([
  ["phd", "PhD"],
  ["md", "MD"],
  ["m.d.", "M.D."],
  ["ph.d.", "Ph.D."],
]);

// Title-case each whitespace-separated word in a name, handling initials
// (capitalizeNamePart), particles (kept as-is), and suffix canonical casing.
function _titleCaseNameWords(str) {
  return str
    .split(/\s+/)
    .map((w) => {
      const lower = w.toLowerCase();
      if (SUFFIX_CANONICAL_CASE.has(lower)) return SUFFIX_CANONICAL_CASE.get(lower);
      if (NAME_PARTICLES.has(lower)) return w;
      return capitalizeNamePart(lower);
    })
    .join(" ");
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

      // Strip trailing punctuation before the acronym/proper-noun check only
      // (re-attached below) so "FBI:" is recognized as the acronym "FBI"
      // instead of failing the check on the trailing colon.
      const trailingPunct = word.match(/[.,:;!?]+$/);
      const core = trailingPunct ? word.slice(0, -trailingPunct[0].length) : word;

      // Preserve acronyms and proper nouns
      if (looksLikeProperNoun(core) || looksLikeAcronym(core)) {
        return core + (trailingPunct ? trailingPunct[0] : "");
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
  let result = title.trim();

  // Iteratively strip junk that sits at the END of the title (plus any trailing
  // dash between tokens). Trailing-only: a junk-looking word in the MIDDLE of a
  // real title (e.g. "The (Complete) Idiot's Guide", "Live in (HQ) Studio") must
  // be preserved \u2014 using lastIndexOf here would corrupt those titles.
  let changed = true;
  while (changed) {
    changed = false;

    const dedashed = result.replace(/[-\u2013]+\s*$/, "").trim();
    if (dedashed !== result) {
      result = dedashed;
      changed = true;
    }

    // Bracketed bitrate markers, e.g. "[64kbps]", "[320kbps]".
    const bitrateMatch = result.match(/\s*\[\d+\s*kbps\]\s*$/i);
    if (bitrateMatch) {
      result = result.slice(0, bitrateMatch.index).trim();
      changed = true;
      continue;
    }

    const lower = result.toLowerCase();
    for (const suffix of JUNK_SUFFIXES) {
      if (lower.endsWith(suffix.toLowerCase())) {
        result = result.slice(0, result.length - suffix.length).trim();
        changed = true;
        break;
      }
    }
  }

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
    if (
      subtitle.length > 2 &&
      !NARRATOR_PREFIXES.some((p) =>
        subtitle.toLowerCase().startsWith(p.toLowerCase())
      )
    ) {
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

  // Handle "Last, First" / "Last, First, Suffix" -> "First Last [Suffix]".
  // Never leave an embedded comma: authors are later split on "," downstream,
  // so "King, Stephen, Jr." must not become "Stephen, Jr. King" (two authors).
  //
  // But a comma is also how co-authors are joined ("Stephen King, Peter
  // Straub"). The "Last, First" swap only makes sense when the first
  // comma-part is a single word (a surname) and the second is 1-2 words (a
  // given name, optionally with a middle name) - if BOTH parts are
  // multi-word, this is a co-author list, not a single inverted name, and
  // swapping would mangle it into one garbled name. In that case each name
  // is cleaned individually and the list is preserved comma-joined.
  const suffixes = ["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "phd", "md", "m.d.", "ph.d."];
  const commaParts = result.split(",").map((p) => p.trim()).filter(Boolean);
  const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

  if (commaParts.length === 2) {
    const [first, second] = commaParts;
    if (suffixes.includes(second.toLowerCase())) {
      // "Name, Suffix" -> "Name Suffix"
      result = `${first} ${second}`;
    } else if (wordCount(first) === 1 && wordCount(second) <= 2) {
      // "Last, First [Middle]" -> "First [Middle] Last"
      result = `${second} ${first}`;
    } else {
      // Co-authors already in "First Last" order - clean each name
      // independently and keep them comma-separated.
      return commaParts.map((p) => _titleCaseNameWords(p)).join(", ");
    }
  } else if (commaParts.length >= 3) {
    const allMultiWord = commaParts.every((p) => wordCount(p) > 1);
    if (allMultiWord) {
      // "Stephen King, Peter Straub, Neil Gaiman" - a co-author list, not a
      // "Last, First, Suffix..." inversion.
      return commaParts.map((p) => _titleCaseNameWords(p)).join(", ");
    }
    // "Last, First, Suffix..." -> "First Last Suffix..."
    const [lastName, firstName, ...rest] = commaParts;
    result = `${firstName} ${lastName} ${rest.join(" ")}`.trim();
  }

  return _titleCaseNameWords(result);
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
 * Validate and extract a year value (1000..currentYear+2, mirrors api.js's
 * isValidYear).
 *
 * Accepts a plain year string or extracts a word-bounded 4-digit year from a
 * larger string. The word boundary keeps this from matching a year-shaped
 * digit run embedded inside a longer number, e.g. an ISBN/ASIN.
 * Returns null if no valid year can be found.
 *
 * @param {string} str
 * @returns {string | null}
 *
 * @example
 * validateYear("2020")              // "2020"
 * validateYear("Released in 2015")  // "2015"
 * validateYear("999")               // null (too old)
 * validateYear("invalid")           // null
 */
export function validateYear(str) {
  const trimmed = str.trim();
  const maxYear = new Date().getFullYear() + 2;

  // Word-boundary match so a year-shaped run embedded in a longer digit
  // string (e.g. an ISBN) is not mistaken for a standalone year.
  const match = trimmed.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  if (!match) return null;

  const num = parseInt(match[0], 10);
  if (num >= 1000 && num <= maxYear) {
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
  result = result.replace(/[:\s-]+(?:track|chapter|part|opening|closing|credits|intro|prologue|epilogue)\s*\d+\s*$/i, "");

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

// Exact (not substring) placeholder values seen in author/narrator fields,
// e.g. ABS sets "Unknown" on unmatched books. Matched case-insensitively
// after trimming - a real name that merely contains one of these words
// (e.g. author "Unknown Soldier") must NOT match, hence exact Set.has()
// rather than a regex/startsWith test.
const PLACEHOLDER_NAMES = new Set([
  "unknown",
  "author unknown",
  "unknown author",
  "unknown narrator",
  "n/a",
  "none",
]);

/**
 * Detect a placeholder author/narrator value (e.g. ABS's "Unknown" fallback
 * for unmatched books), as distinct from a genuinely missing/empty value or a
 * real name. Single source of truth for placeholder detection - reused by
 * `api.js`'s `fix_authors_batch` bad-author check and by ScannerPage's
 * audio-check smart-skip gate (issue #57: a literal "Unknown" author was
 * counted as "present" and blocked audio extraction).
 *
 * Narrower than `isValidAuthor` below: this only flags known placeholder
 * strings (exact match), not other invalid-name heuristics.
 *
 * @param {*} value
 * @returns {boolean}
 *
 * @example
 * isPlaceholderAuthor("Unknown")          // true
 * isPlaceholderAuthor("  N/A ")           // true
 * isPlaceholderAuthor("Unknown Soldier")  // false (real name, not a placeholder)
 * isPlaceholderAuthor(null)               // true
 */
export function isPlaceholderAuthor(value) {
  if (value == null) return true;
  const s = String(value).trim();
  if (!s) return true;
  return PLACEHOLDER_NAMES.has(s.toLowerCase());
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
// Known suffixes that must NOT be treated as a separate author when they
// follow a comma (e.g. "Martin Luther King, Jr." is ONE author, not two).
const AUTHOR_SUFFIXES = new Set([
  "jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "phd", "md", "m.d.", "ph.d.",
]);

/**
 * Split a raw "author" string into individual author names.
 *
 * Splits on "&" and " and " (case-insensitive), and on "," EXCEPT when the
 * comma-delimited part is a known name suffix (Jr, Jr., Sr, Sr., II, III, IV,
 * PhD, MD, M.D., Ph.D.), in which case it is rejoined onto the previous name.
 * Ported from the 2026-07-21 audit finding K: `meta.author.split(/[,&]/)`
 * mangled "Martin Luther King, Jr." into two authors.
 *
 * @param {string} str
 * @returns {string[]}
 *
 * @example
 * splitAuthors("Martin Luther King, Jr.")  // ["Martin Luther King, Jr."]
 * splitAuthors("Stephen King, John Grisham")  // ["Stephen King", "John Grisham"]
 * splitAuthors("Stephen King & John Grisham")  // ["Stephen King", "John Grisham"]
 */
export function splitAuthors(str) {
  if (!str || typeof str !== "string") return [];

  // Split on "&" and " and " first (word-boundary, case-insensitive).
  const chunks = str.split(/\s*&\s*|\s+and\s+/i).map((c) => c.trim()).filter(Boolean);

  const authors = [];
  for (const chunk of chunks) {
    const commaParts = chunk.split(",").map((p) => p.trim()).filter(Boolean);
    for (const part of commaParts) {
      const isSuffix = AUTHOR_SUFFIXES.has(part.toLowerCase());
      if (isSuffix && authors.length > 0) {
        authors[authors.length - 1] = `${authors[authors.length - 1]}, ${part}`;
      } else {
        authors.push(part);
      }
    }
  }

  return authors;
}

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
