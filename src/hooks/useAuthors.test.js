// src/hooks/useAuthors.test.js
// Regression tests for the 2026-07-22 audit (task 4, items 8/9/11):
// - H5/M-8: pushToAbs must keep staged entries that failed (or whose outcome
//   is unconfirmed) instead of blanket-clearing pendingChanges/pendingMerges.
// - CR-7: updateDetail lets callers mutate `detail` without reaching into the
//   hook's internal setDetail.
// - Item 11: applyNormalizationFixes must not drop a legitimate suggested
//   value of 0 via a bare truthiness check, while still skipping an empty
//   suggestion (no regression for the string case).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuthors } from './useAuthors';

const mockCallBackend = vi.fn();
vi.mock('../api', () => ({
  callBackend: (...args) => mockCallBackend(...args),
  subscribe: () => () => {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockCallBackend.mockImplementation(async (cmd) => {
    if (cmd === 'get_abs_authors') return [];
    return {};
  });
});

describe('useAuthors.pushToAbs (H5/M-8)', () => {
  it('clears only the succeeded change entry and keeps the failed one staged', async () => {
    mockCallBackend.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_abs_authors') return [];
      if (cmd === 'push_author_changes_to_abs') {
        return { updated: 1, failed: 1, errors: [{ id: 'a2', error: 'HTTP 500' }] };
      }
      return {};
    });

    const { result } = renderHook(() => useAuthors());

    act(() => {
      result.current.stageChange('a1', 'name', 'A1 New');
      result.current.stageChange('a2', 'name', 'A2 New');
    });

    let pushResult;
    await act(async () => {
      pushResult = await result.current.pushToAbs();
    });

    expect(pushResult).toEqual({ updated: 1, failed: 1, errors: [{ id: 'a2', error: 'HTTP 500' }] });
    expect(result.current.pendingChanges).toEqual({ a2: { name: 'A2 New' } });
  });

  it('keeps every staged change when the backend reports failures without identifying which ids failed', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_abs_authors') return [];
      if (cmd === 'push_author_changes_to_abs') {
        return { updated: 1, failed: 1, errors: ['something went wrong, no id given'] };
      }
      return {};
    });

    const { result } = renderHook(() => useAuthors());

    act(() => {
      result.current.stageChange('a1', 'name', 'A1 New');
      result.current.stageChange('a2', 'name', 'A2 New');
    });

    await act(async () => {
      await result.current.pushToAbs();
    });

    // We can't prove either one succeeded, data preservation wins.
    expect(result.current.pendingChanges).toEqual({
      a1: { name: 'A1 New' },
      a2: { name: 'A2 New' },
    });
  });

  it('keeps every staged change and reports failure when the backend returns the generic unimplemented-command stub shape', async () => {
    // push_author_changes_to_abs isn't wired up in src/api.js's HANDLERS (or
    // TAURI_COMMANDS), so callBackend actually returns this shape today:
    // { _stub: true, message: "'push_author_changes_to_abs' is not
    // available in the web version." }. Without a shape check, that reads
    // as updated=0/failed=0/errors=[] and pushToAbs would clear every
    // staged change with zero feedback - a live data-destruction bug.
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_abs_authors') return [];
      if (cmd === 'push_author_changes_to_abs') {
        return { _stub: true, message: "'push_author_changes_to_abs' is not available in the web version." };
      }
      return {};
    });

    const { result } = renderHook(() => useAuthors());

    act(() => {
      result.current.stageChange('a1', 'name', 'A1 New');
      result.current.stageChange('a2', 'name', 'A2 New');
    });

    let pushResult;
    await act(async () => {
      pushResult = await result.current.pushToAbs();
    });

    expect(result.current.pendingChanges).toEqual({
      a1: { name: 'A1 New' },
      a2: { name: 'A2 New' },
    });
    expect(pushResult.failed).toBe(2);
    expect(pushResult.updated).toBe(0);
    expect(pushResult.errors.length).toBeGreaterThan(0);
  });

  it('keeps every staged change and reports failure when the backend returns nothing at all', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_abs_authors') return [];
      if (cmd === 'push_author_changes_to_abs') return undefined;
      return {};
    });

    const { result } = renderHook(() => useAuthors());

    act(() => {
      result.current.stageChange('a1', 'name', 'A1 New');
    });

    let pushResult;
    await act(async () => {
      pushResult = await result.current.pushToAbs();
    });

    expect(result.current.pendingChanges).toEqual({ a1: { name: 'A1 New' } });
    expect(pushResult.failed).toBe(1);
  });

  it('clears all staged changes when the backend confirms full success', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_abs_authors') return [];
      if (cmd === 'push_author_changes_to_abs') {
        return { updated: 2, failed: 0, errors: [] };
      }
      return {};
    });

    const { result } = renderHook(() => useAuthors());

    act(() => {
      result.current.stageChange('a1', 'name', 'A1 New');
      result.current.stageChange('a2', 'name', 'A2 New');
    });

    await act(async () => {
      await result.current.pushToAbs();
    });

    expect(result.current.pendingChanges).toEqual({});
  });

  it('keeps a merge staged when merge_abs_authors rejects for that primary, clearing only the succeeded one', async () => {
    mockCallBackend.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_abs_authors') return [];
      if (cmd === 'merge_abs_authors') {
        if (args.primaryId === 'p2') throw new Error('merge failed');
        return {};
      }
      return {};
    });

    const { result } = renderHook(() => useAuthors());

    act(() => {
      result.current.stageMerge('p1', 's1', 'Secondary One');
      result.current.stageMerge('p2', 's2', 'Secondary Two');
    });

    await act(async () => {
      await result.current.pushToAbs();
    });

    expect(result.current.pendingMerges).toEqual({
      p2: [{ id: 's2', name: 'Secondary Two' }],
    });
  });

  it('returns a no-op summary and touches nothing when there is nothing staged', async () => {
    const { result } = renderHook(() => useAuthors());
    let pushResult;
    await act(async () => {
      pushResult = await result.current.pushToAbs();
    });
    expect(pushResult).toEqual({ updated: 0, failed: 0, errors: [] });
    expect(mockCallBackend).not.toHaveBeenCalled();
  });
});

describe('useAuthors.updateDetail (CR-7)', () => {
  it('updates a single field on the loaded detail without clobbering the rest', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_abs_author_detail') {
        return { id: 'a1', name: 'Author One', description: 'Old bio' };
      }
      return {};
    });

    const { result } = renderHook(() => useAuthors());

    await act(async () => {
      await result.current.loadDetail('a1');
    });

    act(() => {
      result.current.updateDetail('description', 'New bio');
    });

    expect(result.current.detail).toEqual({ id: 'a1', name: 'Author One', description: 'New bio' });
  });

  it('is a no-op when there is no detail loaded', () => {
    const { result } = renderHook(() => useAuthors());
    act(() => {
      result.current.updateDetail('description', 'New bio');
    });
    expect(result.current.detail).toBeNull();
  });
});

describe('useAuthors.applyNormalizationFixes (item 11)', () => {
  it('stages a suggested_value of 0 instead of dropping it via bare truthiness', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_abs_authors') return [{ id: 'a1', name: 'A' }];
      if (cmd === 'analyze_authors_from_abs') {
        return {
          issues: [
            { issue_type: 'needs_normalization', author_id: 'a1', suggested_value: 0 },
          ],
        };
      }
      return {};
    });

    const { result } = renderHook(() => useAuthors());
    await act(async () => {
      await result.current.loadAuthors();
      await result.current.runAnalysis();
    });

    let count;
    act(() => {
      count = result.current.applyNormalizationFixes(['a1']);
    });

    expect(count).toBe(1);
    expect(result.current.pendingChanges.a1).toEqual({ name: 0 });
  });

  it('still skips an empty-string suggested_value (no regression)', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_abs_authors') return [{ id: 'a1', name: 'A' }];
      if (cmd === 'analyze_authors_from_abs') {
        return {
          issues: [
            { issue_type: 'needs_normalization', author_id: 'a1', suggested_value: '' },
          ],
        };
      }
      return {};
    });

    const { result } = renderHook(() => useAuthors());
    await act(async () => {
      await result.current.loadAuthors();
      await result.current.runAnalysis();
    });

    let count;
    act(() => {
      count = result.current.applyNormalizationFixes(['a1']);
    });

    expect(count).toBe(0);
    expect(result.current.pendingChanges.a1).toBeUndefined();
  });
});
