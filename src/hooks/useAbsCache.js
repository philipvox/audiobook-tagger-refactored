// src/hooks/useAbsCache.js
// Hook for managing the centralized ABS library cache

import { useState, useCallback, useEffect } from 'react';
import { callBackend, subscribe } from '../api';

export function useAbsCache() {
  const [cacheStatus, setCacheStatus] = useState({
    isLoaded: false,
    isStale: true,
    stats: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState(null);

  // Check cache status on mount
  useEffect(() => {
    checkCacheStatus();
  }, []);

  // Check current cache status
  const checkCacheStatus = useCallback(async () => {
    try {
      const status = await callBackend('get_abs_cache_status');
      setCacheStatus({
        isLoaded: status.is_loaded,
        isStale: status.is_stale,
        stats: status.stats,
      });
      return status;
    } catch (error) {
      console.error('Failed to check cache status:', error);
      return null;
    }
  }, []);

  // Refresh the entire cache
  const refreshCache = useCallback(async () => {
    let unlisten = null;
    try {
      setRefreshing(true);
      setRefreshProgress({
        phase: 'starting',
        message: 'Starting cache refresh...',
        current: 0,
        total: 0,
      });

      // Listen for progress events
      unlisten = subscribe('abs_cache_progress', (data) => {
        setRefreshProgress(data);
      });

      // Refreshing ABS cache
      const result = await callBackend('refresh_abs_cache');

      if (result.success) {
        // Cache refreshed
        setCacheStatus({
          isLoaded: true,
          isStale: false,
          stats: {
            total_items: result.total_items,
            items_with_files: result.items_with_files,
            items_with_chapters: result.items_with_chapters,
          },
        });
      }

      return result;
    } catch (error) {
      console.error('Cache refresh failed:', error);
      throw error;
    } finally {
      if (unlisten) unlisten();
      setRefreshing(false);
      setRefreshProgress(null);
    }
  }, []);

  // Get all cached items
  const getCachedItems = useCallback(async () => {
    try {
      return await callBackend('get_cached_items');
    } catch (error) {
      console.error('Failed to get cached items:', error);
      return [];
    }
  }, []);

  // Get a single cached item by ID
  const getCachedItem = useCallback(async (id) => {
    try {
      return await callBackend('get_cached_item', { id });
    } catch (error) {
      console.error('Failed to get cached item:', error);
      return null;
    }
  }, []);

  // Get files for a cached item
  const getCachedItemFiles = useCallback(async (id) => {
    try {
      return await callBackend('get_cached_item_files', { id });
    } catch (error) {
      console.error('Failed to get cached item files:', error);
      return [];
    }
  }, []);

  // Get chapters for a cached item
  const getCachedItemChapters = useCallback(async (id) => {
    try {
      return await callBackend('get_cached_item_chapters', { id });
    } catch (error) {
      console.error('Failed to get cached item chapters:', error);
      return [];
    }
  }, []);

  // Search cached items
  const searchCachedItems = useCallback(async (query) => {
    try {
      return await callBackend('search_cached_items', { query });
    } catch (error) {
      console.error('Failed to search cached items:', error);
      return [];
    }
  }, []);

  // Clear the cache
  const clearCache = useCallback(async () => {
    try {
      await callBackend('clear_abs_full_cache');
      setCacheStatus({
        isLoaded: false,
        isStale: true,
        stats: null,
      });
      // Cache cleared
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  }, []);

  // Format helpers for display
  const formatDuration = (seconds) => {
    if (!seconds) return '-';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '-';
    const gb = 1024 * 1024 * 1024;
    const mb = 1024 * 1024;
    if (bytes >= gb) return `${(bytes / gb).toFixed(2)} GB`;
    if (bytes >= mb) return `${(bytes / mb).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  const formatCacheAge = (seconds) => {
    if (!seconds) return 'Never';
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  return {
    // State
    cacheStatus,
    refreshing,
    refreshProgress,

    // Actions
    checkCacheStatus,
    refreshCache,
    getCachedItems,
    getCachedItem,
    getCachedItemFiles,
    getCachedItemChapters,
    searchCachedItems,
    clearCache,

    // Helpers
    formatDuration,
    formatBytes,
    formatCacheAge,
  };
}
