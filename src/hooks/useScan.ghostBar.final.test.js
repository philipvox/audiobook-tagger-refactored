// Ledger item (Task 14): a progress poll still in flight when a folder scan
// settles must not write progress back after the bar was reset.

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const pending = [];
vi.mock('../api', () => ({
  callBackend: vi.fn((cmd) => {
    if (cmd === 'get_scan_progress') return new Promise((resolve) => pending.push(resolve));
    if (cmd === 'scan_library') return new Promise((resolve) => setTimeout(() => resolve({ groups: [{ id: 'g', files: [] }], total_files: 1 }), 1500));
    return Promise.resolve(null);
  }),
  subscribe: vi.fn(() => () => {}),
  pickPath: vi.fn(async () => ['/books']),
  askToConfirm: vi.fn(async () => true),
}));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ groups: [], setGroups: vi.fn() }) }));

const { useScan } = await import('./useScan');

describe('folder scan progress after the scan settles', () => {
  it('a late poll does not rewrite the reset progress', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useScan());
      let done;
      await act(async () => { done = result.current.handleScan(); await vi.advanceTimersByTimeAsync(1100); });
      expect(pending.length).toBeGreaterThan(0); // one poll is in flight
      await act(async () => { await vi.advanceTimersByTimeAsync(500); await done; });
      await act(async () => { await vi.advanceTimersByTimeAsync(600); }); // the 500 ms reset ran
      expect(result.current.scanProgress.total).toBe(0);
      // The poll that was in flight answers now.
      await act(async () => { pending.forEach((resolve) => resolve({ current: 7, total: 9 })); await Promise.resolve(); });
      expect(result.current.scanProgress.total).toBe(0);
      expect(result.current.scanProgress.current).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
