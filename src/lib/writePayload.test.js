import { describe, it, expect } from 'vitest';
import { buildWritePayload } from './writePayload';

const groups = [
  {
    id: 'g1',
    files: [
      { id: 'f1', path: '/a.m4b', changes: { title: { old: 'A', new: 'B' }, author: { old: 'X', new: 'Y' } } },
      { id: 'f2', path: '/b.m4b', changes: {} },
    ],
  },
  {
    id: 'g2',
    files: [
      { id: 'f3', path: '/c.m4b', changes: { year: { old: '', new: '2020' } } },
    ],
  },
];

describe('buildWritePayload', () => {
  it('includes only selected files that have changes', () => {
    const { fileIds, filesMap } = buildWritePayload(groups, new Set(['f1', 'f2']));
    expect(fileIds).toEqual(['f1']); // f2 has no changes
    expect(filesMap.f1).toEqual({
      path: '/a.m4b',
      changes: { title: { old: 'A', new: 'B' }, author: { old: 'X', new: 'Y' } },
    });
    expect(filesMap.f2).toBeUndefined();
  });

  it('drops per-field excluded changes (fileId:field keys)', () => {
    const excluded = new Set(['f1:author']);
    const { fileIds, filesMap } = buildWritePayload(groups, new Set(['f1']), excluded);
    expect(fileIds).toEqual(['f1']);
    expect(filesMap.f1.changes).toEqual({ title: { old: 'A', new: 'B' } });
    expect(filesMap.f1.changes.author).toBeUndefined();
  });

  it('drops a file whose changes are all excluded', () => {
    const excluded = new Set(['f1:title', 'f1:author']);
    const { fileIds, filesMap } = buildWritePayload(groups, new Set(['f1']), excluded);
    expect(fileIds).toEqual([]);
    expect(filesMap.f1).toBeUndefined();
  });

  it('exclusion is scoped per file id (does not cross files)', () => {
    // f1:author excluded must not touch f3.
    const excluded = new Set(['f1:author']);
    const { fileIds, filesMap } = buildWritePayload(groups, new Set(['f1', 'f3']), excluded);
    expect(fileIds).toEqual(['f1', 'f3']);
    expect(filesMap.f3.changes).toEqual({ year: { old: '', new: '2020' } });
  });

  it('ignores unselected files and files with no changes object', () => {
    const g = [{ id: 'x', files: [{ id: 'n', path: '/n' }] }];
    const { fileIds, filesMap } = buildWritePayload(g, new Set(['n']));
    expect(fileIds).toEqual([]);
    expect(filesMap).toEqual({});
  });
});
