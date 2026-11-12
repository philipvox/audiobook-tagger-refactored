// userCleared - tracks which list fields the USER emptied by hand, so the ABS
// push can tell an explicit clear from an AI/policy result that left a list
// empty (a push never sends an empty array without this flag).
//
// metadata.user_cleared is an array containing 'genres' and/or 'tags'.

const FIELDS = ['genres', 'tags'];

// updates: partial metadata about to be applied by a UI edit handler.
// Returns { user_cleared } to merge into the metadata, or {} when the edit does
// not touch genres/tags. The flag is added when the edit leaves the list empty
// and removed when it becomes non-empty.
export function userClearedPatch(prevMetadata, updates = {}) {
  const touched = FIELDS.filter((f) => f in (updates || {}));
  if (touched.length === 0) return {};
  const set = new Set(Array.isArray(prevMetadata?.user_cleared) ? prevMetadata.user_cleared : []);
  for (const f of touched) {
    const v = updates[f];
    if (Array.isArray(v) && v.length === 0) set.add(f);
    else set.delete(f);
  }
  return { user_cleared: [...set] };
}
