// lookupMatch.js - does an external lookup hit describe the book we asked for?
//
// M-3: the OpenLibrary / Audible lookups used to take the first hit unchecked,
// so a search for one book could stage another book's ISBN, ASIN or author.
// A hit is accepted only when its title matches (normalised, containment
// either way) and, when the book has a real author, an author surname matches.

import { isPlaceholderAuthor } from './normalize.js';

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

/** True when one normalised title contains the other. Empty never matches. */
export function titlesMatch(a, b) {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
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

/**
 * Does a hit match the book? `hitAuthors` may be a string or an array of
 * names. With no real book author only the title is checked.
 */
export function lookupHitMatches({ title, author }, { title: hitTitle, authors: hitAuthors }) {
  if (!titlesMatch(title, hitTitle)) return false;
  if (!hasRealAuthor(author)) return true;
  const hitWords = new Set(normalizeForMatch(
    Array.isArray(hitAuthors) ? hitAuthors.join(' ') : hitAuthors,
  ).split(' ').filter(Boolean));
  return surnames(author).some((s) => hitWords.has(s));
}
