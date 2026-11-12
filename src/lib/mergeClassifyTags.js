// mergeClassifyTags - pure helper for the classify handler's tag merge (H1).
//
// The classifier can return three kinds of tags: top-level classification
// tags (`tags`), DNA tags (`dna:` prefixed), and age tags (`age-*`, `rated-*`,
// `for-kids`, `not-for-kids`). Sub-steps often come back with ONLY dna/age
// tags and no top-level tags. The old code always did
//   tags = [...new Set([...tags, ...dna_tags, ...age_tags])]
// which wiped every curated tag whenever `tags` was empty. This helper instead:
//   - fully replaces (folding dna/age in) only when top-level tags are present;
//   - otherwise merges dna/age additively, preserving curated tags and
//     stripping only the stale dna:/age tags being replaced;
//   - leaves the existing tags untouched when nothing new came back.

// A tag is an "age tag" if it matches the age-rating vocabulary the classifier
// emits (see api.js buildAgeTags). Kept in sync with the detector used for the
// classify smart-skip in ScannerPage.
export function isAgeTag(t) {
  return /^age-|^for-kids$|^for-teens$|^for-ya$|^not-for-kids$|^rated-/i.test(String(t));
}

// existingTags: string[] (the book's current tags)
// result: { tags?, dna_tags?, age_tags? } from the classifier
// originalTags (optional, v2.2.3): the tags ABS held at import
// (group.abs_original.tags); [] for a book with no snapshot (local files).
// options.aiTags (optional): the tags earlier AI answers added this session
// (group.ai_tags).
// Returns { tags: string[], changed: boolean, aiTags: string[] }.
//
// One policy for every AI tag answer (Classify, AI Tags, DNA, Lookup Age):
//   - a tag in the import snapshot is never removed, except a dna: tag when
//     new dna: tags came back (the DNA set is replaced as a whole, Task 2);
//   - an age tag is replaced by new age tags only when it is not in the
//     snapshot (D-3; the Task 8 ruling for Lookup Age);
//   - a full classification (top-level tags) replaces only the tags an
//     earlier AI answer added (D-7): with options.aiTags given, exactly
//     those; without it, every tag not in the snapshot (the pre-tracking rule);
//   - without originalTags a full classification replaces every tag (Force,
//     which the caller only uses when the AI supplied a replacement).
// `aiTags` in the result is the tracking list to store back on the group: the
// non-dna, non-age tags of the result that an AI answer added and that are
// not in the snapshot. A tag the user had before the answer stays theirs.
const lower = (t) => String(t).toLowerCase();
const isDna = (t) => String(t).startsWith('dna:');
const unique = (list) => [...new Set(list)];

export function mergeClassifyTags(existingTags, result = {}, originalTags = undefined, { aiTags } = {}) {
  const existing = Array.isArray(existingTags) ? existingTags : [];
  const clsTags = result.tags || [];
  const dnaTags = result.dna_tags || [];
  const ageTags = result.age_tags || [];
  const changed = clsTags.length > 0 || dnaTags.length > 0 || ageTags.length > 0;
  const snap = Array.isArray(originalTags) ? new Set(originalTags.map(lower)) : null;
  const inSnap = (t) => snap != null && snap.has(lower(t));
  const tracked = Array.isArray(aiTags) ? new Set(aiTags.map(lower)) : null;
  const prevAi = tracked || new Set();

  const staleDna = (t) => dnaTags.length > 0 && isDna(t);
  const staleAge = (t) => ageTags.length > 0 && isAgeTag(t) && !inSnap(t);
  const nextAiTags = (tags, fromAnswer) => {
    const before = new Set(existing.filter((t) => !prevAi.has(lower(t))).map(lower));
    const answer = new Set(fromAnswer.map(lower));
    return tags.filter((t) => !inSnap(t) && !isDna(t) && !isAgeTag(t)
      && (prevAi.has(lower(t)) || (answer.has(lower(t)) && !before.has(lower(t)))));
  };

  if (clsTags.length > 0) {
    if (!snap) {
      // No snapshot: a full replace that still folds DNA and age in.
      const tags = unique([...clsTags, ...dnaTags, ...ageTags]);
      return { tags, changed, aiTags: nextAiTags(tags, clsTags) };
    }
    const earlierAi = (t) => !inSnap(t) && !isDna(t) && !isAgeTag(t)
      && (tracked ? tracked.has(lower(t)) : true);
    const kept = existing.filter((t) => !staleDna(t) && !staleAge(t) && !earlierAi(t));
    const tags = unique([...kept, ...clsTags, ...dnaTags, ...ageTags]);
    return { tags, changed, aiTags: nextAiTags(tags, clsTags) };
  }

  if (dnaTags.length > 0 || ageTags.length > 0) {
    // Additive merge: preserve every other tag, drop only the stale dna:/age
    // tags that the new sets replace (never an age tag from the snapshot).
    const preserved = existing.filter((t) => !staleDna(t) && !staleAge(t));
    const tags = unique([...preserved, ...dnaTags, ...ageTags]);
    return { tags, changed, aiTags: nextAiTags(tags, []) };
  }

  // No tag data at all - leave the existing tags untouched.
  return { tags: existing, changed, aiTags: nextAiTags(existing, []) };
}
