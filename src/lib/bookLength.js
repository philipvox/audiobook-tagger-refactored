// Book length: the length tags come from the book's real duration, never from
// the AI. Models guess the length from the title and description and were
// right on about half of books (2026-11-24 whole-library test).

import { getLengthTagFromSeconds } from './genres';

const LENGTH_TAGS = new Set(['under-5-hours', '5-10-hours', '10-15-hours', '15-20-hours', 'over-20-hours']);

const positive = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

/** Duration in seconds of a scanner group: ABS duration, runtime_minutes, or the sum of its files. */
export function groupDurationSeconds(group) {
  const m = group?.metadata || {};
  const fromFiles = (group?.files || []).reduce((s, f) => s + (positive(f?.duration) || 0), 0);
  return positive(m.duration) || (positive(m.runtime_minutes) ? m.runtime_minutes * 60 : null) || positive(fromFiles);
}

/** Duration in seconds of a book sent to a backend command (`duration` seconds or `duration_minutes`). */
export function bookDurationSeconds(book) {
  return positive(book?.duration) || (positive(book?.duration_minutes) ? book.duration_minutes * 60 : null);
}

/** "3h 0m", for prompts. */
export function formatDurationForPrompt(seconds) {
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** DNA length bands, as the DNA prompt defines them: <5h short, 5-12h medium, 12-20h long, 20h+ epic. */
export function dnaLengthFromSeconds(seconds) {
  const h = seconds / 3600;
  return h < 5 ? 'short' : h < 12 ? 'medium' : h < 20 ? 'long' : 'epic';
}

/**
 * Put the real length into a tag list. Plain lists get one length tag (any
 * guessed one is replaced); DNA lists ({ dna: true }) get dna:length replaced,
 * and only when the list already has DNA tags. An unknown duration changes nothing.
 */
export function withLengthTags(tags, seconds, { dna = false } = {}) {
  const list = Array.isArray(tags) ? tags : [];
  if (!positive(seconds)) return list;
  if (dna) {
    if (!list.some((t) => String(t).startsWith('dna:'))) return list;
    return [...list.filter((t) => !String(t).startsWith('dna:length:')), `dna:length:${dnaLengthFromSeconds(seconds)}`];
  }
  return [...list.filter((t) => !LENGTH_TAGS.has(String(t).toLowerCase())), getLengthTagFromSeconds(seconds)];
}
