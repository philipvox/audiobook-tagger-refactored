import { describe, it, expect } from 'vitest';
import { buildWritePayload, unwritableReason, splitFileChanges } from './writePayload';

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
      group_size: 2,
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

describe('buildWritePayload sends only what the writer writes (#62)', () => {
  it('sends group_size = the number of files in the book', () => {
    const { filesMap } = buildWritePayload(groups, new Set(['f1', 'f3']));
    expect(filesMap.f1.group_size).toBe(2);
    expect(filesMap.f3.group_size).toBe(1);
  });

  it('leaves app-only fields (tags, DNA, age) out of the payload', () => {
    const g = [{
      id: 'g', files: [{
        id: 'a', path: '/x/a.m4b',
        changes: { tags: { old: '', new: 'dna:pace:fast' }, age_rating: { old: '', new: 'Teen' }, genre: { old: '', new: 'Fantasy' } },
      }],
    }];
    const { fileIds, filesMap } = buildWritePayload(g, new Set(['a']));
    expect(fileIds).toEqual(['a']);
    expect(filesMap.a.changes).toEqual({ genre: { old: '', new: 'Fantasy' } });
  });

  it('drops a file whose only staged changes are app-only', () => {
    const g = [{ id: 'g', files: [{ id: 'a', path: '/x/a.m4b', changes: { tags: { old: '', new: 'x' } } }] }];
    expect(buildWritePayload(g, new Set(['a'])).fileIds).toEqual([]);
  });

  it('leaves out fields the file format has no tag for', () => {
    const g = [{
      id: 'g', files: [
        { id: 'mp3', path: '/x/a.mp3', changes: { description: { old: '', new: 'D' }, publisher: { old: '', new: 'P' }, isbn: { old: '', new: '1' } } },
        { id: 'm4b', path: '/x/b.m4b', changes: { description: { old: '', new: 'D' }, publisher: { old: '', new: 'P' }, isbn: { old: '', new: '1' } } },
      ],
    }];
    const { filesMap } = buildWritePayload(g, new Set(['mp3', 'm4b']));
    expect(Object.keys(filesMap.mp3.changes)).toEqual(['publisher']);
    expect(Object.keys(filesMap.m4b.changes).sort()).toEqual(['description', 'isbn']);
  });
});

describe('unwritableReason / splitFileChanges (#62)', () => {
  it('names the reason a staged change will not be written', () => {
    expect(unwritableReason('title', '/a.mp3')).toBeNull();
    expect(unwritableReason('genre', '/a.m4b')).toBeNull();
    expect(unwritableReason('tags', '/a.m4b')).toMatch(/app only/i);
    expect(unwritableReason('description', 'C:\\Books\\a.MP3')).toMatch(/MP3/);
    expect(unwritableReason('publisher', '/a.m4b')).toMatch(/M4B/);
    expect(unwritableReason('asin', '/a.flac')).toMatch(/M4B/);
  });

  it('splits a file\'s staged changes into written and app-only rows', () => {
    const { writable, notWritten } = splitFileChanges({
      path: '/a.mp3',
      changes: { title: { old: 'A', new: 'B' }, tags: { old: '', new: 't' }, description: { old: '', new: 'd' } },
    });
    expect(writable.map(([f]) => f)).toEqual(['title']);
    expect(notWritten.map((r) => r.field)).toEqual(['tags', 'description']);
    expect(notWritten.every((r) => typeof r.reason === 'string' && r.reason.length > 0)).toBe(true);
    expect(splitFileChanges({ path: '/a.m4b' })).toEqual({ writable: [], notWritten: [] });
  });
});
