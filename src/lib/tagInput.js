// tagInput - pure helpers for the inline tag editor in MetadataPanel (#54).
//
// The editor used to force `toLowerCase()` on every tag the user typed or
// edited, so a curated "Sci-Fi" came back as "sci-fi" the moment the user
// touched it (wtanksleyjr, #54). User-typed casing is now preserved. The one
// exception is the generated vocabulary the app matches literally - DNA tags
// (isDnaTag uses a case-sensitive `startsWith('dna:')`) and age/rating tags -
// which stay normalized so they keep flowing through the DNA/age branches.
//
// Dedup comparisons are case-insensitive throughout, so "Fantasy" and
// "fantasy" never coexist in one book's tag list.

import { isAgeTag } from './mergeClassifyTags';

// Trim, collapse internal whitespace to hyphens, and lowercase ONLY the
// app-generated vocabulary. Returns '' for blank input.
export function normalizeTagInput(raw) {
  const tag = String(raw ?? '').trim().replace(/\s+/g, '-');
  if (!tag) return '';
  if (/^dna:/i.test(tag) || isAgeTag(tag)) return tag.toLowerCase();
  return tag;
}

// Append a tag to the list. Returns the SAME array reference when nothing
// changes (blank input, or a case-insensitive duplicate).
export function addTagToList(tags, raw) {
  const list = Array.isArray(tags) ? tags : [];
  const tag = normalizeTagInput(raw);
  if (!tag) return list;
  const key = tag.toLowerCase();
  if (list.some((t) => String(t).toLowerCase() === key)) return list;
  return [...list, tag];
}

// True when two tag lists are identical (same order, same exact strings).
// The editor uses this to skip a no-op commit: onInlineEdit stamps
// file.changes unconditionally, so re-committing an unchanged tag would
// otherwise stage a `tags` change with old === new.
export function isSameTagList(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

// Replace the tag at `idx`. A cleared value removes the tag. The duplicate
// check skips the slot being edited, so re-committing an unchanged tag (or
// only changing its casing) is not mistaken for a duplicate; renaming a tag
// onto another existing tag collapses the two instead of duplicating.
export function replaceTagInList(tags, idx, raw) {
  const list = Array.isArray(tags) ? tags : [];
  if (typeof idx !== 'number' || idx < 0 || idx >= list.length) return list;

  const tag = normalizeTagInput(raw);
  if (!tag) return list.filter((_, i) => i !== idx);

  const key = tag.toLowerCase();
  if (list.some((t, i) => i !== idx && String(t).toLowerCase() === key)) {
    return list.filter((_, i) => i !== idx);
  }

  const next = [...list];
  next[idx] = tag;
  return next;
}
