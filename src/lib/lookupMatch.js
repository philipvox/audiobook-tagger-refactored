// lookupMatch.js - does an external lookup hit describe the book we asked for?
//
// M-3: the OpenLibrary / Audible / Audnexus lookups used to take the first hit
// unchecked, so a search for one book could stage another book's ISBN, ASIN
// or author. Rules:
//   - Titles are compared normalised (case, punctuation, diacritics, trailing
//     junk such as "(Unabridged)" removed), on whole words only: "It" never
//     matches "The Pit and the Pendulum".
//   - An exact title match is accepted when the author check passes (or the
//     book has no real author to check).
//   - A containment match ("Dune" in "Dune Messiah") is accepted only when the
//     book has a real author AND an author surname matches.
//   - When choosing from a list, an exact match beats a containment match.

import { isPlaceholderAuthor, removeJunkSuffixes } from './normalize.js';

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md']);

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeForMatch(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeTitle(value) {
  const raw = String(value ?? '').trim();
  return normalizeForMatch(raw ? removeJunkSuffixes(raw) : '');
}

/**
 * 'exact' when the normalised titles are equal, 'contains' when one contains
 * the other on word boundaries, null otherwise. Empty never matches.
 */
export function titleMatch(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return null;
  if (x === y) return 'exact';
  const wx = ` ${x} `;
  const wy = ` ${y} `;
  return wx.includes(wy) || wy.includes(wx) ? 'contains' : null;
}

/** Surnames of every author in a "A B, C D & E F" style string. */
function surnames(authorString) {
  return String(authorString ?? '')
    .split(/,|;|&|\band\b/i)
    .map((name) => normalizeForMatch(name).split(' ').filter((w) => w && !NAME_SUFFIXES.has(w)))
    .map((words) => words[words.length - 1])
    .filter(Boolean);
}

/** True when `author` is a real name (not empty, not a placeholder). */
export function hasRealAuthor(author) {
  return !isPlaceholderAuthor(author);
}

function authorMatches(author, hitAuthors) {
  const hitWords = new Set(normalizeForMatch(
    Array.isArray(hitAuthors) ? hitAuthors.join(' ') : hitAuthors,
  ).split(' ').filter(Boolean));
  return surnames(author).some((s) => hitWords.has(s));
}

/**
 * How well a hit matches the book: 'exact', 'contains' or null (rejected).
 * `hitAuthors` may be a string or an array of names.
 */
export function lookupHitMatch({ title, author }, { title: hitTitle, authors: hitAuthors }) {
  const quality = titleMatch(title, hitTitle);
  if (!quality) return null;
  if (hasRealAuthor(author)) return authorMatches(author, hitAuthors) ? quality : null;
  // No real author to confirm a partial title: only an exact title counts.
  return quality === 'exact' ? quality : null;
}

/** True when the hit is acceptable for the book. */
export function lookupHitMatches(book, hit) {
  return lookupHitMatch(book, hit) !== null;
}

/**
 * Pick the best hit from `items`: the first exact match, else the first
 * containment match, else null. `toHit(item)` returns { title, authors };
 * `accept(item)` can exclude items (e.g. no ISBN) before matching.
 */
export function pickLookupHit(book, items, toHit, accept = () => true) {
  let partial = null;
  for (const item of items || []) {
    if (!accept(item)) continue;
    const quality = lookupHitMatch(book, toHit(item));
    if (quality === 'exact') return item;
    if (quality === 'contains' && partial === null) partial = item;
  }
  return partial;
}
