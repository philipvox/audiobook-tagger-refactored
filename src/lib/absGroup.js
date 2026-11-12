// absGroup.js - turn ABS library items into BookGroups.
//
// The one group builder for every ABS import: the workspace import
// (api.js import_from_abs) and the onboarding wizard (abs-client.js
// importLibrary) both go through absItemsToBookGroups, so seriesName parsing,
// the multi-series item fetch and series_unresolved behave the same (C-3).

import { absApi } from './proxy';
import { snapshotAbsMetadata, parseSeriesName, isMultiSeriesName } from './absPayload.js';

// M-4/L-14: parse a year out of a free-form ABS date string (publishedDate or
// an embedded tagDate) defensively. Only take the first 4 characters when
// they're actually 4 digits; otherwise fall back to Date parsing, and give up
// (null) rather than return a bogus year. abs-client.js re-exports this as
// parseYearFromTagDate.
export function parseYearFromDateString(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  if (!str) return null;
  const first4 = str.substring(0, 4);
  if (/^\d{4}$/.test(first4)) return first4;
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return String(parsed.getFullYear());
  return null;
}

// C-3: list items whose seriesName may hold several series ("A #6, B #1")
// and carry no series array. The list endpoint cannot be split safely, so
// GET /api/items/:id?expanded=1 for each one. Returns Map(id -> series array);
// an id maps to null when the fetch failed or returned no series, which the
// group builder records as series_unresolved.
export async function fetchMultiSeries(baseUrl, token, items, { concurrency = 4, onProgress, shouldStop } = {}) {
  const wanted = items.filter((item) => {
    const meta = item?.media?.metadata || {};
    const hasArray = Array.isArray(meta.series) && meta.series.length > 0;
    return item?.id && !hasArray && isMultiSeriesName(meta.seriesName);
  });
  const out = new Map();
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      // H-7: a cancelled import starts no further item fetches.
      if (shouldStop?.()) return;
      const item = wanted[next++];
      try {
        const full = await absApi(baseUrl, token, `/api/items/${item.id}?expanded=1`);
        const series = full?.media?.metadata?.series;
        // Every entry needs a name; a partial array is no better than none.
        const usable = Array.isArray(series) && series.length > 0
          && series.every((x) => (typeof x === 'string' ? x : x?.name)?.trim?.());
        out.set(item.id, usable ? series : null);
      } catch (err) {
        console.warn(`[abs import] Could not fetch series for ${item.id}: ${err?.message || err}`);
        out.set(item.id, null);
      }
      onProgress?.(out.size, wanted.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
  return out;
}

// fetchedSeries: undefined when no item fetch was needed, the item's series
// array when fetchMultiSeries got one, null when it failed.
export function absItemToBookGroup(item, absBaseUrl, fetchedSeries) {
  const meta = item.media?.metadata || {};
  const base = absBaseUrl.replace(/\/$/, '');

  // ABS exposes embedded ID3/M4B tags on each audioFile. When the book's
  // top-level metadata is empty (common when no Audible match and no sidecar),
  // these tags often still carry the truth. Use the first file's tags as a
  // fallback for author / narrator / series.
  const firstTags = item.media?.audioFiles?.[0]?.metaTags || {};
  const fromTags = (s) => (s && String(s).trim()) || null;

  // ABS returns authors as both `authorName` (string) and `authors` (array of {id, name})
  const author = fromTags(meta.authorName)
    || fromTags((meta.authors || []).map(a => typeof a === 'string' ? a : a.name).join(', '))
    || fromTags(firstTags.tagAlbumArtist)
    || fromTags(firstTags.tagArtist)
    || 'Unknown';

  const narrator = fromTags(meta.narratorName)
    || fromTags((meta.narrators || []).map(n => typeof n === 'string' ? n : n.name).join(', '))
    || fromTags(firstTags.tagComposer)
    || null;

  // Series: a metadata.series array when ABS sends one; otherwise the list
  // endpoint's seriesName ("Name #seq"), or the item fetch for a string that
  // may hold several series (C-3). If that could not be resolved the book is
  // series_unresolved and push never sends series for it.
  let sourceSeries = Array.isArray(meta.series) && meta.series.length > 0 ? meta.series : [];
  let seriesUnresolved = false;
  if (sourceSeries.length === 0 && fetchedSeries) sourceSeries = fetchedSeries;
  if (sourceSeries.length === 0 && meta.seriesName && String(meta.seriesName).trim()) {
    const parsed = parseSeriesName(String(meta.seriesName));
    if (parsed) sourceSeries = [parsed];
    else seriesUnresolved = true;
  }
  // L: use ?? (not ||) so a legitimate sequence of 0 is preserved.
  const seriesArr = sourceSeries.map(s => ({
    name: typeof s === 'string' ? s : s.name,
    sequence: (typeof s === 'string' ? undefined : s.sequence) ?? null,
    source: 'abs',
  }));

  const title = fromTags(meta.title)
    || fromTags(firstTags.tagAlbum)
    || fromTags(firstTags.tagTitle)
    || 'Unknown';

  const publishedYear = meta.publishedYear
    || parseYearFromDateString(meta.publishedDate)
    || parseYearFromDateString(firstTags.tagDate)
    || firstTags.tagYear
    || null;

  // L: don't let `|| meta.seriesSequence` override a legitimate sequence of 0.
  const primarySequence = seriesArr[0]?.sequence;

  const group = {
    id: item.id || crypto.randomUUID(),
    abs_id: item.id,
    source: 'abs',
    metadata: {
      title,
      author,
      narrator,
      subtitle: meta.subtitle || null,
      series: seriesArr[0]?.name || meta.seriesName || fromTags(firstTags.tagSeries) || null,
      sequence: primarySequence != null ? primarySequence : (meta.seriesSequence || fromTags(firstTags.tagSeriesPart) || null),
      all_series: seriesArr,
      series_unresolved: seriesUnresolved,
      genres: meta.genres || [],
      tags: item.media?.tags || [],
      description: meta.description || null,
      publisher: meta.publisher || fromTags(firstTags.tagPublisher) || null,
      published_year: publishedYear,
      year: publishedYear,
      language: meta.language || fromTags(firstTags.tagLanguage) || null,
      isbn: meta.isbn || fromTags(firstTags.tagIsbn) || null,
      asin: meta.asin || fromTags(firstTags.tagAsin) || null,
      cover_url: item.id ? `${base}/api/items/${item.id}/cover` : null,
      duration: item.media?.duration || null,
      added_at: item.addedAt || item.createdAt || 0,
    },
    // CR-3: every file needs a stable id (used for selection Sets etc.) and
    // a changes object (write/rescan paths assume file.changes exists).
    files: (item.media?.audioFiles || []).map((f, index) => ({
      id: `${item.id}-f${index}`,
      path: f.metadata?.path || '',
      filename: f.metadata?.filename || '',
      duration: f.duration || 0,
      size: f.metadata?.size || 0,
      ino: f.ino || null,
      changes: {},
    })),
  };
  // C-3: make an unresolved series visible on the book (BookList renders
  // lastError), since push will silently skip series for it.
  if (seriesUnresolved) {
    group.lastError = {
      stage: 'import',
      kind: 'series',
      severity: 'warn',
      message: "Could not read this book's series from AudiobookShelf. Series will not be pushed until you re-import.",
    };
  }
  // v2.2.3: what ABS holds right now. Push diffs against this so it only
  // sends what the user/AI changed, and so policy never touches existing values.
  // Taken after series are resolved so an untouched book diffs to nothing.
  group.abs_original = snapshotAbsMetadata(group.metadata);
  return group;
}

/**
 * Convert list-endpoint items to BookGroups, first fetching the series of
 * any item whose seriesName may hold several series.
 * @param {function} [onItem] optional (index, total, item) callback per item
 * @param {function} [onSeriesProgress] optional (done, total) callback after
 *   each multi-series item fetch, so a long fetch phase shows progress
 * @param {object} [options] { shouldStop } - stop starting series fetches once
 *   it returns true (a cancelled import; the caller discards the groups)
 */
export async function absItemsToBookGroups(baseUrl, token, items, onItem, onSeriesProgress, { shouldStop } = {}) {
  const fetchedSeries = await fetchMultiSeries(baseUrl, token, items, { onProgress: onSeriesProgress, shouldStop });
  return items.map((item, index) => {
    onItem?.(index, items.length, item);
    return absItemToBookGroup(item, baseUrl, fetchedSeries.get(item.id));
  });
}
