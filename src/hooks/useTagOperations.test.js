// src/hooks/useTagOperations.test.js
// Regression test for the 2026-07-22 audit (task 4, item 2 continuation):
// CR-3 says any `selectedFiles.has(file.id)` check should skip files with a
// null/undefined id defensively. useTagOperations.js:62 (renameFiles) is the
// spot the brief calls out by name.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTagOperations } from './useTagOperations';

const mockCallBackend = vi.fn();
vi.mock('../api', () => ({
  callBackend: (...args) => mockCallBackend(...args),
}));

let mockGroups = [];
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    config: {},
    groups: mockGroups,
    updateFileStatuses: vi.fn(),
    setWriteProgress: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGroups = [];
});

describe('useTagOperations.renameFiles', () => {
  it('only sends files whose id is present in the selection, ignoring an id-less file even if `undefined` is in the Set', async () => {
    mockGroups = [{
      id: 'g1',
      metadata: { title: 'Book' },
      files: [
        { id: 'f1', path: '/a/1.m4b' },
        { id: undefined, path: '/a/2.m4b' }, // e.g. a not-yet-normalized ABS file
      ],
    }];
    mockCallBackend.mockResolvedValue({ renamed: 1 });

    const { result } = renderHook(() => useTagOperations());

    // Selecting both the real id and (defensively) `undefined` itself -
    // without the guard this would incorrectly include the id-less file.
    const selectedFiles = new Set(['f1', undefined]);

    await act(async () => {
      await result.current.renameFiles(selectedFiles);
    });

    expect(mockCallBackend).toHaveBeenCalledWith('rename_files', {
      files: [['/a/1.m4b', { title: 'Book' }]],
    });
  });
});

describe('useTagOperations.pushToAudiobookShelf (minor fix: line 114 guard)', () => {
  it('does not push a group whose only selected-looking file has a null/undefined id', async () => {
    mockGroups = [{
      id: 'g1',
      metadata: { title: 'Book' },
      files: [{ id: undefined, path: '/a/1.m4b' }],
    }];
    mockCallBackend.mockResolvedValue({ updated: 0, unmatched: [], failed: [] });

    const { result } = renderHook(() => useTagOperations());

    // Defensively includes `undefined` itself, matching the renameFiles
    // test above - without the f.id != null guard, Set.has(undefined)
    // would be true and this id-less file would count as "selected".
    const selectedFiles = new Set([undefined]);

    await act(async () => {
      await result.current.pushToAudiobookShelf(selectedFiles);
    });

    expect(mockCallBackend).not.toHaveBeenCalled();
  });

  it('still pushes a group with a genuinely selected id', async () => {
    mockGroups = [{
      id: 'g1',
      metadata: { title: 'Book' },
      files: [{ id: 'f1', path: '/a/1.m4b' }],
    }];
    mockCallBackend.mockResolvedValue({ updated: 1, unmatched: [], failed: [] });

    const { result } = renderHook(() => useTagOperations());
    const selectedFiles = new Set(['f1']);

    await act(async () => {
      await result.current.pushToAudiobookShelf(selectedFiles);
    });

    expect(mockCallBackend).toHaveBeenCalledWith('push_abs_updates', {
      request: { items: [{ path: '/a/1.m4b', metadata: { title: 'Book' }, group_id: 'g1' }] },
    });
  });
});
