import { describe, it, expect } from 'vitest';
import {
  selectedGroupsFrom, selectionForSelectAll, localWriteTargets,
  summarizeWriteResult, applyWriteResult, fileNameOf,
  summarizeRenameResult, applyRenameResult,
} from './localWrite';
import { buildWritePayload } from './writePayload';

const local = (id, files, extra = {}) => ({
  id,
  metadata: { title: `Book ${id}` },
  files: files.map(([fid, path, changes = {}]) => ({ id: fid, path, filename: path.split('/').pop(), changes })),
  ...extra,
});
const abs = (id) => ({
  id, abs_id: id, source: 'abs', metadata: { title: `ABS ${id}` },
  files: [{ id: `${id}-f0`, path: '/audiobooks/x.m4b', changes: { title: { old: 'a', new: 'b' } } }],
});
const title = { old: 'Old', new: 'New' };

describe('selection for Write Tags and Rename (#62)', () => {
  it('with a filter active, Select All then Write Tags targets only the filtered local books', () => {
    const groups = [
      local('a', [['a1', '/l/a/1.m4b', { title }]]),
      local('b', [['b1', '/l/b/1.m4b', { title }]]),
      local('c', [['c1', '/l/c/1.m4b', { title }], ['c2', '/l/c/2.m4b', { title }]]),
      abs('z'),
    ];
    const filtered = [groups[0], groups[2], groups[3]];
    const sel = selectionForSelectAll(groups, filtered);
    expect(sel.allSelected).toBe(false);
    const selected = selectedGroupsFrom(groups, { allSelected: sel.allSelected, selectedGroupIds: sel.groupIds });
    expect(selected.map((g) => g.id)).toEqual(['a', 'c', 'z']);
    const targets = localWriteTargets(selected);
    expect(targets.localGroups.map((g) => g.id)).toEqual(['a', 'c']);
    expect(targets.fileIds).toEqual(['a1', 'c1', 'c2']);
  });

  it('Select All with no filter (or a filter showing every book) takes the allSelected fast path', () => {
    const groups = [local('a', [['a1', '/l/a.m4b']]), abs('z')];
    expect(selectionForSelectAll(groups, undefined).allSelected).toBe(true);
    expect(selectionForSelectAll(groups, groups).allSelected).toBe(true);
    expect(selectedGroupsFrom(groups, { allSelected: true, selectedGroupIds: new Set() })).toBe(groups);
  });

  it('an explicit selection keeps the library order', () => {
    const groups = [local('a', [['a1', '/l/a.m4b']]), local('b', [['b1', '/l/b.m4b']])];
    expect(selectedGroupsFrom(groups, { allSelected: false, selectedGroupIds: new Set(['b']) }).map((g) => g.id)).toEqual(['b']);
  });

  it('only files with staged changes are write targets, and writableCount ignores app-only changes', () => {
    const groups = [local('a', [
      ['a1', '/l/a/1.m4b', { title }],
      ['a2', '/l/a/2.m4b', {}],
      ['a3', '/l/a/3.m4b', { tags: { old: '', new: 't' } }],
    ])];
    const t = localWriteTargets(groups);
    expect(t.fileIds).toEqual(['a1', 'a3']);
    expect(t.writableCount).toBe(1);
  });
});

const groupsForWrite = () => [
  local('a', [
    ['a1', '/l/a/1.mp3', { title, description: { old: '', new: 'D' }, tags: { old: '', new: 't' } }],
    ['a2', '/l/a/2.mp3', { title }],
  ]),
  local('b', [['b1', '/l/b/1.m4b', { title, year: { old: '', new: 'soon' } }]]),
];

describe('summarizeWriteResult / applyWriteResult (#62)', () => {
  const sentFor = (groups) => buildWritePayload(groups, new Set(['a1', 'a2', 'b1'])).filesMap;

  it('a refused file keeps its reason: in the summary and as the book\'s lastError', () => {
    const groups = groupsForWrite();
    const reason = 'this MP3 has a lyrics frame that could not be preserved; not written';
    const result = {
      success: 2, failed: 1,
      errors: [{ file_id: 'a2', path: '/l/a/2.mp3', error: reason }],
      results: [
        { file_id: 'a1', path: '/l/a/1.mp3', status: 'success', skipped_fields: [] },
        { file_id: 'a2', path: '/l/a/2.mp3', status: 'failed', skipped_fields: [] },
        { file_id: 'b1', path: '/l/b/1.m4b', status: 'success', skipped_fields: ['year'] },
      ],
      sent: sentFor(groups),
    };
    const s = summarizeWriteResult(result, groups);
    expect(s.failures).toEqual([{ fileId: 'a2', groupId: 'a', name: '2.mp3', error: reason }]);
    expect(s.skipped).toEqual([{ fileId: 'b1', groupId: 'b', name: '1.m4b', fields: ['year'] }]);
    expect(s.toast.type).toBe('warning');
    expect(s.toast.message).toContain(`2.mp3: ${reason}`);
    expect(s.toast.message).toContain('1.m4b (year)');

    const next = applyWriteResult(groups, result);
    const a = next.find((g) => g.id === 'a');
    expect(a.lastError).toMatchObject({ stage: 'write', severity: 'error' });
    expect(a.lastError.message).toContain(reason);
    // Written file: the written fields are cleared; app-only and format-skipped
    // ones (never sent) stay staged.
    expect(Object.keys(a.files[0].changes).sort()).toEqual(['description', 'tags']);
    // Refused file: nothing cleared, so the same change is offered again.
    expect(a.files[1].changes).toEqual({ title });
    const b = next.find((g) => g.id === 'b');
    // The writer skipped `year` (unparseable): it stays staged, and the book says so.
    expect(b.files[0].changes).toEqual({ year: { old: '', new: 'soon' } });
    expect(b.lastError).toMatchObject({ stage: 'write', severity: 'warn' });
    expect(b.lastError.message).toContain('year');
  });

  it('a clean write clears the written changes and an earlier write error', () => {
    const groups = [local('a', [['a1', '/l/a.m4b', { title }]], { lastError: { stage: 'write', message: 'old' } })];
    const result = {
      success: 1, failed: 0, errors: [],
      results: [{ file_id: 'a1', path: '/l/a.m4b', status: 'success', skipped_fields: [] }],
      sent: sentFor(groups),
    };
    expect(summarizeWriteResult(result, groups).toast).toEqual({ type: 'success', title: 'Write Complete', message: 'Wrote tags to 1 file.' });
    const [g] = applyWriteResult(groups, result);
    expect(g.files[0].changes).toEqual({});
    expect(g.files[0].status).toBe('unchanged');
    expect(g.total_changes).toBe(0);
    expect(g.lastError).toBeUndefined();
  });

  it('an error from another stage is not cleared by a clean write', () => {
    const groups = [local('a', [['a1', '/l/a.m4b', { title }]], { lastError: { stage: 'classify', message: 'x' } })];
    const result = { success: 1, failed: 0, errors: [], results: [{ file_id: 'a1', status: 'success', skipped_fields: [] }], sent: sentFor(groups) };
    expect(applyWriteResult(groups, result)[0].lastError).toEqual({ stage: 'classify', message: 'x' });
  });

  it('every file failing is an error toast naming each file and reason', () => {
    const groups = [local('a', [['a1', '/l/a/1.mp3', { title }], ['a2', '/l/a/2.mp3', { title }]])];
    const result = {
      success: 0, failed: 2,
      errors: [
        { file_id: 'a1', error: 'file has more than one ID3 tag; not written' },
        { file_id: 'a2', error: 'file not found' },
      ],
      results: [{ file_id: 'a1', status: 'failed', skipped_fields: [] }, { file_id: 'a2', status: 'failed', skipped_fields: [] }],
      sent: sentFor(groups),
    };
    const s = summarizeWriteResult(result, groups);
    expect(s.toast.type).toBe('error');
    expect(s.toast.title).toBe('Write Failed');
    expect(s.toast.message).toContain('1.mp3: file has more than one ID3 tag; not written');
    expect(s.toast.message).toContain('2.mp3: file not found');
    const [g] = applyWriteResult(groups, result);
    expect(g.lastError.message).toContain('1.mp3: file has more than one ID3 tag');
    expect(g.lastError.message).toContain('2.mp3: file not found');
    expect(g.files.every((f) => f.changes.title)).toBe(true);
  });
});

describe('rename results (#62)', () => {
  it('fileNameOf takes the last segment of a Windows or POSIX path', () => {
    expect(fileNameOf('C:\\Books\\Author\\Book.m4b')).toBe('Book.m4b');
    expect(fileNameOf('/books/Author/Book.m4b')).toBe('Book.m4b');
    expect(fileNameOf('')).toBe('');
  });

  it('a renamed Windows path updates path and filename; a failure keeps its reason on the book', () => {
    const groups = [
      { id: 'w', metadata: { title: 'W' }, files: [{ id: 'w1', path: 'C:\\B\\old.m4b', filename: 'old.m4b', changes: {} }] },
      { id: 'x', metadata: { title: 'X' }, files: [{ id: 'x1', path: 'C:\\B\\x.m4b', filename: 'x.m4b', changes: {} }] },
    ];
    const result = {
      renamed: [{ old_path: 'C:\\B\\old.m4b', new_path: 'C:\\B\\Author - Title.m4b', status: 'renamed' }],
      failed: 1,
      results: [
        { old_path: 'C:\\B\\old.m4b', new_path: 'C:\\B\\Author - Title.m4b', status: 'renamed' },
        { old_path: 'C:\\B\\x.m4b', new_path: 'C:\\B\\y.m4b', status: 'failed', error: 'target already exists' },
      ],
    };
    const s = summarizeRenameResult(result, groups);
    expect(s.renamed).toBe(1);
    expect(s.failures).toEqual([{ groupId: 'x', name: 'x.m4b', error: 'target already exists' }]);
    expect(s.toast.type).toBe('warning');
    expect(s.toast.message).toContain('x.m4b: target already exists');

    const next = applyRenameResult(groups, result);
    expect(next[0].files[0]).toMatchObject({ path: 'C:\\B\\Author - Title.m4b', filename: 'Author - Title.m4b' });
    expect(next[1].files[0].path).toBe('C:\\B\\x.m4b');
    expect(next[1].lastError).toMatchObject({ stage: 'rename', severity: 'error' });
    expect(next[1].lastError.message).toContain('target already exists');
  });

  it('nothing renamed is an error toast', () => {
    const s = summarizeRenameResult({ renamed: [], failed: 0, results: [] }, []);
    expect(s.toast.type).toBe('error');
  });
});
