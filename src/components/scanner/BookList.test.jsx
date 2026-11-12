import { describe, it, expect, vi } from 'vitest';
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
