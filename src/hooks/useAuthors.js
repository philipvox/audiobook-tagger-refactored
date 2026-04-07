// src/hooks/useAuthors.js
// Hook for author data loading & operations with local-first editing + push to ABS

import { useState, useCallback, useEffect, useRef } from 'react';
import { callBackend, subscribe } from '../api';

export function useAuthors() {
  const [authors, setAuthors] = useState([]);
  const [selectedAuthorId, setSelectedAuthorId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [fixingDescriptions, setFixingDescriptions] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [progressMessage, setProgressMessage] = useState(null);
  const [error, setError] = useState(null);

  // Local pending changes - edits staged before push
  const [pendingChanges, setPendingChanges] = useState({});

  // Pending merges: primaryId -> [{ id, name }]
  // Secondary authors get folded into the primary on push
  const [pendingMerges, setPendingMerges] = useState({});

  // Selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [allSelected, setAllSelected] = useState(false);
  const [lastSelectedIndex, setLastSelectedIndex] = useState(null);

  const unlistenRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const unlisten = subscribe('authors_progress', (data) => {
      if (!cancelled) setProgressMessage(data);
    });
    unlistenRef.current = unlisten;
    return () => {
      cancelled = true;
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  // Load all authors, overlaying pending changes
  const loadAuthors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callBackend('get_abs_authors');
      for (const author of result) {
        const pending = pendingChanges[author.id];
        if (pending) {
          if (pending.name) author.name = pending.name;
          if (pending.description) author.description = pending.description;
        }
      }
      result.sort((a, b) => a.name.localeCompare(b.name));
      setAuthors(result);
      return result;
    } catch (err) {
      setError(typeof err === 'string' ? err : String(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, [pendingChanges]);

  // Load detail for a specific author, overlaying pending changes
  const loadDetail = useCallback(async (authorId) => {
    setSelectedAuthorId(authorId);
    setLoadingDetail(true);
    try {
      const result = await callBackend('get_abs_author_detail', { authorId });
      const pending = pendingChanges[authorId];
      if (pending) {
        if (pending.name) result.name = pending.name;
        if (pending.description) result.description = pending.description;
      }
      setDetail(result);
      return result;
    } catch (err) {
      // Detail load failed — error shown via detail=null state
      setDetail(null);
      return null;
    } finally {
      setLoadingDetail(false);
    }
  }, [pendingChanges]);

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const result = await callBackend('analyze_authors_from_abs');
      setAnalysis(result);
      return result;
    } catch (err) {
      setError(typeof err === 'string' ? err : String(err));
      return null;
    } finally {
      setAnalyzing(false);
      // progressMessage cleared by phase:"done" event via the page
    }
  }, []);

  // Stage a local change
  const stageChange = useCallback((authorId, field, value) => {
    setPendingChanges(prev => ({
      ...prev,
      [authorId]: { ...(prev[authorId] || {}), [field]: value },
    }));
  }, []);

  const discardAllChanges = useCallback(() => {
    setPendingChanges({});
    setPendingMerges({});
  }, []);

  // ---- Selection ----

  const handleAuthorClick = useCallback((author, index, event, visibleAuthors) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) event.preventDefault();
    setSelectedAuthorId(author.id);
    if (allSelected) setAllSelected(false);
    const list = visibleAuthors || authors;

    if (event.shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const newIds = new Set(selectedIds);
      for (let i = start; i <= end; i++) {
        if (list[i]) newIds.add(list[i].id);
      }
      setSelectedIds(newIds);
    } else if (event.metaKey || event.ctrlKey) {
      const newIds = new Set(selectedIds);
      if (newIds.has(author.id)) newIds.delete(author.id);
      else newIds.add(author.id);
      setSelectedIds(newIds);
    } else {
      setSelectedIds(new Set([author.id]));
    }

    setLastSelectedIndex(index);
    loadDetail(author.id);
  }, [authors, selectedIds, allSelected, lastSelectedIndex, loadDetail]);

  const handleSelectAll = useCallback((filteredAuthors) => {
    if (filteredAuthors && filteredAuthors.length < authors.length) {
      setSelectedIds(new Set(filteredAuthors.map(a => a.id)));
      setAllSelected(false);
    } else {
      setAllSelected(true);
      setSelectedIds(new Set());
    }
  }, [authors]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setAllSelected(false);
  }, []);

  const getSelectedAuthors = useCallback((filteredList) => {
    if (allSelected) return filteredList || authors;
    return (filteredList || authors).filter(a => selectedIds.has(a.id));
  }, [authors, allSelected, selectedIds]);

  const getSelectedCount = useCallback((filteredList) => {
    if (allSelected) return (filteredList || authors).length;
    return selectedIds.size;
  }, [authors, allSelected, selectedIds]);

  // ---- Rename (stages locally) ----

  const renameAuthor = useCallback((authorId, newName) => {
    stageChange(authorId, 'name', newName);
    setAuthors(prev => prev.map(a =>
      a.id === authorId ? { ...a, name: newName } : a
    ));
    if (detail && detail.id === authorId) {
      setDetail(prev => prev ? { ...prev, name: newName } : prev);
    }
  }, [detail, stageChange]);

  // ---- Merge (stages locally, executed on push) ----

  const stageMerge = useCallback((primaryId, secondaryId, secondaryName) => {
    setPendingMerges(prev => {
      const existing = prev[primaryId] || [];
      // Don't add if already staged
      if (existing.some(s => s.id === secondaryId)) return prev;
      return { ...prev, [primaryId]: [...existing, { id: secondaryId, name: secondaryName }] };
    });
  }, []);

  const unstageMerge = useCallback((primaryId, secondaryId) => {
    setPendingMerges(prev => {
      const existing = (prev[primaryId] || []).filter(s => s.id !== secondaryId);
      if (existing.length === 0) {
        const next = { ...prev };
        delete next[primaryId];
        return next;
      }
      return { ...prev, [primaryId]: existing };
    });
  }, []);

  // ---- Auto-merge all detected duplicates ----
  // Priority: most books > most info (description+image) > proper name (periods in initials) > keep oldest (lower id)

  const autoMergeDuplicates = useCallback(() => {
    if (!analysis) return 0;

    // Build duplicate clusters: normalized_key -> [author objects]
    // The analysis issues tell us pairs, but we need to cluster them
    const dupPairs = analysis.issues.filter(i => i.issue_type === 'potential_duplicate');
    if (dupPairs.length === 0) return 0;

    // Build a union-find from duplicate pairs
    const parent = {};
    const find = (id) => {
      if (!parent[id]) parent[id] = id;
      if (parent[id] !== id) parent[id] = find(parent[id]);
      return parent[id];
    };
    const union = (a, b) => { parent[find(a)] = find(b); };

    for (const issue of dupPairs) {
      if (issue.duplicate_of) {
        union(issue.author_id, issue.duplicate_of.id);
      }
    }

    // Group authors by cluster root
    const clusters = {};
    const authorMap = {};
    for (const a of authors) authorMap[a.id] = a;

    const allDupIds = new Set();
    for (const issue of dupPairs) {
      allDupIds.add(issue.author_id);
      if (issue.duplicate_of) allDupIds.add(issue.duplicate_of.id);
    }

    for (const id of allDupIds) {
      const root = find(id);
      if (!clusters[root]) clusters[root] = [];
      if (!clusters[root].some(a => a.id === id) && authorMap[id]) {
        clusters[root].push(authorMap[id]);
      }
    }

    // For each cluster, pick the best primary and merge the rest into it
    let mergeCount = 0;
    for (const members of Object.values(clusters)) {
      if (members.length < 2) continue;

      // Score each author
      const scored = members.map(a => {
        let score = 0;
        // Most books (major factor)
        score += (a.num_books || 0) * 1000;
        // Has description
        if (a.description && a.description.trim().length > 10) score += 100;
        // Has image
        if (a.image_path && a.image_path.trim()) score += 50;
        // Proper name formatting (has periods in initials like "J. K." vs "J K")
        if (/[A-Z]\.\s/.test(a.name)) score += 10;
        // Longer name often more complete
        score += a.name.length;
        return { author: a, score };
      });

      // Sort: highest score first. Tie-break: pick the one whose id sorts first (oldest)
      scored.sort((a, b) => b.score - a.score || a.author.id.localeCompare(b.author.id));

      const primary = scored[0].author;
      for (let i = 1; i < scored.length; i++) {
        const secondary = scored[i].author;
        stageMerge(primary.id, secondary.id, secondary.name);
        mergeCount++;
      }
    }

    return mergeCount;
  }, [analysis, authors, stageMerge]);

  // ---- Fix descriptions with GPT ----

  const fixDescriptions = useCallback(async (authorIds, force) => {
    setFixingDescriptions(true);
    setError(null);
    try {
      const result = await callBackend('fix_author_descriptions_gpt', {
        authorIds,
        force: force || false,
      });
      for (const r of result.results) {
        if (r.fixed && r.new_description) {
          stageChange(r.id, 'description', r.new_description);
          setAuthors(prev => prev.map(a =>
            a.id === r.id ? { ...a, description: r.new_description } : a
          ));
          if (detail && detail.id === r.id) {
            setDetail(prev => prev ? { ...prev, description: r.new_description } : prev);
          }
        }
      }
      return result;
    } catch (err) {
      setError(typeof err === 'string' ? err : String(err));
      return null;
    } finally {
      setFixingDescriptions(false);
      // progressMessage cleared by phase:"done" event via the page
    }
  }, [detail, stageChange]);

  // ---- Apply normalization fixes from analysis ----

  const applyNormalizationFixes = useCallback((authorIds) => {
    if (!analysis) return 0;
    const idSet = authorIds ? new Set(authorIds) : null;
    let count = 0;
    for (const issue of analysis.issues) {
      if (issue.issue_type !== 'needs_normalization' || !issue.suggested_value) continue;
      if (idSet && !idSet.has(issue.author_id)) continue;
      stageChange(issue.author_id, 'name', issue.suggested_value);
      setAuthors(prev => prev.map(a =>
        a.id === issue.author_id ? { ...a, name: issue.suggested_value } : a
      ));
      count++;
    }
    return count;
  }, [analysis, stageChange]);

  // ---- Push all pending changes + merges to ABS ----

  const pushToAbs = useCallback(async () => {
    const changeEntries = Object.entries(pendingChanges);
    const mergeEntries = Object.entries(pendingMerges);
    if (changeEntries.length === 0 && mergeEntries.length === 0) {
      return { updated: 0, failed: 0, errors: [] };
    }

    setPushing(true);
    setError(null);
    try {
      let totalUpdated = 0;
      let totalFailed = 0;
      let allErrors = [];

      // 1. Push name/description changes
      if (changeEntries.length > 0) {
        const items = changeEntries.map(([id, changes]) => ({
          id,
          name: changes.name || null,
          description: changes.description || null,
        }));
        const result = await callBackend('push_author_changes_to_abs', { items });
        totalUpdated += result.updated;
        totalFailed += result.failed;
        allErrors = allErrors.concat(result.errors);
      }

      // 2. Execute merges
      for (const [primaryId, secondaries] of mergeEntries) {
        try {
          await callBackend('merge_abs_authors', {
            primaryId,
            secondaryIds: secondaries.map(s => s.id),
          });
          totalUpdated += secondaries.length;
        } catch (err) {
          totalFailed += secondaries.length;
          allErrors.push(`Merge failed: ${err}`);
        }
      }

      // Clear all staged state
      setPendingChanges({});
      setPendingMerges({});

      // Reload to get fresh state
      await loadAuthors();

      return { updated: totalUpdated, failed: totalFailed, errors: allErrors };
    } catch (err) {
      setError(typeof err === 'string' ? err : String(err));
      return null;
    } finally {
      setPushing(false);
      // progressMessage cleared by phase:"done" event via the page
    }
  }, [pendingChanges, pendingMerges, loadAuthors]);

  // ---- Helpers ----

  const getIssuesForAuthor = useCallback((authorId) => {
    if (!analysis) return [];
    return analysis.issues.filter(i => i.author_id === authorId);
  }, [analysis]);

  // Count all pending operations
  const pendingCount = Object.keys(pendingChanges).length
    + Object.values(pendingMerges).reduce((sum, arr) => sum + arr.length, 0);

  // Set of author IDs that are staged to be merged into someone else (hidden from main list)
  const mergedAwayIds = new Set(
    Object.values(pendingMerges).flatMap(arr => arr.map(s => s.id))
  );

  return {
    authors, selectedAuthorId, detail, analysis,
    loading, loadingDetail, analyzing, fixingDescriptions, pushing,
    progressMessage, error, pendingChanges, pendingMerges, pendingCount,
    mergedAwayIds,
    selectedIds, allSelected, lastSelectedIndex,

    loadAuthors, loadDetail, runAnalysis,
    renameAuthor, stageMerge, unstageMerge, autoMergeDuplicates, fixDescriptions,
    applyNormalizationFixes, pushToAbs,
    stageChange, discardAllChanges, setSelectedAuthorId,

    handleAuthorClick, handleSelectAll, handleClearSelection,
    getSelectedAuthors, getSelectedCount,

    getIssuesForAuthor,
  };
}
