import { describe, it, expect } from 'vitest';
import { aggregateGroupChanges } from './aggregateChanges';

describe('aggregateGroupChanges (L10: union across all files, first old/new per field)', () => {
  it('unions changed fields from every file, not just the first', () => {
    const group = {
      files: [
        { changes: { title: { old: 'a', new: 'b' } } },
        { changes: { author: { old: 'c', new: 'd' } } },
      ],
    };
    const out = aggregateGroupChanges(group);
    expect(Object.keys(out).sort()).toEqual(['author', 'title']);
    expect(out.title).toEqual({ old: 'a', new: 'b' });
    expect(out.author).toEqual({ old: 'c', new: 'd' });
  });

  it('keeps the first file that carries a given field as representative', () => {
    const group = {
      files: [
        { changes: { title: { old: 'first', new: 'X' } } },
        { changes: { title: { old: 'second', new: 'Y' } } },
      ],
    };
    expect(aggregateGroupChanges(group).title).toEqual({ old: 'first', new: 'X' });
  });

  it('returns an empty object for missing/empty groups', () => {
    expect(aggregateGroupChanges(null)).toEqual({});
    expect(aggregateGroupChanges({ files: [] })).toEqual({});
    expect(aggregateGroupChanges({ files: [{}] })).toEqual({});
  });
});
