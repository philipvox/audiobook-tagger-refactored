// applyAiResults - pure per-group appliers for the Enrich actions (audit H-3,
// M-5, M-7): Fix Titles, Fix Series, Fix Subtitles, Clean Genres (AI), Lookup
// Age, ISBN lookup and Check by Audio.
//
// Every applier takes (group, entry) where `entry` is that book's backend
// result (or a { success: false, error } the caller built from a rejection),
// and returns { group, outcome }:
//   'changed'   a value was applied and stamped via applyMetadataToGroup
//   'unchanged' the call worked but there was nothing to apply
//   'skipped'   the book was deliberately left alone (e.g. unknown series list)
//   'warning'   the call worked but the answer was unusable (amber pill)
//   'notfound'  a lookup found nothing (not an error)
//   'failed'    the call failed; group.lastError says why
//   'none'      no entry for this book
//
// Data preservation: a null, empty or placeholder value keeps the current
// value; tags and genres only change through the shared merge helpers.

import { applyMetadataToGroup } from './applyMetadata.js';
import { mergeGenres } from './mergeGenres.js';
import { mergeClassifyTags } from './mergeClassifyTags.js';
import { isPlaceholderSeries, stripEmbeddedSequence } from './absPayload.js';
import { isPlaceholderAuthor, isPlaceholderTitle } from './normalize.js';
import { enforceGenrePolicyWithSplit, splitCombinedGenres } from './genres.js';
import { mapAgeCategory } from './ageCategory.js';
import { severityForKind } from './errorDetail.js';
import { extractNarrator } from './extractNarrator.js';

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const same = (a, b) => (a == null ? '' : String(a)) === (b == null ? '' : String(b));
const lower = (v) => String(v).trim().toLowerCase();
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const errorMessage = (entry, fallback) => {
  const e = entry?.error;
  if (!e) return fallback;
  return String(e.message ?? e);
};

function failed(group, stage, entry, fallback) {
  const lastError = entry?.errorDetail
    ? { ...entry.errorDetail, severity: 'error' }
    : { stage, kind: 'network', message: errorMessage(entry, fallback), severity: 'error' };
  return { group: { ...group, lastError }, outcome: 'failed' };
}

function warned(group, detail) {
  return {
    group: { ...group, lastError: { ...detail, severity: severityForKind(detail.kind) } },
    outcome: 'warning',
  };
}

// A clean run clears an earlier error from the same stage only.
const clearStage = (group, stage) =>
  group.lastError && group.lastError.stage === stage ? { ...group, lastError: undefined } : group;

const isFailure = (entry) => !entry || entry.success !== true;

// ---- Fix Titles: title, author, subtitle (never series) ----
export function applyTitleResult(group, entry) {
  if (!entry) return { group, outcome: 'none' };
  if (isFailure(entry) || !entry.result) return failed(group, 'resolve', entry, 'Title lookup failed.');
  // Low confidence or an empty answer: the handler kept the current values;
  // apply nothing and show why.
  if (entry.errorDetail) return warned(group, entry.errorDetail);

  const m = group.metadata || {};
  const r = entry.result;
  const updates = {};
  if (has(r.title) && !isPlaceholderTitle(r.title) && r.title !== m.title) updates.title = r.title;
  if (has(r.author) && !isPlaceholderAuthor(r.author) && r.author !== m.author) updates.author = r.author;
  if (has(r.subtitle) && !isPlaceholderSeries(r.subtitle) && !same(r.subtitle, m.subtitle)) updates.subtitle = r.subtitle;

  const fields = Object.keys(updates);
  if (fields.length === 0) return { group: clearStage(group, 'resolve'), outcome: 'unchanged' };
  return { group: clearStage(applyMetadataToGroup(group, updates, fields), 'resolve'), outcome: 'changed' };
}

// ---- Fix Series: replace the primary series (M-5) ----
export const UNRESOLVED_SERIES_MESSAGE =
  "Fix Series skipped this book: its series could not be read from AudiobookShelf. Re-import it first.";

export function applySeriesResult(group, entry) {
  const m = group.metadata || {};
  // Its real series list is unknown, so any change could drop a series.
  if (m.series_unresolved === true) {
    return {
      group: { ...group, lastError: { stage: 'series', kind: 'series', message: UNRESOLVED_SERIES_MESSAGE, severity: 'warn' } },
      outcome: 'skipped',
    };
  }
  if (!entry) return { group, outcome: 'none' };
  if (isFailure(entry) || !entry.result) return failed(group, 'series', entry, 'Series lookup failed.');
  if (entry.errorDetail) return warned(group, entry.errorDetail);

  const r = entry.result;
  if (!has(r.series) || isPlaceholderSeries(r.series)) {
    return { group: clearStage(group, 'series'), outcome: 'unchanged' };
  }
  const stripped = stripEmbeddedSequence(String(r.series).trim());
  const series = stripped.name;
  const sequence = has(r.sequence) ? String(r.sequence).trim() : (stripped.sequence ?? m.sequence ?? null);

  const fields = [];
  if (series !== m.series) fields.push('series');
  if (!same(sequence, m.sequence)) fields.push('sequence');
  if (fields.length === 0) return { group: clearStage(group, 'series'), outcome: 'unchanged' };
  // No all_series in the updates: syncAllSeries (inside applyMetadataToGroup)
  // replaces the primary entry in place, or promotes the named secondary
  // series, and keeps every other series (D-2).
  const next = applyMetadataToGroup(group, { series, sequence }, fields);
  return { group: clearStage(next, 'series'), outcome: 'changed' };
}

// ---- Fix Subtitles ----
export function applySubtitleResult(group, entry) {
  if (!entry) return { group, outcome: 'none' };
  if (isFailure(entry)) return failed(group, 'subtitles', entry, 'Subtitle lookup failed.');
  const subtitle = has(entry.subtitle) ? String(entry.subtitle).trim() : null;
  if (!entry.fixed || !subtitle || isPlaceholderSeries(subtitle) || same(subtitle, group.metadata?.subtitle)) {
    return { group: clearStage(group, 'subtitles'), outcome: 'unchanged' };
  }
  return { group: clearStage(applyMetadataToGroup(group, { subtitle }, ['subtitle']), 'subtitles'), outcome: 'changed' };
}

// ---- Clean Genres (AI) ----
// A genre from the import snapshot survives unless the answer holds an exact
// replacement for the whole genre: the genre itself (any casing), or, for a
// single genre, the one value the genre policy maps it to ("Sci-Fi" ->
// "Science Fiction"). A compound genre ("Biography, Memoir") is never
// replaced by an answer that holds some of its parts: when in doubt the
// snapshot genre stays and the answer's genres are added beside it.
function isReplaced(genre, cleanedKeys) {
  if (cleanedKeys.has(lower(genre))) return true;
  if (splitCombinedGenres([genre]).length !== 1) return false;
  const mapped = enforceGenrePolicyWithSplit([genre]);
  return mapped.length === 1 && cleanedKeys.has(lower(mapped[0]));
}

export function applyGenreCleanupResult(group, entry) {
  if (!entry) return { group, outcome: 'none' };
  if (isFailure(entry)) return failed(group, 'genres', entry, 'Genre cleanup failed.');
  const current = Array.isArray(group.metadata?.genres) ? group.metadata.genres : [];
  const cleaned = (Array.isArray(entry.cleaned_genres) ? entry.cleaned_genres : []).filter(has);
  if (cleaned.length === 0) return { group, outcome: 'unchanged' };

  const original = group.abs_original?.genres;
  const originalKeys = new Set((Array.isArray(original) ? original : []).filter(has).map(lower));
  const cleanedKeys = new Set(cleaned.map(lower));
  const kept = current.filter((g) => has(g) && originalKeys.has(lower(g)) && !isReplaced(g, cleanedKeys));
  // Kept snapshot genres are appended uncapped: they are never trimmed.
  const genres = mergeGenres(cleaned, kept, { preserve: true, max: Infinity }).genres;

  if (sameList([...genres].sort(), [...current].sort())) {
    return { group: clearStage(group, 'genres'), outcome: 'unchanged' };
  }
  return { group: clearStage(applyMetadataToGroup(group, { genres }, ['genre']), 'genres'), outcome: 'changed' };
}

// The static (no AI) cleanup answers { id, changed, cleaned_genres } with no
// success flag. It goes through the same merge, so it stamps changedFields and
// never drops a genre that was in the import snapshot without a replacement.
export function applyStaticGenreCleanupResult(group, entry) {
  if (!entry) return { group, outcome: 'none' };
  if (!entry.changed) return { group, outcome: 'unchanged' };
  return applyGenreCleanupResult(group, { success: true, cleaned_genres: entry.cleaned_genres });
}

// ---- Lookup Age ----
// The age-tag policy lives in mergeClassifyTags (D-3, one place): a tag that
// was in ABS at import (originalTags) is never removed; only age tags added
// this session are replaced. Existing order is kept, new tags appended.
export function mergeAgeTags(existingTags, ageTags, originalTags) {
  return mergeClassifyTags(existingTags, { age_tags: ageTags }, Array.isArray(originalTags) ? originalTags : []).tags;
}

// Age tags go through mergeClassifyTags (curated tags kept, stale age tags
// replaced). With addGenre, a non-adult age category is added as a genre via
// mergeGenres, which never drops an existing genre.
export function applyAgeResult(group, entry, { addGenre = true } = {}) {
  if (!entry) return { group, outcome: 'none' };
  if (isFailure(entry)) return failed(group, 'age', entry, 'Age lookup failed.');
  const m = group.metadata || {};
  const ageTags = (Array.isArray(entry.age_tags) ? entry.age_tags : []).filter(has);
  const category = has(entry.age_category) ? String(entry.age_category).trim() : null;
  if (ageTags.length === 0 && !category) {
    return warned(group, { stage: 'age', kind: 'empty-content', message: 'The AI returned no age rating, so nothing was changed.' });
  }

  const updates = {};
  const fields = [];
  const existingTags = Array.isArray(m.tags) ? m.tags : [];
  if (ageTags.length > 0) {
    // No snapshot (local files): every current tag counts as existing, same
    // rule as applyTagResults' keepTags.
    const tags = mergeAgeTags(existingTags, ageTags, group.abs_original?.tags ?? existingTags);
    if (!sameList(tags, existingTags)) {
      updates.tags = tags;
      fields.push('tags');
    }
  }
  const mapped = has(entry.age_rating) ? entry.age_rating : mapAgeCategory(category);
  if (addGenre && category && mapped && mapped !== 'Adult') {
    const merged = mergeGenres(m.genres, [category], { preserve: true });
    if (merged.changed) {
      updates.genres = merged.genres;
      fields.push('genre');
    }
  }
  if (mapped && mapped !== m.age_rating) updates.age_rating = mapped;
  if (has(entry.content_rating) && entry.content_rating !== m.content_rating) updates.content_rating = entry.content_rating;

  if (Object.keys(updates).length === 0) return { group: clearStage(group, 'age'), outcome: 'unchanged' };
  const next = applyMetadataToGroup(group, updates, fields);
  const changedFields = next.changedFields.includes('age') ? next.changedFields : [...next.changedFields, 'age'];
  return { group: clearStage({ ...next, changedFields }, 'age'), outcome: 'changed' };
}

// The AI Tags age sub-step: age tags only (no genre), and a failed or empty
// age answer never replaces an error another stage (the tags step) already
// put on the book. Only a clean age result clears an age error.
export function applyAgeTagsResult(group, entry) {
  const out = applyAgeResult(group, entry, { addGenre: false });
  const bad = out.outcome === 'failed' || out.outcome === 'warning';
  if (bad && group.lastError && group.lastError.stage !== 'age') return { group, outcome: out.outcome };
  return out;
}

// ---- ISBN / ASIN lookup ----
export function applyIsbnResult(group, entry) {
  if (!entry) return { group, outcome: 'none' };
  if (entry.success === true && (has(entry.isbn) || has(entry.asin))) {
    const m = group.metadata || {};
    const updates = {};
    if (has(entry.isbn) && entry.isbn !== m.isbn) updates.isbn = entry.isbn;
    if (has(entry.asin) && entry.asin !== m.asin) updates.asin = entry.asin;
    const fields = Object.keys(updates);
    if (fields.length === 0) return { group: clearStage(group, 'lookup-isbn'), outcome: 'unchanged' };
    return { group: clearStage(applyMetadataToGroup(group, updates, fields), 'lookup-isbn'), outcome: 'changed' };
  }
  // A lookup that errored (HTTP, network) carries errorDetail; a clean miss does not.
  if (entry.errorDetail) return failed(group, 'lookup-isbn', entry, 'ISBN lookup failed.');
  return { group, outcome: 'notfound' };
}

// ---- Check by Audio ----
const MISSING = {
  title: (m) => isPlaceholderTitle(m.title),
  author: (m) => isPlaceholderAuthor(m.author),
  narrator: (m) => isPlaceholderAuthor(m.narrator),
  subtitle: (m) => !has(m.subtitle),
  publisher: (m) => !has(m.publisher),
  language: (m) => !has(m.language),
};

// The metadata updates one audio-intro result supplies for `field`
// ('all' | 'narrator' | 'author' | 'title' | 'publisher' | 'language').
// Without force only missing (or placeholder) values are filled.
export function audioIntroUpdates(metadata, result, field = 'all', force = false) {
  const m = metadata || {};
  const want = (f) => field === 'all' || field === f;
  const fill = (f) => force || MISSING[f](m);
  const updates = {};
  const narrators = (result.narrators || []).filter((n) => has(n) && !isPlaceholderAuthor(n));
  if (want('narrator') && narrators.length > 0 && fill('narrator')) {
    updates.narrators = narrators;
    updates.narrator = narrators[0];
  }
  const author = (result.authors || []).find((a) => has(a) && !isPlaceholderAuthor(a));
  if (want('author') && author && fill('author')) updates.author = author;
  if (want('title') && has(result.title) && !isPlaceholderTitle(result.title)) {
    if (fill('title')) updates.title = result.title;
    if (has(result.subtitle) && fill('subtitle')) updates.subtitle = result.subtitle;
  }
  const publisher = result.publisher || result.audio_publisher;
  if (want('publisher') && has(publisher) && fill('publisher')) updates.publisher = publisher;
  if (want('language') && has(result.language) && fill('language')) updates.language = result.language;
  // Drop values equal to the current ones so they are not stamped as changes.
  for (const k of Object.keys(updates)) {
    if (k !== 'narrators' && same(updates[k], m[k])) delete updates[k];
  }
  if (!('narrator' in updates)) delete updates.narrators;
  return updates;
}

// result: one AudioIntroResult (src-tauri/src/whisper.rs), whose `status` is
// "ok" | "failed" | "cancelled" | "timed_out" with `error` when it stopped
// early, or a { success: false, error } built from a rejected call.
export function applyAudioResult(group, result, field = 'all', force = false) {
  if (!result) return { group, outcome: 'none' };
  const status = result.status || (result.transcript == null ? 'failed' : 'ok');
  const cause = has(result.error) ? String(result.error?.message ?? result.error) : '';
  // Stopped by Cancel: not a failure, and nothing to say on the book.
  if (status === 'cancelled') return { group, outcome: 'cancelled' };
  if (status === 'timed_out') {
    return {
      group: { ...group, lastError: { stage: 'audio', kind: 'timeout', severity: 'error',
        message: `Check by Audio timed out${cause ? `: ${cause}` : '.'}` } },
      outcome: 'timedout',
    };
  }
  // No transcript at all: download, FFmpeg or Whisper failed for this book,
  // or the whole call was rejected (no key, ffmpeg missing, no ABS URL).
  if (result.success === false || status === 'failed' || result.transcript == null) {
    return failed(group, 'audio', null, cause
      ? `Could not transcribe the audio intro: ${cause}`
      : 'Could not transcribe the audio intro (download, FFmpeg or Whisper failed).');
  }
  const updates = audioIntroUpdates(group.metadata, result, field, force);
  const fields = Object.keys(updates).filter((k) => k !== 'narrators');
  if (fields.length === 0) return { group: clearStage(group, 'audio'), outcome: 'unchanged' };
  return { group: clearStage(applyMetadataToGroup(group, updates, fields), 'audio'), outcome: 'changed' };
}

// ---- Resolve Metadata ----
// entry: one resolve_metadata_batch result. gatherDetail: the errorDetail the
// earlier gather step recorded for this book, if any. A resolve-stage error
// wins over the gather-stage one (resolve runs after gather).
export function applyResolveResult(group, entry, gatherDetail) {
  const r = entry;
  if (!r) return group;
  const g = group;
  const errorSource = r.errorDetail || gatherDetail;
  let lastError;
  if (errorSource) {
    const isHardFailure = r.error || r.success === false || ['network', 'http', 'parse', 'schema'].includes(errorSource.kind);
    lastError = { ...errorSource, severity: isHardFailure ? 'error' : 'warn' };
  }

  // Hard failure or no usable change: surface error, don't merge metadata.
  if (r.error || r.success === false || !r.changed) {
    return lastError ? { ...g, lastError } : g;
  }

  // H2/H6: stamp each resolved field that actually changed into file.changes
  // so Write Tags writes the resolution output.
  // D-6: never stage a series on a book whose series list could not be read
  // (push would never send it). An empty or placeholder answer never clears
  // a series. A series the book is already in as a secondary is promoted by
  // syncAllSeries, keeping the old primary (D-2).
  const m = g.metadata || {};
  const takeSeries = r.series !== undefined
    && m.series_unresolved !== true
    && !isPlaceholderSeries(r.series);
  const changedFileFields = [];
  if (r.title && r.title !== m.title) changedFileFields.push('title');
  if (r.author && r.author !== m.author) changedFileFields.push('author');
  if (r.subtitle && r.subtitle !== m.subtitle) changedFileFields.push('subtitle');
  if (takeSeries && r.series !== m.series) changedFileFields.push('series');
  if (takeSeries && r.sequence !== undefined && r.sequence !== m.sequence) changedFileFields.push('sequence');
  if (r.narrator && r.narrator !== m.narrator) changedFileFields.push('narrator');
  const next = applyMetadataToGroup(
    g,
    {
      title: r.title || m.title,
      author: r.author || m.author,
      subtitle: r.subtitle || m.subtitle,
      series: takeSeries ? r.series : m.series,
      sequence: takeSeries && r.sequence !== undefined ? r.sequence : m.sequence,
      narrator: r.narrator || m.narrator,
    },
    changedFileFields
  );
  return { ...next, lastError };
}

// ---- Descriptions ----
// A narrator found in a description is staged only when the book has none (or
// a placeholder); an existing narrator is never overwritten.
export function hasNoNarrator(metadata) {
  const m = metadata || {};
  const list = Array.isArray(m.narrators) ? m.narrators : [];
  return isPlaceholderAuthor(m.narrator) && list.every(isPlaceholderAuthor);
}

// Description Processing: entry is one process_descriptions_batch result.
// Returns the group (unchanged when the entry changed nothing).
export function applyDescriptionProcessResult(group, entry) {
  if (!entry || entry.error || !entry.changed) return group;
  // An empty or placeholder ("N/A") description never replaces the current one.
  if (!has(entry.description) || isPlaceholderSeries(entry.description)) return group;
  const narrator = hasNoNarrator(group.metadata) ? extractNarrator(entry.description) : null;
  return applyMetadataToGroup(
    group,
    { description: entry.description, ...(narrator ? { narrator } : {}) },
    narrator ? ['description', 'narrator'] : ['description']
  );
}

// Fix Descriptions: entry is one fix_descriptions_with_gpt result, or a
// { success: false, error } the caller built from a rejected chunk.
export function applyFixDescriptionResult(group, entry) {
  if (!entry) return { group, outcome: 'none' };
  if (isFailure(entry)) return failed(group, 'description', entry, 'Fix Descriptions failed.');
  const updates = {};
  const fields = [];
  if (entry.fixed && has(entry.new_description) && entry.new_description !== group.metadata?.description) {
    updates.description = entry.new_description;
    fields.push('description');
  }
  if (has(entry.extracted_narrator) && hasNoNarrator(group.metadata)) {
    const names = String(entry.extracted_narrator).split(';')
      .map((n) => extractNarrator(`Narrated by ${n.trim()}`)).filter(Boolean);
    if (names.length > 0) {
      updates.narrator = names.join(', ');
      updates.narrators = names;
      fields.push('narrator');
    }
  }
  if (fields.length === 0) return { group: clearStage(group, 'description'), outcome: 'unchanged' };
  return { group: clearStage(applyMetadataToGroup(group, updates, fields), 'description'), outcome: 'changed' };
}

// ---- Counting ----
// pairs: [{ id, outcome }]. Returns summarizeBatch counts plus the per-book
// list scrollToFirstErrorGroup reads for "Show details".
export function tallyOutcomes(pairs) {
  const counts = { succeeded: 0, skipped: 0, warnings: 0, failed: 0, cancelled: 0, timedOut: 0 };
  const errorResults = [];
  for (const { id, outcome } of pairs) {
    if (outcome === 'changed') counts.succeeded++;
    else if (outcome === 'unchanged') counts.skipped++;
    else if (outcome === 'skipped') {
      counts.skipped++;
      errorResults.push({ id, errorDetail: { kind: 'empty-content' } });
    } else if (outcome === 'warning') {
      counts.warnings++;
      errorResults.push({ id, errorDetail: { kind: 'empty-content' } });
    } else if (outcome === 'notfound') counts.warnings++;
    else if (outcome === 'failed') {
      counts.failed++;
      errorResults.push({ id, success: false });
    } else if (outcome === 'timedout') {
      counts.timedOut++;
      errorResults.push({ id, success: false });
    } else if (outcome === 'cancelled') counts.cancelled++;
  }
  return { counts, errorResults };
}
