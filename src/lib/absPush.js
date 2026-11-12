// absPush.js: pure helpers for the "Push to AudiobookShelf" flow (#60).
//
// Routing used to key off `files.length === 0`, but books imported from ABS
// carry their audio files too, so they were sent down the path-based branch,
// which never included the ABS item id and failed every item with
// "Missing item ID" - silently. These helpers route by ABS id instead and
// normalise the two backend result shapes so the UI can report outcomes.

import {
  buildAbsPayload, isEmptyPayload, applyPayloadToSnapshot, snapshotAbsMetadata,
  readLiveLists, rebasePayloadOnLive,
} from './absPayload.js';

const s = (v) => (v == null ? '' : String(v).trim());

/** The ABS library item id for a group, or null if it is not ABS-backed. */
export function getAbsId(group) {
  if (!group) return null;
  if (group.abs_id) return group.abs_id;
  // Imported groups always set abs_id; source==='abs' with only `id` is a
  // defensive fallback (absItemToBookGroup sets id = item.id).
  if (group.source === 'abs' && group.id) return group.id;
  return null;
}

/**
 * Single definition of "this book lives in AudiobookShelf". Use this instead
 * of `files.length === 0`: imported books carry their audio files (#60).
 */
export function isAbsBacked(group) {
  return getAbsId(group) != null;
}

/**
 * Restrict a set of selected file ids to the files of the given groups, so a
 * mixed selection does not send ABS-backed books down a local-file path.
 */
export function fileIdsInGroups(fileIds, groups) {
  const allowed = new Set();
  for (const g of groups || []) {
    for (const f of g.files || []) if (f.id != null) allowed.add(f.id);
  }
  return new Set([...(fileIds || [])].filter(id => allowed.has(id)));
}

/** Split push groups into ABS-backed (push by id) and genuinely local ones. */
export function partitionPushGroups(groups) {
  const absGroups = [];
  const localGroups = [];
  for (const g of groups || []) {
    if (isAbsBacked(g)) absGroups.push(g);
    else localGroups.push(g);
  }
  return { absGroups, localGroups };
}

/** Turn one backend error entry (string or {id, error}) into a message. */
export function errorMessage(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err.error) return err.id && err.id !== 'unknown' ? `${err.id}: ${err.error}` : String(err.error);
  if (err.message) return String(err.message);
  try { return JSON.stringify(err); } catch { return String(err); }
}

/** One per-book result entry: { id, title } plus `reason` or `error`. */
function entry(e, extraKey) {
  if (e == null || typeof e !== 'object') {
    const out = { id: null, title: '' };
    if (extraKey) out[extraKey] = e == null ? '' : String(e);
    return out;
  }
  const out = { id: e.id ?? null, title: e.title ?? '' };
  if (extraKey) out[extraKey] = String(e[extraKey] ?? (extraKey === 'error' ? errorMessage(e) : ''));
  return out;
}

/**
 * M-9: normalise a push result to { updated, skipped, failed }, three arrays
 * of per-book entries ({id, title}, {id, title, reason}, {id, title, error}).
 * A legacy count (number) is expanded into that many untitled entries, with
 * messages taken from `errors`, so no failure is ever lost.
 */
export function normalizePushResult(result) {
  const r = result || {};
  const errors = (Array.isArray(r.errors) ? r.errors : []).map(errorMessage).filter(Boolean);
  const list = (value, extraKey, messages = []) => {
    if (Array.isArray(value)) return value.map((e) => entry(e, extraKey));
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return [];
    return Array.from({ length: n }, (_, i) => entry(messages[i] ?? null, extraKey));
  };
  return {
    updated: list(r.updated ?? r.success),
    skipped: list(r.skipped, 'reason'),
    failed: list(r.failed, 'error', errors),
  };
}

/** Concatenate several push results. */
export function mergePushResults(...results) {
  const out = { updated: [], skipped: [], failed: [] };
  for (const r of results) {
    if (!r) continue;
    const n = normalizePushResult(r);
    out.updated.push(...n.updated);
    out.skipped.push(...n.skipped);
    out.failed.push(...n.failed);
  }
  return out;
}

/** "A, B, C, D, E and 2 more": the first `max` titles, then a count. */
export function formatTitleList(entries, max = 5) {
  const titles = (entries || []).map((e) => e.title || e.id || 'Untitled book');
  const head = titles.slice(0, max).join(', ');
  return titles.length > max ? `${head} and ${titles.length - max} more` : head;
}

/**
 * Build the user-facing summary for a finished push.
 * Returns { type: 'success'|'warning'|'error'|'info', title, message }.
 */
export function summarizePush(result, attempted) {
  const { updated, skipped, failed } = normalizePushResult(result);
  const plural = (n) => (n === 1 ? '' : 's');
  const parts = [];
  if (skipped.length > 0) {
    const reasons = [...new Set(skipped.map((e) => e.reason).filter(Boolean))].join(', ');
    parts.push(`${skipped.length} book${plural(skipped.length)} skipped${reasons ? ` (${reasons})` : ''}.`);
  }
  if (failed.length > 0) {
    parts.push(`Failed: ${formatTitleList(failed)}.`);
    if (failed[0].error) parts.push(`First error: ${failed[0].error}`);
  }
  const tail = parts.length > 0 ? ` ${parts.join(' ')}` : '';

  if (failed.length === 0 && updated.length > 0) {
    return {
      type: 'success',
      title: 'Push Complete',
      message: `Updated ${updated.length} book${plural(updated.length)} in AudiobookShelf.${tail}`,
    };
  }
  if (updated.length === 0 && failed.length > 0) {
    return {
      type: 'error',
      title: 'Push Failed',
      message: `No books were updated; ${failed.length} failed.${tail}`,
    };
  }
  if (failed.length > 0) {
    return {
      type: 'warning',
      title: 'Push Partially Complete',
      message: `Updated ${updated.length}, failed ${failed.length}.${tail}`,
    };
  }
  if (skipped.length > 0) {
    return { type: 'info', title: 'Nothing Pushed', message: `Nothing needed updating in AudiobookShelf.${tail}` };
  }
  return {
    type: attempted > 0 ? 'warning' : 'info',
    title: 'Nothing Pushed',
    message: attempted > 0
      ? `None of the ${attempted} selected book${plural(attempted)} were pushed.`
      : 'No books were selected to push.',
  };
}

/** A result in which every given group failed with `error`. */
export function failedPushResult(groups, error) {
  const message = String(error?.message || error);
  return {
    updated: [],
    skipped: [],
    failed: (groups || []).map((g) => ({ id: g?.id ?? null, title: g?.metadata?.title || '', error: message })),
  };
}

/**
 * Orchestrate a push for the confirmed groups (#60).
 *
 *   pushById(groups)        -> handlePushAbsImports; used for every ABS-backed
 *                              group, whether or not it carries files.
 *   pushByFileIds(Set<id>)  -> pushToAudiobookShelf; only for local groups.
 *
 * A branch that throws is recorded as all of its books failing, so one
 * branch's failure never hides the other's outcome. Never throws.
 * Returns { attempted, absCount, localCount, updated, skipped, failed, summary }.
 */
export async function runPush(groups, { pushById, pushByFileIds }) {
  const { absGroups, localGroups } = partitionPushGroups(groups);
  const parts = [];

  if (absGroups.length > 0) {
    try {
      parts.push(await pushById(absGroups));
    } catch (error) {
      parts.push(failedPushResult(absGroups, error));
    }
  }

  if (localGroups.length > 0) {
    // M15: build the file-id set from the snapshot taken at modal open.
    const fileIds = new Set();
    localGroups.forEach(g =>
      (g.files || []).forEach(f => { if (f.id != null) fileIds.add(f.id); })
    );
    try {
      parts.push(await pushByFileIds(fileIds));
    } catch (error) {
      parts.push(failedPushResult(localGroups, error));
    }
  }

  const merged = mergePushResults(...parts);
  const attempted = absGroups.length + localGroups.length;
  return {
    attempted,
    absCount: absGroups.length,
    localCount: localGroups.length,
    ...merged,
    summary: summarizePush(merged, attempted),
  };
}

/**
 * H-11: run `worker(item, index)` over `items` with at most `concurrency`
 * calls in flight. Results come back in input order. A worker that throws
 * rejects the pool, so workers should catch their own errors.
 */
export async function runPool(items, worker, concurrency) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const limit = Math.max(1, Math.min(list.length, Math.floor(Number(concurrency)) || 1));
  let next = 0;
  const lane = async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await worker(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: limit }, lane));
  return results;
}

export const DEFAULT_PUSH_CONCURRENCY = 3;
export const MAX_PUSH_CONCURRENCY = 10;

/** H-11: push workers from config.concurrency_abs_push, clamped to 1..10, default 3. */
export function pushConcurrency(config) {
  const raw = config?.concurrency_abs_push;
  if (raw == null || raw === '') return DEFAULT_PUSH_CONCURRENCY;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_PUSH_CONCURRENCY;
  return Math.min(MAX_PUSH_CONCURRENCY, Math.max(1, n));
}

/**
 * Push one book. H-5: diff against the import snapshot, then re-read the live
 * item and apply only the local tag/genre delta to it, so values added in ABS
 * since import survive. When in doubt nothing is sent: a failed or unreadable
 * GET fails the book without a PATCH.
 *
 * `request(path, options?)` performs an ABS API call; `cfg` is the app config.
 * Returns { status: 'updated'|'skipped'|'failed', entry, snapshot? }.
 */
export async function pushOneAbsItem(item, { request, cfg = {} }) {
  const meta = item?.metadata || {};
  const original = item?.original || null;
  const absId = item?.abs_id || item?.id;
  const id = item?.id ?? item?.group_id ?? absId ?? null;
  const title = s(meta.title) || s(item?.title) || String(absId || '');
  if (!absId) return { status: 'failed', entry: { id, title, error: 'Missing item ID' } };

  const first = buildAbsPayload(meta, original, cfg);
  if (isEmptyPayload(first)) return { status: 'skipped', entry: { id, title, reason: 'no changes' } };

  try {
    const live = readLiveLists(await request(`/api/items/${absId}?expanded=1`));
    if (!live) {
      return { status: 'failed', entry: { id, title, error: 'Could not read the current tags and genres from ABS' } };
    }
    const { payload, lists } = rebasePayloadOnLive(first, original, live, meta);
    if (isEmptyPayload(payload)) return { status: 'skipped', entry: { id, title, reason: 'no changes' } };
    await request(`/api/items/${absId}/media`, { method: 'PATCH', body: payload });
    const snapshot = applyPayloadToSnapshot(original || snapshotAbsMetadata(meta), meta, payload);
    snapshot.tags = lists.tags;
    snapshot.genres = lists.genres;
    return { status: 'updated', entry: { id, title }, snapshot };
  } catch (err) {
    return { status: 'failed', entry: { id, title, error: String(err?.message || err) } };
  }
}

/**
 * Push several books through pushOneAbsItem, `pushConcurrency(cfg)` at a time.
 * Returns { updated, skipped, failed, snapshots } where `snapshots` holds the
 * advanced abs_original of each updated book, keyed by its id.
 */
export async function pushAbsItems(items, { request, cfg = {} }) {
  const outcomes = await runPool(items || [], (item) => pushOneAbsItem(item, { request, cfg }), pushConcurrency(cfg));
  const result = { updated: [], skipped: [], failed: [], snapshots: {} };
  for (const o of outcomes) {
    result[o.status].push(o.entry);
    if (o.status === 'updated' && o.entry.id != null) result.snapshots[o.entry.id] = o.snapshot;
  }
  return result;
}

/**
 * v2.2.3: request items for push_abs_imports. `original` is the snapshot taken
 * at import (group.abs_original) that the push diffs against; null when the
 * group predates snapshots (the push then falls back non-destructively).
 */
export function buildPushItems(groups) {
  return (groups || []).map((g) => ({
    id: g.id,
    abs_id: getAbsId(g) || g.id,
    metadata: g.metadata,
    original: g.abs_original || null,
  }));
}

/**
 * Advance each pushed group's abs_original to what ABS now holds, so a later
 * revert of a pushed change is still detected. `snapshots` is keyed by group id.
 * H-5: the group's tags and genres become the server's (including values
 * added in ABS since import), and its staged state is cleared: total_changes,
 * changedFields, every file.changes and metadata.user_cleared.
 */
export function applyPushSnapshots(groups, snapshots) {
  if (!snapshots || typeof snapshots !== 'object') return groups;
  return (groups || []).map((g) => {
    if (!Object.prototype.hasOwnProperty.call(snapshots, g.id) || !snapshots[g.id]) return g;
    const snapshot = snapshots[g.id];
    const metadata = { ...(g.metadata || {}) };
    delete metadata.user_cleared;
    if (Array.isArray(snapshot.tags)) metadata.tags = [...snapshot.tags];
    if (Array.isArray(snapshot.genres)) metadata.genres = [...snapshot.genres];
    return {
      ...g,
      abs_original: snapshot,
      metadata,
      total_changes: 0,
      changedFields: [],
      files: (g.files || []).map((f) => ({ ...f, changes: {} })),
    };
  });
}
