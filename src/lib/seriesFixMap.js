// seriesFixMap — pure helpers for keying SeriesIssueModal's fix selections.
//
// M3 bug: the modal keyed its "which fix is selected" map by `${book_id}-${field}`.
// Two distinct suggested fixes that target the same book + field but propose
// DIFFERENT values collapse onto one key, so toggling one silently toggles the
// other (and Apply sends the wrong fix). Including the suggested value in the
// key disambiguates genuinely-different fixes. Truly-identical fixes still share
// a key, which is harmless: applying either produces the same change.

export function fixMatchKey(fix) {
  if (!fix) return null;
  const book = fix.book_id ?? '';
  const field = fix.field ?? '';
  const value = fix.suggested_value ?? '';
  return `${book}::${field}::${value}`;
}

// Build a Map from fixMatchKey -> index into all_fixes. First occurrence wins;
// identical duplicates share an index (harmless, same change).
export function buildFixIndexMap(allFixes = []) {
  const map = new Map();
  allFixes.forEach((fix, idx) => {
    const key = fixMatchKey(fix);
    if (key !== null && !map.has(key)) {
      map.set(key, idx);
    }
  });
  return map;
}

// Resolve the all_fixes index for an issue's suggested_fix, or null when the
// issue has no fix / no match.
export function fixIndexForIssue(issue, fixIndexMap) {
  if (!issue?.suggested_fix || !fixIndexMap) return null;
  const key = fixMatchKey(issue.suggested_fix);
  return fixIndexMap.has(key) ? fixIndexMap.get(key) : null;
}
