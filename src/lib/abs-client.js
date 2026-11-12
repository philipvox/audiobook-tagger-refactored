// src/lib/abs-client.js
// AudiobookShelf API client, runs in the browser, calls ABS through the CORS proxy.

import { absApi } from './proxy';
import { absItemsToBookGroups, parseYearFromDateString } from './absGroup.js';

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

  // Convert ABS items to book groups (shared builder, see absGroup.js).
  const groups = await absItemsToBookGroups(baseUrl, token, allItems, (index, total, item) => {
    onProgress?.(index, total, `Processing ${item.media?.metadata?.title || 'book'}...`);
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
 * M-4/L-14: parse a year out of an embedded tagDate value defensively
 * (4 leading digits, else Date parsing, else null). Kept as an export for
 * existing callers; the implementation lives in absGroup.js.
 */
export const parseYearFromTagDate = parseYearFromDateString;
