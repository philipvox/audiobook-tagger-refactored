// mergeGenres - pure helper for the classify handler's genre merge (#54).
//
// Default (preserve=false) is the legacy behavior the classify block has always
// had: the AI's genres REPLACE the book's genres whenever the AI returned any,
// and are ignored when it returned none.
//
// With the `preserve_existing_genres` setting on (preserve=true) the AI's
// genres SUPPLEMENT the existing ones instead (chickenbockbok, #54): the result
// is a case-insensitive-deduped union with the existing genres first and their
// original casing intact. Existing genres are NEVER dropped - the genre-count
// policy (MAX_GENRES, the cap enforceGenrePolicy applies) only limits how many
// AI genres get appended, so a book already at the cap simply keeps what it has.
//
// `changed` is deliberately asymmetric:
//   - preserve OFF: `changed` mirrors the pre-#54 signal ("the AI returned
//     genres"), so the default-off classify path stamps the `genre` file change
//     exactly as it did before this helper existed.
//   - preserve ON:  `changed` is a real value comparison, so a supplement that
//     adds nothing new does not stage a no-op change.

import { MAX_GENRES } from './genres';

const clean = (g) => (typeof g === 'string' ? g.trim() : '');

// existing:  string[] (the book's current genres)
// aiGenres:  string[] (the classifier's genres)
// options:   { preserve?: boolean, max?: number }
// Returns { genres: string[], changed: boolean }.
export function mergeGenres(existing, aiGenres, { preserve = false, max = MAX_GENRES } = {}) {
  const existingList = Array.isArray(existing) ? existing : [];
  const aiList = Array.isArray(aiGenres) ? aiGenres : [];

  if (!preserve) {
    return {
      genres: aiList.length > 0 ? aiList : existingList,
      changed: aiList.length > 0,
    };
  }

  const seen = new Set();
  const kept = [];
  for (const g of existingList) {
    const s = clean(g);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(s);
  }

  // Only the ADDITIONS are capped; trimming never eats a curated genre.
  const room = Math.max(0, max - kept.length);
  const additions = [];
  for (const g of aiList) {
    if (additions.length >= room) break;
    const s = clean(g);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(s);
  }

  const genres = [...kept, ...additions];
  const changed =
    genres.length !== existingList.length || genres.some((g, i) => g !== existingList[i]);

  return { genres, changed };
}
