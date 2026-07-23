// listFingerprint - a cheap identity fingerprint of the list a selection anchor
// was taken against (M13).
//
// Shift-click range selection stores an anchor INDEX and later indexes back into
// the visible list. If that list changes between the anchor click and the
// shift-click (a filter is applied/cleared, results reorder), the stored index
// no longer points at the same row, so the built range is wrong. Comparing a
// fingerprint of the list at anchor time vs shift-click time lets the caller
// detect the mismatch and fall back to a plain click.
//
// The fingerprint intentionally uses only length + first/last id: cheap to
// compute on every click and sufficient to catch the filter-changed /
// list-swapped cases that actually break indexing.
export function listFingerprint(list) {
  const arr = Array.isArray(list) ? list : [];
  const len = arr.length;
  if (len === 0) return '0::';
  const first = arr[0]?.id ?? '';
  const last = arr[len - 1]?.id ?? '';
  return `${len}:${first}:${last}`;
}
