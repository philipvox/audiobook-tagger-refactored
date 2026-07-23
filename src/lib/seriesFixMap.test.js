import { describe, it, expect } from 'vitest';
import { fixMatchKey, buildFixIndexMap, fixIndexForIssue } from './seriesFixMap';

describe('seriesFixMap (M3: key fixes so same book/field but different values stay distinct)', () => {
  it('builds distinct indices for two fixes on the same book+field with different values', () => {
    const allFixes = [
      { book_id: 'b1', field: 'series', suggested_value: 'Harry Potter' },
      { book_id: 'b1', field: 'series', suggested_value: 'Harry Potter and the Sorcerer' },
    ];
    const map = buildFixIndexMap(allFixes);

    const idx0 = fixIndexForIssue({ suggested_fix: allFixes[0] }, map);
    const idx1 = fixIndexForIssue({ suggested_fix: allFixes[1] }, map);

    // The old `${book_id}-${field}` key collapsed these onto one entry; the
    // value-aware key keeps them independently selectable.
    expect(idx0).toBe(0);
    expect(idx1).toBe(1);
    expect(idx0).not.toBe(idx1);
  });

  it('resolves an issue whose suggested_fix is a distinct object with equal content (JSON boundary)', () => {
    const allFixes = [
      { book_id: 'b2', field: 'sequence', suggested_value: '3' },
    ];
    const map = buildFixIndexMap(allFixes);
    // Simulate a separately-deserialized copy (different object identity).
    const issue = { suggested_fix: { book_id: 'b2', field: 'sequence', suggested_value: '3' } };
    expect(fixIndexForIssue(issue, map)).toBe(0);
  });

  it('returns null for an issue with no suggested_fix or an unmatched fix', () => {
    const map = buildFixIndexMap([{ book_id: 'b1', field: 'series', suggested_value: 'X' }]);
    expect(fixIndexForIssue({}, map)).toBeNull();
    expect(fixIndexForIssue({ suggested_fix: { book_id: 'zz', field: 'series', suggested_value: 'Y' } }, map)).toBeNull();
  });

  it('fixMatchKey folds truly-identical fixes (harmless: same change) onto one index', () => {
    const allFixes = [
      { book_id: 'b1', field: 'series', suggested_value: 'Dune' },
      { book_id: 'b1', field: 'series', suggested_value: 'Dune' },
    ];
    expect(fixMatchKey(allFixes[0])).toBe(fixMatchKey(allFixes[1]));
    const map = buildFixIndexMap(allFixes);
    // First occurrence wins.
    expect(map.get(fixMatchKey(allFixes[0]))).toBe(0);
  });
});
