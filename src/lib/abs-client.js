// src/lib/abs-client.js
// AudiobookShelf API client, runs in the browser, calls ABS through the CORS proxy.

import { absApi } from './proxy';

/**
 * Test connection to an ABS instance.
 */
export async function testConnection(absBaseUrl, absToken) {
  if (!absBaseUrl) return { success: false, message: 'No URL configured' };
  if (!absToken) return { success: false, message: 'No API token configured' };

  try {
    await absApi(absBaseUrl, absToken, '/api/libraries');
    return { success: true, message: `Connected to ${absBaseUrl}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Fetch all libraries.
 */
export async function getLibraries(absBaseUrl, absToken) {
  const data = await absApi(absBaseUrl, absToken, '/api/libraries');
  return data.libraries || [];
}

/**
 * Import all books from an ABS library.
 * @param {object} config - App config with abs_base_url, abs_api_token, abs_library_id
 * @param {function} onProgress - Optional callback (current, total, message)
 * @returns {Array} Array of book groups
 */
export async function importLibrary(config, onProgress) {
  const { abs_base_url: baseUrl, abs_api_token: token, abs_library_id: libraryId } = config;

  if (!baseUrl || !token || !libraryId) {
    throw new Error('Configure ABS URL, token, and library ID in Settings first');
  }

  // Fetch all items with pagination.
  // Pagination guards: some ABS responses omit `total`, in which case the old
  // `allItems.length < total` condition (total defaulting to 0) exited after a
  // single page even when more data existed. Loop on page shape instead: keep
  // going while the last page was a full page, stop on an empty or short
  // page, and cap iterations so a misbehaving server can't spin this forever.
  const allItems = [];
  let page = 0;
  const limit = 100;
  let lastKnownTotal = 0;

  while (true) {
    onProgress?.(allItems.length, lastKnownTotal, `Fetching page ${page + 1}...`);
    const data = await absApi(baseUrl, token, `/api/libraries/${libraryId}/items?limit=${limit}&page=${page}&expanded=1`);
    const items = data.results || [];
    const total = data.total || 0;
    if (total) lastKnownTotal = total;
    allItems.push(...items);
    page++;
    if (items.length === 0) break;
    if (total && allItems.length >= total) break;
    if (items.length < limit) break;
    if (page > 1000) { console.warn('[importLibrary] Pagination cap (1000 pages) hit; stopping.'); break; }
  }

  onProgress?.(allItems.length, lastKnownTotal || allItems.length, 'Processing...');

  // Convert ABS items to book groups
  const groups = allItems.map((item, index) => {
    onProgress?.(index, allItems.length, `Processing ${item.media?.metadata?.title || 'book'}...`);
    return absItemToBookGroup(item, baseUrl);
  });

  return groups;
}

/**
 * Push metadata updates back to ABS.
 * @param {object} config - App config
 * @param {Array} items - Array of { absId, metadata } to update
 * @param {function} onProgress - Optional callback
 */
export async function pushUpdates(config, items, onProgress) {
  const { abs_base_url: baseUrl, abs_api_token: token } = config;
  let success = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const { absId, metadata } = items[i];
    onProgress?.(i, items.length, `Pushing ${metadata.title || absId}...`);

    try {
      await absApi(baseUrl, token, `/api/items/${absId}/media`, {
        method: 'PATCH',
        body: { metadata },
      });
      success++;
    } catch (err) {
      failed++;
      errors.push({ absId, error: err.message });
    }
  }

  return { success, failed, errors };
}

/**
 * Get chapters for a book.
 */
export async function getChapters(config, absId) {
  const data = await absApi(config.abs_base_url, config.abs_api_token, `/api/items/${absId}`);
  return data.media?.chapters || [];
}

/**
 * M-4/L-14: parse a year out of an embedded tagDate value defensively.
 * ABS's tagDate is a free-form string, sometimes a plain 4-digit year,
 * sometimes a full date, sometimes garbage. Only take the first 4
 * characters when they're actually 4 digits; otherwise fall back to
 * Date parsing, and give up (null) rather than return a bogus year.
 */
export function parseYearFromTagDate(tagDate) {
  if (!tagDate) return null;
  const str = String(tagDate).trim();
  if (!str) return null;
  const first4 = str.substring(0, 4);
  if (/^\d{4}$/.test(first4)) return first4;
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return String(parsed.getFullYear());
  return null;
}

/**
 * Convert an ABS library item to a BookGroup for the frontend.
 */
function absItemToBookGroup(item, absBaseUrl) {
  const meta = item.media?.metadata || {};
  const audioFiles = item.media?.audioFiles || [];

  // ABS exposes embedded ID3/M4B tags on each audioFile. When the book's
  // top-level metadata is empty, these tags often still carry the truth.
  const firstTags = audioFiles[0]?.metaTags || {};
  const fromTags = (s) => (s && String(s).trim()) || null;

  // Extract series info
  const series = (meta.series || []).map(s => ({
    name: s.name,
    sequence: s.sequence,
    source: 'abs',
  }));

  // Build cover URL
  const coverUrl = item.id ? `${absBaseUrl}/api/items/${item.id}/cover` : null;

  const author = fromTags((meta.authors || []).map(a => a.name).join(', '))
    || fromTags(meta.authorName)
    || fromTags(firstTags.tagAlbumArtist)
    || fromTags(firstTags.tagArtist)
    || 'Unknown';

  const narrator = fromTags((meta.narrators || []).map(n => typeof n === 'string' ? n : n.name).join(', '))
    || fromTags(meta.narratorName)
    || fromTags(firstTags.tagComposer)
    || null;

  const title = fromTags(meta.title)
    || fromTags(firstTags.tagAlbum)
    || fromTags(firstTags.tagTitle)
    || 'Unknown';

  // M-4/L-14: publishedYear/year need to carry the same value so downstream
  // rescan payloads (which read metadata.year) get it too.
  const publishedYear = meta.publishedYear || parseYearFromTagDate(firstTags.tagDate) || firstTags.tagYear || null;

  return {
    id: item.id || crypto.randomUUID(),
    abs_id: item.id,
    source: 'abs',
    metadata: {
      title,
      author,
      narrator,
      subtitle: meta.subtitle || null,
      series: series.length > 0 ? series[0].name : fromTags(firstTags.tagSeries),
      sequence: series.length > 0 ? series[0].sequence : fromTags(firstTags.tagSeriesPart),
      all_series: series,
      genres: meta.genres || [],
      tags: (item.media?.tags || []),
      description: meta.description || null,
      publisher: meta.publisher || fromTags(firstTags.tagPublisher) || null,
      published_year: publishedYear,
      year: publishedYear,
      language: meta.language || fromTags(firstTags.tagLanguage) || null,
      isbn: meta.isbn || fromTags(firstTags.tagIsbn) || null,
      asin: meta.asin || fromTags(firstTags.tagAsin) || null,
      cover_url: coverUrl,
      duration: item.media?.duration || null,
    },
    // CR-3: every file needs a stable id (used for selection Sets etc.) and
    // a changes object (write/rescan paths assume file.changes exists).
    files: audioFiles.map((f, index) => ({
      id: `${item.id}-f${index}`,
      path: f.metadata?.path || f.ino || '',
      filename: f.metadata?.filename || '',
      duration: f.duration || 0,
      size: f.metadata?.size || 0,
      ino: f.ino || null,
      changes: {},
    })),
  };
}
