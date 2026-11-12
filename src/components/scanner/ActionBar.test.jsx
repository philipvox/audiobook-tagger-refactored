import { describe, it, expect, vi } from 'vitest';
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
