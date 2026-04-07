// src/context/AppContext.jsx
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { callBackend, subscribe } from '../api';

const AppContext = createContext(null);

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

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, []);

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
        issue.suggested_value &&
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