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
// Returns { tags: string[], changed: boolean }.
// originalTags (optional, v2.2.3): the tags ABS held at import
// (group.abs_original.tags). When given, a full classification keeps every
// existing tag that is in that snapshot (curated/user/dna tags) and only
// replaces tags produced earlier this session; stale dna:/age tags are still
// replaced when the classifier returns new ones.
export function mergeClassifyTags(existingTags, result = {}, originalTags = undefined) {
  const existing = Array.isArray(existingTags) ? existingTags : [];
  const clsTags = result.tags || [];
  const dnaTags = result.dna_tags || [];
  const ageTags = result.age_tags || [];
  const changed = clsTags.length > 0 || dnaTags.length > 0 || ageTags.length > 0;

  if (clsTags.length > 0) {
    // Full classification replace (still fold DNA + age in, dedup) - but
    // never drop tags that already existed in ABS.
    let curated = [];
    if (Array.isArray(originalTags)) {
      const orig = new Set(originalTags.map((t) => String(t).toLowerCase()));
      curated = existing.filter((t) => {
        const str = String(t);
        if (!orig.has(str.toLowerCase())) return false;
        if (dnaTags.length > 0 && str.startsWith('dna:')) return false;
        if (ageTags.length > 0 && isAgeTag(str)) return false;
        return true;
      });
    }
    return { tags: [...new Set([...curated, ...clsTags, ...dnaTags, ...ageTags])], changed };
  }

  if (dnaTags.length > 0 || ageTags.length > 0) {
    // Additive merge: preserve curated tags, drop only the stale dna:/age
    // tags that the new sets replace.
    const preserved = existing.filter((t) => {
      const s = String(t);
      if (dnaTags.length > 0 && s.startsWith('dna:')) return false;
      if (ageTags.length > 0 && isAgeTag(s)) return false;
      return true;
    });
    return { tags: [...new Set([...preserved, ...dnaTags, ...ageTags])], changed };
  }

  // No tag data at all - leave the existing tags untouched.
  return { tags: existing, changed };
}
