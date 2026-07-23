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

describe('useTagOperations.renameFiles (CR-6a: explicit old->new pairs)', () => {
  it('forwards computed old->new pairs to the backend as `renames`', async () => {
    mockCallBackend.mockResolvedValue({ renamed: [] });

    const { result } = renderHook(() => useTagOperations());

    const pairs = [
      { fileId: 'f1', oldPath: '/a/1.m4b', newPath: '/a/Author - Book.m4b' },
    ];

    await act(async () => {
      await result.current.renameFiles(pairs);
    });

    expect(mockCallBackend).toHaveBeenCalledWith('rename_files', {
      renames: [{ file_id: 'f1', old_path: '/a/1.m4b', new_path: '/a/Author - Book.m4b' }],
    });
  });

  it('CR-3: drops pairs with a null/undefined fileId (or a missing path) defensively', async () => {
    mockCallBackend.mockResolvedValue({ renamed: [] });

    const { result } = renderHook(() => useTagOperations());

    const pairs = [
      { fileId: undefined, oldPath: '/a/2.m4b', newPath: '/a/x.m4b' }, // id-less: skip
      { fileId: 'f1', oldPath: '/a/1.m4b', newPath: '/a/y.m4b' },       // kept
      { fileId: 'f3', oldPath: '/a/3.m4b', newPath: '' },               // no target: skip
    ];

    await act(async () => {
      await result.current.renameFiles(pairs);
    });

    expect(mockCallBackend).toHaveBeenCalledWith('rename_files', {
      renames: [{ file_id: 'f1', old_path: '/a/1.m4b', new_path: '/a/y.m4b' }],
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
