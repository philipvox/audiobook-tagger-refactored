// Final review fixes I-4, I-5, I-7, M-a, M-d, M-f: write and undo keep the
// display, the staged changes and the files in agreement, and Undo from the
// action bar says what it will do before doing it.
//
// Contracts (src-tauri/src/writer.rs): write_tags returns results
// [{ file_id, path, status, skipped_fields }]; undo_last_write returns
// restored_files (paths) and, on a partial restore, success:false with error;
// get_undo_status returns { available, count, books_count (a file count),
// age_seconds, files }.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { applyWriteResult, applyUndoResult, undoConfirmMessage } from './localWrite.js';
import { UndoToast } from '../components/UndoToast';
import { WritePreviewModal } from '../components/WritePreviewModal';
import { ActionBar } from '../components/scanner/ActionBar';

const group = (changes, extra = {}) => ({
  id: 'g1',
  metadata: { title: 'B' },
  files: [{ id: 'f1', path: '/books/a.m4b', filename: 'a.m4b', changes }],
  changedFields: Object.keys(changes).map((k) => (k === 'genre' ? 'genres' : k)),
  total_changes: Object.keys(changes).length,
  ...extra,
});
const ok = (sentChanges) => ({
  sent: { f1: { path: '/books/a.m4b', changes: sentChanges, group_size: 1 } },
  results: [{ file_id: 'f1', path: '/books/a.m4b', status: 'success', skipped_fields: [] }],
  errors: [],
});

describe('I-7: a change staged while the write ran stays staged', () => {
  it('keeps the newer title, with the value just written as its old value', () => {
    const [g] = applyWriteResult([group({ title: { old: 'X', new: 'B' } })], ok({ title: { old: 'X', new: 'A' } }));
    expect(g.files[0].changes.title).toEqual({ old: 'A', new: 'B' });
    expect(g.total_changes).toBe(1);
    expect(g.changedFields).toContain('title');
  });

  it('a change written as staged is cleared', () => {
    const [g] = applyWriteResult([group({ title: { old: 'X', new: 'A' } })], ok({ title: { old: 'X', new: 'A' } }));
    expect(g.files[0].changes).toEqual({});
  });
});

describe('M-f: changedFields drop the fields that were written', () => {
  it('title written, tags (app-only) stay', () => {
    const g0 = { ...group({ title: { old: 'X', new: 'A' }, tags: { old: '', new: 't' } }), changedFields: ['title', 'tags'] };
    const [g] = applyWriteResult([g0], ok({ title: { old: 'X', new: 'A' } }));
    expect(g.changedFields).toEqual(['tags']);
  });

  it('genre written clears genres', () => {
    const [g] = applyWriteResult([group({ genre: { old: '', new: 'Fantasy' } })], ok({ genre: { old: '', new: 'Fantasy' } }));
    expect(g.changedFields).toEqual([]);
  });
});

describe('I-4: after Undo the reverted changes are staged again', () => {
  const written = () => applyWriteResult([group({ title: { old: 'X', new: 'A' } }), { id: 'g2', metadata: {}, files: [{ id: 'f2', path: '/other.m4b', changes: {} }] }],
    ok({ title: { old: 'X', new: 'A' } }));

  it('re-stages the written fields and marks the book', () => {
    const before = written();
    const [g, other] = applyUndoResult(before, ['/books/a.m4b'], ok({ title: { old: 'X', new: 'A' } }));
    expect(g.files[0].changes.title).toEqual({ old: 'X', new: 'A' });
    expect(g.changedFields).toContain('title');
    expect(g.total_changes).toBe(1);
    expect(g.lastError).toMatchObject({ stage: 'undo', severity: 'warn' });
    expect(g.lastError.message).toMatch(/staged/);
    expect(other).toBe(before[1]); // an untouched group is returned as is
  });

  it('without the last write (an earlier session) the book is marked, nothing invented', () => {
    const [g] = applyUndoResult(written(), ['/books/a.m4b'], null);
    expect(g.files[0].changes).toEqual({});
    expect(g.lastError.message).toMatch(/Scan the folder again/);
  });

  it('a newer staged change wins over the re-staged one, with the restored value as old', () => {
    const w = written();
    w[0] = { ...w[0], files: [{ ...w[0].files[0], changes: { title: { old: 'A', new: 'C' } } }] };
    const [g] = applyUndoResult(w, ['/books/a.m4b'], ok({ title: { old: 'X', new: 'A' } }));
    expect(g.files[0].changes.title).toEqual({ old: 'X', new: 'C' });
  });
});

describe('I-5: Undo from the action bar asks first', () => {
  it('the message states the file count, the age and that the current contents are replaced', () => {
    const msg = undoConfirmMessage({ available: true, count: 12, age_seconds: 3 * 24 * 3600 }, 1_000_000_000_000);
    expect(msg).toMatch(/12 files/);
    expect(msg).toMatch(/3 days ago/);
    expect(msg).toMatch(/current contents of those files will be replaced/);
  });
});

describe('UndoToast copy (I-5)', () => {
  it('counts files and has no false countdown', () => {
    render(<UndoToast fileCount={3} onUndo={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/Wrote 3 files/)).toBeTruthy();
    expect(screen.queryByText(/available for/)).toBeNull();
  });
});

describe('M-a: Fast Mode says the write cannot be undone', () => {
  it('in the toggle text', () => {
    const groups = [{ id: 'g1', metadata: { title: 'B' }, files: [{ id: 'f1', path: '/b.m4b', filename: 'b.m4b', changes: { title: { old: 'a', new: 'b' } } }] }];
    render(<WritePreviewModal isOpen onClose={vi.fn()} onConfirm={vi.fn()} selectedFiles={new Set(['f1'])} groups={groups} backupEnabled />);
    expect(screen.getAllByText(/This write cannot be undone/).length).toBeGreaterThan(0);
  });
});

describe('ActionBar during a write and with an empty workspace', () => {
  afterEach(() => { delete window.__TAURI_INTERNALS__; });
  const base = { selectedFiles: new Set(), fileStatuses: {}, hasAbsConnection: true, onPull: vi.fn(), onPush: vi.fn(), onSelectAll: vi.fn(), onClearSelection: vi.fn(), onScan: vi.fn() };

  it('I-7: Scan Folder, Import, Enrich and Push are disabled while writing', () => {
    window.__TAURI_INTERNALS__ = {};
    const groups = [{ id: 'g', metadata: { title: 'x' }, files: [] }];
    render(<ActionBar {...base} groups={groups} selectedGroupCount={1} writing />);
    for (const name of ['Scan Folder', 'Import', 'Push']) expect(screen.getByRole('button', { name: new RegExp(`^${name}$`) })).toBeDisabled();
    expect(screen.getByTitle('Enrich metadata')).toBeDisabled();
  });

  it('M-d: Undo last write shows on an empty workspace when a journal exists', () => {
    window.__TAURI_INTERNALS__ = {};
    render(<ActionBar {...base} groups={[]} undoAvailable onUndo={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Undo last write/ })).toBeInTheDocument();
  });
});
