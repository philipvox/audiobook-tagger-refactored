import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionBar } from './ActionBar';

const makeGroups = (n) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, metadata: { title: `Book ${i}` }, files: [] }));

const renderBar = (props = {}) => render(
  <ActionBar
    groups={makeGroups(3000)}
    selectedFiles={new Set()}
    fileStatuses={{}}
    hasAbsConnection
    onPull={vi.fn()}
    onPush={vi.fn()}
    onSelectAll={vi.fn()}
    onClearSelection={vi.fn()}
    {...props}
  />
);

const button = (name) => screen.getByRole('button', { name: new RegExp(`^${name}$`) });

describe('ActionBar Select All (H-8)', () => {
  it('with a filter active and 30 of 3,000 books shown, Select All passes exactly those 30', () => {
    const onSelectAll = vi.fn();
    const filteredGroups = makeGroups(3000).slice(0, 30);
    renderBar({ onSelectAll, filteredGroups });
    fireEvent.click(button('Select All'));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onSelectAll.mock.calls[0][0]).toBe(filteredGroups);
  });

  it('with no filter, Select All takes the whole-library fast path (no list)', () => {
    const onSelectAll = vi.fn();
    renderBar({ onSelectAll, filteredGroups: null });
    fireEvent.click(button('Select All'));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onSelectAll.mock.calls[0][0]).toBeUndefined();
  });

  it('the selected-count label shows the filtered count after a filtered Select All', () => {
    renderBar({ selectedGroupCount: 30 });
    expect(screen.getByText('30 selected')).toBeInTheDocument();
  });
});

describe('ActionBar Push and busy state', () => {
  it('Push with no selection is disabled', () => {
    const onPush = vi.fn();
    renderBar({ onPush, selectedGroupCount: 0 });
    expect(button('Push')).toBeDisabled();
  });

  it('Push with a selection is enabled', () => {
    renderBar({ selectedGroupCount: 2 });
    expect(button('Push')).not.toBeDisabled();
  });

  it('Fix Subtitles running counts as processing (Import and Push disabled)', () => {
    renderBar({ selectedGroupCount: 2, fixingSubtitles: true });
    expect(button('Import')).toBeDisabled();
    expect(button('Push')).toBeDisabled();
  });
});

describe('ActionBar Scan Folder (#62)', () => {
  afterEach(() => { delete window.__TAURI_INTERNALS__; });

  it('in the desktop build, Scan Folder is enabled with no ABS connection and no books, and calls onScan', () => {
    window.__TAURI_INTERNALS__ = {};
    const onScan = vi.fn();
    renderBar({ onScan, hasAbsConnection: false, groups: [] });
    expect(button('Scan Folder')).not.toBeDisabled();
    fireEvent.click(button('Scan Folder'));
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('Scan Folder is disabled while another operation runs', () => {
    window.__TAURI_INTERNALS__ = {};
    renderBar({ onScan: vi.fn(), pushing: true });
    expect(button('Scan Folder')).toBeDisabled();
  });

  it('the browser build has no Scan Folder (it cannot read local files)', () => {
    renderBar({ onScan: vi.fn() });
    expect(screen.queryByRole('button', { name: /^Scan Folder$/ })).not.toBeInTheDocument();
  });
});

describe('ActionBar Write Tags, Rename and Undo (#62)', () => {
  afterEach(() => { delete window.__TAURI_INTERNALS__; });

  const localBook = { id: 'l1', metadata: { title: 'Local' }, files: [{ id: 'lf', path: '/books/Local/book.m4b' }] };
  const absBook = { id: 'a1', abs_id: 'a1', source: 'abs', metadata: { title: 'ABS' }, files: [{ id: 'af', path: '/audiobooks/ABS/book.m4b' }] };

  it('with a locally scanned book selected, shows Write Tags and Rename, which call their handlers', () => {
    window.__TAURI_INTERNALS__ = {};
    const onWrite = vi.fn();
    const onRename = vi.fn();
    renderBar({ onWrite, onRename, selectedGroupCount: 2, selectedGroups: [localBook, absBook] });
    fireEvent.click(button('Write Tags'));
    fireEvent.click(button('Rename'));
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('with only ABS books selected, shows neither', () => {
    window.__TAURI_INTERNALS__ = {};
    renderBar({ onWrite: vi.fn(), onRename: vi.fn(), selectedGroupCount: 1, selectedGroups: [absBook] });
    expect(screen.queryByRole('button', { name: /^Write Tags$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Rename$/ })).not.toBeInTheDocument();
  });

  it('Write Tags is disabled while a write runs', () => {
    window.__TAURI_INTERNALS__ = {};
    renderBar({ onWrite: vi.fn(), onRename: vi.fn(), selectedGroupCount: 1, selectedGroups: [localBook], writing: true });
    expect(button('Write Tags')).toBeDisabled();
    expect(button('Rename')).toBeDisabled();
  });

  it('"Undo last write" shows only when get_undo_status reports a journal', () => {
    window.__TAURI_INTERNALS__ = {};
    const onUndo = vi.fn();
    const { unmount } = renderBar({ onUndo, undoAvailable: false });
    expect(screen.queryByRole('button', { name: /^Undo last write$/ })).not.toBeInTheDocument();
    unmount();
    renderBar({ onUndo, undoAvailable: true });
    fireEvent.click(button('Undo last write'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('Push is disabled for a selection of local folders only, with the reason as its tooltip', () => {
    renderBar({ selectedGroupCount: 1, selectedGroups: [localBook] });
    expect(button('Push')).toBeDisabled();
    expect(button('Push')).toHaveAttribute('title', 'Local folders have no ABS item to push to');
  });

  it('Push stays enabled for a mixed selection', () => {
    renderBar({ selectedGroupCount: 2, selectedGroups: [localBook, absBook] });
    expect(button('Push')).not.toBeDisabled();
  });
});
