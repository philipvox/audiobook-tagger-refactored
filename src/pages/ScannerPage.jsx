import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
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
import { RestoreSessionToast } from '../components/RestoreSessionToast';
import { SeriesIssueModal } from '../components/SeriesIssueModal';
import { ValidationIssueModal } from '../components/ValidationIssueModal';
import { AuthorAnalysisModal } from '../components/AuthorAnalysisModal';
import { BatchFixModal } from '../components/BatchFixModal';
import { useToast } from '../components/Toast';
import { useScan } from '../hooks/useScan';
import { useFileSelection } from '../hooks/useFileSelection';
import { useTagOperations } from '../hooks/useTagOperations';
import { useBatchOperations } from '../hooks/useBatchOperations';
import { useModals } from '../hooks/useModals';
import { useApp } from '../context/AppContext';
import { severityForKind } from '../lib/errorDetail';
import { summarizeBatch, scrollToFirstErrorGroup } from '../lib/batchToast';
import { logEvent, logBatchStart, logBatchEnd } from '../lib/logEvent';
import { mergeClassifyTags } from '../lib/mergeClassifyTags';
import { mergeGenres } from '../lib/mergeGenres';
import { applyMetadataToGroup, readFileField } from '../lib/applyMetadata';
import { listFingerprint } from '../lib/selectionFingerprint';
import { isPlaceholderAuthor, isPlaceholderTitle } from '../lib/normalize';
import { WritePreviewModal } from '../components/WritePreviewModal';
import { ConfirmModal } from '../components/ConfirmModal';

export function ScannerPage({ onNavigateToSettings, activeTab, navigateTo, logoSvg }) {
  const {
    config, groups, setGroups, fileStatuses, updateFileStatuses, clearFileStatuses, writeProgress,
    validationResults, validationStats, validating, runValidation, runAuthorAnalysis, authorAnalysis,
    applyBatchFixes, applyAuthorFixes, clearValidation,
    seriesAnalysis, analyzingSeries, runSeriesAnalysis, applySeriesFixes,
    savedSession, sessionRestorePending, sessionUnreadable, restoreSession, discardSession,
    keepCurrentWorkspace, autosaveWarning, acknowledgeAutosaveWarning
  } = useApp();
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  // H2: staged full-library JSON import awaiting user confirmation (replacing
  // the current in-memory groups is destructive, so it goes through a warning).
  const [pendingImport, setPendingImport] = useState(null);
  // M9: bump to invalidate cached covers after a cover assignment. `ids` are the
  // affected group ids (cleared from BookList's coverCache); `nonce` also
  // re-triggers MetadataPanel's cover load for the open book.
  const [coverRefresh, setCoverRefresh] = useState({ nonce: 0, ids: [] });

  // H3 (Run All stale groups): keep a live ref to `groups` so Run All's
  // sequential enrichment steps read each prior step's merged results instead
  // of the stale closure snapshot captured at render time.
  const groupsRef = useRef(groups);
  useEffect(() => { groupsRef.current = groups; }, [groups]);

  // M13: fingerprint of the list the shift-click anchor (lastSelectedIndex) was
  // taken against, so a stale anchor from a since-changed/filtered list degrades
  // to a plain click instead of selecting the wrong range.
  const lastSelectionFingerprintRef = useRef(null);

  // M2: true only while Run All is orchestrating. Standalone flows check this
  // before nulling the shared gatheredDataRef so they don't wipe the gather
  // hints out from under a later Run All step (ISBN/years reuse them).
  const runAllActiveRef = useRef(false);

  // Consolidated modal and batch operation state
  const modals = useModals();
  const batch = useBatchOperations({ dnaEnabledDefault: !config?.local_skip_dna });

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

    // Capture the affected file paths before we clear undoStatus.
    const affectedPaths = undoStatus.files || undoStatus.paths || undoStatus.affected_paths || [];

    setUndoing(true);
    try {
      const result = await callBackend('undo_last_write');

      // M7: a stub/no-op or an explicit failure must surface an error toast,
      // not silently swallow (the old code only ever no-op'd on success).
      const failed = !result || result._stub || result.success === false || result.error;
      if (failed) {
        const msg = result?.error || result?.message || 'Could not revert the last tag write.';
        toast.error('Undo Failed', String(msg));
        return;
      }

      setShowUndoToast(false);
      setUndoStatus(null);

      // M5: revert the UI for the undone files. A cheap re-read (read_tags /
      // rescan) is not wired here, so per the brief we take the "no cheap path"
      // branch: mark the affected groups 'undone' so the user knows the on
      // screen tags may be stale, clear the stale write-status pills, and tell
      // them via toast to rescan.
      const paths = result.restored_files || result.files || affectedPaths || [];
      const pathSet = new Set(paths);
      if (pathSet.size > 0) {
        setGroups(prev => prev.map(g => {
          const touched = (g.files || []).some(f => pathSet.has(f.path));
          return touched ? { ...g, status: 'undone' } : g;
        }));
      }
      // The write-status overlay reflected the write we just reverted, so it is
      // no longer accurate for any file - clear it.
      clearFileStatuses();

      toast.success('Changes Reverted', 'Restored the files from the last write. Rescan to refresh the on-screen tags.');
    } catch (error) {
      console.error('Undo failed:', error);
      toast.error('Undo Failed', String(error?.message || error));
    } finally {
      setUndoing(false);
    }
  }, [undoStatus, undoing, toast, setGroups, clearFileStatuses]);

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

  // #58 restore prompt. Restore drops the saved work back into the workspace;
  // Discard is the only path that deletes a snapshot the user has not replaced,
  // so it is a deliberate click, never a dismissal or a timeout.
  const [sessionBusy, setSessionBusy] = useState(false);
  // Staged restore awaiting confirmation, because the workspace already holds
  // books. Same shape as pendingImport: replacing loaded books is destructive.
  const [pendingRestore, setPendingRestore] = useState(null);

  const finishRestore = useCallback((result) => {
    if (!result?.restored) return;
    setSelectedGroup(null);
    setSelectedGroupIds(new Set());
    logEvent('session', 'restored previous session', { books: result.count });
    if (result.count > 0) {
      toast.success(
        'Session Restored',
        `Brought back ${result.count} book${result.count === 1 ? '' : 's'} from your last session.`
      );
    }
  }, [toast]);

  const handleRestoreSession = useCallback(() => {
    const result = restoreSession();
    // The prompt has no dismiss, so the user can scan or import while it is
    // still open. Restoring on top of that would throw the new work away with
    // no snapshot to recover from, so it goes through a confirmation first.
    if (!result.restored && result.reason === 'workspace-not-empty') {
      setPendingRestore(result);
      return;
    }
    finishRestore(result);
  }, [restoreSession, finishRestore]);

  const confirmRestoreSession = useCallback(() => {
    const result = restoreSession({ force: true });
    setPendingRestore(null);
    finishRestore(result);
  }, [restoreSession, finishRestore]);

  // "Keep current books": the declined snapshot moves to the second slot and
  // autosave resumes, so the user is neither stranded unprotected nor loses
  // the previous session.
  const handleKeepCurrentBooks = useCallback(async () => {
    setPendingRestore(null);
    setSessionBusy(true);
    try {
      await keepCurrentWorkspace();
      logEvent('session', 'kept current books, previous session moved to the second slot');
      toast.info(
        'Keeping Current Books',
        'Autosave resumed. Your previous session was kept as a backup copy in the app data folder.'
      );
    } finally {
      setSessionBusy(false);
    }
  }, [keepCurrentWorkspace, toast]);

  // One-time warning when autosave has failed repeatedly. Consumed here so the
  // context can re-arm it for a later failure streak.
  useEffect(() => {
    if (!autosaveWarning) return;
    toast.warning(
      'Autosave Is Failing',
      `Session autosave is failing: ${autosaveWarning.reason}. Your work will not be restored after a crash.`
    );
    acknowledgeAutosaveWarning();
  }, [autosaveWarning, acknowledgeAutosaveWarning, toast]);

  const handleDiscardSession = useCallback(async () => {
    setSessionBusy(true);
    try {
      const discarded = savedSession?.bookCount ?? 0;
      await discardSession();
      logEvent('session', 'discarded saved session', { books: discarded });
      toast.info('Session Discarded', 'The saved session was deleted.');
    } finally {
      setSessionBusy(false);
    }
  }, [discardSession, savedSession, toast]);

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

    // M13: the stored anchor index only points at the right row if the list it
    // was taken against is unchanged. If the fingerprint differs (filter applied/
    // cleared, list reordered), fall through to a plain click below.
    const currentFingerprint = listFingerprint(groupsToUse);
    const anchorValid = lastSelectedIndex !== null
      && lastSelectionFingerprintRef.current === currentFingerprint;

    if (event.shiftKey && anchorValid) {
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
    lastSelectionFingerprintRef.current = currentFingerprint;
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
      // Otherwise, select only the filtered group IDs AND their file ids.
      // H4: without the file ids, getSelectedFileIds returns an empty set and
      // Write / Rename / Rescan silently do nothing on a filtered selection.
      clearSelection();
      const fileIds = new Set();
      filteredGroups.forEach(g =>
        (g.files || []).forEach(f => { if (f.id != null) fileIds.add(f.id); })
      );
      setSelectedFiles(fileIds);
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

  // M12: rebuild diffs from the group's ACTUAL current metadata (old =
  // group.metadata[field], not a stale file.changes.old), include cleared
  // fields (old set, new ''), map every modal field into file.changes, and
  // PRESERVE unrelated staged changes (merge via applyMetadataToGroup rather
  // than rebuilding file.changes from scratch).
  const EDIT_MODAL_FILE_FIELDS = [
    'title', 'subtitle', 'author', 'narrator', 'genre', 'series', 'sequence',
    'year', 'publisher', 'description', 'isbn', 'asin', 'language',
    'age_rating', 'abridged', 'runtime',
  ];

  const handleSaveMetadata = (newMetadata) => {
    const editGroup = modals.data.edit?.group;
    if (!editGroup) return;

    setGroups(prevGroups =>
      prevGroups.map(group => {
        if (group.id !== editGroup.id) return group;
        // A field is "changed" when its file-facing (tag-vocabulary) value
        // differs from the current metadata. readFileField normalizes both
        // sides (genres->genre join, narrator prefix) so the comparison and the
        // stamped diff use the same vocabulary. Cleared fields (new === '')
        // differ from a set old and are included automatically.
        const changedFileFields = EDIT_MODAL_FILE_FIELDS.filter(
          f => readFileField(newMetadata, f) !== readFileField(group.metadata, f)
        );
        return applyMetadataToGroup(group, newMetadata, changedFileFields);
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
          // Mark source as manual for bulk edited fields. H1: use key presence
          // (not truthiness) so an intentional clear (present null) still marks
          // the field manual rather than being ignored.
          sources: {
            ...group.metadata.sources,
            ...('author' in updates && { author: 'manual' }),
            ...('narrator' in updates && { narrator: 'manual' }),
            ...('genres' in updates && { genres: 'manual' }),
            ...('publisher' in updates && { publisher: 'manual' }),
            ...('language' in updates && { language: 'manual' }),
            ...('year' in updates && { year: 'manual' }),
            ...('series' in updates && { series: 'manual' }),
          },
        };

        // Update file changes. H1: an update KEY being present drives the change
        // (a present null == intentional clear -> stamp an empty new value);
        // absent keys are left untouched.
        const updatedFiles = (group.files || []).map(file => {
          const changes = { ...file.changes };

          if ('author' in updates) {
            const oldAuthor = file.changes.author?.old || '';
            const newAuthor = updates.author || '';
            if (oldAuthor !== newAuthor) {
              changes.author = { old: oldAuthor, new: newAuthor };
            }
          }

          if ('narrator' in updates) {
            const oldNarrator = file.changes.narrator?.old || '';
            const newNarratorValue = updates.narrator ? `Narrated by ${updates.narrator}` : '';
            if (oldNarrator !== newNarratorValue) {
              changes.narrator = { old: oldNarrator, new: newNarratorValue };
            }
          }

          if ('genres' in updates) {
            const oldGenre = file.changes.genre?.old || '';
            const newGenre = (updates.genres || []).join(', ');
            if (oldGenre !== newGenre) {
              changes.genre = { old: oldGenre, new: newGenre };
            }
          }

          if ('series' in updates) {
            changes.series = { old: '', new: updates.series || '' };
          }

          if ('sequence' in updates) {
            changes.sequence = { old: '', new: updates.sequence || '' };
          }

          if ('year' in updates) {
            changes.year = { old: file.changes.year?.old || '', new: updates.year || '' };
          }

          if ('publisher' in updates) {
            changes.publisher = { old: '', new: updates.publisher || '' };
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

    // H2: a full JSON import is an array of BookGroups (each has `files`).
    // Replacing the current in-memory groups is destructive, so stage it and
    // ask for confirmation instead of applying (or silently dropping) it.
    if (updates[0]?.files) {
      setPendingImport(updates);
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

  // H2: apply a staged full JSON import, replacing all groups. Normalize the
  // imported groups defensively so downstream (selection, write) never crashes:
  // every group needs an id, every file an id and a `changes` object.
  const applyPendingImport = () => {
    if (!pendingImport) return;
    const normalized = pendingImport.map((group, gi) => {
      const groupId = group.id ?? `import-${gi}`;
      const files = (group.files || []).map((file, fi) => ({
        ...file,
        id: file.id ?? `${groupId}-f${fi}`,
        changes: file.changes ?? {},
      }));
      return { ...group, id: groupId, files };
    });
    setGroups(normalized);
    setSelectedGroup(null);
    setSelectedGroupIds(new Set());
    setPendingImport(null);
    toast.success('Library Imported', `Replaced the workspace with ${normalized.length} imported book${normalized.length === 1 ? '' : 's'}.`);
  };

  // H3: open the Write Tags preview modal. The user reviews the exact per-file
  // changes, can exclude individual rows, and chooses backup (ON by default)
  // before anything is written. Snapshot the selected file ids at open so the
  // write targets what was selected when the modal opened.
  const handleWriteClick = () => {
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

    const fileIds = Array.from(getSelectedFileIds(groups));
    modals.open('write', { fileIds });
  };

  // H3: actually write after the preview is confirmed. `skipBackup` and
  // `excludedChanges` come from the modal; the payload equals exactly what the
  // preview showed minus the excluded rows.
  const handleConfirmWrite = async (skipBackup, excludedChanges) => {
    const fileIds = modals.data.write?.fileIds || [];
    if (fileIds.length === 0) return;

    try {
      const result = await writeSelectedTags(new Set(fileIds), {
        backup: !skipBackup,
        excludedChanges,
      });

      if (result.success > 0) {
        toast.success('Write Complete', `Successfully wrote ${result.success} file${result.success > 1 ? 's' : ''}.`);

        // Post-write staging: clear the file.changes entries that were actually
        // written so the same edits are not re-offered on the next write (and undo
        // journals are not overwritten by a no-op re-write). Only files reported
        // `success` are cleared; excluded `fileId:field` pairs stay staged, and
        // group.metadata / changedFields are left intact (they drive the ABS push).
        const excluded = excludedChanges instanceof Set ? excludedChanges : new Set();
        const writtenFileIds = new Set(
          (result.results || [])
            .filter(r => r.status === 'success' && r.file_id != null)
            .map(r => r.file_id)
        );
        if (writtenFileIds.size > 0) {
          setGroups(prev => prev.map(g => {
            if (!(g.files || []).some(f => writtenFileIds.has(f.id))) return g;
            return {
              ...g,
              files: g.files.map(f => {
                if (!writtenFileIds.has(f.id) || !f.changes) return f;
                const kept = {};
                for (const [field, change] of Object.entries(f.changes)) {
                  // A field the user unchecked in the preview was NOT written, so
                  // it stays staged; everything else was written and is cleared.
                  if (excluded.has(`${f.id}:${field}`)) kept[field] = change;
                }
                return { ...f, changes: kept };
              }),
            };
          }));
        }

        handleClearSelection();
        // Check undo status after successful write
        await checkUndoStatus();
      }
      if (result.failed > 0) {
        toast.error('Write Errors', `Failed to write ${result.failed} file${result.failed > 1 ? 's' : ''}. Check console for details.`);
      }
      // Close the honesty loop: warn (not error) when the backend could not embed
      // some requested fields (format-unsupported or ABS-only) in one or more files.
      const skippedCount = (result.results || []).filter(
        r => Array.isArray(r.skipped_fields) && r.skipped_fields.length > 0
      ).length;
      if (skippedCount > 0) {
        toast.warning(
          'Some Fields Not Written',
          `Some fields are not supported by this file format and were not written (${skippedCount} file${skippedCount === 1 ? '' : 's'} affected).`
        );
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
        // M1: honor the user-chosen scan mode (was hardcoded 'force_fresh',
        // which ignored smart/selective/deep choices from the Rescan modal).
        // Pass selectiveFields to only update specific fields if custom rescan.
        const result = await handleRescanAbsImports(absImports, scanMode, false, selectiveFields);
      }

      // Handle local files (if any mixed in)
      if (localFiles.length > 0) {
        const transcriptionLabel = options.enableTranscription ? ' + audio verification' : '';
        const actualSelectedFiles = getSelectedFileIds(groups);
        const result = await handleRescan(actualSelectedFiles, groups, scanMode, selectiveFields, options);
        // CR-1: handleRescan now returns { success: false, error } instead of
        // throwing when the scan itself failed, surface that to the user.
        if (result && result.success === false && result.error) {
          toast.error('Rescan Failed', result.error);
        }
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
    logBatchStart('genres', selectedGroups.length);


    let cleanedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;

    // Listen for per-book progress events within each chunk
    let chunkOffset = 0;
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'genres') return;
      batch.update('genres', { current: chunkOffset + d.current, currentBook: d.title });
    });

    // Process in batches of 25 for efficiency while still showing progress
    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      chunkOffset = i;

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
                // H2/H6: stamp the cleaned genres into file.changes (genre field).
                return applyMetadataToGroup(g, { genres: genreResult.cleaned_genres }, ['genre']);
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

    unlisten();
    logBatchEnd('genres', {
      books: selectedGroups.length,
      cleaned: cleanedCount,
      unchanged: unchangedCount,
      failed: failedCount,
    });

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
    logBatchStart('titles', selectedGroups.length);


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

      // M3: compute success/failure counts from the results array BEFORE
      // setGroups. Counting inside the updater double-counts under React
      // StrictMode (updaters run twice) and races the async state commit.
      for (const res of results) {
        const v = res.status === 'fulfilled' ? res.value : null;
        if (v && v.result && v.result.success && v.result.result) successCount++;
        else failedCount++;
      }

      // Update groups with new title/author/subtitle ONLY (not series - use Fix Series for that)
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (!batchResult) return g;
          const { result, error } = batchResult.value;
          // CR-2: the rejected/error branch returns { groupId, error } with no
          // `result`. Guard before touching result.* so one failed lookup can
          // never throw inside the updater and crash the whole batch. Surface
          // the failure as a per-book error pill instead.
          if (!result) {
            const message = error?.message ? String(error.message) : 'Title lookup failed';
            return { ...g, lastError: { stage: 'resolve', kind: 'network', message, severity: 'error' } };
          }
          if (result.success && result.result) {
            const r = result.result;

            // If confidence is very low (< 50) and we have a suggestion, prefer the suggestion
            const useTitle = (r.confidence < 50 && r.suggested_title) ? r.suggested_title : r.title;
            const useAuthor = (r.confidence < 50 && r.suggested_author) ? r.suggested_author : (r.author || g.metadata.author);

            const newTitle = useTitle || g.metadata.title;
            const newAuthor = useAuthor || g.metadata.author;
            const newSubtitle = r.subtitle || g.metadata.subtitle;
            // H2/H6: stamp title/author/subtitle into file.changes. Only stamp a
            // field that actually changed so we don't create no-op diffs.
            const changedFields = [];
            if (newTitle !== g.metadata.title) changedFields.push('title');
            if (newAuthor !== g.metadata.author) changedFields.push('author');
            if (newSubtitle !== g.metadata.subtitle) changedFields.push('subtitle');
            return applyMetadataToGroup(
              g,
              {
                title: newTitle,
                author: newAuthor,
                subtitle: newSubtitle,
                // Store suggestions for UI display (not stamped as changes)
                title_suggestion: r.suggested_title || null,
                author_suggestion: r.suggested_author || null,
                suggestion_source: r.suggestion_source || null,
                title_confidence: r.confidence,
                // NOTE: series/sequence NOT updated here - use Fix Series button
              },
              changedFields
            );
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

    logBatchEnd('titles', {
      books: selectedGroups.length,
      succeeded: successCount,
      failed: failedCount,
    });
    batch.end('titles');
  };

  // ✅ Subtitle fixing via Audible + GPT for selected books
  const handleFixSubtitles = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('subtitles', { total: selectedGroups.length, fixed: 0, skipped: 0 });
    logBatchStart('subtitles', selectedGroups.length);


    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // Listen for per-book progress events within each chunk
    let subtitleChunkOffset = 0;
    const unlistenSubtitles = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'subtitles') return;
      batch.update('subtitles', { current: subtitleChunkOffset + d.current, currentBook: d.title });
    });

    // Process in batches of 10 (lower due to Audible rate limits)
    const batchSize = 10;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      subtitleChunkOffset = i;

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

              // H2/H6: stamp the subtitle change into file.changes.
              return applyMetadataToGroup(g, { subtitle: subResult.subtitle }, ['subtitle']);
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

    unlistenSubtitles();
    logBatchEnd('subtitles', {
      books: selectedGroups.length,
      fixed: fixedCount,
      skipped: skippedCount,
      failed: failedCount,
    });

    // Clear progress after a short delay
    batch.end('subtitles', 1500);
  };

  // ✅ Author fixing via ABS + GPT for selected books
  const handleFixAuthors = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('authors', { total: selectedGroups.length, fixed: 0, skipped: 0 });
    logBatchStart('authors', selectedGroups.length);


    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    // M14: accumulate per-book results across chunks so the "Show details"
    // toast action can scroll to the first errored book from FRESH data,
    // instead of reading a stale `groups` closure that predates setGroups.
    const authorErrorResults = [];

    // Listen for per-book progress events within each chunk
    let authorChunkOffset = 0;
    const unlistenAuthors = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'authors') return;
      batch.update('authors', { current: authorChunkOffset + d.current, currentBook: d.title });
    });

    // Process in batches of 10
    const batchSize = 10;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      authorChunkOffset = i;

      // Update progress with current batch
      batch.update('authors', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          current_author: g.metadata?.author || '',
          subtitle: g.metadata?.subtitle || null,
          series: g.metadata?.series || null,
          narrator: g.metadata?.narrator || null,
          publisher: g.metadata?.publisher || null,
          year: g.metadata?.published_year || g.metadata?.year || null,
          isbn: g.metadata?.isbn || null,
          asin: g.metadata?.asin || null,
          description: g.metadata?.description || null,
        }));

        const result = await callBackend('fix_authors_batch', { books, config, force: forceFresh });

        // Update groups with new authors (and route errorDetail to lastError
        // so ai-empty / hard failures render an amber/red pill per commit 8).
        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const authResult = result.results.find(r => r.id === g.id);
              if (!authResult) return g;
              const lastError = authResult.errorDetail
                ? { ...authResult.errorDetail, severity: severityForKind(authResult.errorDetail.kind) }
                : undefined;
              if (!authResult.fixed || !authResult.author) {
                return lastError ? { ...g, lastError } : g;
              }
              // H2/H6: stamp the author change into file.changes so Write Tags
              // actually writes it (not just group.metadata).
              const next = applyMetadataToGroup(g, { author: authResult.author }, ['author']);
              return { ...next, lastError }; // undefined clears; preserved if the AI errored (unlikely on a fixed path, but safe)
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
          authorErrorResults.push(...(result.results || []));
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

    unlistenAuthors();

    // Per D4, Fix Authors stays toast-silent on all-success. summarizeBatch
    // returns null for {0,0,0,0}, and for {fixed=N, skipped=M, 0 failed, 0
    // warnings} we skip the success toast too, progress bar already showed
    // counts. Only surface V2/V3 when there's something to flag.
    const authorWarnings = 0; // fix_authors_batch ai-empty is failed, not warn (commit 8 normalization)
    if (failedCount > 0 || authorWarnings > 0) {
      const summary = summarizeBatch({ op: 'authors', succeeded: fixedCount, skipped: skippedCount, warnings: authorWarnings, failed: failedCount });
      if (summary) {
        const opts = { action: { label: 'Show details', onClick: () => scrollToFirstErrorGroup(authorErrorResults, summary.hasFailures ? 'error' : 'warn') } };
        toast[summary.type](summary.title, summary.message, opts);
      }
    }

    // Logged unconditionally, unlike the toast: an all-success run is exactly
    // what you want to see in the log when reconstructing what a crashed
    // session had already finished.
    logBatchEnd(
      'authors',
      { books: selectedGroups.length, fixed: fixedCount, skipped: skippedCount, failed: failedCount },
      authorErrorResults
    );

    // Clear progress after a short delay
    batch.end('authors', 1500);
  };

  // ✅ Year fixing (original publication year) via ABS + GPT for selected books
  const handleFixYears = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    // H3: read live groups so a Run All chain sees prior steps' merges.
    const currentGroups = groupsRef.current;
    const selectedGroups = allSelected ? currentGroups : currentGroups.filter(g => selectedGroupIds.has(g.id));
    batch.start('years', { total: selectedGroups.length, fixed: 0, skipped: 0 });
    logBatchStart('years', selectedGroups.length);


    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    // M14: accumulate per-book results across chunks for the fresh-data
    // "Show details" scroll (see Fix Authors above).
    const yearErrorResults = [];

    // Listen for per-book progress events within each chunk
    let yearChunkOffset = 0;
    const unlistenYears = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'years') return;
      batch.update('years', { current: yearChunkOffset + d.current, currentBook: d.title });
    });

    // Process in batches of 50 (backend handles concurrency)
    const batchSize = 50;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      yearChunkOffset = i;

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

        // Update groups with new years and pub tags (and route errorDetail to
        // lastError for invalid-year / hard-failure cases per commit 9).
        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const yearResult = result.results.find(r => r.id === g.id);
              if (!yearResult) return g;
              const lastError = yearResult.errorDetail
                ? { ...yearResult.errorDetail, severity: severityForKind(yearResult.errorDetail.kind) }
                : undefined;
              if (!yearResult.year) {
                return lastError ? { ...g, lastError } : g;
              }

              // Add pub_tag to tags if we have one (even for skipped - they have valid years)
              let newTags = g.metadata?.tags || [];
              if (yearResult.pub_tag) {
                // Remove any existing pub- tags first
                newTags = newTags.filter(t => !t.startsWith('pub-'));
                newTags.push(yearResult.pub_tag);
              }

              // Skipped (year already valid) but we still stamped a pub- tag:
              // M8 - record that as a real change so it counts toward the diff
              // and shows as a changed field, otherwise the new tag never gets
              // written on Write Tags.
              if (!yearResult.fixed) {
                if (yearResult.pub_tag) {
                  // H2/H6/M8: pub- tag stamped even though the year was already
                  // valid, so it still gets written on Write Tags.
                  return applyMetadataToGroup(g, { tags: newTags }, ['tags']);
                }
                return { ...g, metadata: { ...g.metadata, tags: newTags } };
              }

              // H2/H6: stamp the resolved year (and any pub- tag) into file.changes.
              const changedFileFields = ['year'];
              if (yearResult.pub_tag) changedFileFields.push('tags');
              return applyMetadataToGroup(g, { year: yearResult.year, tags: newTags }, changedFileFields);
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
          yearErrorResults.push(...(result.results || []));
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

    unlistenYears();

    // Per D4, toast-silent on all-success (progress bar suffices). Surface V2/V3
    // only when there's something to flag. fix_years_batch emits kind='schema'
    // for invalid-year, which maps to severity=error, so these are failures,
    // not warnings.
    if (failedCount > 0) {
      const summary = summarizeBatch({ op: 'years', succeeded: fixedCount, skipped: skippedCount, warnings: 0, failed: failedCount });
      if (summary) {
        const opts = { action: { label: 'Show details', onClick: () => scrollToFirstErrorGroup(yearErrorResults, 'error') } };
        toast[summary.type](summary.title, summary.message, opts);
      }
    }

    logBatchEnd(
      'years',
      { books: selectedGroups.length, fixed: fixedCount, skipped: skippedCount, failed: failedCount },
      yearErrorResults
    );

    // M2: this flow read gather hints from gatheredDataRef; clear them when
    // running standalone so a later unrelated flow doesn't reuse stale data.
    // Guarded so a Run All step never nulls the shared ref mid-sequence.
    if (!runAllActiveRef.current) gatheredDataRef.current = null;

    // Clear progress after a short delay
    batch.end('years', 1500);
  };

  // ✅ Check by Audio - extract metadata from audio intros via Whisper
  const extractingByAudio = batch.isActive('audio_check');
  const handleExtractByAudio = async (field = 'all') => {
    const fieldLabels = { all: 'All Fields', narrator: 'Narrator', author: 'Author', title: 'Title', publisher: 'Publisher', language: 'Language' };
    const label = fieldLabels[field] || field;

    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    // Smart skip: only process books missing the requested field (unless forceFresh)
    const needsProcessing = forceFresh ? selectedGroups : selectedGroups.filter(g => {
      const m = g.metadata || {};
      // Placeholder values (e.g. ABS's "Unknown" fallback for unmatched books)
      // count as missing, not present - issue #57: a literal "Unknown" author
      // was silently skipping books that actually needed audio extraction.
      if (field === 'narrator') return isPlaceholderAuthor(m.narrator) && (!m.narrators || m.narrators.length === 0 || m.narrators.every(isPlaceholderAuthor));
      if (field === 'author') return isPlaceholderAuthor(m.author);
      if (field === 'title') return isPlaceholderTitle(m.title);
      if (field === 'publisher') return !m.publisher;
      if (field === 'language') return !m.language;
      // 'all': process if missing any of these
      return isPlaceholderAuthor(m.narrator) || isPlaceholderAuthor(m.author) || !m.publisher || !m.language;
    });

    if (needsProcessing.length === 0) {
      toast.success(`Check ${label}`, `All selected books already have ${label.toLowerCase()}`);
      return;
    }

    batch.start('audio_check', { total: needsProcessing.length });
    logBatchStart('audio_check', needsProcessing.length);

    const items = needsProcessing.map(g => ({
      item_id: g.id || g.group_name,
      source: g.id ? 'abs' : 'local',
      title: g.metadata?.title || null,
      author: g.metadata?.author || null,
      file_ino: g.files?.[0]?.ino || null,
      file_path: g.files?.[0]?.path || null,
      abs_base_url: config?.abs_base_url || null,
      abs_api_token: config?.abs_api_token || null,
      openai_api_key: config?.openai_api_key || null,
      use_local_ai: config?.use_local_ai || false,
      ollama_model: config?.ollama_model || null,
      ollama_base_url: config?.ollama_base_url || null,
      use_local_whisper: config?.use_local_whisper || false,
      whisper_model: config?.whisper_model || 'base',
    }));

    // Listen for Tauri progress events with stage tracking
    let tauriUnlisten = null;
    try {
      if (typeof window.__TAURI__ !== 'undefined') {
        const { listen } = await import('@tauri-apps/api/event');
        tauriUnlisten = await listen('audio_intro_progress', (event) => {
          const { current, total, status, stage, found, cached } = event.payload;
          const stageLabels = { downloading: 'Downloading', extracting: 'FFmpeg', transcribing: 'Whisper', parsing: 'Parsing', cached: 'Cached' };
          const stageText = stageLabels[stage] || stage || '';
          batch.update('audio_check', {
            current,
            success: found || 0,
            currentBook: `[${stageText}] ${status}`,
          });
        });
      }
    } catch (e) { /* not in Tauri */ }

    try {
      const results = await callBackend('batch_extract_audio_intros', { items, force: forceFresh });

      const resultMap = new Map(results.map(r => [r.item_id, r]));
      let updatedCount = 0;

      setGroups(prevGroups => prevGroups.map(g => {
        const key = g.id || g.group_name;
        const result = resultMap.get(key);
        if (!result) return g;

        // Build merge object based on requested field
        const merge = {};
        const shouldMerge = (f, value) => value && (forceFresh || !g.metadata?.[f]);

        if ((field === 'all' || field === 'narrator') && result.narrators.length > 0) {
          if (forceFresh || !g.metadata?.narrator) {
            merge.narrators = result.narrators;
            merge.narrator = result.narrators[0];
          }
        }
        if ((field === 'all' || field === 'author') && result.authors.length > 0) {
          if (forceFresh || !g.metadata?.author) {
            merge.author = result.authors[0];
          }
        }
        if ((field === 'all' || field === 'title') && result.title) {
          if (forceFresh || !g.metadata?.title || g.metadata?.title === 'Untitled') {
            merge.title = result.title;
          }
          if (result.subtitle && (forceFresh || !g.metadata?.subtitle)) {
            merge.subtitle = result.subtitle;
          }
        }
        if (field === 'all' || field === 'publisher') {
          const pub = result.publisher || result.audio_publisher;
          if (pub && (forceFresh || !g.metadata?.publisher)) {
            merge.publisher = pub;
          }
        }
        // Language from Whisper detection
        if ((field === 'all' || field === 'language') && result.language) {
          if (forceFresh || !g.metadata?.language) {
            merge.language = result.language;
          }
        }

        if (Object.keys(merge).length === 0) return g;
        updatedCount++;

        return {
          ...g,
          metadata: { ...g.metadata, ...merge },
          total_changes: (g.total_changes || 0) + 1,
        };
      }));

      logBatchEnd('audio_check', { books: needsProcessing.length, field, updated: updatedCount });
      toast.success(`Check ${label}`, `Updated ${updatedCount} of ${needsProcessing.length} books from audio`);
    } catch (error) {
      logEvent('batch', 'audio_check aborted', { error: String(error?.message || error) });
      toast.error(`Check ${label}`, String(error));
    } finally {
      if (tauriUnlisten) tauriUnlisten();
      batch.end('audio_check', 1500);
    }
  };

  // ✅ Series fixing via Audible + GPT for selected books
  const handleFixSeries = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('series', { total: selectedGroups.length });
    logBatchStart('series', selectedGroups.length);


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

      // M3: compute counts from the results array before the updater (avoids
      // StrictMode double-count and the async-commit race).
      for (const res of results) {
        const v = res.status === 'fulfilled' ? res.value : null;
        if (v && v.result && v.result.success && v.result.result) successCount++;
        else failedCount++;
      }

      // Update groups with new series/sequence ONLY
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (!batchResult) return g;
          const { result, error } = batchResult.value;
          // CR-2: rejected/error branch has no `result`. Guard before use so a
          // single failed lookup can't throw inside the updater. Surface the
          // failure as a per-book error pill.
          if (!result) {
            const message = error?.message ? String(error.message) : 'Series lookup failed';
            return { ...g, lastError: { stage: 'resolve', kind: 'network', message, severity: 'error' } };
          }
          if (result.success && result.result) {
            const r = result.result;
            const newSeries = r.series || g.metadata.series;
            const newSequence = r.sequence || g.metadata.sequence;
            // Update all_series array to keep UI in sync
            const newAllSeries = newSeries
              ? [{ name: newSeries, sequence: newSequence }, ...(g.metadata.all_series || []).filter(s => s.name !== newSeries).slice(0)]
              : g.metadata.all_series;
            // H2/H6: stamp series/sequence into file.changes (only what changed).
            const changedFileFields = [];
            if (newSeries !== g.metadata.series) changedFileFields.push('series');
            if (newSequence !== g.metadata.sequence) changedFileFields.push('sequence');
            return applyMetadataToGroup(
              g,
              { series: newSeries, sequence: newSequence, all_series: newAllSeries },
              changedFileFields
            );
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

    logBatchEnd('series', {
      books: selectedGroups.length,
      succeeded: successCount,
      failed: failedCount,
    });
    batch.end('series');
  };

  // ✅ Age rating lookup via web search (Goodreads, etc.)
  const handleLookupAge = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('age', { total: selectedGroups.length });
    logBatchStart('age', selectedGroups.length);


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

      // M3: compute counts from the results array before the updater.
      for (const res of results) {
        const v = res.status === 'fulfilled' ? res.value : null;
        if (v && v.result && v.result.success && v.result.age_category) successCount++;
        else failedCount++;
      }

      // Update groups with new age ratings
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result && result.success && result.age_category) {
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

    logBatchEnd('age', {
      books: selectedGroups.length,
      succeeded: successCount,
      failed: failedCount,
    });
    batch.end('age');
  };

  // ✅ ISBN/ASIN lookup for selected books
  const handleLookupISBN = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    batch.start('isbn', {});
    // H3: read live groups so a Run All chain sees prior steps' merges.
    const currentGroups = groupsRef.current;
    const selectedGroups = allSelected ? currentGroups : currentGroups.filter(g => selectedGroupIds.has(g.id));

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
    logBatchStart('isbn', booksToProcess.length);


    let successCount = 0;
    let failedCount = 0;

    // Process in batches of 3 (API calls are fast)
    const batchSize = 3;
    for (let i = 0; i < booksToProcess.length; i += batchSize) {
      const chunk = booksToProcess.slice(i, i + batchSize);

      // Update progress with current batch
      batch.update('isbn', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      // Process batch, use pre-fetched data from gather phase if available
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

      // M3: compute counts from the results array before the updater.
      for (const res of results) {
        const v = res.status === 'fulfilled' ? res.value : null;
        if (v && v.result && v.result.success && (v.result.isbn || v.result.asin)) successCount++;
        else failedCount++;
      }

      // Update groups with ISBN/ASIN
      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result && result.success && (result.isbn || result.asin)) {
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

    logBatchEnd('isbn', {
      books: booksToProcess.length,
      found: successCount,
      skipped: skippedIsbn,
      notFound: failedCount,
    });

    // M2: ISBN lookup reads gather hints from gatheredDataRef; clear them when
    // standalone. Guarded so a Run All step never nulls the shared ref.
    if (!runAllActiveRef.current) gatheredDataRef.current = null;

    batch.end('isbn');
  };

  // ✅ CALL A: METADATA RESOLUTION, title + subtitle + author + series in ONE GPT call per book
  const resolvingMetadata = batch.isActive('metadata');
  const metadataProgress = batch.getProgress('metadata');
  const handleMetadataResolution = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;
    // H3: read the LIVE groups (via ref) so that when Run All chains this step
    // after an earlier one, we build payloads from the prior step's merged
    // metadata, not a stale render snapshot. Standalone use is unaffected
    // (groupsRef stays in sync with groups at rest).
    const currentGroups = groupsRef.current;
    const selectedGroups = allSelected ? currentGroups : currentGroups.filter(g => selectedGroupIds.has(g.id));

    // Smart skip: only process books with missing/suspect metadata unless forceFresh
    const needsMetadata = (g) => {
      const m = g.metadata || {};
      // Missing title or author
      if (!m.title || !m.author) return true;
      // Title looks like a filename (has extension or underscores)
      if (/\.\w{2,4}$/.test(m.title) || m.title.includes('_')) return true;
      // Author looks like a path or placeholder
      if (m.author.includes('/') || m.author.includes('\\') || isPlaceholderAuthor(m.author)) return true;
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
    logBatchStart('resolve', booksToProcess.length);

    // If there's no pre-fetched gather data (i.e. user hit Fix Metadata standalone,
    // not Run All), pull external data inline for books with missing/Unknown author.
    // This is what lets a book like "The Sentence" get Louise Erdrich back even
    // when ABS itself has no author stored.
    const needsLookup = booksToProcess.filter(g => isPlaceholderAuthor(g.metadata?.author));
    if (!gatheredDataRef.current && needsLookup.length > 0) {
      try {
        const lookupBooks = needsLookup.map(g => ({
          id: g.id,
          title: g.metadata?.title || g.group_name || '',
          author: g.metadata?.author || '',
          asin: g.metadata?.asin || null,
          isbn: g.metadata?.isbn || null,
        }));
        const lookupResult = await callBackend('gather_external_data', { books: lookupBooks, config });
        const dataMap = new Map();
        for (const item of (lookupResult.results || [])) dataMap.set(item.id, item);
        gatheredDataRef.current = dataMap;
      } catch (e) {
        console.error('Inline gather failed:', e);
      }
    }

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
        current_narrator: g.metadata?.narrator || null,
        current_publisher: g.metadata?.publisher || null,
        current_year: g.metadata?.published_year || g.metadata?.year || null,
        current_isbn: g.metadata?.isbn || null,
        current_asin: g.metadata?.asin || null,
        current_description: g.metadata?.description || null,
        audible_title: gathered?.abs_title || null,
        audible_author: gathered?.abs_author || null,
        audible_subtitle: gathered?.abs_subtitle || null,
        audible_series: gathered?.abs_series || null,
        audible_sequence: gathered?.abs_sequence || null,
        audible_candidates: gathered?.abs_candidates || null,
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
          if (!r) return g;

          // Pick the most relevant errorDetail for this book: resolve-stage error
          // wins over the earlier gather-stage error (resolve runs after gather;
          // if both stages produced errors, the resolve error is newer signal).
          const gatherDetail = gatheredDataRef.current?.get(g.id)?.errorDetail;
          const errorSource = r.errorDetail || gatherDetail;
          let lastError;
          if (errorSource) {
            const isHardFailure = r.error || r.success === false || ['network', 'http', 'parse', 'schema'].includes(errorSource.kind);
            lastError = { ...errorSource, severity: isHardFailure ? 'error' : 'warn' };
          }

          // Hard failure or no usable change: surface error, don't merge metadata.
          if (r.error || r.success === false || !r.changed) {
            return lastError ? { ...g, lastError } : g;
          }

          // H2/H6: stamp each resolved field that actually changed into
          // file.changes so Write Tags writes the resolution output.
          const changedFileFields = [];
          if (r.title && r.title !== g.metadata.title) changedFileFields.push('title');
          if (r.author && r.author !== g.metadata.author) changedFileFields.push('author');
          if (r.subtitle && r.subtitle !== g.metadata.subtitle) changedFileFields.push('subtitle');
          if (r.series !== undefined && r.series !== g.metadata.series) changedFileFields.push('series');
          if (r.sequence !== undefined && r.sequence !== g.metadata.sequence) changedFileFields.push('sequence');
          if (r.narrator && r.narrator !== g.metadata.narrator) changedFileFields.push('narrator');
          const next = applyMetadataToGroup(
            g,
            {
              title: r.title || g.metadata.title,
              author: r.author || g.metadata.author,
              subtitle: r.subtitle || g.metadata.subtitle,
              series: r.series !== undefined ? r.series : g.metadata.series,
              sequence: r.sequence !== undefined ? r.sequence : g.metadata.sequence,
              narrator: r.narrator || g.metadata.narrator,
            },
            changedFileFields
          );
          return { ...next, lastError };
        });
      });

      unlisten();
      const processed = result.total_processed || 0;
      const failed = result.total_failed || 0;
      // Count warnings by scanning the fresh result (sub-step warnings surface as
      // severity=warn on the book but don't live in result.total_failed).
      const warnings = (result.results || []).filter(r =>
        r.errorDetail && !r.error && r.success !== false && severityForKind(r.errorDetail.kind) === 'warn'
      ).length;
      batch.update('metadata', { current: booksToProcess.length, success: processed, failed, currentBook: 'Complete' });
      const summary = summarizeBatch({ op: 'resolve', succeeded: processed, skipped, warnings, failed });
      if (summary) {
        const errResults = result.results || [];
        const opts = (summary.hasWarnings || summary.hasFailures)
          ? { action: { label: 'Show details', onClick: () => scrollToFirstErrorGroup(errResults, summary.hasFailures ? 'error' : 'warn') } }
          : undefined;
        toast[summary.type](summary.title, summary.message, opts);
      }
      // Log against the same errorDetail precedence the UI uses above
      // (resolve-stage error wins over the earlier gather-stage one). Built
      // from booksToProcess rather than result.results so a book that failed
      // during gather and never came back from resolve is still logged.
      // gatheredDataRef is cleared further down, so this must run before it.
      const resolveResultById = new Map((result.results || []).map(r => [r.id, r]));
      const loggedResolveResults = booksToProcess.map(g => {
        const r = resolveResultById.get(g.id);
        const errorDetail = r?.errorDetail || gatheredDataRef.current?.get(g.id)?.errorDetail;
        return errorDetail ? { id: g.id, errorDetail } : { id: g.id };
      });
      logBatchEnd(
        'resolve',
        { books: booksToProcess.length, processed, skipped, warnings, failed },
        loggedResolveResults
      );
    } catch (e) {
      unlisten();
      console.error('Metadata resolution error:', e);
      logEvent('batch', 'resolve aborted', { error: String(e?.message || e) });
      toast.error('Metadata Resolution Failed', e.toString());
    }
    // M2: fix-metadata standalone may have populated gatheredDataRef via the
    // inline gather; clear it so it doesn't leak into a later flow. Guarded so
    // a Run All step never nulls the shared ref mid-sequence.
    if (!runAllActiveRef.current) gatheredDataRef.current = null;
    batch.end('metadata', 2000);
  };

  // ✅ CALL C: DESCRIPTION PROCESSING, validate + clean/generate in ONE GPT call per book
  const processingDescriptions = batch.isActive('descriptionProcessing');
  const descriptionProgress = batch.getProgress('descriptionProcessing');
  const handleDescriptionProcessing = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;
    // H3: read live groups so a Run All chain sees prior steps' merges.
    const currentGroups = groupsRef.current;
    const selectedGroups = allSelected ? currentGroups : currentGroups.filter(g => selectedGroupIds.has(g.id));

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
    logBatchStart('description', booksToProcess.length);

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

          // H2/H6: stamp description (and any extracted narrator) into file.changes.
          const addNarrator = narratorMatch && !g.metadata.narrator;
          const changedFileFields = ['description'];
          if (addNarrator) changedFileFields.push('narrator');
          return applyMetadataToGroup(
            g,
            {
              description: r.description,
              ...(addNarrator ? { narrator: narratorMatch[1] } : {}),
            },
            changedFileFields
          );
        });
      });

      const processed = result.total_processed || 0;
      const failed = result.total_failed || 0;
      unlisten();
      batch.update('descriptionProcessing', { current: booksToProcess.length, success: processed, failed, currentBook: 'Complete' });
      const descWarnings = (result.results || []).filter(r =>
        r.errorDetail && !r.error && r.success !== false && severityForKind(r.errorDetail.kind) === 'warn'
      ).length;
      const descSummary = summarizeBatch({ op: 'description', succeeded: processed, skipped: skippedDesc, warnings: descWarnings, failed });
      if (descSummary) {
        const errResults = result.results || [];
        const opts = (descSummary.hasWarnings || descSummary.hasFailures)
          ? { action: { label: 'Show details', onClick: () => scrollToFirstErrorGroup(errResults, descSummary.hasFailures ? 'error' : 'warn') } }
          : undefined;
        toast[descSummary.type](descSummary.title, descSummary.message, opts);
      }
      logBatchEnd(
        'description',
        { books: booksToProcess.length, processed, skipped: skippedDesc, warnings: descWarnings, failed },
        result.results || []
      );
    } catch (e) {
      unlisten();
      console.error('Description processing error:', e);
      logEvent('batch', 'description aborted', { error: String(e?.message || e) });
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

    // M2: mark Run All active so the standalone gatheredDataRef clears inside
    // the step handlers no-op and don't wipe the shared gather hints out from
    // under a later step. Reset in the finally no matter how we exit.
    runAllActiveRef.current = true;

    // Phase 1: Gather all external API data upfront
    const totalSteps = 6; // gather + 5 enrichment steps
    batch.start('enrichment', {
      total: totalSteps,
      currentBook: 'Step 1/6: Gathering external data (ABS, Goodreads, Open Library, Google Books)...',
    });

    // Hoisted out of the try so the finally can log the outcome of a Run All
    // that threw partway through, which is the case most worth having in the
    // log after a crash.
    let stepSucceeded = 1; // gather phase counted as 1
    let stepFailed = 0;
    let enrichmentBooks = 0;

    try {
      const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
      enrichmentBooks = selectedGroups.length;
      logBatchStart('enrichment', selectedGroups.length);

      try {
        const gatherBooks = selectedGroups.map(g => ({
          id: g.id,
          title: g.metadata?.title || g.group_name || '',
          author: g.metadata?.author || '',
          asin: g.metadata?.asin || null,
          isbn: g.metadata?.isbn || null,
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
        logEvent('batch', 'enrichment gather failed', { error: String(error?.message || error) });
        gatheredDataRef.current = null;
        // Continue anyway, individual steps will fall back to their own API calls
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

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepNum = i + 2; // offset by 1 for gather phase
        batch.update('enrichment', {
          current: stepNum - 1,
          currentBook: `Step ${stepNum}/${totalSteps}: ${step.name}`,
        });

        try {
          await step.fn();
          stepSucceeded++;
          logEvent('enrichment', 'step complete', { step: step.name });
        } catch (error) {
          console.error(`❌ ${step.name} failed:`, error);
          stepFailed++;
          logEvent('enrichment', 'step failed', { step: step.name, error: String(error?.message || error) });
        }

        batch.update('enrichment', {
          current: stepNum,
          success: stepSucceeded,
          failed: stepFailed,
          currentBook: stepNum < totalSteps ? `Finished ${step.name}` : 'Complete!',
        });

        if (i + 1 < steps.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } finally {
      // Clear gathered data and release the guard no matter how we exit, so a
      // future standalone flow starts clean and its M2 clear works again.
      gatheredDataRef.current = null;
      runAllActiveRef.current = false;
      logBatchEnd('enrichment', {
        books: enrichmentBooks,
        steps: totalSteps,
        succeeded: stepSucceeded,
        failed: stepFailed,
      });
      batch.end('enrichment', 2000);
    }
  };

  // ✅ GPT-powered tag assignment for selected books (with progress)
  const handleAssignTagsGpt = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('tags', { total: selectedGroups.length });
    logBatchStart('tags', selectedGroups.length);


    let successCount = 0;
    let failedCount = 0;

    // Listen for per-book progress events within each chunk
    let tagChunkOffset = 0;
    const unlistenTags = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'tags') return;
      batch.update('tags', { current: tagChunkOffset + d.current, currentBook: d.title });
    });

    // Process in batches of 25 for efficiency while still showing progress
    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      tagChunkOffset = i;

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

    unlistenTags();

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


    logBatchEnd('tags', {
      books: selectedGroups.length,
      succeeded: successCount,
      failed: failedCount,
    });

    // Clear progress after a short delay
    batch.end('tags', 1500);
  };

  // ✅ BookDNA generation - creates structured fingerprint tags (dna:*)
  const handleGenerateDna = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('dna', { total: selectedGroups.length });
    logBatchStart('dna', selectedGroups.length);


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

      logBatchEnd(
        'dna',
        { books: selectedGroups.length, succeeded: successCount, failed: failedCount },
        results
      );
    } catch (error) {
      console.error('BookDNA generation failed:', error);
      logEvent('batch', 'dna aborted', { error: String(error?.message || error) });
      toast.error('DNA Generation Failed', error.toString());
    }

    // Clear progress after a short delay
    batch.end('dna', 1500);
  };

  // ✅ CONSOLIDATED CLASSIFY, replaces genres + tags + age + DNA + description in ONE GPT call per book
  const classifying = batch.isActive('classify');
  const classifyProgress = batch.getProgress('classify');

  const handleClassifyAll = async (includeDescription = true) => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    // H3: read live groups so a Run All chain sees prior steps' merges.
    const currentGroups = groupsRef.current;
    const selectedGroups = allSelected ? currentGroups : currentGroups.filter(g => selectedGroupIds.has(g.id));

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

    // When Force is on, we want to clear stale classification data, but only AFTER the AI
    // call succeeds. Clearing eagerly (a) strips the tag signal the prompt builder reads back
    // via books[].tags and (b) permanently loses the user's existing tags if the API fails.
    // We record the ids to reset and apply the reset inside the success branch.
    const idsToForceReset = forceFresh ? new Set(booksToProcess.map(g => g.id)) : null;

    batch.start('classify', { total: booksToProcess.length, currentBook: 'Starting classification...' });
    logBatchStart('classify', booksToProcess.length);


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
          if (!r) return g;
          // Hard failure: surface the error on the group and skip the metadata merge.
          if (r.error || r.success === false) {
            return {
              ...g,
              lastError: r.errorDetail
                ? { ...r.errorDetail, severity: 'error' }
                : { stage: 'classify', kind: 'network', message: r.error || 'Classification failed', severity: 'error' },
            };
          }

          const isForceReset = idsToForceReset?.has(g.id);
          const updatedMeta = { ...g.metadata };

          // On a successful force-classify, wipe stale arrays before repopulating so that
          // books whose AI response is empty/partial don't keep old genres/tags/themes/tropes.
          if (isForceReset) {
            updatedMeta.genres = [];
            updatedMeta.tags = [];
            updatedMeta.themes = [];
            updatedMeta.tropes = [];
          }

          // Genres: #54 - by default the AI's genres replace the book's. With
          // `preserve_existing_genres` on they SUPPLEMENT them instead (union,
          // existing first, existing casing kept, capped at MAX_GENRES without
          // ever dropping an existing genre). See mergeGenres for the rationale
          // and unit tests. On a Force run updatedMeta.genres was just cleared
          // above, so Force still wins over the preserve setting.
          const { genres: mergedGenres, changed: genresChanged } = mergeGenres(
            updatedMeta.genres,
            r.genres,
            { preserve: config?.preserve_existing_genres === true }
          );
          updatedMeta.genres = mergedGenres;

          // Tags: H1 - only fully replace tags when the AI returned top-level
          // classification tags; when only DNA/age tags come back, merge them
          // additively so curated tags survive. See mergeClassifyTags for the
          // full rationale and unit tests. The old inline code always did
          // tags = [...new Set([...r.tags, ...dna, ...age])], which wiped every
          // curated tag on the common DNA-only sub-step.
          const { tags: mergedTags, changed: tagsChanged } = mergeClassifyTags(updatedMeta.tags, r);
          updatedMeta.tags = mergedTags;

          // Themes & tropes
          if (r.themes?.length > 0) updatedMeta.themes = r.themes;
          if (r.tropes?.length > 0) updatedMeta.tropes = r.tropes;

          // Description (if changed)
          if (r.description && r.description_changed) {
            updatedMeta.description = r.description;
          }

          // H2/H6: stamp the writable classification output into file.changes.
          // genres -> `genre` (comma-joined), tags, and description are what the
          // write path can embed; themes/tropes/age/dna are ABS-only and stay in
          // changedFields (below) for the UI + ABS push, but aren't file changes.
          const changedFileFields = [];
          if (genresChanged) changedFileFields.push('genre');
          if (tagsChanged) changedFileFields.push('tags');
          if (r.description && r.description_changed) changedFileFields.push('description');

          // Sub-step warning (e.g. classification OK, DNA failed): amber pill.
          // Clear lastError if there was a prior failure and this run succeeded cleanly.
          const lastError = r.errorDetail
            ? { ...r.errorDetail, severity: 'warn' }
            : undefined;

          // On a force reset, drop the prior changedFields base (matches the old
          // `isForceReset ? [] : g.changedFields` behavior); the helper unions the
          // writable fields (genre->genres, tags, description) on top.
          const next = applyMetadataToGroup(
            { ...g, changedFields: isForceReset ? [] : (g.changedFields || []) },
            updatedMeta,
            changedFileFields
          );
          const cf = new Set(next.changedFields);
          if (r.themes?.length > 0) cf.add('themes');
          if (r.tropes?.length > 0) cf.add('tropes');
          if (r.age_category && r.age_category !== 'Unknown') cf.add('age');
          if (r.dna_tags?.length > 0) cf.add('dna');
          return { ...next, changedFields: [...cf], lastError };
        });
      });

      unlisten();
      const successCount = result.total_processed || 0;
      const failedCount = result.total_failed || 0;

      batch.update('classify', { current: booksToProcess.length, success: successCount, failed: failedCount, currentBook: 'Complete!' });

      const classifyWarnings = (result.results || []).filter(r =>
        r.errorDetail && !r.error && r.success !== false && severityForKind(r.errorDetail.kind) === 'warn'
      ).length;
      const classifySummary = summarizeBatch({ op: 'classify', succeeded: successCount, skipped: skippedClassify, warnings: classifyWarnings, failed: failedCount });
      if (classifySummary) {
        const errResults = result.results || [];
        const opts = (classifySummary.hasWarnings || classifySummary.hasFailures)
          ? { action: { label: 'Show details', onClick: () => scrollToFirstErrorGroup(errResults, classifySummary.hasFailures ? 'error' : 'warn') } }
          : undefined;
        toast[classifySummary.type](classifySummary.title, classifySummary.message, opts);
      }

      logBatchEnd(
        'classify',
        {
          books: booksToProcess.length,
          processed: successCount,
          skipped: skippedClassify,
          warnings: classifyWarnings,
          failed: failedCount,
        },
        result.results || []
      );
    } catch (error) {
      unlisten();
      console.error('Classification failed:', error);
      logEvent('batch', 'classify aborted', { error: String(error?.message || error) });
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
    logBatchStart('descriptions', selectedGroups.length);


    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // Listen for per-book progress events within each chunk
    let descChunkOffset = 0;
    const unlistenDescs = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'description') return;
      batch.update('descriptions', { current: descChunkOffset + d.current, currentBook: d.title });
    });

    // Process in batches of 25 for efficiency while still showing progress
    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      descChunkOffset = i;

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

              // H2/H6: stamp description / narrator into file.changes.
              const changedFileFields = [];
              if (updates.description) changedFileFields.push('description');
              if (updates.narrator) changedFileFields.push('narrator');
              return applyMetadataToGroup(g, updates, changedFileFields);
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

    unlistenDescs();
    logBatchEnd('descriptions', {
      books: selectedGroups.length,
      fixed: fixedCount,
      skipped: skippedCount,
      failed: failedCount,
    });

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
            // Only count fixable issues (with suggested_value). Use != null so
            // a legitimate 0 (e.g. sequence 0) counts as fixable, matching the
            // != null semantics used elsewhere in this branch.
            if (issue.suggested_value != null) {
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
        // M15: build the file-id set from the snapshot taken at modal open
        // (localFiles), mirroring the ABS branch, rather than reading the live
        // selection which may have changed while the confirm modal was open.
        const snapshotFileIds = new Set();
        localFiles.forEach(g =>
          (g.files || []).forEach(f => { if (f.id != null) snapshotFileIds.add(f.id); })
        );

        const result = await pushToAudiobookShelf(
          snapshotFileIds,
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
        onExtractByAudio={handleExtractByAudio}
        extractingByAudio={extractingByAudio}
        useLocalWhisper={!!config?.use_local_whisper}
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
            // L7: single-row expansion. Auto-collapse the previously expanded row
            // so the manual virtualizer only ever has one variable-height row,
            // keeping the scroll geometry bounded and correct.
            setExpandedGroups(prev => (prev.has(groupId) ? new Set() : new Set([groupId])));
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
          coverInvalidation={coverRefresh}
        />

        <MetadataPanel
          group={selectedGroup}
          onEdit={handleEditMetadata}
          onInlineEdit={(groupId, field, value) => {
            setGroups(prev => prev.map(g => {
              if (g.id !== groupId) return g;
              // H2/H6: inline edits now stage real file.changes (previously they
              // only touched group.metadata, so Write Tags dropped them). `field`
              // is a metadata field name; map the genres array to the `genre`
              // file-change field, otherwise the names match 1:1.
              const fileField = field === 'genres' ? 'genre' : field;
              return applyMetadataToGroup(g, { [field]: value }, [fileField]);
            }));
          }}
          validationData={selectedGroup ? validationResults[selectedGroup.id] : null}
          onFixIssue={handleFixSingleIssue}
          coverRefreshNonce={coverRefresh.nonce}
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

      {extractingByAudio && batch.getProgress('audio_check').total > 0 && (
        <ProgressBar
          type="audio_check"
          progress={batch.getProgress('audio_check')}
          onCancel={async () => {
            try {
              await callBackend('cancel_audio_extraction');
              toast.info('Cancelling audio extraction...');
            } catch (e) { console.error(e); }
          }}
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

      {/* H2: full JSON import replace-groups confirmation */}
      <ConfirmModal
        isOpen={!!pendingImport}
        onClose={() => setPendingImport(null)}
        onConfirm={applyPendingImport}
        type="danger"
        title="Replace current library?"
        message={`Importing this file will replace all ${groups.length} book${groups.length === 1 ? '' : 's'} currently loaded (and any unsaved edits) with ${pendingImport?.length || 0} imported book${pendingImport?.length === 1 ? '' : 's'}. This cannot be undone.`}
        confirmText="Replace"
        cancelText="Cancel"
      />

      {modals.isOpen('rename') && (
        <RenamePreviewModal
          // CR-6b: each file carries its OWN group's metadata so previews are
          // per-book, not all rendered against a single selected group's data.
          files={(() => {
            const fileIds = getSelectedFileIds(groups);
            const out = [];
            for (const group of groups) {
              for (const file of (group.files || [])) {
                if (file.id != null && fileIds.has(file.id)) {
                  out.push({ fileId: file.id, path: file.path, metadata: group.metadata });
                }
              }
            }
            return out;
          })()}
          onConfirm={async (pairs, _template) => {
            try {
              // CR-6a: rename by the explicit old->new pairs the modal computed
              // from its previews (with the chosen template).
              const renameResult = await renameFiles(pairs);

              // M6: do NOT call handleScan() here - it opens a folder picker and,
              // on cancel, drops the entire in-memory session (every curated
              // edit). Instead patch each renamed file's path/filename in place.
              const renamed = renameResult?.renamed || renameResult?.results || [];
              const pathMap = new Map();
              for (const r of renamed) {
                const oldPath = r?.old_path ?? r?.oldPath;
                const newPath = r?.new_path ?? r?.newPath;
                if (oldPath && newPath) pathMap.set(oldPath, newPath);
              }

              // Visible-failure guard (Tasks 5-6 pattern): the Rust rename_files
              // is a stub until Task 9b. If nothing came back applied, surface
              // it and keep the modal open rather than silently "succeeding".
              if (pathMap.size === 0) {
                toast.error(
                  'Rename Failed',
                  'The rename backend applied no changes (not yet implemented). Your files were not renamed.'
                );
                return;
              }

              setGroups(prev => prev.map(g => {
                if (!(g.files || []).some(f => pathMap.has(f.path))) return g;
                return {
                  ...g,
                  files: g.files.map(f => {
                    const np = pathMap.get(f.path);
                    if (!np) return f;
                    return { ...f, path: np, filename: np.split('/').pop() };
                  }),
                };
              }));
              modals.close('rename');
              toast.success('Files Renamed', `Renamed ${pathMap.size} file${pathMap.size === 1 ? '' : 's'}.`);
              // Truthful partial-failure: some pairs applied, others did not.
              // Surface the failed count alongside the success toast (not gated
              // behind the all-failed early return above).
              const renameFailed = renameResult?.failed || 0;
              if (renameFailed > 0) {
                toast.error(
                  'Some Renames Failed',
                  `${renameFailed} file${renameFailed === 1 ? '' : 's'} could not be renamed. Check console for details.`
                );
              }
            } catch (error) {
              console.error('Rename failed:', error);
              toast.error('Rename Failed', error?.message || String(error));
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

      {/* Write Tags Preview Modal (H3) */}
      {modals.isOpen('write') && (
        <WritePreviewModal
          isOpen={modals.isOpen('write')}
          onClose={() => modals.close('write')}
          onConfirm={handleConfirmWrite}
          // Materialize the snapshot ids into a Set so allSelected mode (which
          // keeps the raw selection Set empty) still previews correctly.
          selectedFiles={new Set(modals.data.write?.fileIds || [])}
          groups={groups}
          backupEnabled={true}
        />
      )}

      {/* Bulk Cover Assignment Modal */}
      {modals.isOpen('bulkCover') && (selectedGroupIds.size > 0 || allSelected) && (
        <BulkCoverAssignment
          isOpen={modals.isOpen('bulkCover')}
          onClose={() => modals.close('bulkCover')}
          selectedGroups={getSelectedGroups()}
          onCoversAssigned={({ succeeded = [], failed = [] }) => {
            // M9: invalidate cached covers for the books that were updated so
            // BookList + MetadataPanel reload the new art instead of the stale one.
            if (succeeded.length > 0) {
              setCoverRefresh(prev => ({ nonce: prev.nonce + 1, ids: succeeded }));
              setGroups([...groups]);
              toast.success('Covers Applied', `Updated ${succeeded.length} cover${succeeded.length === 1 ? '' : 's'}.`);
            }
            if (failed.length > 0) {
              toast.error('Some Covers Failed', `${failed.length} cover${failed.length === 1 ? '' : 's'} could not be applied.`);
            }
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

      {/* #58: the restore prompt and its confirmation are portaled to
          document.body. ScannerPage lives inside a wrapper that App.jsx sets
          to `hidden` on the Settings tab, and a hidden restore prompt would be
          invisible while still silently suppressing autosave. */}
      {createPortal(
        <>
          {/* Non-blocking, and it stays until the user answers: autosave is
              suppressed the whole time it is open, so the saved snapshot
              cannot be overwritten before they decide. */}
          {sessionRestorePending && savedSession && (
            <RestoreSessionToast
              session={savedSession}
              busy={sessionBusy}
              onRestore={handleRestoreSession}
              onDiscard={handleDiscardSession}
            />
          )}

          {/* A snapshot that is on disk but unreadable or corrupt. There is
              nothing to restore, but autosave stays paused until the user
              discards it, so they need a way to say so. */}
          {!sessionRestorePending && sessionUnreadable && (
            <RestoreSessionToast
              unreadableReason={sessionUnreadable.reason}
              busy={sessionBusy}
              onDiscard={handleDiscardSession}
            />
          )}

          {/* Restoring on top of books already loaded is destructive, and
              autosave is suppressed while the prompt is open, so there is no
              snapshot of the current workspace to fall back on. */}
          <ConfirmModal
            isOpen={!!pendingRestore}
            onClose={handleKeepCurrentBooks}
            onConfirm={confirmRestoreSession}
            type="danger"
            title="Replace the books you have loaded?"
            message={`Restoring will replace the ${pendingRestore?.currentCount || 0} book${pendingRestore?.currentCount === 1 ? '' : 's'} currently loaded (and any unsaved edits) with the ${pendingRestore?.count || 0} book${pendingRestore?.count === 1 ? '' : 's'} from your previous session. The current books have not been saved anywhere, so this cannot be undone.\n\nKeeping the current books resumes autosave and keeps the previous session as a backup copy.`}
            confirmText="Restore"
            cancelText="Keep current books"
          />
        </>,
        document.body
      )}
    </div>
  );
}