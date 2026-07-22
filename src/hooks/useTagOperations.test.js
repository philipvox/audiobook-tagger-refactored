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
