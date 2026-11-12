// absPush.js: pure helpers for the "Push to AudiobookShelf" flow (#60).
//
// Routing used to key off `files.length === 0`, but books imported from ABS
// carry their audio files too, so they were sent down the path-based branch,
// which never included the ABS item id and failed every item with
// "Missing item ID" - silently. These helpers route by ABS id instead and
// normalise the two backend result shapes so the UI can report outcomes.

import {
  buildAbsPayload, isEmptyPayload, applyPayloadToSnapshot, snapshotAbsMetadata,
  readLiveLists, rebasePayloadOnLive, settledFields, dedupe, listKey, sameList,
} from './absPayload.js';
import { mapTag, isDnaTag, enforceGenrePolicyWithSplit, MAX_GENRES } from './genres.js';

const s = (v) => (v == null ? '' : String(v).trim());

/** H-7: the skip reason for a book a cancelled push never started. */
export const CANCELLED_REASON = 'cancelled';

/** #62: the skip reason (and Push tooltip) for a locally scanned book. */
export const LOCAL_PUSH_REASON = 'Local folders have no ABS item to push to';

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
  if (Array.isArray(e.notSent) && e.notSent.length > 0) out.notSent = e.notSent;
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

// D-8: how a value that was not sent is described, per reason.
const NOT_SENT_TEXT = {
  'not-approved': (field, n) => `${n} ${field}${n === 1 ? ' was' : 's were'} not sent because ${n === 1 ? 'it is' : 'they are'} not in the approved list`,
  'tag-limit': (field, n) => `${n} ${field}${n === 1 ? ' was' : 's were'} not sent because of the limit on new tags`,
  'genre-limit': (field, n) => `${n} ${field}${n === 1 ? ' was' : 's were'} not sent because the ${MAX_GENRES}-genre limit was reached`,
  empty: (field, n) => `The ${field}s of ${n} book${n === 1 ? ' were' : 's were'} not sent because the list would be empty`,
};

/** D-8: one sentence per (list, reason) naming the values a push did not send. */
export function describeNotSent(entries) {
  const groups = new Map();
  for (const e of entries || []) {
    for (const n of Array.isArray(e?.notSent) ? e.notSent : []) {
      const k = `${n.field}|${n.reason}`;
      if (!groups.has(k)) groups.set(k, { field: n.field, reason: n.reason, values: new Map(), books: 0 });
      const g = groups.get(k);
      g.books += 1;
      if (n.value != null) g.values.set(listKey(n.value), n.value);
    }
  }
  const sentences = [];
  for (const g of groups.values()) {
    const field = g.field === 'genres' ? 'genre' : 'tag';
    const text = NOT_SENT_TEXT[g.reason] || NOT_SENT_TEXT['not-approved'];
    if (g.reason === 'empty') {
      sentences.push(`${text(field, g.books)}.`);
      continue;
    }
    const values = [...g.values.values()];
    sentences.push(`${text(field, values.length)}: ${formatTitleList(values.map((v) => ({ title: v })), 8)}.`);
  }
  if (sentences.length > 0) sentences.push('They stay staged in the app.');
  return sentences.join(' ');
}

/**
 * Build the user-facing summary for a finished push.
 * Returns { type: 'success'|'warning'|'error'|'info', title, message }.
 * D-8: values a push did not send (tag policy, genre cap, an empty list) are
 * named, and make an otherwise clean push a warning.
 */
export function summarizePush(result, attempted) {
  const base = summarizePushCounts(result, attempted);
  const { updated, skipped } = normalizePushResult(result);
  const notSent = describeNotSent([...updated, ...skipped]);
  if (!notSent) return base;
  return {
    ...base,
    type: base.type === 'success' || base.type === 'info' ? 'warning' : base.type,
    message: `${base.message} ${notSent}`,
  };
}

function summarizePushCounts(result, attempted) {
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

  // H-7: a cancelled push says so, and how many books it did not reach.
  const cancelled = skipped.filter((e) => e.reason === CANCELLED_REASON).length;
  if (cancelled > 0) {
    const otherSkipped = skipped.length - cancelled;
    const extra = [];
    if (otherSkipped > 0) extra.push(`${otherSkipped} other book${plural(otherSkipped)} skipped.`);
    if (failed.length > 0) {
      extra.push(`Failed: ${formatTitleList(failed)}.`);
      if (failed[0].error) extra.push(`First error: ${failed[0].error}`);
    }
    return {
      type: failed.length > 0 ? 'error' : 'warning',
      title: 'Push Cancelled',
      message: `Updated ${updated.length} book${plural(updated.length)} before the push was cancelled; ${cancelled} ${cancelled === 1 ? 'was' : 'were'} not pushed.${extra.length ? ` ${extra.join(' ')}` : ''}`,
    };
  }

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
 *   pushById(groups, { cancel }) -> handlePushAbsImports; used for every
 *                                   ABS-backed group, files or not.
 *
 * #62: a book that is not in ABS has no item to PATCH, so it is never sent:
 * it lands in `skipped` with LOCAL_PUSH_REASON. (The old path-based branch
 * sent such books to push_abs_updates without an item id, where every one
 * failed "Missing item ID".) Local books are written with Write Tags instead.
 *
 * H-7: `cancel` is this push's token (lib/cancel.js).
 *
 * A push that throws is recorded as all of its books failing. Never throws.
 * Returns { attempted, absCount, localCount, updated, skipped, failed, summary }.
 */
export async function runPush(groups, { pushById, cancel = null }) {
  const { absGroups, localGroups } = partitionPushGroups(groups);
  const parts = [];

  if (absGroups.length > 0) {
    try {
      parts.push(await (cancel ? pushById(absGroups, { cancel }) : pushById(absGroups)));
    } catch (error) {
      parts.push(failedPushResult(absGroups, error));
    }
  }

  if (localGroups.length > 0) {
    parts.push({
      updated: [],
      skipped: localGroups.map((g) => ({ id: g?.id ?? null, title: g?.metadata?.title || '', reason: LOCAL_PUSH_REASON })),
      failed: [],
    });
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
 * never stops the other lanes: its slot gets `onError(error, item, index)`
 * (default `{ error }`).
 *
 * H-7: `shouldStop()` is checked before each item starts. Once it returns
 * true no new item starts, items in flight finish, and every item not started
 * gets `onStopped(item, index)` (default `{ stopped: true }`).
 */
export async function runPool(items, worker, concurrency, onError = (error) => ({ error }), { shouldStop, onStopped = () => ({ stopped: true }) } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const limit = Math.max(1, Math.min(list.length, Math.floor(Number(concurrency)) || 1));
  let next = 0;
  const lane = async () => {
    while (next < list.length) {
      if (shouldStop?.()) {
        while (next < list.length) {
          const i = next++;
          results[i] = onStopped(list[i], i);
        }
        return;
      }
      const i = next++;
      try {
        results[i] = await worker(list[i], i);
      } catch (error) {
        results[i] = onError(error, list[i], i);
      }
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

/** id and title used to report one push item; never throws. */
function describeItem(item) {
  const absId = item?.abs_id || item?.id;
  const id = item?.id ?? item?.group_id ?? absId ?? null;
  let title = '';
  try { title = s(item?.metadata?.title) || s(item?.title); } catch { /* unreadable title */ }
  return { absId, id, title: title || String(absId || '') };
}

/** `snapshot` with its tags and genres replaced by the server's lists. */
function withLists(snapshot, lists) {
  return { ...snapshot, tags: [...lists.tags], genres: [...lists.genres] };
}

const LIST_FIELDS = ['tags', 'genres'];

// changedFields names with no ABS field: kept in the app only.
const APP_ONLY_FIELDS = ['themes', 'tropes'];

// changedFields names whose values live in the tags list (dna: and age
// tags): they settle when the tags do.
const TAG_DERIVED_FIELDS = ['dna', 'age'];

// D-8: true when `value`, a local addition, is on the server after the push,
// as itself or as what the tag/genre policy maps it to.
function isOnServer(field, value, serverKeys, cfg) {
  if (serverKeys.has(listKey(value))) return true;
  if (field === 'tags') {
    if (isDnaTag(String(value))) return false;
    const mapped = mapTag(value);
    return mapped != null && serverKeys.has(listKey(mapped));
  }
  if (cfg.genre_enforcement === false) return false;
  const mapped = enforceGenrePolicyWithSplit([value]);
  return mapped.length > 0 && mapped.every((g) => serverKeys.has(listKey(g)));
}

// Why a local addition did not reach the server.
function notSentReason(field, value, cfg) {
  if (field === 'tags') {
    return mapTag(value) == null && cfg.preserve_existing_tags !== true ? 'not-approved' : 'tag-limit';
  }
  if (cfg.genre_enforcement !== false && enforceGenrePolicyWithSplit([value]).length === 0) return 'not-approved';
  return 'genre-limit';
}

const SKIP_REASON = {
  'not-approved': (field) => `${field} not in the approved list`,
  'tag-limit': () => 'new-tag limit reached',
  'genre-limit': () => `genre limit (${MAX_GENRES}) reached`,
  empty: (field) => `would leave ${field} empty`,
};

/** The skip reason for a book whose staged lists could not be sent. */
function skipReasonFor(notSent) {
  const reasons = [...new Set(notSent.map((n) => SKIP_REASON[n.reason]?.(n.field) || 'not sent'))];
  return reasons.join('; ');
}

/**
 * D-8: for each staged list (local differs from the snapshot), what the push
 * did not send. `server` is { tags, genres } as ABS holds them after the push
 * (the snapshot lists when nothing was read or sent); `intended` the rebased
 * lists (rebasePayloadOnLive); `live` the lists read before the push.
 * Returns { notSent: [{ field, value, reason }], unsettled: Set(field) }:
 * `unsettled` lists the fields that keep their staged state.
 */
function listOutcomes({ meta, original, cfg, server, intended = {}, live = null, sentFields }) {
  const cleared = Array.isArray(meta.user_cleared) ? meta.user_cleared : [];
  const notSent = [];
  const unsettled = new Set();
  for (const field of LIST_FIELDS) {
    const local = dedupe(meta[field]);
    const snap = dedupe(original?.[field]);
    if (sameList(local, snap)) continue;
    const userCleared = cleared.includes(field);
    const emptied = (local.length === 0 && snap.length > 0 && !userCleared)
      || (field in intended && intended[field].length === 0 && live && live[field].length > 0 && !userCleared);
    if (emptied && !sentFields.has(field)) {
      notSent.push({ field, value: null, reason: 'empty' });
      unsettled.add(field);
      continue;
    }
    const snapKeys = new Set(snap.map(listKey));
    const serverKeys = new Set((server[field] || []).map(listKey));
    for (const value of local) {
      if (snapKeys.has(listKey(value))) continue;
      if (isOnServer(field, value, serverKeys, cfg)) continue;
      notSent.push({ field, value, reason: notSentReason(field, value, cfg) });
      unsettled.add(field);
    }
  }
  return { notSent, unsettled };
}

/**
 * Push one book. H-5: diff against the import snapshot, then re-read the live
 * item and apply only the local tag/genre delta to it, so values added in ABS
 * since import survive. When in doubt nothing is sent: a failed or unreadable
 * GET fails the book without a PATCH. Never throws: any error lands the book
 * in `failed` with its id and title.
 *
 * `request(path, options?)` performs an ABS API call; `cfg` is the app config.
 * Returns { status: 'updated'|'skipped'|'failed', entry, snapshot?, pushed?, refreshed? }.
 * `refreshed` ({ snapshot, fields, keep }) is set when the rebase left nothing
 * to send: the caller adopts the server lists for `fields`.
 *
 * D-8: a value the push did not send (tag policy, genre cap, a list that
 * would become empty) is never silently dropped. The entry carries
 * `notSent: [{ field, value, reason }]`, the skip reason names the cause when
 * it is why nothing was sent, and the list keeps its staged values: `keep`
 * ({ tags?, genres? }) is what the group's list must hold afterwards, and the
 * snapshot keeps its old list for a list that was not sent at all. For an
 * updated book `pushed` is { fields, keep }: `fields` are the metadata fields
 * now in step with ABS (the only ones whose staged state may be cleared).
 */
export async function pushOneAbsItem(item, { request, cfg = {} }) {
  const { absId, id, title } = describeItem(item);
  try {
    const meta = item?.metadata || {};
    const original = item?.original || null;
    if (!absId) return { status: 'failed', entry: { id, title, error: 'Missing item ID' } };
    // H-4: a group restored without its import snapshot cannot be diffed.
    if (item?.needs_reimport === true) {
      return { status: 'skipped', entry: { id, title, reason: 'Re-import from ABS before pushing' } };
    }

    const first = buildAbsPayload(meta, original, cfg);
    if (isEmptyPayload(first)) {
      // Nothing to send. Still say why when a staged list was held back.
      const { notSent } = original
        ? listOutcomes({ meta, original, cfg, server: original, sentFields: new Set() })
        : { notSent: [] };
      if (notSent.length > 0) return { status: 'skipped', entry: { id, title, reason: skipReasonFor(notSent), notSent } };
      return { status: 'skipped', entry: { id, title, reason: 'no changes' } };
    }

    const live = readLiveLists(await request(`/api/items/${absId}?expanded=1`));
    if (!live) {
      return { status: 'failed', entry: { id, title, error: 'Could not read the current tags and genres from ABS' } };
    }
    const { payload, lists, intended } = rebasePayloadOnLive(first, original, live, meta);
    const sentFields = new Set();
    if ('tags' in payload) sentFields.add('tags');
    if ('genres' in (payload.metadata || {})) sentFields.add('genres');
    const { notSent, unsettled } = listOutcomes({ meta, original, cfg, server: lists, intended, live, sentFields });

    // A list that was not sent and still has staged values keeps both its
    // local values and its old snapshot; a list that was sent shows the
    // server list plus any value that did not reach it.
    const keep = {};
    const holdSnapshot = (snap) => {
      const out = { ...snap };
      for (const field of unsettled) {
        if (sentFields.has(field)) {
          keep[field] = dedupe([...lists[field], ...notSent.filter((n) => n.field === field && n.value != null).map((n) => n.value)]);
        } else {
          keep[field] = [...(meta[field] || [])];
          out[field] = [...(original?.[field] || [])];
        }
      }
      return out;
    };
    const withNotes = (e) => (notSent.length > 0 ? { ...e, notSent } : e);

    if (isEmptyPayload(payload)) {
      // Only lists were staged. ABS already holds the ones that are settled:
      // adopt them so the book stops showing them as changed.
      const fields = LIST_FIELDS.filter((f) => !unsettled.has(f)
        && (f === 'tags' ? 'tags' in first : 'genres' in (first.metadata || {})));
      const snapshot = holdSnapshot(withLists(snapshotAbsMetadata(original || meta), lists));
      return {
        status: 'skipped',
        entry: withNotes({ id, title, reason: notSent.length > 0 ? skipReasonFor(notSent) : 'no changes' }),
        refreshed: { snapshot, fields, keep },
      };
    }
    await request(`/api/items/${absId}/media`, { method: 'PATCH', body: payload });
    const snapshot = holdSnapshot(withLists(applyPayloadToSnapshot(original || snapshotAbsMetadata(meta), meta, payload), lists));
    const after = { ...meta, ...keep };
    for (const field of LIST_FIELDS) if (!(field in keep)) after[field] = snapshot[field];
    // Fields ABS has no place for (themes, tropes) are never held back by a
    // push: their values stay in the metadata, only the badge clears.
    return {
      status: 'updated',
      entry: withNotes({ id, title }),
      snapshot,
      pushed: { fields: [...settledFields(after, snapshot), ...APP_ONLY_FIELDS], keep },
    };
  } catch (err) {
    return { status: 'failed', entry: { id, title, error: String(err?.message || err) } };
  }
}

/**
 * Push several books through pushOneAbsItem, `pushConcurrency(cfg)` at a time.
 * Returns { updated, skipped, failed, snapshots, refreshed }: `snapshots`
 * holds the advanced abs_original of each updated book and `refreshed` the
 * { snapshot, fields } of each book skipped because ABS already matched,
 * both keyed by book id.
 *
 * I-2: `onProgress(settled, total, title)` is called as each book settles.
 *
 * H-7: once `shouldStop()` is true no new book starts; books in flight finish
 * and every book not started is skipped with reason 'cancelled' (the result
 * then carries `cancelled: true`). Snapshots for the books that were written
 * are returned either way, so the caller can apply them.
 */
export async function pushAbsItems(items, { request, cfg = {}, shouldStop, onProgress } = {}) {
  const onError = (err, item) => {
    const { id, title } = describeItem(item);
    return { status: 'failed', entry: { id, title, error: String(err?.message || err) } };
  };
  const onStopped = (item) => {
    const { id, title } = describeItem(item);
    return { status: 'skipped', entry: { id, title, reason: CANCELLED_REASON }, stopped: true };
  };
  // I-2: onProgress(settled, total, title) as each started book settles.
  const total = (items || []).length;
  let settled = 0;
  const worker = async (item) => {
    const out = await pushOneAbsItem(item, { request, cfg });
    settled += 1;
    try { onProgress?.(settled, total, out?.entry?.title || ''); } catch { /* progress only */ }
    return out;
  };
  const outcomes = await runPool(items || [], worker, pushConcurrency(cfg), onError, { shouldStop, onStopped });
  const result = { updated: [], skipped: [], failed: [], snapshots: {}, refreshed: {}, pushed: {} };
  if (outcomes.some((o) => o.stopped)) result.cancelled = true;
  for (const o of outcomes) {
    result[o.status].push(o.entry);
    if (o.entry.id == null) continue;
    if (o.status === 'updated') result.snapshots[o.entry.id] = o.snapshot;
    if (o.status === 'updated' && o.pushed) result.pushed[o.entry.id] = o.pushed;
    if (o.refreshed) result.refreshed[o.entry.id] = o.refreshed;
  }
  return result;
}

/**
 * v2.2.3: request items for push_abs_imports. `original` is the snapshot taken
 * at import (group.abs_original) that the push diffs against; null when the
 * group predates snapshots (such a book is skipped, never pushed).
 */
export function buildPushItems(groups) {
  return (groups || []).map((g) => ({
    id: g.id,
    abs_id: getAbsId(g) || g.id,
    metadata: g.metadata,
    original: g.abs_original || null,
    ...(g.needs_reimport === true && { needs_reimport: true }),
  }));
}

// changedFields uses metadata names; file.changes uses 'genre' for genres.
const FILE_FIELDS = { tags: ['tags'], genres: ['genre', 'genres'], year: ['year'], published_year: ['year'] };

/**
 * A group with `snapshot` as its abs_original and the server's tags/genres
 * (or, per list, `keep`'s values: D-8, values that were not sent stay).
 * `fields` null clears all staged state (total_changes, changedFields, every
 * file.changes, metadata.user_cleared); otherwise only those fields'.
 */
function adoptServerState(g, snapshot, fields, keep = {}) {
  const metadata = { ...(g.metadata || {}) };
  for (const field of LIST_FIELDS) {
    if (Array.isArray(keep?.[field])) metadata[field] = [...keep[field]];
    else if (Array.isArray(snapshot[field])) metadata[field] = [...snapshot[field]];
  }
  if (fields == null) {
    delete metadata.user_cleared;
    return {
      ...g,
      abs_original: snapshot,
      metadata,
      total_changes: 0,
      changedFields: [],
      files: (g.files || []).map((f) => ({ ...f, changes: {} })),
    };
  }
  if (Array.isArray(metadata.user_cleared)) {
    const left = metadata.user_cleared.filter((f) => !fields.includes(f));
    if (left.length > 0) metadata.user_cleared = left;
    else delete metadata.user_cleared;
  }
  if (fields.includes('tags')) fields = [...fields, ...TAG_DERIVED_FIELDS];
  const fileKeys = new Set(fields.flatMap((f) => FILE_FIELDS[f] || [f]));
  const files = (g.files || []).map((f) => {
    const changes = { ...(f.changes || {}) };
    for (const k of fileKeys) delete changes[k];
    return { ...f, changes };
  });
  const changedFields = (g.changedFields || []).filter((f) => !fields.includes(f));
  // Same rule as applyMetadataToGroup: a representative file's change count,
  // or the changed-field count for a group without files.
  const representative = files.find((f) => Object.keys(f.changes).length > 0);
  const total_changes = representative
    ? Object.keys(representative.changes).length
    : (files.length > 0 ? 0 : changedFields.length);
  return { ...g, abs_original: snapshot, metadata, changedFields, total_changes, files };
}

/**
 * Advance each pushed group's abs_original to what ABS now holds, so a later
 * revert of a pushed change is still detected. `snapshots` is keyed by group id.
 * H-5: the group's tags and genres become the server's (including values
 * added in ABS since import).
 *
 * D-8: `pushed` (pushAbsItems' result, keyed by group id, values
 * { fields, keep }) says which fields are now in step with ABS: only their
 * staged state is cleared, and `keep` holds list values that were not sent.
 * Without an entry in `pushed` all staged state is cleared (total_changes,
 * changedFields, every file.changes and metadata.user_cleared).
 */
export function applyPushSnapshots(groups, snapshots, pushed = null) {
  if (!snapshots || typeof snapshots !== 'object') return groups;
  return (groups || []).map((g) => {
    if (!Object.prototype.hasOwnProperty.call(snapshots, g.id) || !snapshots[g.id]) return g;
    const p = pushed && Object.prototype.hasOwnProperty.call(pushed, g.id) ? pushed[g.id] : null;
    if (!p) return adoptServerState(g, snapshots[g.id], null);
    return adoptServerState(g, snapshots[g.id], Array.isArray(p.fields) ? p.fields : [], p.keep || {});
  });
}

/**
 * For books skipped because ABS already held the intended lists (`refreshed`
 * from pushAbsItems, keyed by group id, values { snapshot, fields }): adopt
 * the server lists and clear the staged state of those fields only.
 */
export function applyRefreshedLists(groups, refreshed) {
  if (!refreshed || typeof refreshed !== 'object') return groups;
  return (groups || []).map((g) => {
    const r = Object.prototype.hasOwnProperty.call(refreshed, g.id) ? refreshed[g.id] : null;
    if (!r?.snapshot) return g;
    return adoptServerState(g, r.snapshot, Array.isArray(r.fields) ? r.fields : [], r.keep || {});
  });
}
