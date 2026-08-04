// src/context/AppContext.jsx
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { callBackend, ollamaCall, subscribe } from '../api';
import { isTauri } from '../lib/platform.js';
import {
  AUTOSAVE_DEBOUNCE_MS,
  autosaveDelay,
  clearSession,
  loadSession,
  makeSessionSnapshot,
  nextAutosaveFailureState,
  preserveSession,
  saveSession,
  shouldAutosave,
} from '../lib/session.js';

const AppContext = createContext(null);

/**
 * Decide whether to auto-enable Local AI on startup.
 * Only auto-enables when the user has NEVER made an explicit choice
 * (`use_local_ai === undefined`) and no cloud key is set, and Ollama is
 * actually running with at least one model. An explicit `false` is a user
 * decision and is always respected.
 * Shared by the AppContext startup effect and the SettingsPage poll so the
 * two paths cannot fight each other.
 */
export function shouldAutoEnableLocalAI(config, ollamaStatus) {
  if (!config) return false;
  if (config.use_local_ai !== undefined) return false; // explicit user choice
  if (config.openai_api_key || config.anthropic_api_key) return false;
  return !!(ollamaStatus?.running && ollamaStatus?.models?.length > 0);
}

export function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [groups, setGroups] = useState([]);
  const [fileStatuses, setFileStatuses] = useState({});
  const [writeProgress, setWriteProgress] = useState({ current: 0, total: 0 });
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  // Validation state - stores issues per book and overall stats
  const [validationResults, setValidationResults] = useState({}); // { bookId: { issues: [], errorCount, warningCount } }
  const [validationStats, setValidationStats] = useState({ scanned: 0, withErrors: 0, withWarnings: 0, clean: 0 });
  const [validating, setValidating] = useState(false);
  const [authorAnalysis, setAuthorAnalysis] = useState(null); // { authors, needsNormalization, suspicious }

  // Global progress state for app-wide operations
  const [globalProgress, setGlobalProgress] = useState({
    active: false,
    current: 0,
    total: 0,
    message: '',
    detail: '',
    startTime: null,
    canCancel: false,
    type: 'info', // 'info', 'warning', 'danger', 'success'
    cancelFn: null
  });

  const cancelRef = useRef(null);

  // ==========================================================================
  // Session persistence (#58)
  //
  // A crash or a forced window close used to throw away every edit that had
  // not been pushed to AudiobookShelf. The working state is now autosaved on a
  // debounce and offered back on the next launch. Two invariants keep this from
  // becoming its own source of data loss:
  //
  //   * nothing is written before startup has finished reading the saved
  //     session, and
  //   * nothing is written while the user still owes us a Restore/Discard
  //     answer, because until they answer, the file on disk is the only copy of
  //     that work.
  // ==========================================================================

  // The snapshot read at startup, held until the user answers the prompt.
  const [savedSession, setSavedSession] = useState(null);
  const [sessionRestorePending, setSessionRestorePending] = useState(false);
  // False until the startup read finishes, gating the first autosave.
  const [sessionChecked, setSessionChecked] = useState(false);
  // Whether a snapshot of THIS session's work is on disk. Drives the one case
  // where autosave clears instead of writes: a workspace that was explicitly
  // emptied. Without it, an empty workspace at startup would look identical to
  // a reset and wipe a session the user never chose to discard.
  const hadGroupsRef = useRef(false);
  // When the last snapshot was written, so a workspace that never stops
  // changing still gets saved at least every AUTOSAVE_MAX_WAIT_MS instead of
  // having its debounce reset forever by an in-flight batch run.
  const lastSaveAtRef = useRef(0);

  // A snapshot that exists but could not be read or parsed. Autosave stays
  // paused while this is set: the file may hold real work, and overwriting it
  // would destroy the user's only copy on the strength of a read error. The
  // user's escape is the Discard action on the prompt.
  const [sessionUnreadable, setSessionUnreadable] = useState(null);

  // One-time warning that autosave is failing repeatedly. Silently dropping
  // { saved: false } means a browser build over the localStorage quota never
  // saves and never says so.
  const [autosaveWarning, setAutosaveWarning] = useState(null);
  const autosaveFailureRef = useRef({ consecutiveFailures: 0, warned: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let outcome = { session: null, unreadable: false };
      try {
        outcome = await loadSession();
      } catch (e) {
        console.warn('Could not read the saved session:', e);
        outcome = { session: null, unreadable: true, error: String(e?.message || e) };
      }
      if (cancelled) return;
      if (outcome.session) {
        setSavedSession(outcome.session);
        setSessionRestorePending(true);
      } else if (outcome.unreadable) {
        setSessionUnreadable({ reason: outcome.error || 'unknown error' });
      }
      setSessionChecked(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!sessionChecked) return;
    if (sessionRestorePending) return;
    // A present-but-unreadable snapshot is treated like an unanswered prompt:
    // do not write over it until a successful read or an explicit discard.
    if (sessionUnreadable) return;

    const hasWork = shouldAutosave(groups);
    // Nothing in memory and nothing of ours on disk: leave any older snapshot
    // alone. This is the fresh-launch and post-discard case.
    if (!hasWork && !hadGroupsRef.current) return;

    const libraryId = config?.abs_library_id || null;
    const delay = hasWork ? autosaveDelay(lastSaveAtRef.current) : AUTOSAVE_DEBOUNCE_MS;
    const timer = setTimeout(() => {
      if (hasWork) {
        hadGroupsRef.current = true;
        // Stamped when the write is fired, not when it lands, so a persistently
        // failing store cannot turn the max-wait into a hot retry loop.
        lastSaveAtRef.current = Date.now();
        saveSession(makeSessionSnapshot({ groups, libraryId }))
          .then((result) => {
            const next = nextAutosaveFailureState(autosaveFailureRef.current, result);
            autosaveFailureRef.current = { consecutiveFailures: next.consecutiveFailures, warned: next.warned };
            if (next.warn) setAutosaveWarning({ reason: next.reason, at: Date.now() });
          })
          .catch(() => {});
      } else {
        // The workspace was explicitly emptied. Clearing happens here, after
        // the new state settled, rather than in the click handler, so the
        // "clear only once the replacement is durable" ordering holds by
        // construction: a replacement with books saves instead of clearing.
        hadGroupsRef.current = false;
        lastSaveAtRef.current = 0;
        clearSession().catch(() => {});
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [groups, config?.abs_library_id, sessionChecked, sessionRestorePending, sessionUnreadable]);

  // Consumed once by the UI so the warning toast shows a single time per
  // failure streak rather than on every render.
  const acknowledgeAutosaveWarning = useCallback(() => setAutosaveWarning(null), []);

  // Explicit user decision: bring the saved work back into the workspace.
  //
  // Refuses to clobber a non-empty workspace unless the caller forces it. The
  // prompt has no dismiss, so it can still be open while the user scans or
  // imports; restoring over that fresh work would destroy it, and because
  // autosave is suppressed while the prompt is open there would be no snapshot
  // of it to recover from. The refusal is the caller's cue to confirm first.
  //
  // Returns { restored, count, reason?, currentCount? }.
  const restoreSession = useCallback(({ force = false } = {}) => {
    if (!savedSession) return { restored: false, count: 0, reason: 'no-session' };
    if (!force && groups.length > 0) {
      return {
        restored: false,
        count: savedSession.bookCount ?? savedSession.groups.length,
        currentCount: groups.length,
        reason: 'workspace-not-empty',
      };
    }
    const restored = savedSession.groups;
    setGroups(restored);
    // The restored state is already the snapshot on disk, so an empty-workspace
    // clear must not fire against it later, and the max-wait clock starts now
    // rather than treating the restore as 30s overdue.
    hadGroupsRef.current = true;
    lastSaveAtRef.current = Date.now();
    setSavedSession(null);
    setSessionRestorePending(false);
    return { restored: true, count: restored.length };
  }, [savedSession, groups]);

  // Explicit user decision: throw the saved work away. The only path in the app
  // that deletes a snapshot the user has not replaced.
  const discardSession = useCallback(async () => {
    setSavedSession(null);
    setSessionRestorePending(false);
    // Also the escape hatch for a snapshot that could not be read: discarding
    // it is what re-arms autosave.
    setSessionUnreadable(null);
    hadGroupsRef.current = false;
    lastSaveAtRef.current = 0;
    await clearSession();
  }, []);

  // Explicit user decision: keep what is loaded now and stop being asked.
  // The declined snapshot is moved to the second slot rather than deleted, so
  // autosave can resume into the primary slot without destroying it. The move
  // is awaited BEFORE the prompt is dismissed: dismissing first would let an
  // autosave land in the primary slot and then be moved to the second slot by
  // this very call, losing the newly protected work.
  //
  // Returns whether the backup copy actually landed. It can fail (a browser
  // build under quota pressure throws on the second setItem and leaves the
  // primary slot in place, where resumed autosave overwrites it a few seconds
  // later), and the caller must not claim the previous session was kept when
  // it was not. Either way the prompt is dismissed and autosave resumes: the
  // user chose their current work, and stranding them unprotected again would
  // repeat the bug this whole path exists to fix.
  const keepCurrentWorkspace = useCallback(async () => {
    const preserved = await preserveSession();
    setSavedSession(null);
    setSessionRestorePending(false);
    setSessionUnreadable(null);
    hadGroupsRef.current = false;
    lastSaveAtRef.current = 0;
    return preserved;
  }, []);

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, []);

  // Auto-detect system Ollama on startup (Tauri only)
  // If no AI is configured and Ollama is running with models, auto-enable local AI
  useEffect(() => {
    if (!isTauri() || !config || isLoadingConfig) return;
    // Skip the Ollama probe entirely if the user has an explicit choice or a cloud key.
    if (config.use_local_ai !== undefined) return;
    if (config.openai_api_key || config.anthropic_api_key) return;

    (async () => {
      try {
        const status = await ollamaCall('ollama_get_status');
        if (shouldAutoEnableLocalAI(config, status)) {
          const model = status.models[0].name;
          const newConfig = { ...config, use_local_ai: true, ollama_model: model };
          await callBackend('save_config', { config: newConfig });
          setConfig(newConfig);
          console.log(`Auto-detected Ollama with model "${model}" — enabled Local AI`);
        }
      } catch (e) {
        // Silent — auto-detection is best-effort
      }
    })();
  }, [config, isLoadingConfig]);

  // Listen for write progress events
  useEffect(() => {
    const unlistenFn = subscribe('write_progress', (data) => {
      setWriteProgress(data);
    });
    return () => { unlistenFn(); };
  }, []);

  const loadConfig = async () => {
    try {
      setIsLoadingConfig(true); // ✅ ADD THIS
      const cfg = await callBackend('get_config');
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to load config:', error);
    } finally {
      setIsLoadingConfig(false); // ✅ ADD THIS
    }
  };

  const saveConfig = async (newConfig) => {
    try {
      await callBackend('save_config', { config: newConfig });
      setConfig(newConfig);
      return { success: true };
    } catch (error) {
      console.error('Failed to save config:', error);
      return { success: false, error: error.toString() };
    }
  };

  const updateFileStatus = (fileId, status) => {
    setFileStatuses(prev => ({
      ...prev,
      [fileId]: status
    }));
  };

  const updateFileStatuses = (statusMap) => {
    setFileStatuses(prev => ({
      ...prev,
      ...statusMap
    }));
  };

  const clearFileStatuses = () => {
    setFileStatuses({});
  };

  // Global progress management functions
  const startGlobalProgress = useCallback(({ message, total = 0, canCancel = false, type = 'info', cancelFn = null }) => {
    cancelRef.current = cancelFn;
    setGlobalProgress({
      active: true,
      current: 0,
      total,
      message,
      detail: '',
      startTime: Date.now(),
      canCancel,
      type,
      cancelFn
    });
  }, []);

  const updateGlobalProgress = useCallback(({ current, total, message, detail }) => {
    setGlobalProgress(prev => ({
      ...prev,
      ...(current !== undefined && { current }),
      ...(total !== undefined && { total }),
      ...(message !== undefined && { message }),
      ...(detail !== undefined && { detail })
    }));
  }, []);

  const endGlobalProgress = useCallback(() => {
    cancelRef.current = null;
    setGlobalProgress({
      active: false,
      current: 0,
      total: 0,
      message: '',
      detail: '',
      startTime: null,
      canCancel: false,
      type: 'info',
      cancelFn: null
    });
  }, []);

  const cancelGlobalProgress = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current();
    }
    endGlobalProgress();
  }, [endGlobalProgress]);

  // Run validation on all groups
  const runValidation = useCallback(async (groupsToValidate) => {
    if (!groupsToValidate || groupsToValidate.length === 0) return;

    setValidating(true);
    startGlobalProgress({
      message: 'Scanning for metadata issues...',
      total: groupsToValidate.length,
      type: 'info'
    });

    // Listen for progress events from backend
    const unlisten = subscribe('validation_progress', (data) => {
      const { current, total, message } = data;
      updateGlobalProgress({
        current,
        total,
        detail: message
      });
    });

    try {
      const result = await callBackend('scan_metadata_errors', { groups: groupsToValidate });

      // Convert to map for quick lookup
      const resultsMap = {};
      for (const book of result.books) {
        resultsMap[book.book_id] = {
          issues: book.issues,
          errorCount: book.error_count,
          warningCount: book.warning_count,
        };
      }

      setValidationResults(resultsMap);
      setValidationStats({
        scanned: result.total_scanned,
        withErrors: result.books_with_errors,
        withWarnings: result.books_with_warnings,
        clean: result.total_scanned - (result.books?.length || 0),
      });

      updateGlobalProgress({ current: groupsToValidate.length, message: 'Validation complete' });
    } catch (error) {
      console.error('Validation failed:', error);
    } finally {
      unlisten();
      setValidating(false);
      endGlobalProgress();
    }
  }, [startGlobalProgress, updateGlobalProgress, endGlobalProgress]);

  // Run author analysis
  const runAuthorAnalysis = useCallback(async (groupsToAnalyze) => {
    if (!groupsToAnalyze || groupsToAnalyze.length === 0) return;

    setValidating(true);
    startGlobalProgress({
      message: 'Analyzing authors...',
      total: groupsToAnalyze.length,
      type: 'info'
    });

    try {
      const result = await callBackend('analyze_authors', { groups: groupsToAnalyze });
      setAuthorAnalysis(result);
      updateGlobalProgress({ current: groupsToAnalyze.length, message: 'Author analysis complete' });
    } catch (error) {
      console.error('Author analysis failed:', error);
    } finally {
      setValidating(false);
      endGlobalProgress();
    }
  }, [startGlobalProgress, updateGlobalProgress, endGlobalProgress]);

  // Clear validation results
  const clearValidation = useCallback(() => {
    setValidationResults({});
    setValidationStats({ scanned: 0, withErrors: 0, withWarnings: 0, clean: 0 });
    setAuthorAnalysis(null);
    setSeriesAnalysis(null);
  }, []);

  // Series analysis state
  const [seriesAnalysis, setSeriesAnalysis] = useState(null);
  const [analyzingSeries, setAnalyzingSeries] = useState(false);

  // Run comprehensive series analysis
  const runSeriesAnalysis = useCallback(async (groupsToAnalyze) => {
    if (!groupsToAnalyze || groupsToAnalyze.length === 0) return;

    setAnalyzingSeries(true);

    // Cancel function for series analysis
    const cancelFn = async () => {
      try {
        await callBackend('cancel_series_scan');
      } catch (e) {
        // Ignore if not running
      }
    };

    startGlobalProgress({
      message: 'Analyzing series...',
      total: groupsToAnalyze.length,
      type: 'info',
      canCancel: true,
      cancelFn
    });

    // Listen for progress events from backend
    const unlisten = subscribe('series_analysis_progress', (data) => {
      const { phase, current, total, message } = data;
      updateGlobalProgress({
        current,
        total,
        message: `[${phase}] ${message}`
      });
    });

    try {
      const result = await callBackend('analyze_series_comprehensive', {
        groups: groupsToAnalyze,
        config: config,
        openaiKey: config?.openai_api_key || null
      });

      setSeriesAnalysis(result);
      updateGlobalProgress({
        current: result.total_books,
        message: `Found ${result.total_issues} issues across ${result.series_groups.length} series`
      });
    } catch (error) {
      console.error('Series analysis failed:', error);
    } finally {
      unlisten();
      setAnalyzingSeries(false);
      endGlobalProgress();
    }
  }, [config, startGlobalProgress, updateGlobalProgress, endGlobalProgress]);

  // Apply series fixes to groups
  const applySeriesFixes = useCallback(async (currentGroups, fixes) => {
    if (!fixes || fixes.length === 0) return { updatedGroups: currentGroups, fixCount: 0 };

    try {
      const updatedGroups = await callBackend('apply_series_fixes', {
        groups: currentGroups,
        fixes
      });
      return { updatedGroups, fixCount: fixes.length };
    } catch (error) {
      console.error('Failed to apply series fixes:', error);
      return { updatedGroups: currentGroups, fixCount: 0 };
    }
  }, []);

  // Apply batch fixes from validation issues to groups
  // Returns the updated groups and a count of fixes applied
  // @param {Array} currentGroups - The groups to apply fixes to
  // @param {Object|null} allowedIssueTypes - Optional filter: { IssueType: true/false }. If null, apply all.
  const applyBatchFixes = useCallback((currentGroups, allowedIssueTypes = null) => {
    if (Object.keys(validationResults).length === 0) {
      return { updatedGroups: currentGroups, fixCount: 0 };
    }

    let fixCount = 0;
    const updatedGroups = currentGroups.map(group => {
      const validation = validationResults[group.id];
      if (!validation || !validation.issues || validation.issues.length === 0) {
        return group;
      }

      // Find issues with suggested fixes, optionally filtered by issue type
      const fixableIssues = validation.issues.filter(issue =>
        issue.suggested_value != null &&
        (allowedIssueTypes === null || allowedIssueTypes[issue.issue_type])
      );
      if (fixableIssues.length === 0) {
        return group;
      }

      // Apply each fix
      const newMetadata = { ...group.metadata };
      for (const issue of fixableIssues) {
        const field = issue.field;
        const suggestedValue = issue.suggested_value;

        // Map validation field names to metadata field names
        switch (field) {
          case 'author':
            newMetadata.author = suggestedValue;
            // Also update authors array to keep UI in sync
            newMetadata.authors = [suggestedValue, ...(newMetadata.authors || []).slice(1)];
            break;
          case 'title':
            newMetadata.title = suggestedValue;
            break;
          case 'series':
            newMetadata.series = suggestedValue;
            // Also update all_series array to keep UI in sync
            if (newMetadata.all_series?.length > 0) {
              newMetadata.all_series = [{ ...newMetadata.all_series[0], name: suggestedValue }, ...newMetadata.all_series.slice(1)];
            } else {
              newMetadata.all_series = [{ name: suggestedValue, sequence: newMetadata.sequence }];
            }
            break;
          case 'sequence':
            newMetadata.sequence = suggestedValue;
            // Also update all_series array to keep UI in sync
            if (newMetadata.all_series?.length > 0) {
              newMetadata.all_series = [{ ...newMetadata.all_series[0], sequence: suggestedValue }, ...newMetadata.all_series.slice(1)];
            }
            break;
          case 'narrator':
            newMetadata.narrator = suggestedValue;
            // Also update narrators array to keep UI in sync
            newMetadata.narrators = [suggestedValue, ...(newMetadata.narrators || []).slice(1)];
            break;
          case 'description':
            newMetadata.description = suggestedValue;
            break;
          case 'genres':
            // Suggested genres might be a comma-separated string
            if (typeof suggestedValue === 'string') {
              newMetadata.genres = suggestedValue.split(',').map(g => g.trim()).filter(Boolean);
            } else if (Array.isArray(suggestedValue)) {
              newMetadata.genres = suggestedValue;
            }
            break;
          default:
            // For any other field, try direct assignment
            if (field in newMetadata) {
              newMetadata[field] = suggestedValue;
            }
        }
        fixCount++;
      }

      return {
        ...group,
        metadata: newMetadata,
        total_changes: (group.total_changes || 0) + fixableIssues.length,
      };
    });

    return { updatedGroups, fixCount };
  }, [validationResults]);

  // Apply author normalizations from author analysis to groups
  // Returns the updated groups and a count of fixes applied
  const applyAuthorFixes = useCallback((currentGroups) => {
    if (!authorAnalysis || !authorAnalysis.needs_normalization || authorAnalysis.needs_normalization.length === 0) {
      return { updatedGroups: currentGroups, fixCount: 0 };
    }

    // Build a lookup map of author variations to canonical form
    const authorLookup = {};
    for (const candidate of authorAnalysis.needs_normalization) {
      if (candidate.canonical) {
        // Map the primary name to canonical
        authorLookup[candidate.name.toLowerCase()] = candidate.canonical;
        // Also map all variations
        if (candidate.variations) {
          for (const variation of candidate.variations) {
            authorLookup[variation.toLowerCase()] = candidate.canonical;
          }
        }
      }
    }

    if (Object.keys(authorLookup).length === 0) {
      return { updatedGroups: currentGroups, fixCount: 0 };
    }

    let fixCount = 0;
    const updatedGroups = currentGroups.map(group => {
      const currentAuthor = group.metadata?.author?.toLowerCase();
      if (!currentAuthor) {
        return group;
      }

      const canonical = authorLookup[currentAuthor];
      if (!canonical || canonical === group.metadata.author) {
        return group;
      }

      fixCount++;
      return {
        ...group,
        metadata: {
          ...group.metadata,
          author: canonical,
          // Also update authors array to keep UI in sync
          authors: [canonical, ...(group.metadata.authors || []).slice(1)],
          sources: {
            ...group.metadata.sources,
            author: 'normalized',
          },
        },
        total_changes: (group.total_changes || 0) + 1,
      };
    });

    return { updatedGroups, fixCount };
  }, [authorAnalysis]);

  const value = {
    config,
    setConfig,
    loadConfig,
    saveConfig,
    groups,
    setGroups,
    fileStatuses,
    updateFileStatus,
    updateFileStatuses,
    clearFileStatuses,
    writeProgress,
    setWriteProgress,
    // Session persistence (#58)
    savedSession,
    sessionRestorePending,
    sessionUnreadable,
    restoreSession,
    discardSession,
    keepCurrentWorkspace,
    autosaveWarning,
    acknowledgeAutosaveWarning,
    // Global progress
    globalProgress,
    startGlobalProgress,
    updateGlobalProgress,
    endGlobalProgress,
    cancelGlobalProgress,
    // Validation
    validationResults,
    validationStats,
    validating,
    authorAnalysis,
    runValidation,
    runAuthorAnalysis,
    clearValidation,
    applyBatchFixes,
    applyAuthorFixes,
    // Series analysis
    seriesAnalysis,
    analyzingSeries,
    runSeriesAnalysis,
    applySeriesFixes
  };

  return (
    <AppContext.Provider value={{ ...value, isLoadingConfig }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}