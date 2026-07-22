// src/hooks/useScan.js
import { useState, useCallback, useRef, useEffect } from 'react';
import { callBackend, subscribe, pickPath } from '../api';
import { useApp } from '../context/AppContext';

// ============================================================================
// Pure helpers, extracted so they can be unit-tested without rendering the
// hook (src/hooks/useScan.test.js is fully describe.skip'd; see that file's
// header comment for why). Exported for src/hooks/useScan.helpers.test.js.
// ============================================================================

/**
 * L-11: find the parent directory of a file path, handling both POSIX and
 * Windows separators (a path scanned on Windows may contain '\\').
 * Returns null if the path has no directory separator.
 */
export function getParentDir(path) {
  if (!path) return null;
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return lastSlash > 0 ? path.substring(0, lastSlash) : null;
}

/**
 * CR-1 support: merge freshly-rescanned groups into the existing group list.
 * Drops any previous group that had a selected file (it's being replaced by
 * the rescan result) and appends the new groups. Pure, does not decide
 * whether the merge should run at all; the caller (handleRescan) skips
 * calling this entirely when the scan itself failed, so a failed rescan
 * never touches existing groups or staged edits.
 */
export function buildRescanGroups(prevGroups, selectedFilePaths, newGroups) {
  const filtered = prevGroups.filter(group => {
    const hasSelectedFile = group.files.some(file => selectedFilePaths.has(file.path));
    return !hasSelectedFile;
  });
  return [...filtered, ...newGroups];
}

/** True if a group has any staged/unsaved local edits. */
function groupHasStagedChanges(group) {
  if (!group) return false;
  if ((group.total_changes || 0) > 0) return true;
  return (group.files || []).some(file => Object.keys(file.changes || {}).length > 0);
}

/**
 * L1(pages): merge a fresh ABS pull into the existing groups instead of
 * blindly replacing everything. If nothing locally has staged changes, a
 * full replace is safe (and preserves prior behavior). Otherwise: keep any
 * local group that isn't part of this ABS result, keep local groups that
 * have staged edits as-is (don't clobber unsaved work), and only replace
 * ABS-sourced groups that have no staged edits with the fresh data. Any
 * brand-new ABS groups not previously known are appended.
 */
export function mergeAbsPullGroups(prevGroups, newGroups) {
  const anyStaged = prevGroups.some(groupHasStagedChanges);
  if (!anyStaged) {
    return newGroups;
  }

  const newById = new Map(newGroups.map(g => [g.id, g]));
  const seen = new Set();

  const merged = prevGroups.map(group => {
    if (!newById.has(group.id)) return group;
    seen.add(group.id);
    return groupHasStagedChanges(group) ? group : newById.get(group.id);
  });

  for (const group of newGroups) {
    if (!seen.has(group.id)) merged.push(group);
  }

  return merged;
}

export function useScan() {
  const { setGroups } = useApp();
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({
    current: 0,
    total: 0,
    currentFile: '',
    startTime: null,
    filesPerSecond: 0,
    covers_found: 0,
  });
  
  const progressIntervalRef = useRef(null);
  const resetTimeoutRef = useRef(null);

  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  const calculateETA = useCallback(() => {
    const { current, total, startTime, filesPerSecond } = scanProgress;
    
    if (!startTime || current === 0 || filesPerSecond === 0) {
      return 'Calculating...';
    }
    
    const remaining = total - current;
    const secondsLeft = remaining / filesPerSecond;
    
    if (secondsLeft < 60) {
      return `${Math.round(secondsLeft)}s`;
    } else if (secondsLeft < 3600) {
      const mins = Math.floor(secondsLeft / 60);
      const secs = Math.round(secondsLeft % 60);
      return `${mins}m ${secs}s`;
    } else {
      const hours = Math.floor(secondsLeft / 3600);
      const mins = Math.floor((secondsLeft % 3600) / 60);
      return `${hours}h ${mins}m`;
    }
  }, [scanProgress]);

  /**
   * Scan library with configurable scan mode
   * @param {string} scanMode - Scan mode: 'normal' (default), 'force_fresh' (clean scan)
   */
  const handleScan = useCallback(async (scanMode = 'normal') => {
    // Clean up any existing intervals
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }

    try {
      // OPEN FILE PICKER
      const selected = await pickPath({
        directory: true,
        multiple: true,
      });

      if (!selected) {
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      const modeLabel = scanMode === 'force_fresh' ? 'clean scan' : 'normal scan';

      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
      });

      // Poll for progress - use 1 second interval to reduce IPC overhead
      // Progress updates don't need to be more frequent than this
      progressIntervalRef.current = setInterval(async () => {
        try {
          const progress = await callBackend('get_scan_progress');
          const now = Date.now();
          const elapsed = (now - startTime) / 1000;
          const rate = progress.current > 0 && elapsed > 0 ? progress.current / elapsed : 0;

          setScanProgress({
            current: progress.current,
            total: progress.total,
            currentFile: progress.current_file || '',
            startTime,
            filesPerSecond: rate,
            covers_found: progress.covers_found || 0,
          });
        } catch (error) {
          console.warn('Scan progress polling error:', error);
        }
      }, 1000);

      try {
        // Pass scan mode to backend
        const result = await callBackend('scan_library', { paths, scanMode });

        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }

        // Simple direct set - replace all groups
        if (result && result.groups) {
          setGroups(result.groups);
        }

      } finally {
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }

        setScanning(false);

        resetTimeoutRef.current = setTimeout(() => {
          setScanProgress({
            current: 0,
            total: 0,
            currentFile: '',
            startTime: null,
            filesPerSecond: 0,
            covers_found: 0,
          });
          resetTimeoutRef.current = null;
        }, 500);
      }
    } catch (error) {
      console.error('Scan failed:', error);

      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }

      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }

      setScanning(false);
      throw error;
    }
  }, [setGroups]);

  // Import folders without metadata scanning
  const handleImport = useCallback(async () => {
    // Clean up any existing intervals
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }

    try {
      // OPEN FILE PICKER
      const selected = await pickPath({
        directory: true,
        multiple: true,
      });

      if (!selected) {
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];

      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: 'Importing folders...',
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
      });

      try {
        const result = await callBackend('import_folders', { paths });

        // Simple direct set - replace all groups
        if (result && result.groups) {
          setGroups(result.groups);
        }

      } finally {
        setScanning(false);

        resetTimeoutRef.current = setTimeout(() => {
          setScanProgress({
            current: 0,
            total: 0,
            currentFile: '',
            startTime: null,
            filesPerSecond: 0,
            covers_found: 0,
          });
          resetTimeoutRef.current = null;
        }, 500);
      }
    } catch (error) {
      console.error('Import failed:', error);
      setScanning(false);
      throw error;
    }
  }, [setGroups]);

  /**
   * Rescan selected files with configurable scan mode
   * @param {Set} selectedFiles - Set of selected file IDs
   * @param {Array} groups - Array of book groups
   * @param {string} scanMode - Scan mode: 'normal', 'refresh_metadata', 'force_fresh', 'selective_refresh', 'super_scanner'
   * @param {Array} selectiveFields - Optional array of field names to refresh (for selective_refresh mode)
   * @param {Object} options - Optional options like { enableTranscription: bool }
   */
  const handleRescan = useCallback(async (selectedFiles, groups, scanMode = 'force_fresh', selectiveFields = null, options = {}) => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }

    try {
      const selectedFilePaths = new Set();
      const pathsToScan = new Set();

      groups.forEach(group => {
        group.files.forEach(file => {
          if (file.id != null && selectedFiles.has(file.id)) {
            selectedFilePaths.add(file.path);
            const parentDir = getParentDir(file.path);
            if (parentDir) {
              pathsToScan.add(parentDir);
            }
          }
        });
      });

      const paths = Array.from(pathsToScan);

      if (paths.length === 0) {
        return { success: false, count: 0 };
      }

      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
      });

      progressIntervalRef.current = setInterval(async () => {
        try {
          const progress = await callBackend('get_scan_progress');
          const now = Date.now();
          const elapsed = (now - startTime) / 1000;
          const rate = progress.current > 0 && elapsed > 0 ? progress.current / elapsed : 0;

          setScanProgress({
            current: progress.current,
            total: progress.total,
            currentFile: progress.current_file || '',
            startTime,
            filesPerSecond: rate,
            covers_found: progress.covers_found || 0,
          });
        } catch (error) {
          console.warn('Rescan progress polling error:', error);
        }
      }, 1000);

      try {
        // Batch all paths in a single call for better performance
        // The Rust backend handles parallel processing internally
        let allNewGroups = [];
        let scanError = null;
        try {
          let result;
          const enableTranscription = options.enableTranscription ?? false;
          if (selectiveFields && selectiveFields.length > 0) {
            // Use rescan_fields for selective field refresh
            result = await callBackend('rescan_fields', {
              paths: paths,
              fields: selectiveFields,
              enableTranscription: enableTranscription
            });
          } else {
            // Regular scan with mode
            result = await callBackend('scan_library', {
              paths: paths,
              scanMode: scanMode,
              enableTranscription: enableTranscription
            });
          }
          if (result && result.groups) {
            allNewGroups = result.groups;
          }
        } catch (error) {
          console.error('Failed to scan paths:', error);
          scanError = error;
        }

        // CR-1: if the rescan call itself failed, do NOT touch existing
        // groups, a failed rescan must never destroy groups or staged
        // edits. Surface the failure so the caller can toast it.
        if (scanError) {
          return { success: false, error: scanError.message || String(scanError) };
        }

        setGroups(prevGroups => buildRescanGroups(prevGroups, selectedFilePaths, allNewGroups));

        return { success: true, count: allNewGroups.length };

      } finally {
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }

        setScanning(false);

        resetTimeoutRef.current = setTimeout(() => {
          setScanProgress({
            current: 0,
            total: 0,
            currentFile: '',
            startTime: null,
            filesPerSecond: 0,
            covers_found: 0,
          });
          resetTimeoutRef.current = null;
        }, 500);
      }
    } catch (error) {
      console.error('Rescan failed:', error);

      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }

      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }

      setScanning(false);
      throw error;
    }
  }, [setGroups]);

  // Import books from ABS library (no local file scan)
  // Options: { enrichWithCustomProviders: boolean } - if true, search Goodreads/Hardcover for additional metadata
  const handleImportFromAbs = useCallback(async (options = {}) => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }

    let unlisten = null;
    try {
      setScanning(true);
      const startTime = Date.now();
      const enriching = options.enrichWithCustomProviders ? ' + custom providers' : '';
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: `Connecting to AudiobookShelf${enriching}...`,
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
      });

      // Set up progress listener
      unlisten = subscribe('import_progress', (data) => {
        const { current, total, message, phase } = data;
        setScanProgress(prev => ({
          ...prev,
          current: current || prev.current,
          total: total || prev.total,
          currentFile: message || `Import: ${phase}...`,
        }));
      });


      try {
        const request = options.enrichWithCustomProviders
          ? { enrich_with_custom_providers: true }
          : null;
        const result = await callBackend('import_from_abs', { request });

        if (result && result.groups) {
          // L1(pages): don't blow away staged local edits with a wholesale
          // replace, merge the fresh ABS pull in instead.
          setGroups(prevGroups => mergeAbsPullGroups(prevGroups, result.groups));
        }

        return { success: true, count: result?.total_imported || 0 };

      } finally {
        if (unlisten) unlisten();
        setScanning(false);

        resetTimeoutRef.current = setTimeout(() => {
          setScanProgress({
            current: 0,
            total: 0,
            currentFile: '',
            startTime: null,
            filesPerSecond: 0,
            covers_found: 0,
          });
          resetTimeoutRef.current = null;
        }, 500);
      }
    } catch (error) {
      console.error('ABS import failed:', error);
      if (unlisten) unlisten();
      setScanning(false);
      throw error;
    }
  }, [setGroups]);

  // Push ABS-imported books back to ABS library
  const handlePushAbsImports = useCallback(async (groupsToPush) => {
    if (!groupsToPush || groupsToPush.length === 0) {
      return { success: false, updated: 0 };
    }

    let unlisten = null;
    try {

      // Set up progress listener
      setScanning(true);
      setScanProgress({
        current: 0,
        total: groupsToPush.length,
        currentFile: 'Connecting to ABS...',
        startTime: Date.now(),
        filesPerSecond: 0,
        covers_found: 0,
      });

      unlisten = subscribe('push_progress', (data) => {
        const { current, total, message, phase } = data;
        setScanProgress(prev => ({
          ...prev,
          current: current || prev.current,
          total: total || prev.total,
          currentFile: message || `Push: ${phase}...`,
        }));
      });

      const request = {
        items: groupsToPush.map(g => ({
          id: g.id,
          metadata: g.metadata,
        }))
      };

      const result = await callBackend('push_abs_imports', { request });

      if (result.errors && result.errors.length > 0) {
        // Group errors by type
        const errorTypes = {};
        result.errors.forEach(err => {
          const match = err.match(/HTTP (\d+)|timeout|connection|dns/i);
          const type = match ? match[0] : 'other';
          errorTypes[type] = (errorTypes[type] || 0) + 1;
        });
        console.warn('Push error breakdown:', errorTypes);
        console.warn('Sample errors:', result.errors.slice(0, 10));
      }

      return { success: true, updated: result.updated, failed: result.failed };

    } catch (error) {
      console.error('ABS push failed:', error);
      throw error;
    } finally {
      if (unlisten) unlisten();
      setScanning(false);
    }
  }, []);

  // Rescan ABS-imported books (no local files needed)
  // mode: 'force_fresh' = full API search, 'genres_only' = just normalize genres
  // autoPush: automatically push changes back to ABS after processing
  // fields: optional array of field names to update (e.g., ['description', 'genres'])
  // enrichWithCustomProviders: search Goodreads/Hardcover for additional metadata
  const handleRescanAbsImports = useCallback(async (selectedGroups, mode = 'force_fresh', autoPush = false, fields = null, enrichWithCustomProviders = false) => {
    if (!selectedGroups || selectedGroups.length === 0) {
      return { success: false, count: 0 };
    }

    let unlisten = null;
    try {
      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: selectedGroups.length,
        currentFile: mode === 'genres_only' ? 'Cleaning genres...' : 'Searching APIs...',
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
      });

      // Set up progress listener
      unlisten = subscribe('rescan_progress', (data) => {
        const { current, total, message, phase } = data;
        setScanProgress(prev => ({
          ...prev,
          current: current || prev.current,
          total: total || prev.total,
          currentFile: message || `Rescan: ${phase}...`,
        }));
      });


      const request = {
        groups: selectedGroups.map(g => ({
          id: g.id,
          title: g.metadata.title,
          author: g.metadata.author,
          series: g.metadata.series || null,
          sequence: g.metadata.sequence || null,
          genres: g.metadata.genres || [],
          subtitle: g.metadata.subtitle || null,
          narrator: g.metadata.narrator || null,
          description: g.metadata.description || null,
          year: g.metadata.year || null,
          publisher: g.metadata.publisher || null,
        })),
        mode,
        fields: fields, // Optional: only update specific fields
        enrich_with_custom_providers: enrichWithCustomProviders, // Search Goodreads/Hardcover
      };

      const fieldsStr = fields ? fields.join(', ') : 'all';
      const enrichStr = enrichWithCustomProviders ? ' + custom providers' : '';

      const result = await callBackend('rescan_abs_imports', { request });

      // Update groups with rescanned data (preserve position in list)
      if (result && result.groups) {
        const updatedMap = new Map(result.groups.map(g => [g.id, g]));
        setGroups(prevGroups =>
          prevGroups.map(g => updatedMap.get(g.id) || g)
        );

        // Auto-push to ABS if enabled
        if (autoPush && result.groups.length > 0) {
          setScanProgress(prev => ({
            ...prev,
            currentFile: 'Pushing to ABS...',
          }));

          try {
            const pushResult = await handlePushAbsImports(result.groups);
          } catch (pushError) {
            console.error('Auto-push failed:', pushError);
          }
        }
      }

      return { success: true, count: result.total_rescanned, groups: result.groups };

    } catch (error) {
      console.error('ABS rescan failed:', error);
      throw error;
    } finally {
      if (unlisten) unlisten();
      setScanning(false);
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime: null,
        filesPerSecond: 0,
        covers_found: 0,
      });
    }
  }, [setGroups, handlePushAbsImports]);

  // Process ABS imports through the new metadata pipeline
  // Uses: Gather (ABS API + Custom Providers) → Context (Series) → Decide (GPT) → Validate
  const handlePipelineRescan = useCallback(async (selectedGroups, autoPush = false) => {
    if (!selectedGroups || selectedGroups.length === 0) {
      return { success: false, count: 0 };
    }

    let unlisten = null;
    try {
      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: selectedGroups.length,
        currentFile: 'Pipeline: Gathering metadata...',
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
      });


      // Listen for pipeline progress events
      unlisten = subscribe('pipeline_progress', (data) => {
        const { current, total, message, phase } = data;
        setScanProgress(prev => ({
          ...prev,
          current: current || prev.current,
          total: total || prev.total,
          currentFile: message || `Pipeline: ${phase}...`,
        }));
      });

      // Build pipeline request
      const request = {
        books: selectedGroups.map(g => ({
          abs_id: g.id,
          title: g.metadata.title || null,
          author: g.metadata.author || null,
          narrator: g.metadata.narrator || null,
          series: g.metadata.all_series?.map(s => ({
            name: s.name,
            sequence: s.sequence || null,
          })) || (g.metadata.series ? [{
            name: g.metadata.series,
            sequence: g.metadata.sequence || null,
          }] : []),
          genres: g.metadata.genres || [],
          description: g.metadata.description || null,
          subtitle: g.metadata.subtitle || null,
          year: g.metadata.year || null,
          publisher: g.metadata.publisher || null,
        })),
        concurrency: 150,  // Tier 3: 5000 RPM, 4M TPM
      };

      const result = await callBackend('process_with_pipeline', { request });

      // Update groups with pipeline results
      if (result && result.books) {
        const updatedMap = new Map();
        result.books.forEach(bookResult => {
          if (bookResult.success && bookResult.metadata && bookResult.abs_id) {
            updatedMap.set(bookResult.abs_id, bookResult.metadata);
          }
        });

        setGroups(prevGroups =>
          prevGroups.map(g => {
            const newMeta = updatedMap.get(g.id);
            if (!newMeta) return g;

            return {
              ...g,
              metadata: {
                ...g.metadata,
                ...newMeta,
              }
            };
          })
        );

        // Auto-push to ABS if enabled
        if (autoPush && result.processed > 0) {
          setScanProgress(prev => ({
            ...prev,
            currentFile: 'Pushing to ABS...',
          }));

          try {
            const groupsToPush = selectedGroups.filter(g => updatedMap.has(g.id));
            const pushResult = await handlePushAbsImports(groupsToPush);
          } catch (pushError) {
            console.error('Auto-push failed:', pushError);
          }
        }
      }

      return { success: true, count: result.processed, failed: result.failed };

    } catch (error) {
      console.error('Pipeline rescan failed:', error);
      throw error;
    } finally {
      // L-10: unlisten belongs in finally (matching the other handlers) so a
      // thrown callBackend/setGroups error doesn't leak the subscription.
      if (unlisten) unlisten();
      setScanning(false);
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime: null,
        filesPerSecond: 0,
        covers_found: 0,
      });
    }
  }, [setGroups, handlePushAbsImports]);

  // Cleanup genres for selected books (no rescan)
  const handleCleanupGenres = useCallback(async (selectedGroups) => {
    if (!selectedGroups || selectedGroups.length === 0) {
      return { success: false, count: 0 };
    }

    try {

      const request = {
        groups: selectedGroups.map(g => ({
          id: g.id,
          title: g.metadata.title,
          author: g.metadata.author,
          series: g.metadata.series || null,
          genres: g.metadata.genres || [],
        }))
      };

      const result = await callBackend('cleanup_genres', { request });

      // Update groups with cleaned genres
      setGroups(prevGroups =>
        prevGroups.map(group => {
          const cleaned = result.results.find(r => r.id === group.id);
          if (!cleaned || !cleaned.changed) return group;

          return {
            ...group,
            metadata: {
              ...group.metadata,
              genres: cleaned.cleaned_genres,
            }
          };
        })
      );

      return { success: true, count: result.total_cleaned };

    } catch (error) {
      console.error('Genre cleanup failed:', error);
      throw error;
    }
  }, [setGroups]);

  const cancelScan = useCallback(async () => {
    try {
      await callBackend('cancel_scan');
      
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
      
      setScanning(false);
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime: null,
        filesPerSecond: 0,
        covers_found: 0,
      });
    } catch (error) {
      console.error('Failed to cancel scan:', error);
    }
  }, []);

  return {
    scanning,
    scanProgress,
    calculateETA,
    handleScan,
    handleImport,
    handleImportFromAbs,
    handleRescanAbsImports,
    handlePipelineRescan,
    handlePushAbsImports,
    handleCleanupGenres,
    handleRescan,
    cancelScan,
  };
}