// enrichActions - the shared body of the per-book Enrich actions (audit H-3,
// M-7): Fix Titles, Fix Series, Fix Subtitles, Clean Genres (AI), Lookup Age,
// ISBN lookup and Check by Audio.
//
// Each action is a config (how to call the backend for a book or a chunk, and
// which pure applier from applyAiResults.js to run). runEnrichAction does the
// rest the same way for all of them:
//   - chunk loop; a rejected call becomes { success: false, error } for that
//     book (per-book actions) or for every book in the chunk (chunk actions);
//   - outcomes counted from the groups as sent, outside the setGroups updater
//     (React may run an updater twice); the same applier then runs on the live
//     groups inside the updater;
//   - one summarizeBatch toast at the end, so total failure reads as failure;
//   - M-6: a Cancel (the caller's lib/cancel.js token, via shouldStop) stops
//     the loop between chunks. What was applied stays applied; the toast says
//     how many were processed.
//
// runBatchChunks is the chunk loop for the steps that send a whole selection
// to one batch command (Resolve, Description Processing, Classify, DNA): 25
// books per call, each chunk staged as it lands, the same cancel check.

import {
  applyTitleResult, applySeriesResult, applySubtitleResult, applyGenreCleanupResult,
  applyAgeResult, applyAgeTagsResult, applyIsbnResult, applyAudioResult, tallyOutcomes,
} from './applyAiResults.js';
import { summarizeBatch, scrollToFirstErrorGroup } from './batchToast.js';
import { errorDetailFromException } from './errorDetail.js';

export const rejectedEntry = (err) => ({ success: false, error: String(err?.message || err) });

const byId = (results, key = (r) => r.id) => {
  const map = new Map();
  for (const r of Array.isArray(results) ? results : []) map.set(key(r), r);
  return map;
};

// Apply one entry per group. Returns [{ id, outcome }].
export function applyEntries(setGroups, sentGroups, entryFor, apply) {
  const pairs = sentGroups.map((g) => ({ id: g.id, outcome: apply(g, entryFor(g)).outcome }));
  const ids = new Set(sentGroups.map((g) => g.id));
  setGroups((prev) => prev.map((g) => (ids.has(g.id) ? apply(g, entryFor(g)).group : g)));
  return pairs;
}

// The end-of-run toast for an action. Returns the counts. `cancelled` is the
// number of books a cancelled run never reached; `extra` may carry
// { notProcessed, errorMessage } from runBatchChunks.
export function reportOutcomes(toast, op, pairs, cancelled = 0, extra = {}) {
  const { counts, errorResults } = tallyOutcomes(pairs);
  const summary = summarizeBatch({ op, ...counts, cancelled, ...extra });
  if (summary && toast) {
    const opts = (summary.hasWarnings || summary.hasFailures)
      ? { action: { label: 'Show details', onClick: () => scrollToFirstErrorGroup(errorResults, summary.hasFailures ? 'error' : 'warn') } }
      : undefined;
    toast[summary.type](summary.title, summary.message, opts);
  }
  return counts;
}

const ageRequest = (g) => ({
  request: {
    title: g.metadata?.title || g.group_name,
    author: g.metadata?.author || '',
    series: g.metadata?.series || null,
    description: g.metadata?.description || null,
    genres: g.metadata?.genres || [],
    publisher: g.metadata?.publisher || null,
  },
});

// Per-book actions have callBook(group, ctx, callBackend) -> entry.
// Chunk actions have callChunk(chunk, ctx, callBackend) -> entries aligned
// with the chunk.
export const ENRICH_ACTIONS = Object.freeze({
  titles: {
    op: 'titles',
    chunkSize: 25,
    apply: applyTitleResult,
    callBook: (g, ctx, callBackend) => {
      const folderPath = g.files?.[0]?.path?.split('/').slice(0, -1).join('/')
        || g.metadata?.source_path
        || null;
      return callBackend('resolve_title', {
        request: {
          filename: g.files?.[0]?.filename || null,
          folder_name: g.group_name,
          folder_path: folderPath,
          current_title: g.metadata?.title || '',
          current_author: g.metadata?.author || '',
          current_subtitle: g.metadata?.subtitle || null,
          current_series: g.metadata?.series || null,
          current_sequence: g.metadata?.sequence || null,
          current_narrator: g.metadata?.narrator || null,
          additional_context: null,
        },
      });
    },
  },
  series: {
    op: 'series',
    chunkSize: 3,
    apply: applySeriesResult,
    // A book whose series list could not be read is not sent to the AI: any
    // change could drop a series. The applier marks it skipped.
    skip: (g) => g.metadata?.series_unresolved === true,
    callBook: (g, ctx, callBackend) => callBackend('resolve_series', {
      request: {
        title: g.metadata?.title || g.group_name,
        author: g.metadata?.author || '',
        current_series: g.metadata?.series || null,
        current_sequence: g.metadata?.sequence || null,
      },
    }),
  },
  age: {
    op: 'age',
    chunkSize: 2,
    apply: (g, entry) => applyAgeResult(g, entry),
    callBook: (g, ctx, callBackend) => callBackend('resolve_book_age_rating', ageRequest(g)),
  },
  // The age step of AI Tags: same backend call, age tags only.
  age_tags: {
    op: 'age',
    chunkSize: 3,
    apply: applyAgeTagsResult,
    callBook: (g, ctx, callBackend) => callBackend('resolve_book_age_rating', ageRequest(g)),
  },
  isbn: {
    op: 'isbn',
    chunkSize: 3,
    apply: applyIsbnResult,
    callBook: async (g, ctx, callBackend) => {
      // Use the gather phase's ISBN/ASIN when it found one.
      const gathered = ctx.gathered?.get?.(g.id);
      if (gathered && (gathered.isbn || gathered.asin)) {
        return { success: true, isbn: gathered.isbn, asin: gathered.asin, source: 'gather-phase' };
      }
      try {
        return await callBackend('lookup_book_isbn', {
          request: { title: g.metadata?.title || g.group_name, author: g.metadata?.author || '' },
        });
      } catch (err) {
        // A thrown call is an error, not "not found".
        return { ...rejectedEntry(err), errorDetail: errorDetailFromException(err, { stage: 'lookup-isbn' }) };
      }
    },
  },
  subtitles: {
    op: 'subtitles',
    chunkSize: 10,
    apply: applySubtitleResult,
    callChunk: async (chunk, ctx, callBackend) => {
      const books = chunk.map((g) => ({
        id: g.id,
        title: g.metadata?.title || '',
        author: g.metadata?.author || '',
        current_subtitle: g.metadata?.subtitle || null,
      }));
      const res = byId((await callBackend('fix_subtitles_batch', { books, config: ctx.config, force: !!ctx.force }))?.results);
      return chunk.map((g) => res.get(g.id));
    },
  },
  genres: {
    op: 'genres',
    chunkSize: 25,
    apply: applyGenreCleanupResult,
    callChunk: async (chunk, ctx, callBackend) => {
      const books = chunk.map((g) => ({
        id: g.id,
        title: g.metadata?.title || '',
        author: g.metadata?.author || '',
        genres: g.metadata?.genres || [],
        description: g.metadata?.description || null,
      }));
      const res = byId((await callBackend('cleanup_genres_with_gpt', { books, config: ctx.config }))?.results);
      return chunk.map((g) => res.get(g.id));
    },
  },
  audio_check: {
    op: 'audio_check',
    chunkSize: Infinity, // one backend call; it reports its own progress
    apply: (g, entry, ctx) => applyAudioResult(g, entry, ctx.field || 'all', !!ctx.force),
    callChunk: async (chunk, ctx, callBackend) => {
      const cfg = ctx.config || {};
      const items = chunk.map((g) => ({
        item_id: g.id || g.group_name,
        source: g.id ? 'abs' : 'local',
        title: g.metadata?.title || null,
        author: g.metadata?.author || null,
        file_ino: g.files?.[0]?.ino || null,
        file_path: g.files?.[0]?.path || null,
        abs_base_url: cfg.abs_base_url || null,
        abs_api_token: cfg.abs_api_token || null,
        openai_api_key: cfg.openai_api_key || null,
        use_local_ai: cfg.use_local_ai || false,
        ollama_model: cfg.ollama_model || null,
        ollama_base_url: cfg.ollama_base_url || null,
        use_local_whisper: cfg.use_local_whisper || false,
        whisper_model: cfg.whisper_model || 'base',
      }));
      const res = byId(await callBackend('batch_extract_audio_intros', { items, force: !!ctx.force }), (r) => r.item_id);
      // A book missing from the results (cancelled run) has no entry.
      return chunk.map((g) => res.get(g.id || g.group_name));
    },
  },
});

/**
 * Run one Enrich action over `groups`.
 *
 * options:
 *   callBackend   the api.js dispatcher
 *   setGroups     React state setter (updater form)
 *   toast         { success, warning, error } or null to skip the toast
 *   ctx           { config, force, field, gathered }
 *   apply         override the action's applier (same signature)
 *   chunkSize     override the action's chunk size
 *   extraPairs    outcomes to include in the toast (e.g. smart-skipped books)
 *   onChunkStart(chunk, offset), onChunkDone(done, counts)  progress hooks
 *   shouldStop    checked before each chunk, e.g. () => token.cancelled
 *                 (default: never stop)
 *
 * Returns { pairs, counts, cancelled } where counts is the tally of every
 * pair and cancelled is how many books a cancelled run never reached.
 */
export async function runEnrichAction(name, groups, options = {}) {
  const action = ENRICH_ACTIONS[name];
  if (!action) throw new Error(`runEnrichAction: unknown action "${name}"`);
  const { callBackend, setGroups, toast = null, ctx = {}, extraPairs = [], onChunkStart, onChunkDone, shouldStop = () => false } = options;
  const applyFn = options.apply || action.apply;
  const apply = (g, entry) => applyFn(g, entry, ctx);
  const chunkSize = options.chunkSize || action.chunkSize;

  const skipped = action.skip ? groups.filter(action.skip) : [];
  const toCall = action.skip ? groups.filter((g) => !action.skip(g)) : groups;
  const pairs = skipped.length > 0 ? applyEntries(setGroups, skipped, () => undefined, apply) : [];

  let cancelled = 0;
  for (let i = 0; i < toCall.length; i += chunkSize) {
    if (shouldStop()) { cancelled = toCall.length - i; break; }
    const chunk = toCall.slice(i, i + chunkSize);
    onChunkStart?.(chunk, skipped.length + i);
    let entries;
    if (action.callBook) {
      entries = await Promise.all(chunk.map(async (g) => {
        try {
          return await action.callBook(g, ctx, callBackend);
        } catch (err) {
          console.error(`${name} failed for ${g.group_name || g.id}:`, err);
          return rejectedEntry(err);
        }
      }));
    } else {
      try {
        entries = await action.callChunk(chunk, ctx, callBackend);
      } catch (err) {
        console.error(`${name} failed for a batch of ${chunk.length}:`, err);
        entries = chunk.map(() => rejectedEntry(err));
      }
    }
    const entryById = new Map(chunk.map((g, idx) => [g.id, entries[idx]]));
    pairs.push(...applyEntries(setGroups, chunk, (g) => entryById.get(g.id), apply));
    onChunkDone?.(skipped.length + Math.min(i + chunkSize, toCall.length), tallyOutcomes(pairs).counts);
  }

  const counts = reportOutcomes(toast, action.op, [...pairs, ...extraPairs], cancelled);
  return { pairs, counts, cancelled };
}

export const BATCH_CHUNK_SIZE = 25;

/**
 * M-6: run a whole-selection batch command in chunks, staging each chunk as
 * it lands so a crash or a Cancel keeps what was done.
 *
 * options:
 *   chunkSize     books per call (default 25; Local AI's 5-per-prompt
 *                 batching happens inside the call and is unchanged)
 *   callChunk(chunk, offset) -> { results, total_processed, total_failed }
 *   applyChunk(result, chunk)  stage one chunk (calls setGroups)
 *   onChunkStart(chunk, offset)
 *   stage         errorDetail stage for a chunk whose call throws
 *   shouldStop    checked before each chunk, e.g. () => token.cancelled
 *                 (default: never stop)
 *
 * A chunk whose call throws counts each of its books as failed (with the
 * error on the book) and the next chunk still runs, unless two consecutive
 * chunks have thrown the same error: that cause (a bad key, no provider)
 * will fail every chunk, so the run stops and the remaining books are left
 * not processed (not failed).
 *
 * Returns { results, processed, failed, cancelled, notProcessed, firstError }
 * summed over the chunks. cancelled is how many books a cancelled run never
 * reached; notProcessed how many an early stop left; firstError the message
 * of the first chunk that threw (null if none did).
 */
export async function runBatchChunks(items, options = {}) {
  const { chunkSize = BATCH_CHUNK_SIZE, callChunk, applyChunk, onChunkStart, stage, shouldStop = () => false } = options;
  const out = { results: [], processed: 0, failed: 0, cancelled: 0, notProcessed: 0, firstError: null };
  let lastThrown = null; // message of the previous chunk if it threw
  for (let i = 0; i < items.length; i += chunkSize) {
    if (shouldStop()) { out.cancelled = items.length - i; break; }
    const chunk = items.slice(i, i + chunkSize);
    onChunkStart?.(chunk, i);
    let result;
    let thrown = null;
    try {
      result = await callChunk(chunk, i);
    } catch (err) {
      console.error(`Batch of ${chunk.length} failed:`, err);
      thrown = String(err?.message || err);
      if (out.firstError == null) out.firstError = thrown;
      const errorDetail = errorDetailFromException(err, { stage });
      result = {
        results: chunk.map((g) => ({ id: g.id, success: false, error: thrown, errorDetail })),
        total_processed: 0,
        total_failed: chunk.length,
      };
    }
    applyChunk(result, chunk);
    out.results.push(...(Array.isArray(result?.results) ? result.results : []));
    out.processed += result?.total_processed || 0;
    out.failed += result?.total_failed || 0;
    if (thrown != null && thrown === lastThrown) {
      out.notProcessed = items.length - (i + chunk.length);
      break;
    }
    lastThrown = thrown;
  }
  return out;
}
