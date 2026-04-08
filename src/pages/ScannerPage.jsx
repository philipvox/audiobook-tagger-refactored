import { useState, useEffect, useCallback, useRef } from 'react';
import { callBackend, subscribe } from '../api';
import { BookList } from '../components/scanner/BookList';
import { MetadataPanel } from '../components/scanner/MetadataPanel';
import { ActionBar } from '../components/scanner/ActionBar';
import { ProgressBar } from '../components/scanner/ProgressBar';
import { EditMetadataModal } from '../components/EditMetadataModal';
import { BulkEditModal } from '../components/BulkEditModal';
import { BulkCoverAssignment } from '../components/BulkCoverAssignment';
import { RenamePreviewModal } from '../components/RenamePreviewModal';
import { ExportImportModal } from '../components/ExportImportModal';
import { RescanModal } from '../components/RescanModal';
import { ABSPushModal } from '../components/ABSPushModal';
import { UndoToast } from '../components/UndoToast';
import { SeriesIssueModal } from '../components/SeriesIssueModal';
import { ValidationIssueModal } from '../components/ValidationIssueModal';
import { AuthorAnalysisModal } from '../components/AuthorAnalysisModal';
import { BatchFixModal } from '../components/BatchFixModal';
import { useToast } from '../components/Toast';
import { useScan } from '../hooks/useScan';
import { useFileSelection } from '../hooks/useFileSelection';
import { useTagOperations } from '../hooks/useTagOperations';
import { useAbsCache } from '../hooks/useAbsCache';
import { useBatchOperations } from '../hooks/useBatchOperations';
import { useModals } from '../hooks/useModals';
import { useApp } from '../context/AppContext';

export function ScannerPage({ onNavigateToSettings, activeTab, navigateTo, logoSvg }) {
  const {
    config, groups, setGroups, fileStatuses, updateFileStatuses, clearFileStatuses, writeProgress,
    validationResults, validationStats, validating, runValidation, runAuthorAnalysis, authorAnalysis,
    applyBatchFixes, applyAuthorFixes, clearValidation,
    seriesAnalysis, analyzingSeries, runSeriesAnalysis, applySeriesFixes
  } = useApp();
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  // Consolidated modal and batch operation state
  const modals = useModals();
  const batch = useBatchOperations();

  // Toast notifications
  const toast = useToast();

  // Undo state
  const [undoStatus, setUndoStatus] = useState(null);
  const [undoing, setUndoing] = useState(false);
  const [showUndoToast, setShowUndoToast] = useState(false);

  // Check undo status
  const checkUndoStatus = useCallback(async () => {
    try {
      const status = await callBackend('get_undo_status');
      setUndoStatus(status);
      if (status.available) {
        setShowUndoToast(true);
      }
    } catch (error) {
      console.error('Failed to check undo status:', error);
    }
  }, []);

  // Handle undo
  const handleUndo = useCallback(async () => {
    if (!undoStatus?.available || undoing) return;

    setUndoing(true);
    try {
      const result = await callBackend('undo_last_write');
      setShowUndoToast(false);
      setUndoStatus(null);

      // Refresh the scan to show restored state
      if (result.success > 0) {
        // Could trigger a rescan here if needed
      }
    } catch (error) {
      console.error('Undo failed:', error);
    } finally {
      setUndoing(false);
    }
  }, [undoStatus, undoing]);

  // Dismiss undo toast
  const dismissUndo = useCallback(async () => {
    setShowUndoToast(false);
    try {
      await callBackend('clear_undo_state');
      setUndoStatus(null);
    } catch (error) {
      console.error('Failed to clear undo state:', error);
    }
  }, []);

  const {
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
    cancelScan
  } = useScan();

  // Keep selectedGroup in sync when groups are updated (e.g., after rescan)
  useEffect(() => {
    if (selectedGroup) {
      const updatedGroup = groups.find(g => g.id === selectedGroup.id);
      if (updatedGroup && updatedGroup !== selectedGroup) {
        setSelectedGroup(updatedGroup);
      }
    }
  }, [groups, selectedGroup]);

  const {
    selectedFiles,
    setSelectedFiles,
    allSelected,
    setAllSelected,
    lastSelectedIndex,
    setLastSelectedIndex,
    selectAllInGroup,
    clearSelection,
    selectAll,
    isFileSelected,
    isGroupSelected,
    getSelectedFileIds,
    getSelectedCount,
    getSuccessCount,
    getFilesWithChanges
  } = useFileSelection();

  const {
    writing,
    pushing,
    writeSelectedTags,
    renameFiles,
    pushToAudiobookShelf
  } = useTagOperations();

  const {
    refreshing: refreshingCache,
    refreshCache,
    cacheStatus,
  } = useAbsCache();

  // FIXED: Prevent text selection on Shift+Click and properly handle range selection
  // filteredGroups is passed from BookList when filters are applied
  const handleGroupClick = (group, index, event, filteredGroups = null) => {
    // Prevent text selection on modifier clicks
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
    }

    setSelectedGroup(group);

    // Cancel "all selected" mode when clicking individual groups
    if (allSelected) {
      setAllSelected(false);
    }

    // Use filteredGroups if provided (when filters are active), otherwise use full groups
    const groupsToUse = filteredGroups || groups;

    if (event.shiftKey && lastSelectedIndex !== null) {
      // SHIFT+CLICK: Range selection from last selected to current
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);

      const newSelectedFiles = new Set(selectedFiles);
      const newSelectedGroupIds = new Set(selectedGroupIds);

      for (let i = start; i <= end; i++) {
        const g = groupsToUse[i];
        if (g) {
          newSelectedGroupIds.add(g.id);
          g.files.forEach(f => newSelectedFiles.add(f.id));
        }
      }

      setSelectedFiles(newSelectedFiles);
      setSelectedGroupIds(newSelectedGroupIds);
    } else if (event.metaKey || event.ctrlKey) {
      // CMD/CTRL+CLICK: Toggle this group in selection (add or remove)
      const newSelectedFiles = new Set(selectedFiles);
      const newSelectedGroupIds = new Set(selectedGroupIds);

      if (newSelectedGroupIds.has(group.id)) {
        // Already selected - remove it
        newSelectedGroupIds.delete(group.id);
        group.files.forEach(f => newSelectedFiles.delete(f.id));
      } else {
        // Not selected - add it
        newSelectedGroupIds.add(group.id);
        group.files.forEach(f => newSelectedFiles.add(f.id));
      }

      setSelectedFiles(newSelectedFiles);
      setSelectedGroupIds(newSelectedGroupIds);
    } else {
      // REGULAR CLICK: Clear selection and select only this group
      const newSelectedFiles = new Set();
      const newSelectedGroupIds = new Set();

      newSelectedGroupIds.add(group.id);
      group.files.forEach(f => newSelectedFiles.add(f.id));

      setSelectedFiles(newSelectedFiles);
      setSelectedGroupIds(newSelectedGroupIds);
    }

    setLastSelectedIndex(index);
  };

  const handleSelectGroup = (group, checked) => {
    selectAllInGroup(group, checked);
    
    setSelectedGroupIds(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(group.id);
      } else {
        newSet.delete(group.id);
      }
      return newSet;
    });
  };

  // Optimized: use allSelected flag instead of building huge Sets
  const handleSelectAll = () => {
    selectAll(groups);
    setSelectedGroupIds(new Set()); // Clear - we use allSelected flag
  };

  // Select only the filtered groups (from search results)
  const handleSelectFiltered = (filteredGroups) => {
    if (!filteredGroups || filteredGroups.length === 0) return;

    // If filtered groups equals all groups, use allSelected flag
    if (filteredGroups.length === groups.length) {
      selectAll(groups);
      setSelectedGroupIds(new Set());
    } else {
      // Otherwise, select only the filtered group IDs
      clearSelection();
      setSelectedGroupIds(new Set(filteredGroups.map(g => g.id)));
    }
  };

  const handleClearSelection = () => {
    clearSelection();
    setSelectedGroupIds(new Set());
  };

  const handleEditMetadata = (group) => {
    modals.open('edit', { group });
  };

  const handleSaveMetadata = (newMetadata) => {
    const editGroup = modals.data.edit?.group;
    if (!editGroup) return;

    setGroups(prevGroups =>
      prevGroups.map(group => {
        if (group.id === editGroup.id) {
          const updatedFiles = (group.files || []).map(file => {
            const changes = {};

            const oldTitle = file.changes.title?.old || '';
            const oldAuthor = file.changes.author?.old || '';
            const oldNarrator = file.changes.narrator?.old || '';
            const oldGenre = file.changes.genre?.old || '';
            
            if (oldTitle !== newMetadata.title) {
              changes.title = { old: oldTitle, new: newMetadata.title };
            }
            
            if (oldAuthor !== newMetadata.author) {
              changes.author = { old: oldAuthor, new: newMetadata.author };
            }
            
            if (newMetadata.narrator) {
              const newNarratorValue = `Narrated by ${newMetadata.narrator}`;
              if (oldNarrator !== newNarratorValue) {
                changes.narrator = { old: oldNarrator, new: newNarratorValue };
              }
            }
            
            if (newMetadata.genres?.length > 0) {
              const newGenre = newMetadata.genres.join(', ');
              if (oldGenre !== newGenre) {
                changes.genre = { old: oldGenre, new: newGenre };
              }
            }
            
            if (newMetadata.series) {
              changes.series = { old: '', new: newMetadata.series };
            }
            
            if (newMetadata.sequence) {
              changes.sequence = { old: '', new: newMetadata.sequence };
            }
            
            if (newMetadata.year) {
              changes.year = { old: file.changes.year?.old || '', new: newMetadata.year };
            }
            
            if (newMetadata.publisher) {
              changes.publisher = { old: '', new: newMetadata.publisher };
            }
            
            if (newMetadata.description) {
              changes.description = { old: '', new: newMetadata.description };
            }
            
            return {
              ...file,
              changes,
              status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged'
            };
          });
          
          return {
            ...group,
            metadata: newMetadata,
            files: updatedFiles,
            total_changes: updatedFiles.filter(f => Object.keys(f.changes).length > 0).length
          };
        }
        return group;
      })
    );
  };

  // Get selected groups for bulk edit
  const getSelectedGroups = () => {
    if (allSelected) return groups;
    return groups.filter(g => selectedGroupIds.has(g.id));
  };

  // Handle bulk edit save
  const handleBulkSave = (updates) => {
    if (selectedGroupIds.size === 0 && !allSelected) return;

    setGroups(prevGroups =>
      prevGroups.map(group => {
        if (!allSelected && !selectedGroupIds.has(group.id)) return group;

        // Merge updates into metadata
        const newMetadata = {
          ...group.metadata,
          ...updates,
          // Mark source as manual for bulk edited fields
          sources: {
            ...group.metadata.sources,
            ...(updates.author && { author: 'manual' }),
            ...(updates.narrator && { narrator: 'manual' }),
            ...(updates.genres && { genres: 'manual' }),
            ...(updates.publisher && { publisher: 'manual' }),
            ...(updates.language && { language: 'manual' }),
            ...(updates.year && { year: 'manual' }),
            ...(updates.series && { series: 'manual' }),
          },
        };

        // Update file changes
        const updatedFiles = (group.files || []).map(file => {
          const changes = { ...file.changes };

          if (updates.author) {
            const oldAuthor = file.changes.author?.old || '';
            if (oldAuthor !== updates.author) {
              changes.author = { old: oldAuthor, new: updates.author };
            }
          }

          if (updates.narrator) {
            const oldNarrator = file.changes.narrator?.old || '';
            const newNarratorValue = `Narrated by ${updates.narrator}`;
            if (oldNarrator !== newNarratorValue) {
              changes.narrator = { old: oldNarrator, new: newNarratorValue };
            }
          }

          if (updates.genres) {
            const oldGenre = file.changes.genre?.old || '';
            const newGenre = updates.genres.join(', ');
            if (oldGenre !== newGenre) {
              changes.genre = { old: oldGenre, new: newGenre };
            }
          }

          if (updates.series !== undefined) {
            changes.series = { old: '', new: updates.series || '' };
          }

          if (updates.sequence) {
            changes.sequence = { old: '', new: updates.sequence };
          }

          if (updates.year) {
            changes.year = { old: file.changes.year?.old || '', new: updates.year };
          }

          if (updates.publisher) {
            changes.publisher = { old: '', new: updates.publisher };
          }

          return {
            ...file,
            changes,
            status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged'
          };
        });

        return {
          ...group,
          metadata: newMetadata,
          files: updatedFiles,
          total_changes: updatedFiles.filter(f => Object.keys(f.changes).length > 0).length
        };
      })
    );

  };

  // Handle import from CSV/JSON
  const handleDataImport = (updates) => {
    if (!updates || updates.length === 0) return;

    // If updates is an array of BookGroups (from JSON import)
    if (updates[0]?.files) {
      // Full JSON import - replace groups
      // For now just log - could merge or replace
      return;
    }

    // CSV import - update matched groups
    setGroups(prevGroups =>
      prevGroups.map(group => {
        const update = updates.find(u => u.group_id === group.id);
        if (!update) return group;

        const newMetadata = { ...group.metadata };
        const meta = update.metadata;

        if (meta.title) newMetadata.title = meta.title;
        if (meta.subtitle) newMetadata.subtitle = meta.subtitle;
        if (meta.author) newMetadata.author = meta.author;
        if (meta.narrator) newMetadata.narrator = meta.narrator;
        if (meta.series) newMetadata.series = meta.series;
        if (meta.sequence) newMetadata.sequence = meta.sequence;
        if (meta.genres) newMetadata.genres = meta.genres;
        if (meta.publisher) newMetadata.publisher = meta.publisher;
        if (meta.year) newMetadata.year = meta.year;
        if (meta.language) newMetadata.language = meta.language;
        if (meta.description) newMetadata.description = meta.description;
        if (meta.isbn) newMetadata.isbn = meta.isbn;
        if (meta.asin) newMetadata.asin = meta.asin;

        // Mark source as manual for imported fields
        newMetadata.sources = {
          ...newMetadata.sources,
          ...(meta.title && { title: 'manual' }),
          ...(meta.author && { author: 'manual' }),
          ...(meta.narrator && { narrator: 'manual' }),
          ...(meta.series && { series: 'manual' }),
          ...(meta.genres && { genres: 'manual' }),
          ...(meta.publisher && { publisher: 'manual' }),
          ...(meta.year && { year: 'manual' }),
        };

        // Update file changes
        const updatedFiles = (group.files || []).map(file => {
          const changes = { ...file.changes };

          if (meta.title && meta.title !== group.metadata.title) {
            changes.title = { old: group.metadata.title, new: meta.title };
          }
          if (meta.author && meta.author !== group.metadata.author) {
            changes.author = { old: group.metadata.author, new: meta.author };
          }

          return {
            ...file,
            changes,
            status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged'
          };
        });

        return {
          ...group,
          metadata: newMetadata,
          files: updatedFiles,
          total_changes: updatedFiles.filter(f => Object.keys(f.changes).length > 0).length
        };
      })
    );

  };

  // ✅ SIMPLIFIED - No popups, just write with toast feedback
  const handleWriteClick = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0 && !allSelected) {
      toast.warning('No Selection', 'Select files before writing.');
      return;
    }

    const filesWithChanges = getFilesWithChanges(groups);
    if (filesWithChanges.length === 0) {
      toast.info('No Changes', 'Selected books have no pending changes to write.');
      return;
    }

    try {
      const actualSelectedFiles = getSelectedFileIds(groups);
      const result = await writeSelectedTags(actualSelectedFiles, false); // false = no backup for speed

      if (result.success > 0) {
        toast.success('Write Complete', `Successfully wrote ${result.success} file${result.success > 1 ? 's' : ''}.`);
        handleClearSelection();
        // Check undo status after successful write
        await checkUndoStatus();
      }
      if (result.failed > 0) {
        toast.error('Write Errors', `Failed to write ${result.failed} file${result.failed > 1 ? 's' : ''}. Check console for details.`);
      }
    } catch (error) {
      console.error('Write failed:', error);
      toast.error('Write Failed', error.toString());
    }
  };

  // ✅ SIMPLIFIED - No popup
  const handleRenameClick = () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0 && !allSelected) return;
    modals.open('rename');
  };

  // ✅ Rescan with configurable mode and optional selective fields
  // @param {string} scanMode - 'normal', 'refresh_metadata', 'force_fresh', 'selective_refresh', 'super_scanner'
  // @param {Array} selectiveFields - Optional array of field names for selective refresh
  // @param {Object} options - Optional options like { enableTranscription: bool }
  const handleRescanClick = async (scanMode = 'force_fresh', selectiveFields = null, options = {}) => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) return;

    // Check if these are ABS imports (no local files)
    const absImports = selectedGroups.filter(g => (g.files?.length || 0) === 0);
    const localFiles = selectedGroups.filter(g => (g.files?.length || 0) > 0);

    try {
      const modeLabel = selectiveFields
        ? `selective refresh (${selectiveFields.join(', ')})`
        : scanMode === 'super_scanner'
          ? 'deep scan'
          : scanMode === 'normal'
            ? 'smart scan'
            : 'clean scan';

      // Handle ABS imports (no local files)
      if (absImports.length > 0) {
        // For ABS imports, use force_fresh mode which searches APIs
        // Pass selectiveFields to only update specific fields if custom rescan
        const result = await handleRescanAbsImports(absImports, 'force_fresh', false, selectiveFields);
      }

      // Handle local files (if any mixed in)
      if (localFiles.length > 0) {
        const transcriptionLabel = options.enableTranscription ? ' + audio verification' : '';
        const actualSelectedFiles = getSelectedFileIds(groups);
        const result = await handleRescan(actualSelectedFiles, groups, scanMode, selectiveFields, options);
      }

      handleClearSelection();
      clearFileStatuses();
    } catch (error) {
      console.error('Rescan failed:', error);
    }
  };

  // Bridge getters: read from batch operations hook (setters use batch.start/update/end)
  const cleaningGenres = batch.isActive('genres');
  const genreProgress = batch.getProgress('genres');

  // ✅ GPT-powered genre cleanup for selected books (with progress)
  const handleGenreCleanup = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0 && !allSelected) return;

    // Check if OpenAI key is configured
    if (!config?.openai_api_key) {
      // Fall back to static cleanup if no API key
      try {
        const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
        const result = await handleCleanupGenres(selectedGroups);
      } catch (error) {
        console.error('Genre cleanup failed:', error);
      }
      return;
    }

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('genres', { total: selectedGroups.length, cleaned: 0, unchanged: 0 });


    let cleanedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;

    // Process in batches of 25 for efficiency while still showing progress
    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('genres', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          genres: g.metadata?.genres || [],
          description: g.metadata?.description || null,
        }));

        const result = await callBackend('cleanup_genres_with_gpt', { books, config });

        // Update groups with cleaned genres
        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const genreResult = result.results.find(r => r.id === g.id);
              if (genreResult && genreResult.changed) {
                return {
                  ...g,
                  metadata: {
                    ...g.metadata,
                    genres: genreResult.cleaned_genres,
                  },
                  total_changes: (g.total_changes || 0) + 1,
                };
              }
              return g;
            });
          });

          cleanedCount += result.total_cleaned;
          unchangedCount += result.total_unchanged;
          failedCount += result.total_failed;
        }

        // Update progress after batch
        batch.update('genres', {
          current: Math.min(i + batchSize, selectedGroups.length),
          cleaned: cleanedCount,
          unchanged: unchangedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('genres', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }


    // Clear progress after a short delay
    batch.end('genres', 1500);
  };

  const assigningTags = batch.isActive('tags');
  const tagProgress = batch.getProgress('tags');
  const fixingDescriptions = batch.isActive('descriptions');
  const descProgress = batch.getProgress('descriptions');
  const fixingTitles = batch.isActive('titles');
  const titleProgress = batch.getProgress('titles');
  const fixingSubtitles = batch.isActive('subtitles');
  const subtitleProgress = batch.getProgress('subtitles');
  const fixingAuthors = batch.isActive('authors');
  const authorProgress = batch.getProgress('authors');
  const fixingYears = batch.isActive('years');
  const yearProgress = batch.getProgress('years');
  const fixingSeries = batch.isActive('series');
  const seriesProgress = batch.getProgress('series');
  const lookingUpAge = batch.isActive('age');
  const ageProgress = batch.getProgress('age');
  const lookingUpISBN = batch.isActive('isbn');
  const isbnProgress = batch.getProgress('isbn');
  const runningAll = batch.isActive('enrichment');
  const runAllProgress = batch.getProgress('enrichment');
  const generatingDna = batch.isActive('dna');
  const dnaProgress = batch.getProgress('dna');
  const forceFresh = batch.forceFresh;
  const dnaEnabled = batch.dnaEnabled;

  // ✅ GPT-powered title/author/subtitle fixing for selected books (NO series)
  const handleFixTitles = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('titles', { total: selectedGroups.length });


    let successCount = 0;
    let failedCount = 0;

    // Process in batches of 25 for efficiency
    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('titles', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      // Process batch in parallel
      const results = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            // Extract folder path from first file if available, or use source_path for ABS imports
            const folderPath = group.files?.[0]?.path?.split('/').slice(0, -1).join('/')
              || group.metadata?.source_path
              || null;

            const result = await callBackend('resolve_title', {
              request: {
                filename: group.files?.[0]?.filename || null,
                folder_name: group.group_name,
                folder_path: folderPath,
                current_title: group.metadata?.title || '',
                current_author: group.metadata?.author || '',
                current_series: group.metadata?.series || null,
                current_sequence: group.metadata?.sequence || null,
                additional_context: null
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`Failed to fix title for ${group.group_name}:`, err);
            return { groupId: group.id, error: err };
          }
        })
      );

      // Update groups with new title/author/subtitle ONLY (not series - use Fix Series for that)
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result.success && result.result) {
              const r = result.result;
              successCount++;

              // Log low confidence results with suggestions
              if (r.confidence < 70 && r.suggested_title) {
              }

              // If confidence is very low (< 50) and we have a suggestion, prefer the suggestion
              const useTitle = (r.confidence < 50 && r.suggested_title) ? r.suggested_title : r.title;
              const useAuthor = (r.confidence < 50 && r.suggested_author) ? r.suggested_author : (r.author || g.metadata.author);

              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  title: useTitle || g.metadata.title,
                  author: useAuthor || g.metadata.author,
                  subtitle: r.subtitle || g.metadata.subtitle,
                  // Store suggestions for UI display
                  title_suggestion: r.suggested_title || null,
                  author_suggestion: r.suggested_author || null,
                  suggestion_source: r.suggestion_source || null,
                  title_confidence: r.confidence,
                  // NOTE: series/sequence NOT updated here - use Fix Series button
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            } else {
              failedCount++;
            }
          }
          return g;
        });
      });

      // Update progress after batch
      batch.update('titles', {
        current: Math.min(i + batchSize, selectedGroups.length),
        success: successCount,
        failed: failedCount,
      });
    }

    batch.end('titles');
  };

  // ✅ Subtitle fixing via Audible + GPT for selected books
  const handleFixSubtitles = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('subtitles', { total: selectedGroups.length, fixed: 0, skipped: 0 });


    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // Process in batches of 10 (lower due to Audible rate limits)
    const batchSize = 10;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('subtitles', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          current_subtitle: g.metadata?.subtitle || null,
        }));

        const result = await callBackend('fix_subtitles_batch', { books, config, force: forceFresh });

        // Update groups with new subtitles
        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const subResult = result.results.find(r => r.id === g.id);
              if (!subResult || !subResult.fixed || !subResult.subtitle) return g;


              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  subtitle: subResult.subtitle,
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
        }

        // Update progress after batch
        batch.update('subtitles', {
          current: Math.min(i + batchSize, selectedGroups.length),
          fixed: fixedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('subtitles', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }


    // Clear progress after a short delay
    batch.end('subtitles', 1500);
  };

  // ✅ Author fixing via ABS + GPT for selected books
  const handleFixAuthors = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('authors', { total: selectedGroups.length, fixed: 0, skipped: 0 });


    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // Process in batches of 10
    const batchSize = 10;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('authors', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          current_author: g.metadata?.author || '',
        }));

        const result = await callBackend('fix_authors_batch', { books, config, force: forceFresh });

        // Update groups with new authors
        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const authResult = result.results.find(r => r.id === g.id);
              if (!authResult || !authResult.fixed || !authResult.author) return g;


              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  author: authResult.author,
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
        }

        // Update progress after batch
        batch.update('authors', {
          current: Math.min(i + batchSize, selectedGroups.length),
          fixed: fixedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('authors', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }


    // Clear progress after a short delay
    batch.end('authors', 1500);
  };

  // ✅ Year fixing (original publication year) via ABS + GPT for selected books
  const handleFixYears = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('years', { total: selectedGroups.length, fixed: 0, skipped: 0 });


    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // Process in batches of 50 (backend handles concurrency)
    const batchSize = 50;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('years', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => {
          // Pass pre-fetched year data from gather phase if available
          const gathered = gatheredDataRef.current?.get(g.id);
          return {
            id: g.id,
            title: g.metadata?.title || '',
            author: g.metadata?.author || '',
            current_year: g.metadata?.year || null,
            series: g.metadata?.series || null,
            description: g.metadata?.description || null,
            ol_year: gathered?.ol_year || null,
            ol_date: gathered?.ol_date || null,
            gb_year: gathered?.gb_year || null,
            gb_date: gathered?.gb_date || null,
            provider_year: gathered?.provider_year || null,
          };
        });

        const result = await callBackend('fix_years_batch', { books, config, force: forceFresh });

        // Update groups with new years and pub tags
        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const yearResult = result.results.find(r => r.id === g.id);
              if (!yearResult || !yearResult.year) return g;

              // Add pub_tag to tags if we have one (even for skipped - they have valid years)
              let newTags = g.metadata?.tags || [];
              if (yearResult.pub_tag) {
                // Remove any existing pub- tags first
                newTags = newTags.filter(t => !t.startsWith('pub-'));
                newTags.push(yearResult.pub_tag);
              }

              if (!yearResult.fixed) return {
                ...g,
                metadata: { ...g.metadata, tags: newTags },
              };


              const fields = new Set(g.changedFields || []);
              fields.add('year');
              if (yearResult.pub_tag) fields.add('tags');
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  year: yearResult.year,
                  tags: newTags,
                },
                total_changes: (g.total_changes || 0) + 1,
                changedFields: [...fields],
              };
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
        }

        // Update progress after batch
        batch.update('years', {
          current: Math.min(i + batchSize, selectedGroups.length),
          fixed: fixedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('years', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }


    // Clear progress after a short delay
    batch.end('years', 1500);
  };

  // ✅ Series fixing via Audible + GPT for selected books
  const handleFixSeries = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('series', { total: selectedGroups.length });


    let successCount = 0;
    let failedCount = 0;

    // Process in batches of 3 (series lookup is slower due to Audible API)
    const batchSize = 3;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('series', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      // Process batch in parallel
      const results = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            const result = await callBackend('resolve_series', {
              request: {
                title: group.metadata?.title || group.group_name,
                author: group.metadata?.author || '',
                current_series: group.metadata?.series || null,
                current_sequence: group.metadata?.sequence || null,
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`Failed to fix series for ${group.group_name}:`, err);
            return { groupId: group.id, error: err };
          }
        })
      );

      // Update groups with new series/sequence ONLY
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result.success && result.result) {
              const r = result.result;
              successCount++;
              const newSeries = r.series || g.metadata.series;
              const newSequence = r.sequence || g.metadata.sequence;
              // Update all_series array to keep UI in sync
              const newAllSeries = newSeries
                ? [{ name: newSeries, sequence: newSequence }, ...(g.metadata.all_series || []).filter(s => s.name !== newSeries).slice(0)]
                : g.metadata.all_series;
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  series: newSeries,
                  sequence: newSequence,
                  all_series: newAllSeries,
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            } else {
              failedCount++;
            }
          }
          return g;
        });
      });

      // Update progress after batch
      batch.update('series', {
        current: Math.min(i + batchSize, selectedGroups.length),
        success: successCount,
        failed: failedCount,
      });
    }

    batch.end('series');
  };

  // ✅ Age rating lookup via web search (Goodreads, etc.)
  const handleLookupAge = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('age', { total: selectedGroups.length });


    let successCount = 0;
    let failedCount = 0;

    // Process in batches of 2 (web search is slow)
    const batchSize = 2;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('age', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      // Process batch in parallel
      const results = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            const result = await callBackend('resolve_book_age_rating', {
              request: {
                title: group.metadata?.title || group.group_name,
                author: group.metadata?.author || '',
                series: group.metadata?.series || null,
                description: group.metadata?.description || null,
                genres: group.metadata?.genres || [],
                publisher: group.metadata?.publisher || null,
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`Age lookup failed for ${group.group_name}:`, err);
            return { groupId: group.id, result: { success: false, error: err.toString() } };
          }
        })
      );

      // Update groups with new age ratings
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result.success && result.age_category) {
              successCount++;
              let newGenres = [...(g.metadata?.genres || [])];
              const ageCategory = result.age_category;

              // Add age-specific genre if not Adult
              if (ageCategory && ageCategory !== 'Adult') {
                // Remove any existing age genres first
                newGenres = newGenres.filter(genre =>
                  !genre.startsWith("Children's") &&
                  genre !== "Teen 13-17" &&
                  genre !== "Young Adult" &&
                  genre !== "Middle Grade"
                );
                // Add the new age genre
                if (!newGenres.includes(ageCategory)) {
                  newGenres.splice(1, 0, ageCategory);
                }
              }

              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  genres: newGenres,
                  age_rating: ageCategory,
                  content_rating: result.content_rating,
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            } else {
              failedCount++;
            }
          }
          return g;
        });
      });

      // Update progress after batch
      batch.update('age', {
        current: Math.min(i + batchSize, selectedGroups.length),
        success: successCount,
        failed: failedCount,
      });
    }

    batch.end('age');
  };

  // ✅ ISBN/ASIN lookup for selected books
  const handleLookupISBN = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    batch.start('isbn', {});
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    // Smart skip: only look up books missing ISBN/ASIN unless forceFresh
    const needsIsbn = (g) => {
      const m = g.metadata || {};
      if (m.isbn && m.isbn.trim().length > 0) return false;
      if (m.asin && m.asin.trim().length > 0) return false;
      return true;
    };

    const booksToProcess = forceFresh ? selectedGroups : selectedGroups.filter(needsIsbn);
    const skippedIsbn = selectedGroups.length - booksToProcess.length;

    if (booksToProcess.length === 0) {
      toast.success('ISBN Lookup', 'All selected books already have ISBN/ASIN');
      batch.end('isbn');
      return;
    }

    batch.update('isbn', { total: booksToProcess.length });


    let successCount = 0;
    let failedCount = 0;

    // Process in batches of 3 (API calls are fast)
    const batchSize = 3;
    for (let i = 0; i < booksToProcess.length; i += batchSize) {
      const chunk = booksToProcess.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('isbn', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      // Process batch — use pre-fetched data from gather phase if available
      const results = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            // Check if gather phase already found ISBN/ASIN
            const gathered = gatheredDataRef.current?.get(group.id);
            if (gathered && (gathered.isbn || gathered.asin)) {
              return { groupId: group.id, result: { success: true, isbn: gathered.isbn, asin: gathered.asin, source: 'gather-phase' } };
            }
            const result = await callBackend('lookup_book_isbn', {
              request: {
                title: group.metadata?.title || group.group_name,
                author: group.metadata?.author || '',
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`ISBN lookup failed for ${group.group_name}:`, err);
            return { groupId: group.id, result: { success: false, error: err.toString() } };
          }
        })
      );

      // Update groups with ISBN/ASIN
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result.success && (result.isbn || result.asin)) {
              successCount++;
              const fields = new Set(g.changedFields || []);
              if (result.isbn) fields.add('isbn');
              if (result.asin) fields.add('asin');
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  isbn: result.isbn || g.metadata?.isbn,
                  asin: result.asin || g.metadata?.asin,
                },
                total_changes: (g.total_changes || 0) + 1,
                changedFields: [...fields],
              };
            } else {
              failedCount++;
            }
          }
          return g;
        });
      });

      // Update progress after batch
      batch.update('isbn', {
        current: Math.min(i + batchSize, booksToProcess.length),
        success: successCount,
        failed: failedCount,
      });
    }

    if (successCount > 0 || skippedIsbn > 0) {
      const parts = [];
      if (successCount > 0) parts.push(`${successCount} found`);
      if (skippedIsbn > 0) parts.push(`${skippedIsbn} already had ISBN`);
      if (failedCount > 0) parts.push(`${failedCount} not found`);
      toast.success('ISBN Lookup Complete', parts.join(', '));
    }
    batch.end('isbn');
  };

  // ✅ CALL A: METADATA RESOLUTION — title + subtitle + author + series in ONE GPT call per book
  const resolvingMetadata = batch.isActive('metadata');
  const metadataProgress = batch.getProgress('metadata');
  const handleMetadataResolution = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    // Smart skip: only process books with missing/suspect metadata unless forceFresh
    const needsMetadata = (g) => {
      const m = g.metadata || {};
      // Missing title or author
      if (!m.title || !m.author) return true;
      // Title looks like a filename (has extension or underscores)
      if (/\.\w{2,4}$/.test(m.title) || m.title.includes('_')) return true;
      // Author looks like a path or placeholder
      if (m.author.includes('/') || m.author.includes('\\') || m.author.toLowerCase() === 'unknown') return true;
      // Missing series when folder name suggests one (has number pattern)
      if (!m.series && /book\s*\d|vol/i.test(g.group_name || '')) return true;
      // No subtitle
      if (!m.subtitle) return true;
      return false;
    };

    const booksToProcess = forceFresh ? selectedGroups : selectedGroups.filter(needsMetadata);
    const skipped = selectedGroups.length - booksToProcess.length;

    if (booksToProcess.length === 0) {
      toast.success('Metadata Resolution', 'All selected books already have complete metadata');
      return;
    }

    batch.start('metadata', { total: booksToProcess.length, currentBook: 'Resolving metadata via ABS + GPT...' });

    const books = booksToProcess.map(g => {
      // Use pre-fetched ABS data from gather phase if available
      const gathered = gatheredDataRef.current?.get(g.id);
      return {
        id: g.id,
        filename: g.files?.[0]?.filename || null,
        folder_name: g.group_name || null,
        folder_path: g.files?.[0]?.path?.split('/').slice(0, -1).join('/') || g.metadata?.source_path || null,
        current_title: g.metadata?.title || '',
        current_author: g.metadata?.author || '',
        current_subtitle: g.metadata?.subtitle || null,
        current_series: g.metadata?.series || null,
        current_sequence: g.metadata?.sequence || null,
        audible_title: gathered?.abs_title || null,
        audible_author: gathered?.abs_author || null,
        audible_subtitle: gathered?.abs_subtitle || null,
        audible_series: gathered?.abs_series || null,
        audible_sequence: gathered?.abs_sequence || null,
      };
    });

    // Listen for per-book progress events
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'metadata') return;
      batch.update('metadata', {
        current: d.current,
        currentBook: d.title,
      });
    });

    try {
      const result = await callBackend('resolve_metadata_batch', { books, config });

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const r = result.results?.find(r => r.id === g.id);
          if (!r || r.error || !r.changed) return g;
          const fields = new Set(g.changedFields || []);
          if (r.title && r.title !== g.metadata.title) fields.add('title');
          if (r.author && r.author !== g.metadata.author) fields.add('author');
          if (r.subtitle && r.subtitle !== g.metadata.subtitle) fields.add('subtitle');
          if (r.series !== undefined && r.series !== g.metadata.series) fields.add('series');
          if (r.sequence !== undefined && r.sequence !== g.metadata.sequence) fields.add('sequence');
          if (r.narrator && r.narrator !== g.metadata.narrator) fields.add('narrator');
          return {
            ...g,
            metadata: {
              ...g.metadata,
              title: r.title || g.metadata.title,
              author: r.author || g.metadata.author,
              subtitle: r.subtitle || g.metadata.subtitle,
              series: r.series !== undefined ? r.series : g.metadata.series,
              sequence: r.sequence !== undefined ? r.sequence : g.metadata.sequence,
              narrator: r.narrator || g.metadata.narrator,
            },
            total_changes: (g.total_changes || 0) + 1,
            changedFields: [...fields],
          };
        });
      });

      unlisten();
      const processed = result.total_processed || 0;
      const failed = result.total_failed || 0;
      batch.update('metadata', { current: booksToProcess.length, success: processed, failed, currentBook: 'Complete' });
      if (processed > 0 || skipped > 0) {
        const parts = [];
        if (processed > 0) parts.push(`${processed} resolved`);
        if (skipped > 0) parts.push(`${skipped} already ok`);
        if (failed > 0) parts.push(`${failed} failed`);
        toast.success('Metadata Resolution Complete', parts.join(', '));
      }
    } catch (e) {
      unlisten();
      console.error('Metadata resolution error:', e);
      toast.error('Metadata Resolution Failed', e.toString());
    }
    batch.end('metadata', 2000);
  };

  // ✅ CALL C: DESCRIPTION PROCESSING — validate + clean/generate in ONE GPT call per book
  const processingDescriptions = batch.isActive('descriptionProcessing');
  const descriptionProgress = batch.getProgress('descriptionProcessing');
  const handleDescriptionProcessing = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    // Smart skip: only process books with missing/short/bad descriptions unless forceFresh
    const needsDescription = (g) => {
      const desc = g.metadata?.description;
      if (!desc) return true;
      if (desc.trim().length < 50) return true;
      // Looks like boilerplate/placeholder
      if (/^(no description|description not available|n\/a|none|unknown|tbd)/i.test(desc.trim())) return true;
      // Contains HTML tags (needs cleanup)
      if (/<[^>]+>/.test(desc)) return true;
      return false;
    };

    const booksToProcess = forceFresh ? selectedGroups : selectedGroups.filter(needsDescription);
    const skippedDesc = selectedGroups.length - booksToProcess.length;

    if (booksToProcess.length === 0) {
      toast.success('Description Processing', 'All selected books already have good descriptions');
      return;
    }

    batch.start('descriptionProcessing', { total: booksToProcess.length, currentBook: 'Processing descriptions...' });

    const books = booksToProcess.map(g => ({
      id: g.id,
      title: g.metadata?.title || '',
      author: g.metadata?.author || '',
      genres: g.metadata?.genres || [],
      description: g.metadata?.description || null,
    }));

    // Listen for per-book progress events
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'description') return;
      batch.update('descriptionProcessing', {
        current: d.current,
        currentBook: d.title,
      });
    });

    try {
      const result = await callBackend('process_descriptions_batch', { books, config });

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const r = result.results?.find(r => r.id === g.id);
          if (!r || r.error || !r.changed) return g;

          // Also try to extract narrator from the new description
          const narratorMatch = r.description?.match(/(?:read|narrated|voiced|performed)\s+by\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)/i);

          const fields = new Set(g.changedFields || []);
          fields.add('description');
          if (narratorMatch && !g.metadata.narrator) fields.add('narrator');

          return {
            ...g,
            metadata: {
              ...g.metadata,
              description: r.description,
              ...(narratorMatch && !g.metadata.narrator ? { narrator: narratorMatch[1] } : {}),
            },
            total_changes: (g.total_changes || 0) + 1,
            changedFields: [...fields],
          };
        });
      });

      const processed = result.total_processed || 0;
      const failed = result.total_failed || 0;
      unlisten();
      batch.update('descriptionProcessing', { current: booksToProcess.length, success: processed, failed, currentBook: 'Complete' });
      if (processed > 0 || skippedDesc > 0) {
        const parts = [];
        if (processed > 0) parts.push(`${processed} processed`);
        if (skippedDesc > 0) parts.push(`${skippedDesc} already ok`);
        if (failed > 0) parts.push(`${failed} failed`);
        toast.success('Description Processing Complete', parts.join(', '));
      }
    } catch (e) {
      unlisten();
      console.error('Description processing error:', e);
      toast.error('Description Processing Failed', e.toString());
    }
    batch.end('descriptionProcessing', 2000);
  };

  // ✅ RUN ALL - Sequential enrichment: title -> description -> tags -> age -> isbn -> dna
  // Ref to hold pre-fetched data from gather phase (used by handleRunAll)
  const gatheredDataRef = useRef(null);

  const handleRunAll = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    // Phase 1: Gather all external API data upfront
    const totalSteps = 6; // gather + 5 enrichment steps
    batch.start('enrichment', {
      total: totalSteps,
      currentBook: 'Step 1/6: Gathering external data (ABS, Goodreads, Open Library, Google Books)...',
    });


    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    try {
      const gatherBooks = selectedGroups.map(g => ({
        id: g.id,
        title: g.metadata?.title || g.group_name || '',
        author: g.metadata?.author || '',
      }));

      const gatherResult = await callBackend('gather_external_data', { books: gatherBooks, config });

      // Store gathered data in a Map keyed by book ID
      const dataMap = new Map();
      for (const item of (gatherResult.results || [])) {
        dataMap.set(item.id, item);
      }
      gatheredDataRef.current = dataMap;
    } catch (error) {
      console.error('❌ Phase 1 (gather) failed:', error);
      gatheredDataRef.current = null;
      // Continue anyway — individual steps will fall back to their own API calls
    }

    batch.update('enrichment', {
      current: 1,
      success: 1,
      currentBook: 'Finished gathering external data',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    // Phase 2: Run enrichment steps sequentially (GPT-heavy, using pre-fetched data)
    const steps = [
      { name: 'Metadata Resolution (title, subtitle, author, series)', fn: handleMetadataResolution },
      { name: 'ISBN/ASIN Lookup', fn: handleLookupISBN },
      { name: 'Publication Year', fn: handleFixYears },
      { name: 'Classification & Tagging (genres, tags, age, DNA)', fn: () => handleClassifyAll(false) },
      { name: 'Description Processing (validate, clean, generate)', fn: handleDescriptionProcessing },
    ];

    let successCount = 1; // gather phase counted as 1
    let failedCount = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 2; // offset by 1 for gather phase
      batch.update('enrichment', {
        current: stepNum - 1,
        currentBook: `Step ${stepNum}/${totalSteps}: ${step.name}`,
      });

      try {
        await step.fn();
        successCount++;
      } catch (error) {
        console.error(`❌ ${step.name} failed:`, error);
        failedCount++;
      }

      batch.update('enrichment', {
        current: stepNum,
        success: successCount,
        failed: failedCount,
        currentBook: stepNum < totalSteps ? `Finished ${step.name}` : 'Complete!',
      });

      if (i + 1 < steps.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Clear gathered data
    gatheredDataRef.current = null;


    batch.end('enrichment', 2000);
  };

  // ✅ GPT-powered tag assignment for selected books (with progress)
  const handleAssignTagsGpt = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('tags', { total: selectedGroups.length });


    let successCount = 0;
    let failedCount = 0;

    // Process in batches of 25 for efficiency while still showing progress
    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('tags', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          genres: g.metadata?.genres || [],
          description: g.metadata?.description || null,
          duration_minutes: g.metadata?.runtime_minutes || null,
        }));

        const result = await callBackend('assign_tags_with_gpt', { books, config, dnaEnabled });

        // Update groups with new tags
        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const tagResult = result.results.find(r => r.id === g.id);
              if (tagResult && tagResult.suggested_tags && tagResult.suggested_tags.length > 0) {
                return {
                  ...g,
                  metadata: {
                    ...g.metadata,
                    tags: tagResult.suggested_tags,
                  },
                  total_changes: (g.total_changes || 0) + 1,
                };
              }
              return g;
            });
          });

          successCount += result.total_success;
          failedCount += result.total_failed;
        }

        // Update progress after batch
        batch.update('tags', {
          current: Math.min(i + batchSize, selectedGroups.length),
          success: successCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('tags', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }


    // Now run age rating lookup for the same books and append age tags
    batch.update('tags', { currentBook: 'Looking up age ratings...' });

    // Process age ratings in smaller batches (API calls are slower)
    const ageBatchSize = 3;
    for (let i = 0; i < selectedGroups.length; i += ageBatchSize) {
      const chunk = selectedGroups.slice(i, i + ageBatchSize);

      batch.update('tags', { currentBook: `Age: ${chunk.map(g => g.metadata?.title || g.group_name).join(', ')}` });

      // Process batch in parallel
      const ageResults = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            const result = await callBackend('resolve_book_age_rating', {
              request: {
                title: group.metadata?.title || group.group_name,
                author: group.metadata?.author || '',
                series: group.metadata?.series || null,
                description: group.metadata?.description || null,
                genres: group.metadata?.genres || [],
                publisher: group.metadata?.publisher || null,
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`Age lookup failed for ${group.group_name}:`, err);
            return { groupId: group.id, result: { success: false } };
          }
        })
      );

      // Update groups with age tags
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const ageResult = ageResults.find(r =>
            r.status === 'fulfilled' && r.value.groupId === g.id
          );
          if (ageResult && ageResult.status === 'fulfilled') {
            const { result } = ageResult.value;
            if (result.success && result.age_tags && result.age_tags.length > 0) {
              // Merge age tags with existing tags (avoid duplicates)
              const existingTags = g.metadata?.tags || [];
              const newTags = [...existingTags];
              for (const tag of result.age_tags) {
                if (!newTags.includes(tag)) {
                  newTags.push(tag);
                }
              }
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  tags: newTags,
                  age_rating: result.age_category,
                  content_rating: result.content_rating,
                },
              };
            }
          }
          return g;
        });
      });
    }


    // Clear progress after a short delay
    batch.end('tags', 1500);
  };

  // ✅ BookDNA generation - creates structured fingerprint tags (dna:*)
  const handleGenerateDna = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('dna', { total: selectedGroups.length });


    // Build batch request
    const items = selectedGroups.map(g => ({
      id: g.id,
      title: g.metadata?.title || '',
      author: g.metadata?.author || '',
      description: g.metadata?.description || null,
      genres: g.metadata?.genres || [],
      tags: g.metadata?.tags || [],
      narrator: g.metadata?.narrator || null,
      duration_minutes: g.metadata?.runtime_minutes || null,
      series_name: g.metadata?.series || null,
      series_sequence: g.metadata?.sequence || null,
      year: g.metadata?.year || null,
    }));

    let dnaSuccessCount = 0;
    let dnaFailedCount = 0;

    try {
      // Listen for progress events
      const unlisten = subscribe('dna-progress', (data) => {
        const { current, total, id, title, success, error } = data;
        if (success) dnaSuccessCount++;
        else dnaFailedCount++;
        batch.update('dna', {
          current,
          total,
          success: dnaSuccessCount,
          failed: dnaFailedCount,
          currentBook: title,
        });

        if (error) {
          console.warn(`DNA generation failed for "${title}": ${error}`);
        }
      });

      // Call batch API
      const results = await callBackend('generate_book_dna_batch', {
        request: { items },
      });

      // Update groups with merged tags
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const result = results.find(r => r.id === g.id);
          if (result && result.success) {
            return {
              ...g,
              metadata: {
                ...g.metadata,
                tags: result.merged_tags,
              },
              total_changes: (g.total_changes || 0) + 1,
            };
          }
          return g;
        });
      });

      unlisten();

      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;

      // Show toast
      if (successCount > 0) {
        toast.success('BookDNA Generated', `Generated DNA fingerprints for ${successCount} book${successCount > 1 ? 's' : ''}`);
      }

    } catch (error) {
      console.error('BookDNA generation failed:', error);
      toast.error('DNA Generation Failed', error.toString());
    }

    // Clear progress after a short delay
    batch.end('dna', 1500);
  };

  // ✅ CONSOLIDATED CLASSIFY — replaces genres + tags + age + DNA + description in ONE GPT call per book
  const classifying = batch.isActive('classify');
  const classifyProgress = batch.getProgress('classify');

  const handleClassifyAll = async (includeDescription = true) => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    // Smart skip: only process books missing genres, tags, or age rating unless forceFresh
    const needsClassification = (g) => {
      const m = g.metadata || {};
      if (!m.genres || m.genres.length === 0) return true;
      if (!m.tags || m.tags.length === 0) return true;
      // No age-related tags
      const hasAgeTags = (m.tags || []).some(t => /^age-|^for-kids$|^for-teens$|^for-ya$|^not-for-kids$|^rated-/i.test(t));
      if (!hasAgeTags) return true;
      // No DNA tags
      const hasDnaTags = (m.tags || []).some(t => t.startsWith('dna:'));
      if (!hasDnaTags) return true;
      return false;
    };

    const booksToProcess = forceFresh ? selectedGroups : selectedGroups.filter(needsClassification);
    const skippedClassify = selectedGroups.length - booksToProcess.length;

    if (booksToProcess.length === 0) {
      toast.success('Classification', 'All selected books already classified');
      return;
    }

    // When Force is on, clear existing classification data so stale tags don't persist
    if (forceFresh) {
      const idsToProcess = new Set(booksToProcess.map(g => g.id));
      setGroups(prev => prev.map(g => {
        if (!idsToProcess.has(g.id)) return g;
        const m = { ...g.metadata };
        m.genres = [];
        m.tags = [];
        m.themes = [];
        m.tropes = [];
        return { ...g, metadata: m, changedFields: [] };
      }));
    }

    batch.start('classify', { total: booksToProcess.length, currentBook: 'Starting classification...' });


    const books = booksToProcess.map(g => ({
      id: g.id,
      title: g.metadata?.title || '',
      author: g.metadata?.author || '',
      description: g.metadata?.description || null,
      genres: g.metadata?.genres || [],
      tags: g.metadata?.tags || [],
      duration_minutes: g.metadata?.runtime_minutes || null,
      narrator: g.metadata?.narrator || null,
      series_name: g.metadata?.series || null,
      series_sequence: g.metadata?.sequence || null,
      year: g.metadata?.year || null,
      publisher: g.metadata?.publisher || null,
    }));

    // Listen for per-book progress events
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'classify') return;
      batch.update('classify', {
        current: d.current,
        currentBook: d.title,
      });
    });

    try {
      const result = await callBackend('classify_books_batch', {
        books,
        includeDescription,
        forceFresh: forceFresh,
        dnaEnabled,
        config,
      });

      // Update groups with all classification results
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const r = result.results?.find(r => r.id === g.id);
          if (!r || r.error) return g;

          const updatedMeta = { ...g.metadata };

          // Genres
          if (r.genres?.length > 0) updatedMeta.genres = r.genres;

          // Tags: merge classification tags + DNA tags + age tags (dedup)
          const allTags = new Set([
            ...(r.tags || []),
            ...(r.dna_tags || []),
            ...(r.age_tags || []),
          ]);
          updatedMeta.tags = [...allTags];

          // Themes & tropes
          if (r.themes?.length > 0) updatedMeta.themes = r.themes;
          if (r.tropes?.length > 0) updatedMeta.tropes = r.tropes;

          // Description (if changed)
          if (r.description && r.description_changed) {
            updatedMeta.description = r.description;
          }

          const fields = new Set(g.changedFields || []);
          if (r.genres?.length > 0) fields.add('genres');
          if (allTags.size > 0) fields.add('tags');
          if (r.themes?.length > 0) fields.add('themes');
          if (r.tropes?.length > 0) fields.add('tropes');
          if (r.description && r.description_changed) fields.add('description');
          if (r.age_category && r.age_category !== 'Unknown') fields.add('age');
          if (r.dna_tags?.length > 0) fields.add('dna');

          return {
            ...g,
            metadata: updatedMeta,
            total_changes: (g.total_changes || 0) + 1,
            changedFields: [...fields],
          };
        });
      });

      unlisten();
      const successCount = result.total_processed || 0;
      const failedCount = result.total_failed || 0;

      batch.update('classify', { current: booksToProcess.length, success: successCount, failed: failedCount, currentBook: 'Complete!' });

      if (successCount > 0 || skippedClassify > 0) {
        const cParts = [];
        if (successCount > 0) cParts.push(`${successCount} classified`);
        if (skippedClassify > 0) cParts.push(`${skippedClassify} already ok`);
        if (failedCount > 0) cParts.push(`${failedCount} failed`);
        toast.success('Classification Complete', cParts.join(', '));
      }

    } catch (error) {
      unlisten();
      console.error('Classification failed:', error);
      toast.error('Classification Failed', error.toString());
    }

    batch.end('classify', 1500);
  };

  // ✅ GPT-powered description fixing for selected books (with progress)
  const handleFixDescriptionsGpt = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('descriptions', { total: selectedGroups.length, fixed: 0, skipped: 0 });


    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // Process in batches of 25 for efficiency while still showing progress
    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('descriptions', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          genres: g.metadata?.genres || [],
          description: g.metadata?.description || null,
        }));

        const result = await callBackend('fix_descriptions_with_gpt', { books, config, force: forceFresh });

        // Update groups with new descriptions AND extracted narrators
        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const descResult = result.results.find(r => r.id === g.id);
              if (!descResult) return g;

              // Track changes
              let changes = 0;
              const updates = {};

              // Update description if fixed
              if (descResult.fixed && descResult.new_description) {
                updates.description = descResult.new_description;
                changes++;
              }

              // Always overwrite narrator if extracted from description
              if (descResult.extracted_narrator) {
                updates.narrator = descResult.extracted_narrator;
                // Also update narrators array (split by semicolon for multiple)
                updates.narrators = descResult.extracted_narrator.split(';').map(n => n.trim()).filter(Boolean);
                changes++;
              }

              // If no updates, return unchanged
              if (Object.keys(updates).length === 0) return g;

              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  ...updates,
                },
                total_changes: (g.total_changes || 0) + changes,
              };
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
        }

        // Update progress after batch
        batch.update('descriptions', {
          current: Math.min(i + batchSize, selectedGroups.length),
          fixed: fixedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('descriptions', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }


    // Clear progress after a short delay
    batch.end('descriptions', 1500);
  };

  // ✅ Fix a single issue on a single book
  const handleFixSingleIssue = useCallback((groupId, field, suggestedValue) => {
    setGroups(prevGroups => prevGroups.map(group => {
      if (group.id !== groupId) return group;

      const newMetadata = { ...group.metadata };

      // Apply the fix based on field
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
          if (typeof suggestedValue === 'string') {
            newMetadata.genres = suggestedValue.split(',').map(g => g.trim()).filter(Boolean);
          } else if (Array.isArray(suggestedValue)) {
            newMetadata.genres = suggestedValue;
          }
          break;
        default:
          if (field in newMetadata) {
            newMetadata[field] = suggestedValue;
          }
      }

      return {
        ...group,
        metadata: newMetadata,
        total_changes: (group.total_changes || 0) + 1,
      };
    }));

  }, [setGroups]);

  // ✅ Run author analysis and show review modal when complete
  const handleAuthorAnalysis = useCallback(async () => {
    await runAuthorAnalysis(groups);
    // Show modal after analysis completes
    modals.open('author');
  }, [groups, runAuthorAnalysis]);

  // ✅ Apply selected author normalizations from the review modal
  const handleApplyAuthorFixes = useCallback((fixes) => {
    if (!fixes || fixes.length === 0) return;

    setGroups(prevGroups => {
      const fixesByBook = fixes.reduce((map, fix) => {
        map[fix.bookId] = fix.canonicalAuthor;
        return map;
      }, {});

      return prevGroups.map(group => {
        const canonicalAuthor = fixesByBook[group.id];
        if (!canonicalAuthor) return group;

        return {
          ...group,
          metadata: {
            ...group.metadata,
            author: canonicalAuthor,
            authors: [canonicalAuthor, ...(group.metadata.authors || []).slice(1)],
            sources: {
              ...group.metadata.sources,
              author: 'normalized',
            },
          },
          total_changes: (group.total_changes || 0) + 1,
        };
      });
    });

    clearValidation();
  }, [setGroups, clearValidation]);

  // ✅ Run validation scan and show review modal when complete
  // Works with selection - validates only selected books, or all if none selected
  const handleScanErrors = useCallback(async () => {
    const groupsToValidate = selectedGroupIds.size > 0 || allSelected
      ? (allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id)))
      : groups; // Fall back to all groups if no selection
    await runValidation(groupsToValidate);
    // Show modal after validation completes
    modals.open('validation');
  }, [groups, runValidation, selectedGroupIds, allSelected]);

  // ✅ Apply selected validation fixes from the review modal
  const handleApplyValidationFixes = useCallback((fixes) => {
    if (!fixes || fixes.length === 0) return;

    setGroups(prevGroups => {
      const fixesByBook = fixes.reduce((map, fix) => {
        if (!map[fix.bookId]) map[fix.bookId] = [];
        map[fix.bookId].push(fix);
        return map;
      }, {});

      return prevGroups.map(group => {
        const bookFixes = fixesByBook[group.id];
        if (!bookFixes) return group;

        const newMetadata = { ...group.metadata };

        for (const fix of bookFixes) {
          switch (fix.field) {
            case 'author':
              newMetadata.author = fix.suggestedValue;
              newMetadata.authors = [fix.suggestedValue, ...(newMetadata.authors || []).slice(1)];
              break;
            case 'title':
              newMetadata.title = fix.suggestedValue;
              break;
            case 'series':
              newMetadata.series = fix.suggestedValue;
              if (newMetadata.all_series?.length > 0) {
                newMetadata.all_series = [{ ...newMetadata.all_series[0], name: fix.suggestedValue }, ...newMetadata.all_series.slice(1)];
              } else {
                newMetadata.all_series = [{ name: fix.suggestedValue, sequence: newMetadata.sequence }];
              }
              break;
            case 'sequence':
              newMetadata.sequence = fix.suggestedValue;
              if (newMetadata.all_series?.length > 0) {
                newMetadata.all_series = [{ ...newMetadata.all_series[0], sequence: fix.suggestedValue }, ...newMetadata.all_series.slice(1)];
              }
              break;
            case 'narrator':
              newMetadata.narrator = fix.suggestedValue;
              newMetadata.narrators = [fix.suggestedValue, ...(newMetadata.narrators || []).slice(1)];
              break;
            case 'description':
              newMetadata.description = fix.suggestedValue;
              break;
            case 'genres':
              if (typeof fix.suggestedValue === 'string') {
                newMetadata.genres = fix.suggestedValue.split(',').map(g => g.trim()).filter(Boolean);
              } else if (Array.isArray(fix.suggestedValue)) {
                newMetadata.genres = fix.suggestedValue;
              }
              break;
            default:
              if (fix.field in newMetadata) {
                newMetadata[fix.field] = fix.suggestedValue;
              }
          }
        }

        return {
          ...group,
          metadata: newMetadata,
          total_changes: (group.total_changes || 0) + bookFixes.length,
        };
      });
    });

    clearValidation();
  }, [setGroups, clearValidation]);

  // ✅ Run series analysis and show review modal when complete
  // Works with selection - analyzes only selected books, or all if none selected
  const handleSeriesAnalysis = useCallback(async () => {
    const groupsToAnalyze = selectedGroupIds.size > 0 || allSelected
      ? (allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id)))
      : groups; // Fall back to all groups if no selection
    await runSeriesAnalysis(groupsToAnalyze);
    // Show modal after analysis completes
    modals.open('series');
  }, [groups, runSeriesAnalysis, selectedGroupIds, allSelected]);

  // ✅ Apply selected series fixes from the review modal
  const handleApplySeriesFixes = useCallback(async (fixes) => {
    if (!fixes || fixes.length === 0) return;

    try {
      const updatedGroups = await applySeriesFixes(groups, fixes);
      setGroups(updatedGroups.updatedGroups);
      clearValidation();
    } catch (error) {
      console.error('Failed to apply series fixes:', error);
    }
  }, [groups, setGroups, applySeriesFixes, clearValidation]);

  // ✅ Cancel any running scan
  const handleCancelScan = useCallback(async () => {
    // Cancel scan hook's scan
    cancelScan();
    // Also cancel series scan in backend
    try {
      await callBackend('cancel_series_scan');
    } catch (e) {
      // Ignore if not running
    }
  }, [cancelScan]);

  // ✅ Count pending batch fixes and show confirmation modal
  const handleBatchFix = useCallback(() => {
    // Count validation fixes by issue type
    let validationFixCount = 0;
    const byType = {};
    let hasAuthorIssuesInValidation = false;
    let hasSeriesIssuesInValidation = false;

    if (Object.keys(validationResults).length > 0) {
      for (const validation of Object.values(validationResults)) {
        if (validation?.issues) {
          for (const issue of validation.issues) {
            // Only count fixable issues (with suggested_value)
            if (issue.suggested_value) {
              validationFixCount++;
              byType[issue.issue_type] = (byType[issue.issue_type] || 0) + 1;
            }
            // Track hints for author/series
            if (issue.issue_type === 'AuthorNeedsNormalization') hasAuthorIssuesInValidation = true;
            if (issue.issue_type === 'SeriesContainsNumber' ||
                issue.issue_type === 'TitleMatchesSeries' ||
                issue.issue_type === 'MissingSequence') hasSeriesIssuesInValidation = true;
          }
        }
      }
    }

    // Count author fixes
    let authorFixCount = 0;
    if (authorAnalysis?.needs_normalization) {
      for (const candidate of authorAnalysis.needs_normalization) {
        if (candidate.canonical) {
          const authorLower = candidate.name.toLowerCase();
          authorFixCount += groups.filter(g =>
            g.metadata?.author?.toLowerCase() === authorLower &&
            g.metadata?.author !== candidate.canonical
          ).length;
        }
      }
    }

    // Count series fixes
    const seriesFixCount = seriesAnalysis?.all_fixes?.length || 0;

    const totalFixes = validationFixCount + authorFixCount + seriesFixCount;

    if (totalFixes === 0) {
      toast.info('No Fixes Available', 'No suggested fixes found to apply.');
      return;
    }

    // Set validation breakdown by type
    modals.setBatchFixData({ validationByType: byType });

    // Pre-select all validation types
    const selectedTypes = {};
    Object.keys(byType).forEach(type => {
      selectedTypes[type] = true;
    });
    modals.setBatchFixData({ selectedValidationTypes: selectedTypes });

    modals.setBatchFixData({
      pending: {
        validation: validationFixCount,
        author: authorFixCount,
        series: seriesFixCount,
        hasAuthorIssuesInValidation,
        hasSeriesIssuesInValidation
      }
    });
    // Pre-select fix types that have fixes available
    modals.setBatchFixData({
      selectedTypes: {
        validation: validationFixCount > 0,
        author: authorFixCount > 0,
        series: seriesFixCount > 0
      }
    });
    modals.open('batchFix');
  }, [groups, validationResults, authorAnalysis, seriesAnalysis, toast]);

  // ✅ Actually apply batch fixes after confirmation (only selected types)
  const confirmBatchFix = useCallback(async () => {
    let currentGroups = groups;
    let totalFixes = 0;
    const appliedTypes = [];

    const bfData = modals.data.batchFix;

    // Apply validation fixes if selected (filtered by selected validation sub-types)
    if (bfData.selectedTypes.validation && bfData.pending.validation > 0) {
      // Check if any validation sub-types are selected
      const hasSubTypeSelection = Object.keys(bfData.validationByType).length > 0;
      const anySubTypeSelected = hasSubTypeSelection
        ? Object.values(bfData.selectedValidationTypes).some(v => v)
        : true;

      if (anySubTypeSelected) {
        // Pass selectedValidationTypes to filter which issue types to apply
        const validationResult = applyBatchFixes(
          currentGroups,
          hasSubTypeSelection ? bfData.selectedValidationTypes : null
        );
        currentGroups = validationResult.updatedGroups;
        totalFixes += validationResult.fixCount;
        if (validationResult.fixCount > 0) appliedTypes.push('validation');
      }
    }

    // Apply author normalizations if selected
    if (bfData.selectedTypes.author && bfData.pending.author > 0) {
      const authorResult = applyAuthorFixes(currentGroups);
      currentGroups = authorResult.updatedGroups;
      totalFixes += authorResult.fixCount;
      if (authorResult.fixCount > 0) appliedTypes.push('author');
    }

    // Apply series fixes if selected (async)
    if (bfData.selectedTypes.series && seriesAnalysis?.all_fixes?.length > 0) {
      const seriesResult = await applySeriesFixes(currentGroups, seriesAnalysis.all_fixes);
      currentGroups = seriesResult.updatedGroups;
      totalFixes += seriesResult.fixCount;
      if (seriesResult.fixCount > 0) appliedTypes.push('series');
    }

    if (totalFixes > 0) {
      setGroups(currentGroups);
      // Clear validation after applying fixes - user can re-scan to verify
      clearValidation();
      toast.success('Fixes Applied', `Applied ${totalFixes} ${appliedTypes.join(', ')} fix${totalFixes > 1 ? 'es' : ''}.`);
    } else {
      toast.info('No Changes', 'No fixes were applied.');
    }
  }, [groups, setGroups, applyBatchFixes, applyAuthorFixes, applySeriesFixes, seriesAnalysis, clearValidation, toast, modals.data.batchFix]);

  // Toggle fix type selection
  const toggleFixType = useCallback((type) => {
    modals.toggleFixType(type);
  }, [modals]);

  // Toggle validation sub-type selection
  const toggleValidationType = useCallback((issueType) => {
    modals.toggleValidationType(issueType);
  }, [modals]);

  // ✅ Pipeline rescan for ABS imports (new architecture)
  const handlePipelineClick = async () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    // Only process ABS imports (groups with no local files)
    const absImports = selectedGroups.filter(g => (g.files?.length || 0) === 0);

    if (absImports.length === 0) {
      return;
    }

    try {
      const result = await handlePipelineRescan(absImports);
      handleClearSelection();
    } catch (error) {
      console.error('Pipeline rescan failed:', error);
    }
  };

  // ✅ Check if selected books are ABS-imported (no local files)
  const getSelectedAbsImports = () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    return selectedGroups.filter(g => (g.files?.length || 0) === 0);
  };

  // ✅ Clean ALL genres for all loaded books (no selection needed)
  const handleCleanupAllGenres = async () => {
    if (groups.length === 0) return;

    try {
      // Check if these are ABS imports (no files)
      const absImports = groups.filter(g => (g.files?.length || 0) === 0);

      if (absImports.length > 0) {
        // Use ABS rescan for genre cleanup
        const result = await handleRescanAbsImports(absImports, 'genres_only');
      } else {
        // Use regular genre cleanup
        const result = await handleCleanupGenres(groups);
      }
    } catch (error) {
      console.error('Genre cleanup failed:', error);
    }
  };

  // ✅ Rescan ABS imports with fresh API data
  // options: { enrichWithCustomProviders: boolean }
  const handleAbsRescan = async (mode = 'force_fresh', options = {}) => {
    const absImports = getSelectedAbsImports();
    if (absImports.length === 0) return;

    try {
      const modeLabel = mode === 'genres_only' ? 'genre cleanup' : 'fresh scan';
      const enrichLabel = options.enrichWithCustomProviders ? ' + Goodreads/Hardcover' : '';
      const result = await handleRescanAbsImports(absImports, mode, false, null, options.enrichWithCustomProviders || false);
      handleClearSelection();
    } catch (error) {
      console.error('ABS rescan failed:', error);
    }
  };

  // ✅ Show push confirmation modal before pushing
  const handlePushClick = () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) {
      return;
    }
    modals.open('push', { groups: selectedGroups });
  };

  // ✅ Actually push after confirmation
  const handleConfirmPush = async () => {
    const pushGroups = modals.data.push?.groups || [];
    if (pushGroups.length === 0) return;

    // Check if these are ABS imports (no local files)
    const absImports = pushGroups.filter(g => (g.files?.length || 0) === 0);
    const localFiles = pushGroups.filter(g => (g.files?.length || 0) > 0);

    try {
      // Handle ABS imports - use direct ID-based push
      if (absImports.length > 0) {
        const result = await handlePushAbsImports(absImports);
      }

      // Handle local files - use path-based push
      if (localFiles.length > 0) {
        const actualSelectedFiles = getSelectedFileIds(groups);

        const result = await pushToAudiobookShelf(
          actualSelectedFiles,
          (progress) => {
          }
        );


        if (result.unmatched?.length > 0) {
        }
        if (result.failed?.length > 0) {
        }
      }
    } catch (error) {
      console.error('Push failed:', error);
    } finally {
      modals.close('push');
    }
  };

  return (
    <div className="h-full flex flex-col relative">
      {/* Action bars at the top */}
      <ActionBar
        logoSvg={logoSvg}
        activeTab={activeTab}
        navigateTo={navigateTo}
        selectedFiles={selectedFiles}
        allSelected={allSelected}
        groups={groups}
        fileStatuses={fileStatuses}
        selectedGroupCount={selectedGroupIds.size}
        totalBookCount={groups.length}
        onScan={handleScan}
        onRescan={handleRescanClick}
        onPipelineRescan={handlePipelineClick}
        onWrite={handleWriteClick}
        onRename={handleRenameClick}
        onPush={handlePushClick}
        onPull={handleImportFromAbs}
        onRefreshCache={refreshCache}
        onBulkEdit={() => modals.open('bulkEdit')}
        onBulkCover={() => modals.open('bulkCover')}
        onOpenRescanModal={() => modals.open('rescan')}
        onCleanupGenres={handleGenreCleanup}
        onAssignTagsGpt={handleAssignTagsGpt}
        onFixDescriptions={handleFixDescriptionsGpt}
        onFixTitles={handleFixTitles}
        onFixSubtitles={handleFixSubtitles}
        onFixAuthors={handleFixAuthors}
        onFixYears={handleFixYears}
        onFixSeries={handleFixSeries}
        onLookupAge={handleLookupAge}
        onLookupISBN={handleLookupISBN}
        onRunAll={handleRunAll}
        onGenerateDna={handleGenerateDna}
        onClassifyAll={handleClassifyAll}
        classifying={classifying}
        onMetadataResolution={handleMetadataResolution}
        resolvingMetadata={resolvingMetadata}
        onDescriptionProcessing={handleDescriptionProcessing}
        processingDescriptions={processingDescriptions}
        onClearSelection={handleClearSelection}
        onSelectAll={handleSelectAll}
        onScanErrors={handleScanErrors}
        onAuthorMatch={handleAuthorAnalysis}
        onSeriesAnalysis={handleSeriesAnalysis}
        onBatchFix={handleBatchFix}
        onNavigateToSettings={onNavigateToSettings}
        validationStats={validationStats}
        validating={validating}
        authorAnalysis={authorAnalysis}
        seriesAnalysis={seriesAnalysis}
        analyzingSeries={analyzingSeries}
        writing={writing}
        pushing={pushing}
        scanning={scanning}
        cleaningGenres={cleaningGenres}
        assigningTags={assigningTags}
        fixingDescriptions={fixingDescriptions}
        fixingTitles={fixingTitles}
        fixingSubtitles={fixingSubtitles}
        fixingAuthors={fixingAuthors}
        fixingYears={fixingYears}
        fixingSeries={fixingSeries}
        lookingUpAge={lookingUpAge}
        lookingUpISBN={lookingUpISBN}
        runningAll={runningAll}
        generatingDna={generatingDna}
        refreshingCache={refreshingCache}
        hasAbsConnection={!!(config?.abs_base_url && config?.abs_api_token)}
        hasOpenAiKey={!!(config?.openai_api_key || config?.anthropic_api_key || config?.use_local_ai)}
        useLocalAI={!!(config?.use_local_ai && config?.ollama_model)}
        aiModel={config?.ai_model}
        forceFresh={forceFresh}
        onToggleForceFresh={() => batch.toggleForceFresh()}
        dnaEnabled={dnaEnabled}
        onToggleDna={() => batch.toggleDna()}
      />

      {/* Main content area with book list and metadata panel */}
      <div className="flex-1 flex overflow-hidden bg-neutral-950">
        <BookList
          groups={groups}
          selectedFiles={selectedFiles}
          allSelected={allSelected}
          selectedGroup={selectedGroup}
          selectedGroupIds={selectedGroupIds}
          expandedGroups={expandedGroups}
          fileStatuses={fileStatuses}
          onGroupClick={setSelectedGroup}
          onToggleGroup={(groupId) => {
            const newExpanded = new Set(expandedGroups);
            newExpanded.has(groupId) ? newExpanded.delete(groupId) : newExpanded.add(groupId);
            setExpandedGroups(newExpanded);
          }}
          onSelectGroup={handleSelectGroup}
          onSelectFile={handleGroupClick}
          onScan={handleScan}
          onImport={handleImport}
          onImportFromAbs={handleImportFromAbs}
          onCleanupAllGenres={handleCleanupAllGenres}
          scanning={scanning}
          onSelectAll={handleSelectAll}
          onSelectFiltered={handleSelectFiltered}
          onClearSelection={handleClearSelection}
          onExport={() => modals.open('export')}
          validationResults={validationResults}
          hasAbsConnection={!!(config?.abs_base_url && config?.abs_api_token)}
          onNavigateToSettings={onNavigateToSettings}
        />

        <MetadataPanel
          group={selectedGroup}
          onEdit={handleEditMetadata}
          onInlineEdit={(groupId, field, value) => {
            setGroups(prev => prev.map(g => {
              if (g.id !== groupId) return g;
              return { ...g, metadata: { ...g.metadata, [field]: value } };
            }));
          }}
          validationData={selectedGroup ? validationResults[selectedGroup.id] : null}
          onFixIssue={handleFixSingleIssue}
        />
      </div>

      {/* Progress bars */}
      {scanning && (
        <ProgressBar
          key={scanProgress.startTime} 
          type="scan"
          progress={scanProgress}
          onCancel={cancelScan}
          calculateETA={calculateETA}
        />
      )}

      {writing && writeProgress.total > 0 && (
        <ProgressBar
          type="write"
          progress={writeProgress}
        />
      )}

      {assigningTags && tagProgress.total > 0 && (
        <ProgressBar
          type="tags"
          progress={tagProgress}
        />
      )}

      {fixingDescriptions && descProgress.total > 0 && (
        <ProgressBar
          type="descriptions"
          progress={descProgress}
        />
      )}

      {fixingTitles && titleProgress.total > 0 && (
        <ProgressBar
          type="titles"
          progress={titleProgress}
        />
      )}

      {fixingSubtitles && subtitleProgress.total > 0 && (
        <ProgressBar
          type="subtitles"
          progress={subtitleProgress}
        />
      )}

      {fixingAuthors && authorProgress.total > 0 && (
        <ProgressBar
          type="authors"
          progress={authorProgress}
        />
      )}

      {fixingYears && yearProgress.total > 0 && (
        <ProgressBar
          type="years"
          progress={yearProgress}
        />
      )}

      {fixingSeries && seriesProgress.total > 0 && (
        <ProgressBar
          type="series"
          progress={seriesProgress}
        />
      )}

      {lookingUpAge && ageProgress.total > 0 && (
        <ProgressBar
          type="age"
          progress={ageProgress}
        />
      )}

      {lookingUpISBN && isbnProgress.total > 0 && (
        <ProgressBar
          type="isbn"
          progress={isbnProgress}
        />
      )}

      {runningAll && runAllProgress.total > 0 && (
        <ProgressBar
          type="enrichment"
          progress={runAllProgress}
        />
      )}

      {generatingDna && dnaProgress.total > 0 && (
        <ProgressBar
          type="dna"
          progress={dnaProgress}
        />
      )}

      {cleaningGenres && genreProgress.total > 0 && (
        <ProgressBar
          type="genres"
          progress={genreProgress}
        />
      )}

      {resolvingMetadata && metadataProgress.total > 0 && (
        <ProgressBar
          type="metadata"
          progress={metadataProgress}
        />
      )}

      {classifying && classifyProgress.total > 0 && (
        <ProgressBar
          type="classify"
          progress={classifyProgress}
        />
      )}

      {processingDescriptions && descriptionProgress.total > 0 && (
        <ProgressBar
          type="descriptionProcessing"
          progress={descriptionProgress}
        />
      )}

      {/* Modals */}
      {modals.isOpen('edit') && modals.data.edit?.group && (
        <EditMetadataModal
          isOpen={modals.isOpen('edit')}
          onClose={() => modals.close('edit')}
          onSave={handleSaveMetadata}
          metadata={modals.data.edit.group.metadata}
          groupName={modals.data.edit.group.group_name}
          folderPath={modals.data.edit.group.files?.[0]?.path?.split('/').slice(0, -1).join('/') || modals.data.edit.group.metadata?.source_path || ''}
        />
      )}

      {modals.isOpen('bulkEdit') && (selectedGroupIds.size > 0 || allSelected) && (
        <BulkEditModal
          isOpen={modals.isOpen('bulkEdit')}
          onClose={() => modals.close('bulkEdit')}
          onSave={handleBulkSave}
          selectedGroups={getSelectedGroups()}
        />
      )}

      {modals.isOpen('export') && (
        <ExportImportModal
          isOpen={modals.isOpen('export')}
          onClose={() => modals.close('export')}
          groups={groups}
          onImport={handleDataImport}
        />
      )}

      {modals.isOpen('rename') && (
        <RenamePreviewModal
          selectedFiles={(() => {
            const fileIds = getSelectedFileIds(groups);
            return Array.from(fileIds).map(id => {
              for (const group of groups) {
                const file = group.files.find(f => f.id === id);
                if (file) return file.path;
              }
              return null;
            }).filter(Boolean);
          })()}
          metadata={selectedGroup?.metadata}
          onConfirm={async () => {
            try {
              const actualSelectedFiles = getSelectedFileIds(groups);
              await renameFiles(actualSelectedFiles);
              modals.close('rename');
              await handleScan();
            } catch (error) {
              console.error('Rename failed:', error);
            }
          }}
          onCancel={() => modals.close('rename')}
        />
      )}

      {modals.isOpen('rescan') && (
        <RescanModal
          isOpen={modals.isOpen('rescan')}
          onClose={() => modals.close('rescan')}
          onRescan={handleRescanClick}
          selectedCount={allSelected ? groups.reduce((sum, g) => sum + (g.files?.length || 0), 0) : selectedFiles.size}
          scanning={scanning}
        />
      )}

      {/* ABS Push Confirmation Modal */}
      <ABSPushModal
        isOpen={modals.isOpen('push')}
        onClose={() => modals.close('push')}
        onConfirm={handleConfirmPush}
        groups={modals.data.push?.groups || []}
        pushing={pushing}
      />

      {/* Bulk Cover Assignment Modal */}
      {modals.isOpen('bulkCover') && (selectedGroupIds.size > 0 || allSelected) && (
        <BulkCoverAssignment
          isOpen={modals.isOpen('bulkCover')}
          onClose={() => modals.close('bulkCover')}
          selectedGroups={getSelectedGroups()}
          onCoversAssigned={(count) => {
            // Trigger refresh of cover cache
            setGroups([...groups]);
          }}
        />
      )}

      {/* Series Issue Review Modal */}
      {modals.isOpen('series') && seriesAnalysis && (
        <SeriesIssueModal
          isOpen={modals.isOpen('series')}
          onClose={() => modals.close('series')}
          seriesAnalysis={seriesAnalysis}
          onApplyFixes={handleApplySeriesFixes}
          groups={groups}
        />
      )}

      {/* Validation Issue Review Modal */}
      {modals.isOpen('validation') && (
        <ValidationIssueModal
          isOpen={modals.isOpen('validation')}
          onClose={() => modals.close('validation')}
          validationResults={validationResults}
          selectedBooks={selectedFiles}
          groups={groups}
          onApplyFixes={handleApplyValidationFixes}
        />
      )}

      {/* Author Analysis Modal */}
      {modals.isOpen('author') && authorAnalysis && (
        <AuthorAnalysisModal
          isOpen={modals.isOpen('author')}
          onClose={() => modals.close('author')}
          authorAnalysis={authorAnalysis}
          groups={groups}
          onApplyFixes={handleApplyAuthorFixes}
        />
      )}

      {/* Batch Fix Selection Modal */}
      <BatchFixModal
        isOpen={modals.isOpen('batchFix')}
        onClose={() => modals.close('batchFix')}
        onConfirm={confirmBatchFix}
        pendingFixes={modals.data.batchFix.pending}
        selectedTypes={modals.data.batchFix.selectedTypes}
        onToggleType={toggleFixType}
        validationByType={modals.data.batchFix.validationByType}
        selectedValidationTypes={modals.data.batchFix.selectedValidationTypes}
        onToggleValidationType={toggleValidationType}
        hasAuthorIssuesInValidation={modals.data.batchFix.pending.hasAuthorIssuesInValidation}
        hasSeriesIssuesInValidation={modals.data.batchFix.pending.hasSeriesIssuesInValidation}
      />

      {/* Undo Toast */}
      {showUndoToast && undoStatus?.available && (
        <UndoToast
          booksCount={undoStatus.books_count}
          ageSeconds={undoStatus.age_seconds}
          onUndo={handleUndo}
          onDismiss={dismissUndo}
          undoing={undoing}
        />
      )}
    </div>
  );
}