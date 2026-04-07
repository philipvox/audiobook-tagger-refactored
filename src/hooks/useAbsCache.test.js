// src/hooks/useAbsCache.test.js
// Tests for the useAbsCache hook

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAbsCache } from './useAbsCache';

// Mock Tauri APIs
const mockInvoke = vi.fn();
const mockListen = vi.fn(() => Promise.resolve(() => {}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args) => mockListen(...args),
}));

describe('useAbsCache hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
  });

  describe('initial state', () => {
    it('should initialize with correct default state', async () => {
      mockInvoke.mockResolvedValue({
        is_loaded: false,
        is_stale: true,
        stats: null,
      });

      const { result } = renderHook(() => useAbsCache());

      // Wait for initial cache status check
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('get_abs_cache_status');
      });

      expect(result.current.refreshing).toBe(false);
      expect(result.current.refreshProgress).toBe(null);
    });

    it('should check cache status on mount', async () => {
      mockInvoke.mockResolvedValue({
        is_loaded: true,
        is_stale: false,
        stats: { total_items: 100 },
      });

      const { result } = renderHook(() => useAbsCache());

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('get_abs_cache_status');
      });

      await waitFor(() => {
        expect(result.current.cacheStatus.isLoaded).toBe(true);
        expect(result.current.cacheStatus.isStale).toBe(false);
      });
    });
  });

  describe('checkCacheStatus', () => {
    it('should return cache status from backend', async () => {
      const mockStatus = {
        is_loaded: true,
        is_stale: false,
        stats: { total_items: 50 },
      };
      mockInvoke.mockResolvedValue(mockStatus);

      const { result } = renderHook(() => useAbsCache());

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalled();
      });

      let status;
      await act(async () => {
        status = await result.current.checkCacheStatus();
      });

      expect(status).toEqual(mockStatus);
    });

    it('should handle errors gracefully', async () => {
      mockInvoke.mockRejectedValue(new Error('Check failed'));

      const { result } = renderHook(() => useAbsCache());

      let status;
      await act(async () => {
        status = await result.current.checkCacheStatus();
      });

      expect(status).toBe(null);
    });
  });

  describe('refreshCache', () => {
    it('should set refreshing state during refresh', async () => {
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: false, is_stale: true, stats: null };
        }
        if (cmd === 'refresh_abs_cache') {
          // Delay to test loading state
          await new Promise(r => setTimeout(r, 10));
          return { success: true, total_items: 100 };
        }
      });
      mockListen.mockResolvedValue(() => {});

      const { result } = renderHook(() => useAbsCache());

      let refreshPromise;
      act(() => {
        refreshPromise = result.current.refreshCache();
      });

      expect(result.current.refreshing).toBe(true);

      await act(async () => {
        await refreshPromise;
      });

      expect(result.current.refreshing).toBe(false);
    });

    it('should update cache status on successful refresh', async () => {
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: false, is_stale: true, stats: null };
        }
        if (cmd === 'refresh_abs_cache') {
          return {
            success: true,
            total_items: 100,
            items_with_files: 90,
            items_with_chapters: 80,
          };
        }
      });
      mockListen.mockResolvedValue(() => {});

      const { result } = renderHook(() => useAbsCache());

      await act(async () => {
        await result.current.refreshCache();
      });

      expect(result.current.cacheStatus.isLoaded).toBe(true);
      expect(result.current.cacheStatus.isStale).toBe(false);
      expect(result.current.cacheStatus.stats.total_items).toBe(100);
    });

    it('should throw on refresh error', async () => {
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: false, is_stale: true, stats: null };
        }
        if (cmd === 'refresh_abs_cache') {
          throw new Error('Refresh failed');
        }
      });
      mockListen.mockResolvedValue(() => {});

      const { result } = renderHook(() => useAbsCache());

      await expect(async () => {
        await act(async () => {
          await result.current.refreshCache();
        });
      }).rejects.toThrow('Refresh failed');
    });
  });

  describe('getCachedItems', () => {
    it('should return cached items from backend', async () => {
      const mockItems = [
        { id: '1', title: 'Book 1' },
        { id: '2', title: 'Book 2' },
      ];
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: true, is_stale: false, stats: null };
        }
        if (cmd === 'get_cached_items') {
          return mockItems;
        }
      });

      const { result } = renderHook(() => useAbsCache());

      let items;
      await act(async () => {
        items = await result.current.getCachedItems();
      });

      expect(items).toEqual(mockItems);
    });

    it('should return empty array on error', async () => {
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: false, is_stale: true, stats: null };
        }
        if (cmd === 'get_cached_items') {
          throw new Error('Failed');
        }
      });

      const { result } = renderHook(() => useAbsCache());

      let items;
      await act(async () => {
        items = await result.current.getCachedItems();
      });

      expect(items).toEqual([]);
    });
  });

  describe('getCachedItem', () => {
    it('should return single item by ID', async () => {
      const mockItem = { id: 'abc', title: 'Test Book' };
      mockInvoke.mockImplementation(async (cmd, args) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: true, is_stale: false, stats: null };
        }
        if (cmd === 'get_cached_item') {
          expect(args.id).toBe('abc');
          return mockItem;
        }
      });

      const { result } = renderHook(() => useAbsCache());

      let item;
      await act(async () => {
        item = await result.current.getCachedItem('abc');
      });

      expect(item).toEqual(mockItem);
    });

    it('should return null on error', async () => {
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: false, is_stale: true, stats: null };
        }
        if (cmd === 'get_cached_item') {
          throw new Error('Not found');
        }
      });

      const { result } = renderHook(() => useAbsCache());

      let item;
      await act(async () => {
        item = await result.current.getCachedItem('nonexistent');
      });

      expect(item).toBe(null);
    });
  });

  describe('searchCachedItems', () => {
    it('should search with query', async () => {
      const mockResults = [{ id: '1', title: 'Harry Potter' }];
      mockInvoke.mockImplementation(async (cmd, args) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: true, is_stale: false, stats: null };
        }
        if (cmd === 'search_cached_items') {
          expect(args.query).toBe('harry');
          return mockResults;
        }
      });

      const { result } = renderHook(() => useAbsCache());

      let results;
      await act(async () => {
        results = await result.current.searchCachedItems('harry');
      });

      expect(results).toEqual(mockResults);
    });
  });

  describe('clearCache', () => {
    it('should clear cache and reset status', async () => {
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_abs_cache_status') {
          return { is_loaded: true, is_stale: false, stats: { total_items: 100 } };
        }
        if (cmd === 'clear_abs_full_cache') {
          return undefined;
        }
      });

      const { result } = renderHook(() => useAbsCache());

      await waitFor(() => {
        expect(result.current.cacheStatus.isLoaded).toBe(true);
      });

      await act(async () => {
        await result.current.clearCache();
      });

      expect(result.current.cacheStatus.isLoaded).toBe(false);
      expect(result.current.cacheStatus.isStale).toBe(true);
      expect(result.current.cacheStatus.stats).toBe(null);
    });
  });

  describe('formatDuration', () => {
    it('should format null as dash', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatDuration(null)).toBe('-');
      expect(result.current.formatDuration(undefined)).toBe('-');
      expect(result.current.formatDuration(0)).toBe('-');
    });

    it('should format minutes correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatDuration(60)).toBe('1m');
      expect(result.current.formatDuration(300)).toBe('5m');
      expect(result.current.formatDuration(1800)).toBe('30m');
    });

    it('should format hours and minutes', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatDuration(3600)).toBe('1h 0m');
      expect(result.current.formatDuration(3660)).toBe('1h 1m');
      expect(result.current.formatDuration(7200)).toBe('2h 0m');
      expect(result.current.formatDuration(36000)).toBe('10h 0m');
    });
  });

  describe('formatBytes', () => {
    it('should format null as dash', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatBytes(null)).toBe('-');
      expect(result.current.formatBytes(undefined)).toBe('-');
      expect(result.current.formatBytes(0)).toBe('-');
    });

    it('should format KB correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatBytes(1024)).toBe('1 KB');
      expect(result.current.formatBytes(500 * 1024)).toBe('500 KB');
    });

    it('should format MB correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      const mb = 1024 * 1024;
      expect(result.current.formatBytes(mb)).toBe('1.0 MB');
      expect(result.current.formatBytes(500 * mb)).toBe('500.0 MB');
    });

    it('should format GB correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      const gb = 1024 * 1024 * 1024;
      expect(result.current.formatBytes(gb)).toBe('1.00 GB');
      expect(result.current.formatBytes(2.5 * gb)).toBe('2.50 GB');
    });
  });

  describe('formatCacheAge', () => {
    it('should format null as Never', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(null)).toBe('Never');
      expect(result.current.formatCacheAge(undefined)).toBe('Never');
      expect(result.current.formatCacheAge(0)).toBe('Never');
    });

    it('should format recent times as Just now', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(30)).toBe('Just now');
      expect(result.current.formatCacheAge(59)).toBe('Just now');
    });

    it('should format minutes correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(60)).toBe('1m ago');
      expect(result.current.formatCacheAge(300)).toBe('5m ago');
      expect(result.current.formatCacheAge(3540)).toBe('59m ago');
    });

    it('should format hours correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(3600)).toBe('1h ago');
      expect(result.current.formatCacheAge(7200)).toBe('2h ago');
    });

    it('should format days correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(86400)).toBe('1d ago');
      expect(result.current.formatCacheAge(172800)).toBe('2d ago');
    });
  });
});
