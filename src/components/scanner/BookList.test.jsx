import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../api', () => ({ callBackend: vi.fn(async () => null) }));

const { BookList } = await import('./BookList');

const book = (id, title, fileCount) => ({
  id,
  metadata: { title, author: 'Author' },
  files: Array.from({ length: fileCount }, (_, i) => ({ id: `${id}-f${i}`, filename: `${title} part ${i + 1}.mp3`, changes: {} })),
  total_changes: 0,
});

function renderList(props = {}) {
  const groups = [book('multi', 'Long Book', 12), book('single', 'Short Book', 1)];
  const onToggleGroup = vi.fn();
  const onSelectFile = vi.fn();
  render(
    <BookList
      groups={groups}
      selectedFiles={new Set()}
      selectedGroupIds={new Set()}
      expandedGroups={new Set()}
      fileStatuses={{}}
      onToggleGroup={onToggleGroup}
      onSelectFile={onSelectFile}
      {...props}
    />
  );
  return { onToggleGroup, onSelectFile };
}

describe('BookList per-book file list (LOW)', () => {
  it('clicking a multi-file book\'s file count expands its file list, without selecting the book', () => {
    const { onToggleGroup, onSelectFile } = renderList();
    fireEvent.click(screen.getByRole('button', { name: '12 files' }));
    expect(onToggleGroup).toHaveBeenCalledWith('multi');
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it('a single-file book has no file count control', () => {
    renderList();
    expect(screen.queryByRole('button', { name: '1 file' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /\d+ files/ })).toHaveLength(1);
  });

  it('an expanded book shows its files and marks the control as expanded', () => {
    renderList({ expandedGroups: new Set(['multi']) });
    expect(screen.getByRole('button', { name: '12 files' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Long Book part 12.mp3')).toBeInTheDocument();
  });
});

describe('BookList empty state (#62)', () => {
  afterEach(() => { delete window.__TAURI_INTERNALS__; });

  const renderEmpty = (props = {}) => {
    const handlers = { onScan: vi.fn(), onImportFromAbs: vi.fn(), onNavigateToSettings: vi.fn() };
    render(
      <BookList
        groups={[]}
        selectedFiles={new Set()}
        selectedGroupIds={new Set()}
        expandedGroups={new Set()}
        fileStatuses={{}}
        {...handlers}
        {...props}
      />
    );
    return handlers;
  };

  it('with no ABS credentials, shows "Scan a local folder", and clicking it calls onScan', () => {
    window.__TAURI_INTERNALS__ = {};
    const { onScan, onImportFromAbs } = renderEmpty({ hasAbsConnection: false });
    fireEvent.click(screen.getByRole('button', { name: /Scan a local folder/ }));
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onImportFromAbs).not.toHaveBeenCalled();
  });

  it('offers both choices; without credentials the ABS choice goes to Settings', () => {
    window.__TAURI_INTERNALS__ = {};
    const { onImportFromAbs, onNavigateToSettings } = renderEmpty({ hasAbsConnection: false });
    fireEvent.click(screen.getByRole('button', { name: /Load from AudiobookShelf/ }));
    expect(onNavigateToSettings).toHaveBeenCalledTimes(1);
    expect(onImportFromAbs).not.toHaveBeenCalled();
  });

  it('with ABS credentials, "Load from AudiobookShelf" imports', () => {
    window.__TAURI_INTERNALS__ = {};
    const { onImportFromAbs } = renderEmpty({ hasAbsConnection: true });
    expect(screen.getByRole('button', { name: /Scan a local folder/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load from AudiobookShelf/ }));
    expect(onImportFromAbs).toHaveBeenCalledTimes(1);
  });

  it('both choices are disabled while an operation runs', () => {
    window.__TAURI_INTERNALS__ = {};
    renderEmpty({ hasAbsConnection: true, scanning: true });
    expect(screen.getByRole('button', { name: /Scan a local folder/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Load from AudiobookShelf/ })).toBeDisabled();
  });

  it('the browser build offers no local scan', () => {
    renderEmpty({ hasAbsConnection: true });
    expect(screen.queryByRole('button', { name: /Scan a local folder/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load from AudiobookShelf/ })).toBeInTheDocument();
  });
});

describe('BookList standing warnings (D-6)', () => {
  it('shows the unresolved-series warning even when another stage put its own error on the book', () => {
    const g = {
      ...book('s1', 'Series Book', 1),
      metadata: { title: 'Series Book', author: 'A', series: 'A #6, B #1', series_unresolved: true },
      lastError: { stage: 'resolve', kind: 'low-confidence', message: 'Kept the current values.', severity: 'warn' },
    };
    render(
      <BookList groups={[g]} selectedFiles={new Set()} selectedGroupIds={new Set()} expandedGroups={new Set()} fileStatuses={{}} />
    );
    const pills = screen.getAllByTestId('error-pill').map((el) => el.textContent);
    expect(pills.some((t) => t.includes('Kept the current values'))).toBe(true);
    expect(pills.some((t) => /Could not read this book/.test(t))).toBe(true);
  });
});
