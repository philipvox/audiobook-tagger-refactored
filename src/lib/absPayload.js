// absPayload.js - build the PATCH /api/items/:id/media body for an ABS push.
//
// v2.2.3 push semantics (kept identical to the audiobook-tagger-web repo):
//   - A push sends ONLY fields that differ from the metadata originally
//     imported from ABS (`group.abs_original`, see snapshotAbsMetadata).
//     Without a snapshot it falls back to sending what the book carries, but
//     never through the destructive parts below.
//   - Tag/genre policy (approved list, caps, fuzzy mapping) applies ONLY to
//     values added this session. Tags/genres that already existed in ABS are
//     kept verbatim unless the user removed them.
//   - Never send `genres: []` / `tags: []` unless the user cleared the field.
//   - Never create a placeholder ("Unknown") author.
//   - A series/sequence edit wins over a stale `all_series`.

import { splitAuthors, isPlaceholderAuthor, isPlaceholderTitle } from './normalize.js';
import { enforceGenrePolicyWithSplit, enforceTagPolicy, isDnaTag, MAX_GENRES } from './genres.js';

const SCALARS = [
  // [metadata key, ABS payload key]
  ['title', 'title'],
  ['subtitle', 'subtitle'],
  ['description', 'description'],
  ['publisher', 'publisher'],
  ['published_year', 'publishedYear'],
  ['isbn', 'isbn'],
  ['asin', 'asin'],
  ['language', 'language'],
];

const s = (v) => (v == null ? '' : String(v).trim());
const yearOf = (m) => s(m.published_year ?? m.publishedYear ?? m.year);
const scalarOf = (m, key) => (key === 'published_year' ? yearOf(m) : s(m[key]));
const listKey = (v) => s(v).toLowerCase().replace(/\s+/g, '-');

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const t = s(v);
    if (!t) continue;
    const k = listKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const sameList = (a, b) => {
  const ka = new Set(a.map(listKey));
  const kb = new Set(b.map(listKey));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
};

/**
 * Strip embedded sequence numbers from a series name.
 * e.g. "Harry Potter #3" -> { name: "Harry Potter", sequence: "3" }
 */
export function stripEmbeddedSequence(name) {
  if (!name || typeof name !== 'string') return { name, sequence: null };
  const trimmed = name.trim();
  const re = /[,:]?\s*(?:#|book|bk\.?|vol\.?|volume|part|no\.?|number)\s*(\d+(?:\.\d+)?)\s*$/i;
  const match = trimmed.match(re);
  if (match) {
    const cleaned = trimmed.slice(0, match.index).trim();
    if (cleaned) return { name: cleaned, sequence: match[1] };
  }
  const hashMatch = trimmed.match(/\s+#(\d+(?:\.\d+)?)\s*$/);
  if (hashMatch) {
    const cleaned = trimmed.slice(0, hashMatch.index).trim();
    if (cleaned) return { name: cleaned, sequence: hashMatch[1] };
  }
  return { name: trimmed, sequence: null };
}

/**
 * Keep `all_series` in step with a `series`/`sequence` edit. The edit modal
 * and bulk edit change only series/sequence and carry the old all_series
 * along; without this the push sent the stale primary series (v2.2.3).
 * Returns `next` unchanged (same object) when there is nothing to sync.
 */
export function syncAllSeries(prev = {}, next = {}) {
  const seriesChanged = s(prev.series) !== s(next.series) || s(prev.sequence) !== s(next.sequence);
  if (!seriesChanged) return next;
  // Caller supplied a fresh all_series alongside the edit - trust it.
  if (next.all_series !== undefined
      && JSON.stringify(next.all_series) !== JSON.stringify(prev.all_series)) return next;
  const rest = (Array.isArray(prev.all_series) ? prev.all_series : []).slice(1);
  // Primary cleared: drop it, keep any secondary series.
  if (!s(next.series)) return { ...next, all_series: rest };
  const first = (Array.isArray(prev.all_series) && prev.all_series[0]) || {};
  const primary = { ...first, name: s(next.series), sequence: s(next.sequence) || null };
  const others = rest.filter((x) => s(x?.name).toLowerCase() !== primary.name.toLowerCase());
  return { ...next, all_series: [primary, ...others] };
}

/** Normalised series list to send: [{ name, sequence? }]. */
function seriesList(m) {
  let list = Array.isArray(m.all_series) && m.all_series.length > 0
    ? m.all_series.map((x) => ({ name: s(typeof x === 'string' ? x : x?.name), sequence: typeof x === 'string' ? '' : s(x?.sequence) }))
    : [];
  const primaryName = s(m.series);
  if (primaryName) {
    const primary = { name: primaryName, sequence: s(m.sequence) };
    if (list.length === 0) list = [primary];
    else if (list[0].name !== primary.name || list[0].sequence !== primary.sequence) {
      // series/sequence is what the user edits; it is authoritative for the primary.
      list = [primary, ...list.slice(1).filter((x) => x.name.toLowerCase() !== primaryName.toLowerCase())];
    }
  }
  return list
    .filter((x) => x.name)
    .map((x) => {
      const stripped = stripEmbeddedSequence(x.name);
      const obj = { name: stripped.name };
      const seq = x.sequence !== '' ? x.sequence : stripped.sequence;
      if (seq != null && seq !== '') obj.sequence = String(seq);
      return obj;
    });
}

/** Snapshot of the ABS-side metadata, taken at import (group.abs_original). */
export function snapshotAbsMetadata(m = {}) {
  return {
    title: m.title ?? null,
    subtitle: m.subtitle ?? null,
    author: m.author ?? null,
    narrator: m.narrator ?? null,
    series: m.series ?? null,
    sequence: m.sequence ?? null,
    all_series: (m.all_series || []).map((x) => ({ name: x?.name ?? x, sequence: x?.sequence ?? null })),
    genres: [...(m.genres || [])],
    tags: [...(m.tags || [])],
    description: m.description ?? null,
    publisher: m.publisher ?? null,
    published_year: m.published_year ?? m.publishedYear ?? m.year ?? null,
    isbn: m.isbn ?? null,
    asin: m.asin ?? null,
    language: m.language ?? null,
  };
}

// Genres: existing ones verbatim, policy only on additions.
function diffGenres(cur, orig, cfg, userCleared = false) {
  if (sameList(cur, orig)) return undefined;
  // An empty list is sent only when the user explicitly emptied it by hand
  // (meta.user_cleared); never because AI/policy code left it empty.
  if (cur.length === 0) return orig.length > 0 && userCleared ? [] : undefined;
  const origKeys = new Map(orig.map((g) => [listKey(g), g]));
  const kept = cur.filter((g) => origKeys.has(listKey(g))).map((g) => origKeys.get(listKey(g)));
  const added = cur.filter((g) => !origKeys.has(listKey(g)));
  // Policy and cap apply to additions only; kept (already in ABS) genres are
  // never filtered or trimmed.
  let additions = cfg.genre_enforcement === false ? added : enforceGenrePolicyWithSplit(added);
  const keptKeys = new Set(kept.map(listKey));
  additions = dedupe(additions).filter((g) => !keptKeys.has(listKey(g)));
  additions = additions.slice(0, Math.max(0, MAX_GENRES - kept.length));
  const final = [...kept, ...additions];
  if (final.length === 0 || sameList(final, orig)) return undefined;
  return final;
}

// Tags: existing ones verbatim (incl. dna:/user tags), policy only on additions.
function diffTags(cur, orig, cfg, userCleared = false) {
  if (sameList(cur, orig)) return undefined;
  if (cur.length === 0) return orig.length > 0 && userCleared ? [] : undefined;
  const origKeys = new Map(orig.map((t) => [listKey(t), t]));
  const kept = cur.filter((t) => origKeys.has(listKey(t))).map((t) => origKeys.get(listKey(t)));
  const added = cur.filter((t) => !origKeys.has(listKey(t)));
  const addedDna = added.filter(isDnaTag);
  const addedStd = enforceTagPolicy(added.filter((t) => !isDnaTag(t)), {
    preserveUnrecognized: cfg.preserve_existing_tags === true,
  });
  const keptKeys = new Set(kept.map(listKey));
  const final = dedupe([...kept, ...addedStd.filter((t) => !keptKeys.has(listKey(t))), ...addedDna]);
  if (final.length === 0 || sameList(final, orig)) return undefined;
  return final;
}

/**
 * @param {object} meta      current book metadata
 * @param {object|null} original  snapshot from import (group.abs_original), or null
 * @param {object} cfg       app config (genre_enforcement, preserve_existing_*)
 * @returns {{ metadata: object, tags?: string[] }}
 */
export function buildAbsPayload(meta = {}, original = null, cfg = {}) {
  const m = meta || {};
  const o = original || null;
  const metadata = {};
  const changed = (cur, prev) => o == null || cur !== prev;

  for (const [key, absKey] of SCALARS) {
    const cur = scalarOf(m, key);
    if (!cur) continue; // no clear path for scalars
    if (key === 'title' && isPlaceholderTitle(cur)) continue;
    if (changed(cur, o && scalarOf(o, key))) metadata[absKey] = cur;
  }

  const author = s(m.author);
  if (author && !isPlaceholderAuthor(author) && changed(author, o && s(o.author))) {
    const authors = splitAuthors(author)
      .filter((n) => !isPlaceholderAuthor(n))
      .map((name, i) => ({ id: `new-${i + 1}`, name }));
    if (authors.length > 0) metadata.authors = authors;
  }

  const narrator = s(m.narrator);
  if (narrator && !isPlaceholderAuthor(narrator) && changed(narrator, o && s(o.narrator))) {
    const narrators = splitAuthors(narrator);
    if (narrators.length > 0) metadata.narrators = narrators;
  }

  // Series: never sent empty (clearing stays manual in ABS, CR-4a).
  const series = seriesList(m);
  if (series.length > 0 && (o == null || JSON.stringify(series) !== JSON.stringify(seriesList(o)))) {
    metadata.series = series;
  }

  const payload = { metadata };
  const curGenres = dedupe(m.genres);
  const curTags = dedupe(m.tags);
  if (o == null) {
    // No snapshot: we cannot tell existing from new, so treat everything as
    // existing - no policy, no empty arrays.
    if (curGenres.length > 0) metadata.genres = curGenres;
    if (curTags.length > 0) payload.tags = curTags;
  } else {
    const cleared = Array.isArray(m.user_cleared) ? m.user_cleared : [];
    const genres = diffGenres(curGenres, dedupe(o.genres), cfg, cleared.includes('genres'));
    if (genres !== undefined) metadata.genres = genres;
    const tags = diffTags(curTags, dedupe(o.tags), cfg, cleared.includes('tags'));
    if (tags !== undefined) payload.tags = tags;
  }
  return payload;
}

/** True when the payload would change nothing in ABS. */
export function isEmptyPayload(payload) {
  return Object.keys(payload?.metadata || {}).length === 0 && !('tags' in (payload || {}));
}

/**
 * After a successful push, advance the snapshot to what ABS now holds so a
 * later revert (e.g. removing a tag that was just pushed) is still detected.
 */
export function applyPayloadToSnapshot(original, meta, payload) {
  const next = snapshotAbsMetadata(original || {});
  const md = payload?.metadata || {};
  for (const [key, absKey] of SCALARS) if (absKey in md) next[key] = md[absKey];
  if ('authors' in md) next.author = meta.author;
  if ('narrators' in md) next.narrator = meta.narrator;
  if ('series' in md) {
    next.all_series = md.series.map((x) => ({ name: x.name, sequence: x.sequence ?? null }));
    next.series = md.series[0]?.name ?? null;
    next.sequence = md.series[0]?.sequence ?? null;
  }
  if ('genres' in md) next.genres = [...md.genres];
  if ('tags' in (payload || {})) next.tags = [...payload.tags];
  return next;
}
