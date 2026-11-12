// src/hooks/useScan.js
import { useState, useCallback, useRef, useEffect } from 'react';
import { callBackend, subscribe, pickPath, askToConfirm } from '../api';
import { useApp } from '../context/AppContext';
import { getAbsId, normalizePushResult, buildPushItems, applyPushSnapshots, applyRefreshedLists, failedPushResult } from '../lib/absPush';
import { logEvent } from '../lib/logEvent';
import { isAiConfigured } from '../lib/proxy';
import { requestCancel, startCancellable, finishCancellable } from '../lib/cancel';
import { applyEntries } from '../lib/enrichActions';
import { applyStaticGenreCleanupResult } from '../lib/applyAiResults';

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
 *
 * H-4: a `needs_reimport` group (restored without its import snapshot) is
 * always replaced by the fresh ABS group, staged edits or not. Keeping the
 * stale metadata under a fresh snapshot would push reversals of server-side
 * changes, so those edits are dropped (callers tell the user via `refreshed`).
 * A flagged group whose book is not in the result is kept as it is.
 *
 * D-1: a kept staged group whose series could not be read
 * (`series_unresolved`) takes its series from the fresh group (see
 * healUnresolvedSeries), so a re-import is what clears the flag.
 */
export function mergeAbsPull(prevGroups, newGroups) {
  const isStale = (g) => g?.needs_reimport === true;
  const newById = new Map(newGroups.map(g => [g.id, g]));
  const refreshed = prevGroups.filter(g => isStale(g) && newById.has(g.id)).length;

  const anyStaged = prevGroups.some(groupHasStagedChanges);
  if (!anyStaged) {
    const keptStale = prevGroups.filter(g => isStale(g) && !newById.has(g.id));
    return { groups: keptStale.length > 0 ? [...newGroups, ...keptStale] : newGroups, refreshed };
  }

  const seen = new Set();

  const merged = prevGroups.map(group => {
    if (!newById.has(group.id)) return group;
    seen.add(group.id);
    const fresh = newById.get(group.id);
    if (!groupHasStagedChanges(group) || isStale(group)) return fresh;
    return healUnresolvedSeries(group, fresh);
  });

  for (const group of newGroups) {
    if (!seen.has(group.id)) merged.push(group);
  }

  return { groups: merged, refreshed };
}

const SERIES_FIELDS = ['series', 'sequence'];

/**
 * D-1: a staged group whose series could not be read keeps its other edits on
 * re-import but takes series, sequence, all_series, series_unresolved and the
 * series part of its import snapshot from the fresh group. Any staged series
 * change is dropped with it: it was made against a series list that was never
 * known. Returns `staged` unchanged when it is not series_unresolved.
 */
export function healUnresolvedSeries(staged, fresh) {
  if (staged?.metadata?.series_unresolved !== true || !fresh) return staged;
  const fm = fresh.metadata || {};
  const metadata = {
    ...staged.metadata,
    series: fm.series ?? null,
    sequence: fm.sequence ?? null,
    all_series: Array.isArray(fm.all_series) ? fm.all_series : [],
    series_unresolved: fm.series_unresolved === true,
  };
  const fo = fresh.abs_original || {};
  const abs_original = staged.abs_original
    ? { ...staged.abs_original, series: fo.series ?? null, sequence: fo.sequence ?? null, all_series: Array.isArray(fo.all_series) ? fo.all_series : [] }
    : fresh.abs_original;
  const files = (staged.files || []).map((f) => {
    const changes = { ...(f.changes || {}) };
    for (const k of SERIES_FIELDS) delete changes[k];
    return { ...f, changes };
  });
  const changedFields = (staged.changedFields || []).filter((f) => !SERIES_FIELDS.includes(f));
  const representative = files.find((f) => Object.keys(f.changes).length > 0);
  const total_changes = representative
    ? Object.keys(representative.changes).length
    : (files.length > 0 ? 0 : changedFields.length);
  const next = { ...staged, metadata, abs_original, files, changedFields, total_changes };
  // The import warning was about the series this re-import just read.
  if (staged.lastError?.kind === 'series') next.lastError = fresh.lastError;
  return next;
}

/** I-6: books from an older session (needs_reimport) with unpushed edits. */
export function reimportDiscardCount(groups) {
  return (groups || []).filter((g) => g?.needs_reimport === true && groupHasStagedChanges(g)).length;
}

/** I-6: asked before an import that would discard those edits. */
export const REIMPORT_DISCARD_PROMPT = (n) =>
  `${n} ${n === 1 ? 'book' : 'books'} from an older session ${n === 1 ? 'has' : 'have'} unpushed edits that will be discarded. Continue?`;

/**
 * I-6: an import replaces every needs_reimport book with the fresh ABS copy
 * (mergeAbsPull), staged edits included. Ask first when that would discard
 * edits; resolves true when the import may go ahead.
 */
export async function confirmReimportDiscard(groups) {
  const n = reimportDiscardCount(groups);
  if (n === 0) return true;
  return askToConfirm(REIMPORT_DISCARD_PROMPT(n), {
    title: 'Discard unpushed edits?',
    okLabel: 'Import and discard',
    cancelLabel: 'Cancel',
  });
}

export function mergeAbsPullGroups(prevGroups, newGroups) {
  return mergeAbsPull(prevGroups, newGroups).groups;
}

/**
 * H-9: Import is offered only when the import can run: URL, token and
 * library id are all set (import_from_abs throws without the library id).
 */
export function hasAbsConnection(config) {
  return !!(config?.abs_base_url && config?.abs_api_token && config?.abs_library_id);
}

/**
 * True when an AI provider is configured: an OpenAI key, an Anthropic key or
 * local AI with a model. The Scanner page gates AI actions on it; it is
 * lib/proxy.js isAiConfigured, the rule callAI follows.
 */
export function hasAiProvider(config) {
  return isAiConfigured(config);
}

/**
 * H-9/H-7: run an ABS import and tell the user how it ended. A rejected import
 * gets an error toast with its message (the Import button is bound straight
 * to onClick, so nothing else would catch it); a cancelled one says so; a
 * re-import that refreshed books restored without a snapshot warns (H-4).
 * Never rethrows.
 */
export async function importFromAbsWithNotice(importFn, toast, ...args) {
  let result;
  try {
    result = await importFn(...args);
  } catch (error) {
    const message = String(error?.message || error);
    toast.error('Import Failed', message);
    return { success: false, error: message };
  }
  if (result?.cancelled) {
    toast.info('Import cancelled', 'The workspace was not changed.');
    return result;
  }
  const n = result?.refreshed || 0;
  if (n > 0) {
    toast.warning(
      'Books Refreshed',
      `${n} ${n === 1 ? 'book' : 'books'} from an older session ${n === 1 ? 'was' : 'were'} refreshed from AudiobookShelf. Their unpushed edits were discarded.`
    );
  }
  return result;
}

/** #62: asked before a folder scan replaces a workspace with staged changes. */
export const SCAN_REPLACE_PROMPT = 'Scanning a folder replaces the books in your workspace. You have unpushed or unwritten changes that will be lost. Continue?';

/**
 * #62: run a folder scan and tell the user how it ended. A rejected scan gets
 * an error toast with its message; a cancelled one says the workspace was not
 * changed; one that found nothing warns. Only a scan that replaced the
 * workspace calls `onReplaced` (the caller clears its selection there). A
 * dismissed picker or a declined prompt is silent. Never rethrows (the Scan
 * Folder controls are bound straight to onClick).
 */
export async function scanFolderWithNotice(scanFn, toast, { onReplaced } = {}) {
  let result;
  try {
    result = await scanFn();
  } catch (error) {
    const message = String(error?.message || error);
    toast.error('Scan Failed', message);
    return { success: false, error: message };
  }
  if (result?.cancelled) {
    toast.info('Scan cancelled', 'The workspace was not changed.');
  } else if (result?.empty) {
    toast.warning('No Audiobooks Found', 'No audio files were found in that folder. The workspace was not changed.');
  } else if (result?.success) {
    onReplaced?.();
    const n = result.count;
    const files = result.files ?? 0;
    toast.success('Scan Complete', `Found ${n} ${n === 1 ? 'book' : 'books'} in ${files} ${files === 1 ? 'file' : 'files'}.`);
  }
  return result;
}

export function useScan() {
  const { groups: currentGroups, setGroups } = useApp();
  const groupsRef = useRef(currentGroups);
  groupsRef.current = currentGroups;
  const [scanning, setScanning] = useState(false);
  // #62: true while the running operation is a local folder scan.
  const [scanningFolder, setScanningFolder] = useState(false);
  // I-1/I-2: which operation the scan bar is showing ('scan', 'rescan',
  // 'import' or 'push'), so its wording names it.
  const [scanOperation, setScanOperation] = useState('scan');
  // H-7: the cancel token (lib/cancel.js) of the operation the scan progress
  // bar is showing (import, push, pipeline rescan); null while the running
  // operation cannot be cancelled, so the bar offers no Cancel for it.
  const scanCancelRef = useRef(null);
  const [scanCancellable, setScanCancellable] = useState(false);
  // Show an operation's token on the bar while it runs. `given` is a token
  // the caller owns (a pipeline's auto-push, a push from the confirm modal);
  // without one the operation takes, and later finishes, its own. release()
  // gives the bar back to whatever it showed before (null, or an enclosing
  // operation still running), so a settled operation never leaves its dead
  // token, and a Cancel that does nothing, on the bar.
  const liveBarTokensRef = useRef(new Set());
  const beginScanCancel = (given = null) => {
    const token = given || startCancellable();
    const previous = scanCancelRef.current;
    const live = liveBarTokensRef.current;
    live.add(token);
    scanCancelRef.current = token;
    setScanCancellable(true);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (!given) finishCancellable(token);
      // Nested under the same token (a pipeline's auto-push): the enclosing
      // operation still owns the bar.
      if (previous === token) return;
      live.delete(token);
      if (scanCancelRef.current === token) {
        const restore = previous && live.has(previous) ? previous : null;
        scanCancelRef.current = restore;
        setScanCancellable(restore != null);
      }
    };
    return { token, release };
  };
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
   * #62: Scan Folder. Pick one or more folders, read their audio files and
   * replace the workspace with the books found. Takes no arguments: it is
   * bound straight to onClick, so the click event must not become an option.
   *
   * With staged changes in the workspace it asks before replacing. A
   * cancelled scan, or one that found no audiobooks, leaves the workspace as
   * it was (Rust returns the partial groups of a cancelled scan; they are not
   * applied). Resolves { success, count, files } or { success: false } with
   * `dismissed` (picker closed), `declined` (prompt answered No), `cancelled`
   * or `empty`. A failed scan rethrows (scanFolderWithNotice toasts it).
   */
  const handleScan = useCallback(async () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }

    if ((groupsRef.current || []).some(groupHasStagedChanges)) {
      const ok = await askToConfirm(SCAN_REPLACE_PROMPT, {
        title: 'Replace your workspace?',
        okLabel: 'Scan and replace',
        cancelLabel: 'Cancel',
      });
      if (!ok) return { success: false, declined: true };
    }

    const selected = await pickPath({ directory: true, multiple: true });
    const paths = (Array.isArray(selected) ? selected : [selected]).filter(Boolean);
    if (paths.length === 0) return { success: false, dismissed: true };

    const bar = beginScanCancel();
    const cancel = bar.token;
    setScanning(true);
    setScanOperation('scan');
    setScanningFolder(true);
    const startTime = Date.now();
    setScanProgress({
      current: 0,
      total: 0,
      currentFile: 'Reading audio files...',
      startTime,
      filesPerSecond: 0,
      covers_found: 0,
    });

    // Poll the Rust progress counters once a second. `finished` is set when
    // the scan settles, so a poll still in flight cannot write progress back
    // after the bar was reset (the ghost bar).
    let finished = false;
    progressIntervalRef.current = setInterval(async () => {
      try {
        const progress = await callBackend('get_scan_progress');
        if (finished || cancel.cancelled) return; // keep showing "Cancelling..."
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = progress.current > 0 && elapsed > 0 ? progress.current / elapsed : 0;
        setScanProgress(prev => ({
          ...prev,
          current: progress.current || 0,
          total: progress.total || 0,
          filesPerSecond: rate,
        }));
      } catch (error) {
        console.warn('Scan progress polling error:', error);
      }
    }, 1000);

    try {
      const result = await callBackend('scan_library', { paths });

      if (result?.cancelled || cancel.cancelled) {
        logEvent('scan', 'folder scan cancelled', { files_read: result?.total_files ?? 0 });
        return { success: false, cancelled: true };
      }

      const scannedGroups = Array.isArray(result?.groups) ? result.groups : [];
      if (scannedGroups.length === 0) {
        return { success: false, empty: true, count: 0, files: result?.total_files ?? 0 };
      }

      setGroups(scannedGroups);
      logEvent('scan', 'folder scan', { books: scannedGroups.length, files: result.total_files ?? 0 });
      return { success: true, count: scannedGroups.length, files: result.total_files ?? 0 };
    } catch (error) {
      console.error('Scan failed:', error);
      throw error;
    } finally {
      finished = true;
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      bar.release();
      setScanning(false);
      setScanningFolder(false);
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
      setScanOperation('rescan');
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
    // I-6: say before importing that older-session edits will be discarded.
    if (!(await confirmReimportDiscard(groupsRef.current || []))) {
      return { success: false, declined: true, count: 0, refreshed: 0 };
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }

    let unlisten = null;
    const bar = beginScanCancel();
    const cancel = bar.token;
    try {
      setScanning(true);
      setScanOperation('import');
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
        let refreshed = 0;
        const result = await callBackend('import_from_abs', { request, cancel });

        // H-7: a cancelled import leaves the workspace exactly as it was.
        if (result?.cancelled) {
          logEvent('import', 'ABS import cancelled');
          return { success: false, cancelled: true, count: 0, refreshed: 0 };
        }

        if (result && result.groups) {
          // L1(pages): don't blow away staged local edits with a wholesale
          // replace, merge the fresh ABS pull in instead.
          refreshed = mergeAbsPull(groupsRef.current || [], result.groups).refreshed;
          setGroups(prevGroups => mergeAbsPullGroups(prevGroups, result.groups));
        }

        // import_from_abs reports the number of books as `total`.
        return { success: true, count: result?.total ?? result?.groups?.length ?? 0, refreshed };

      } finally {
        if (unlisten) unlisten();
        bar.release();
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
      bar.release();
      setScanning(false);
      throw error;
    }
  }, [setGroups]);

  // Push ABS-imported books back to ABS library
  // H-7: `cancel` (optional) is a token the caller owns (a pipeline auto-push,
  // a push from the confirm modal); the push stops on it and shows it on the
  // bar while it runs. Without it the push takes its own.
  const handlePushAbsImports = useCallback(async (groupsToPush, { cancel: parentCancel = null } = {}) => {
    if (!groupsToPush || groupsToPush.length === 0) {
      return { success: false, attempted: 0, updated: [], skipped: [], failed: [] };
    }

    let unlisten = null;
    const bar = beginScanCancel(parentCancel);
    const cancel = bar.token;
    try {

      // Set up progress listener
      setScanning(true);
      setScanOperation('push');
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

      // #60: send the ABS item id explicitly (abs_id), falling back to the
      // group id for legacy imports where they are the same value.
      // v2.2.3: each item carries its import snapshot so the push only sends
      // what changed (see src/lib/absPayload.js).
      const request = { items: buildPushItems(groupsToPush) };

      const raw = await callBackend('push_abs_imports', { request, cancel });
      const result = normalizePushResult(raw);
      // H-5: pushed books take the server's tags/genres. D-8: only fields now
      // in step with ABS drop their staged state (raw.pushed); values that
      // were not sent stay staged. Books skipped because ABS already matched
      // adopt the server lists too.
      if (raw?.snapshots || raw?.refreshed) {
        setGroups(prev => applyRefreshedLists(applyPushSnapshots(prev, raw.snapshots, raw.pushed), raw.refreshed));
      }

      if (result.failed.length > 0) {
        // Group errors by type
        const errorTypes = {};
        result.failed.forEach(f => {
          const match = String(f.error).match(/HTTP (\d+)|timeout|connection|dns/i);
          const type = match ? match[0] : 'other';
          errorTypes[type] = (errorTypes[type] || 0) + 1;
        });
        console.warn('Push error breakdown:', errorTypes);
        console.warn('Sample errors:', result.failed.slice(0, 10));
        logEvent('push', 'ABS push errors', { breakdown: errorTypes, sample: result.failed.slice(0, 5) });
      }
      logEvent('push', raw?.cancelled ? 'ABS push (by id) cancelled' : 'ABS push (by id) complete', {
        books: groupsToPush.length,
        updated: result.updated.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });

      return {
        success: result.failed.length === 0,
        attempted: groupsToPush.length,
        ...result,
      };

    } catch (error) {
      console.error('ABS push failed:', error);
      logEvent('push', 'ABS push (by id) threw', { books: groupsToPush.length, error: String(error?.message || error) });
      throw error;
    } finally {
      if (unlisten) unlisten();
      bar.release();
      setScanning(false);
    }
  }, [setGroups]);

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
    let pushOutcome = null; // #60: auto-push result, returned to the caller
    try {
      setScanning(true);
      setScanOperation('rescan');
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
      // v2.2.3: never report success for a rescan that returned nothing.
      if (!result || !Array.isArray(result.groups)) {
        throw new Error('Rescan returned no results; nothing was updated.');
      }

      // Update groups with rescanned data (preserve position in list)
      if (result && result.groups) {
        const updatedMap = new Map(result.groups.map(g => [g.id, g]));
        // Merge rather than replace so the ABS import snapshot (abs_original)
        // survives a rescan.
        setGroups(prevGroups =>
          prevGroups.map(g => (updatedMap.has(g.id) ? { ...g, ...updatedMap.get(g.id), abs_original: g.abs_original } : g))
        );

        // Auto-push to ABS if enabled
        if (autoPush && result.groups.length > 0) {
          setScanProgress(prev => ({
            ...prev,
            currentFile: 'Pushing to ABS...',
          }));

          try {
            const snapById = new Map(selectedGroups.map(sg => [sg.id, sg.abs_original]));
            pushOutcome = await handlePushAbsImports(
              result.groups.map(rg => ({ ...rg, abs_original: rg.abs_original || snapById.get(rg.id) || null }))
            );
          } catch (pushError) {
            console.error('Auto-push failed:', pushError);
            pushOutcome = failedPushResult(result.groups, pushError);
          }
        }
      }

      // #60: hand the auto-push outcome back so the page can toast it.
      return { success: true, count: result.total_rescanned, groups: result.groups, push: pushOutcome };

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
    let pushOutcome = null; // #60: auto-push result, returned to the caller
    const bar = beginScanCancel();
    const cancel = bar.token;
    try {
      setScanning(true);
      setScanOperation('rescan');
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
          abs_id: getAbsId(g) || g.id,
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

      const result = await callBackend('process_with_pipeline', { request, cancel });

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

        // Auto-push to ABS if enabled (not after a Cancel: the user stopped the run)
        if (autoPush && result.processed > 0 && !cancel.cancelled) {
          setScanProgress(prev => ({
            ...prev,
            currentFile: 'Pushing to ABS...',
          }));

          const groupsToPush = selectedGroups.filter(g => updatedMap.has(g.id));
          try {
            pushOutcome = await handlePushAbsImports(groupsToPush, { cancel });
          } catch (pushError) {
            console.error('Auto-push failed:', pushError);
            pushOutcome = failedPushResult(groupsToPush, pushError);
          }
        }
      }

      return { success: true, count: result.processed, failed: result.failed, cancelled: result.cancelled || 0, push: pushOutcome };

    } catch (error) {
      console.error('Pipeline rescan failed:', error);
      throw error;
    } finally {
      // L-10: unlisten belongs in finally (matching the other handlers) so a
      // thrown callBackend/setGroups error doesn't leak the subscription.
      if (unlisten) unlisten();
      bar.release();
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

      // Apply through the shared applier so changedFields / total_changes are
      // stamped and snapshot genres are never dropped without a replacement.
      const entries = new Map((result.results || []).map((r) => [r.id, r]));
      const pairs = applyEntries(setGroups, selectedGroups, (g) => entries.get(g.id), applyStaticGenreCleanupResult);

      return { success: true, count: result.total_cleaned, pairs };

    } catch (error) {
      console.error('Genre cleanup failed:', error);
      throw error;
    }
  }, [setGroups]);

  // H-7: Cancel stops the running import or push for real: the JS token
  // stops the page loop / push pool (books in flight finish), and the
  // operation's own finally hides the bar once it has stopped. Hiding the bar
  // here would only make the work invisible while it carried on.
  const cancelScan = useCallback(async () => {
    const token = scanCancelRef.current;
    if (token) {
      requestCancel(token);
      setScanProgress(prev => ({ ...prev, currentFile: 'Cancelling...' }));
    }
    try {
      await callBackend('cancel_scan');
    } catch (error) {
      console.error('Failed to cancel scan:', error);
    }
  }, []);

  return {
    scanning,
    scanningFolder,
    scanOperation,
    scanCancellable,
    scanProgress,
    calculateETA,
    handleScan,
    handleImportFromAbs,
    handleRescanAbsImports,
    handlePipelineRescan,
    handlePushAbsImports,
    handleCleanupGenres,
    handleRescan,
    cancelScan,
  };
}