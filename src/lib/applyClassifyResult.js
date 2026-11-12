// applyClassifyResult - pure genres/tags application for a classify result.
//
// Composes mergeGenres + mergeClassifyTags. Guarantees (audit C-1, H-1):
//   - an empty AI answer (no genres, tags, dna_tags or age_tags) leaves metadata untouched and
//     reports error 'empty-answer';
//   - Force only discards an existing array when the AI supplied a non-empty
//     replacement for that same array;
//   - genres supplement by default (preserveGenres !== false).

import { mergeGenres } from './mergeGenres';
import { mergeClassifyTags } from './mergeClassifyTags';

const nonEmpty = (a) => Array.isArray(a) && a.length > 0;

// Returns { metadata, changedFields, error }. changedFields uses the file-change
// names the scanner stamps: 'genre' and 'tags'.
export function applyClassifyResult(
  metadata,
  result,
  { force = false, preserveGenres = true, originalTags = undefined } = {}
) {
  const r = result || {};
  if (!nonEmpty(r.genres) && !nonEmpty(r.tags) && !nonEmpty(r.dna_tags) && !nonEmpty(r.age_tags)) {
    return { metadata, changedFields: [], error: 'empty-answer' };
  }

  const next = { ...metadata };
  const changedFields = [];

  // Genres. Force replaces, but only when the AI actually gave genres.
  const genreResult = mergeGenres(next.genres, r.genres, {
    preserve: force && nonEmpty(r.genres) ? false : preserveGenres !== false,
  });
  next.genres = genreResult.genres;
  if (genreResult.changed) changedFields.push('genre');

  // Tags. Force drops the existing tags only when top-level tags came back.
  const forceTags = force && nonEmpty(r.tags);
  const tagResult = mergeClassifyTags(
    forceTags ? [] : next.tags,
    r,
    forceTags ? undefined : originalTags
  );
  next.tags = tagResult.tags;
  if (tagResult.changed) changedFields.push('tags');

  return { metadata: next, changedFields, error: undefined };
}
