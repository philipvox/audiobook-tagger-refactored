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
import { useScan, importFromAbsWithNotice, scanFolderWithNotice, hasAbsConnection, hasAiProvider } from '../hooks/useScan';
import { useFileSelection } from '../hooks/useFileSelection';
import { useTagOperations } from '../hooks/useTagOperations';
import { useBatchOperations } from '../hooks/useBatchOperations';
import { useModals } from '../hooks/useModals';
import { useApp } from '../context/AppContext';
import { severityForKind } from '../lib/errorDetail';
import { summarizeBatch, scrollToFirstErrorGroup } from '../lib/batchToast';
import { keepCurrentBooksToast } from '../lib/session.js';
import { logEvent, logBatchStart, logBatchEnd } from '../lib/logEvent';
import { runPush, isAbsBacked, fileIdsInGroups, normalizePushResult, summarizePush } from '../lib/absPush';
import { userClearedPatch } from '../lib/userCleared';
import { bulkFileChanges } from '../lib/bulkEditUpdates';
import { applyClassifyResult } from '../lib/applyClassifyResult';
import { applyTagsResultToGroup, applyDnaResultToGroup, normalizeResults } from '../lib/applyTagResults';
import { applyResolveResult, applyDescriptionProcessResult, applyFixDescriptionResult, tallyOutcomes } from '../lib/applyAiResults';
import { runEnrichAction, applyEntries, reportOutcomes, runBatchChunks } from '../lib/enrichActions';
import { requestCancel, startCancellable, finishCancellable, finishAfter } from '../lib/cancel';
import { syncAllSeries } from '../lib/absPayload';
import { applyMetadataToGroup, readFileField, setYear } from '../lib/applyMetadata';
import { applyFieldFixes } from '../lib/applyValidationFixes';
import {
  selectedGroupsFrom, selectionForSelectAll, localWriteTargets,
  summarizeWriteResult, applyWriteResult, summarizeRenameResult, applyRenameResult,
} from '../lib/localWrite';
import { isLocalGroup } from '../lib/applyMetadata';
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
  // H-8: the books the list's search/filters show; null when they show every book.
  const [listFilteredGroups, setListFilteredGroups] = useState(null);
  // H-7: an ABS push is running (the modal's Confirm stays disabled).
  const [absPushing, setAbsPushing] = useState(false);
  const absPushingRef = useRef(false);
  // H-7: the running push's cancel token (the modal's "Cancel push").
  const pushCancelRef = useRef(null);

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

  // Check undo status. #62: re-checked on mount and after every write,
  // rename and undo, so "Undo last write" shows exactly when a journal exists.
  // `showToast` pops the UndoToast (only right after a write).
  const checkUndoStatus = useCallback(async ({ showToast = false } = {}) => {
    try {
      const status = await callBackend('get_undo_status');
      setUndoStatus(status);
      if (!status?.available) setShowUndoToast(false);
      else if (showToast) setShowUndoToast(true);
    } catch (error) {
      console.error('Failed to check undo status:', error);
    }
  }, []);
  useEffect(() => { checkUndoStatus(); }, [checkUndoStatus]);

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

      if (result.journal_error) {
        // v2.2.3: files were restored but the undo journal could not be updated.
        toast.warning('Changes Reverted', `Restored the files, but the undo record could not be updated: ${result.journal_error}`);
      } else {
        toast.success('Changes Reverted', 'Restored the files from the last write. Rescan to refresh the on-screen tags.');
      }
    } catch (error) {
      // #62: undo_last_write rejects when its background task crashes.
      console.error('Undo failed:', error);
      toast.error('Undo Failed', String(error?.message || error));
    } finally {
      setUndoing(false);
      // A partial undo keeps its failed entries in the journal.
      await checkUndoStatus();
    }
  }, [undoStatus, undoing, toast, setGroups, clearFileStatuses, checkUndoStatus]);

  // Dismiss undo toast. #62: hiding the toast (by hand or after its 30 s
  // countdown) keeps the undo journal, so "Undo last write" in the action bar
  // still works; the next write replaces the journal.
  const dismissUndo = useCallback(() => {
    setShowUndoToast(false);
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
      // Autosave resumes either way: the user chose their current work, and
      // stranding them unprotected again would repeat the bug this path exists
      // to fix. Only the wording changes, because on the failure path the old
      // snapshot is still in the primary slot where autosave will overwrite it.
      const preserved = await keepCurrentWorkspace();
      logEvent(
        'session',
        preserved
          ? 'kept current books, previous session moved to the second slot'
          : 'kept current books, but the backup copy could not be written'
      );
      const notice = keepCurrentBooksToast(preserved);
      toast[notice.type](notice.title, notice.message);
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
    scanningFolder,
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
    scanCancellable,
  } = useScan();

  // H-4/H-9/H-7: tell the user how an import ended: refreshed books, a
  // failure (with its message) or a cancel. Never rethrows (bound to onClick).
  const handleImportFromAbsNotify = (...args) => importFromAbsWithNotice(handleImportFromAbs, toast, ...args);

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

  // Optimized: use allSelected flag instead of building huge Sets.
  // H-8: with a filter active the action bar passes the filtered books, and
  // only those are selected (lib/localWrite.js selectionForSelectAll).
  const handleSelectAll = (filteredGroups) => {
    if (Array.isArray(filteredGroups)) {
      handleSelectFiltered(filteredGroups);
      return;
    }
    selectAll(groups);
    setSelectedGroupIds(new Set()); // Clear - we use allSelected flag
  };

  // Select only the filtered groups (from search results)
  const handleSelectFiltered = (filteredGroups) => {
    if (!filteredGroups || filteredGroups.length === 0) return;
    const selection = selectionForSelectAll(groups, filteredGroups);
    if (selection.allSelected) {
      // The filter shows every book: use the allSelected flag.
      selectAll(groups);
      setSelectedGroupIds(new Set());
    } else {
      // Only the filtered group ids AND their file ids. H4: without the file
      // ids, getSelectedFileIds returns an empty set and Rescan silently does
      // nothing on a filtered selection.
      clearSelection();
      setSelectedFiles(selection.fileIds);
      setSelectedGroupIds(selection.groupIds);
    }
  };

  const handleClearSelection = () => {
    clearSelection();
    setSelectedGroupIds(new Set());
  };

  // #62: Scan Folder. A scan that replaced the workspace clears the selection
  // (the old ids are gone); failures, cancels and empty scans are toasted by
  // scanFolderWithNotice. Never rethrows (bound to onClick).
  const handleScanFolder = () => scanFolderWithNotice(handleScan, toast, {
    onReplaced: () => {
      clearSelection();
      setSelectedGroupIds(new Set());
      setSelectedGroup(null);
    },
  });

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
        return applyMetadataToGroup(
          group,
          // Only genres: this modal has no tags editor, so tags are never user-emptied here.
          { ...newMetadata, ...userClearedPatch(group.metadata, { genres: newMetadata.genres }) },
          changedFileFields
        );
      })
    );
  };

  // Get selected groups for bulk edit
  const getSelectedGroups = () => selectedGroupsFrom(groups, { allSelected, selectedGroupIds });

  // Handle bulk edit save
  const handleBulkSave = (updates) => {
    if (selectedGroupIds.size === 0 && !allSelected) return;

    setGroups(prevGroups =>
      prevGroups.map(group => {
        if (!allSelected && !selectedGroupIds.has(group.id)) return group;

        // Merge updates into metadata. v2.2.3: syncAllSeries keeps the
        // all_series primary in step with a bulk series/sequence edit (the
        // ABS push sends all_series).
        const newMetadata = syncAllSeries(group.metadata, {
          ...group.metadata,
          ...updates,
          // H-2: a bulk year edit moves `year` and `published_year` together.
          ...('year' in updates ? setYear({}, updates.year) : {}),
          ...userClearedPatch(group.metadata, updates),
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
        });

        // Update file changes (lib/bulkEditUpdates.js). H1: a present key drives
        // the change, a present null clears it; W-8: no `changes` object is fine.
        const updatedFiles = (group.files || []).map(file => {
          const changes = bulkFileChanges(file, updates);
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
        if (meta.year) Object.assign(newMetadata, setYear(newMetadata, meta.year));
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
  // #62: only the selected locally scanned books are written (ABS books are
  // updated with Push), with the same selection the Enrich actions use.
  const handleWriteClick = () => {
    const selected = getSelectedGroups();
    if (selected.length === 0) {
      toast.warning('No Selection', 'Select books before writing.');
      return;
    }
    const { localGroups, fileIds, writableCount } = localWriteTargets(selected);
    if (localGroups.length === 0) {
      toast.info('No Local Books', 'Write Tags works on locally scanned folders. Use Push for AudiobookShelf books.');
      return;
    }
    if (writableCount === 0) {
      toast.info(
        'No Changes',
        fileIds.length > 0
          ? 'The selected books only have changes that stay in the app (such as tags or DNA); none can be written to the files.'
          : 'The selected books have no pending changes to write.'
      );
      return;
    }
    modals.open('write', { fileIds });
  };

  // H3: actually write after the preview is confirmed. `skipBackup` and
  // `excludedChanges` come from the modal; the payload equals exactly what the
  // preview showed minus the excluded rows.
  // #62: one write_tags call, so there is no mid-batch cancel. Every per-file
  // refusal reaches the user in the toast and as the book's lastError; only
  // the changes that reached a file are cleared from staging.
  const handleConfirmWrite = async (skipBackup, excludedChanges) => {
    const fileIds = modals.data.write?.fileIds || [];
    if (fileIds.length === 0) return;

    try {
      const result = await writeSelectedTags(new Set(fileIds), {
        backup: !skipBackup,
        excludedChanges,
      });
      const summary = summarizeWriteResult(result, groupsRef.current);
      setGroups(prev => applyWriteResult(prev, result));
      (toast[summary.toast.type] || toast.info)(summary.toast.title, summary.toast.message);
      if (summary.written > 0 && summary.failures.length === 0) handleClearSelection();
      logEvent('write', 'write tags complete', {
        files: fileIds.length,
        written: summary.written,
        failed: summary.failures.length,
        failedFiles: summary.failures.slice(0, 5).map(f => `${f.name}: ${f.error}`),
      });
    } catch (error) {
      // write_tags rejects when its background task crashes: nothing reported
      // per file, so say the whole write failed.
      console.error('Write failed:', error);
      toast.error('Write Failed', String(error?.message || error));
    } finally {
      await checkUndoStatus({ showToast: true });
    }
  };

  // #62: Rename the selected locally scanned books' files from a template.
  const handleRenameClick = () => {
    const selected = getSelectedGroups();
    if (selected.length === 0) return;
    if (!selected.some(isLocalGroup)) {
      toast.info('No Local Books', 'Rename works on locally scanned folders only.');
      return;
    }
    modals.open('rename');
  };

  // #62: apply a confirmed rename. Rename has no undo; the modal says so.
  const handleConfirmRename = async (pairs) => {
    try {
      // CR-6a: rename by the explicit old->new pairs the modal computed
      // from its previews (with the chosen template).
      const result = await renameFiles(pairs);
      const summary = summarizeRenameResult(result, groupsRef.current);
      // M6: do NOT call handleScan() here (it would drop the session); patch
      // each renamed file's path and filename in place.
      setGroups(prev => applyRenameResult(prev, result));
      (toast[summary.toast.type] || toast.info)(summary.toast.title, summary.toast.message);
      // Nothing renamed: keep the modal open so the user can change the template.
      if (summary.renamed > 0) modals.close('rename');
    } catch (error) {
      // rename_files rejects when its background task crashes.
      console.error('Rename failed:', error);
      toast.error('Rename Failed', String(error?.message || error));
    } finally {
      // A rename retargets the undo journal to the new paths.
      await checkUndoStatus();
    }
  };

  // #60: toast the outcome of an auto-push that ran after an ABS rescan.
  // No-op when the rescan did not push (result.push is null).
  const reportAutoPush = (result) => {
    if (!result?.push) return;
    const n = normalizePushResult(result.push);
    const summary = summarizePush(n, n.updated.length + n.skipped.length + n.failed.length);
    (toast[summary.type] || toast.info)(summary.title, summary.message);
  };

  // ✅ Rescan with configurable mode and optional selective fields
  // @param {string} scanMode - 'normal', 'refresh_metadata', 'force_fresh', 'selective_refresh', 'super_scanner'
  // @param {Array} selectiveFields - Optional array of field names for selective refresh
  // @param {Object} options - Optional options like { enableTranscription: bool }
  const handleRescanClick = async (scanMode = 'force_fresh', selectiveFields = null, options = {}) => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) return;

    // ABS-backed books (imported, with or without files) vs genuinely local ones (#60)
    const absImports = selectedGroups.filter(isAbsBacked);
    const localFiles = selectedGroups.filter(g => !isAbsBacked(g));

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
        reportAutoPush(result);
      }

      // Handle local files (if any mixed in)
      if (localFiles.length > 0) {
        const transcriptionLabel = options.enableTranscription ? ' + audio verification' : '';
        // Only the local groups' files: ABS-backed books were handled above.
        const actualSelectedFiles = fileIdsInGroups(getSelectedFileIds(groups), localFiles);
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
      // v2.2.3: was console-only; an unimplemented rescan looked like success.
      toast.error('Rescan Failed', String(error?.message || error));
    }
  };

  // Bridge getters: read from batch operations hook (setters use batch.start/update/end)
  const cleaningGenres = batch.isActive('genres');
  const genreProgress = batch.getProgress('genres');

  // H-3/M-7: the per-book Enrich actions share one body (src/lib/enrichActions.js):
  // chunk loop, per-book failure, counting outside the updater, end toast.
  // `cancel` is the action's token from beginCancellable (M-6).
  const runAction = (name, sentGroups, { cancel, ...options } = {}) =>
    runEnrichAction(name, sentGroups, {
      callBackend, setGroups, toast,
      ...(cancel && { shouldStop: () => cancel.cancelled }),
      ...options,
    });

  // H-7/M-6: every Enrich action takes its own cancel token (lib/cancel.js),
  // keyed by its batch op so its progress bar's Cancel stops it and nothing
  // else. A new action can never clear another's pending Cancel, and a stale
  // Cancel never stops a new run. A Run All step uses Run All's token, so a
  // Cancel during one step also stops the steps after it.
  const opCancelRef = useRef({});
  const runAllCancelRef = useRef(null);
  const beginCancellable = (op) => {
    const previous = opCancelRef.current[op];
    if (previous && previous !== runAllCancelRef.current) finishCancellable(previous);
    const token = (runAllActiveRef.current && runAllCancelRef.current) || startCancellable();
    opCancelRef.current[op] = token;
    return token;
  };
  // Wrap an Enrich handler so the token its run took is released when the run
  // ends, however it ends (Run All's shared token is released by Run All).
  const cancellable = (op, fn) => finishAfter(fn, () => {
    const token = opCancelRef.current[op];
    if (!token || token === runAllCancelRef.current) return null;
    delete opCancelRef.current[op];
    return token;
  });
  // A progress bar's Cancel: chunked actions stop before their next chunk;
  // what was already applied stays applied.
  const handleCancelBatch = (op) => {
    const token = opCancelRef.current[op];
    if (!token || token.cancelled) return;
    requestCancel(token);
    toast.info('Cancelling', 'Stopping once the books in progress finish.');
  };

  // ✅ GPT-powered genre cleanup for selected books (with progress)
  const handleGenreCleanup = cancellable('genres', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0 && !allSelected) return;

    // Any configured AI provider (OpenAI, Anthropic or local AI) takes the AI
    // path; only a setup with none falls back to the static cleaner.
    if (!hasAiProvider(config)) {
      try {
        const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
        const result = await handleCleanupGenres(selectedGroups);
        reportOutcomes(toast, 'genres', result.pairs || []);
      } catch (error) {
        console.error('Genre cleanup failed:', error);
        toast.error('Genre Cleanup Failed', String(error?.message || error));
      }
      return;
    }

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('genres');
    batch.start('genres', { total: selectedGroups.length, cleaned: 0, unchanged: 0 });
    logBatchStart('genres', selectedGroups.length);


    // Listen for per-book progress events within each chunk
    let chunkOffset = 0;
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'genres') return;
      batch.update('genres', { current: chunkOffset + d.current, currentBook: d.title });
    });

    // Chunks of 25. The applier keeps any genre from the import snapshot that
    // the answer has no replacement for.
    const { counts } = await runAction('genres', selectedGroups, {
      cancel,
      ctx: { config },
      onChunkStart: (chunk, offset) => {
        chunkOffset = offset;
        batch.update('genres', { current: offset, currentBook: chunk.map(g => g.metadata?.title).join(', ') });
      },
      onChunkDone: (done, c) => batch.update('genres', { current: done, cleaned: c.succeeded, unchanged: c.skipped, failed: c.failed }),
    });

    unlisten();
    logBatchEnd('genres', {
      books: selectedGroups.length,
      cleaned: counts.succeeded,
      unchanged: counts.skipped,
      failed: counts.failed,
    });

    // Clear progress after a short delay
    batch.end('genres', 1500);
  });

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
  const handleFixTitles = cancellable('titles', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('titles');
    batch.start('titles', { total: selectedGroups.length });
    logBatchStart('titles', selectedGroups.length);


    // Chunks of 25 in parallel. resolve_title returns { success, result }; the
    // applier sets only title/author/subtitle (series is Fix Series' job).
    const { counts } = await runAction('titles', selectedGroups, {
      cancel,
      onChunkStart: (chunk, offset) => batch.update('titles', { current: offset, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') }),
      onChunkDone: (done, c) => batch.update('titles', { current: done, success: c.succeeded + c.skipped + c.warnings, failed: c.failed }),
    });

    logBatchEnd('titles', {
      books: selectedGroups.length,
      succeeded: counts.succeeded + counts.skipped + counts.warnings,
      failed: counts.failed,
    });
    batch.end('titles');
  });

  // ✅ Subtitle fixing via Audible + GPT for selected books
  const handleFixSubtitles = cancellable('subtitles', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('subtitles');
    batch.start('subtitles', { total: selectedGroups.length, fixed: 0, skipped: 0 });
    logBatchStart('subtitles', selectedGroups.length);


    // Listen for per-book progress events within each chunk
    let subtitleChunkOffset = 0;
    const unlistenSubtitles = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'subtitles') return;
      batch.update('subtitles', { current: subtitleChunkOffset + d.current, currentBook: d.title });
    });

    // Chunks of 10 (Audible rate limits). Failed books get lastError.
    const { counts } = await runAction('subtitles', selectedGroups, {
      cancel,
      ctx: { config, force: forceFresh },
      onChunkStart: (chunk, offset) => {
        subtitleChunkOffset = offset;
        batch.update('subtitles', { current: offset, currentBook: chunk.map(g => g.metadata?.title).join(', ') });
      },
      onChunkDone: (done, c) => batch.update('subtitles', { current: done, fixed: c.succeeded, skipped: c.skipped, failed: c.failed }),
    });

    unlistenSubtitles();
    logBatchEnd('subtitles', {
      books: selectedGroups.length,
      fixed: counts.succeeded,
      skipped: counts.skipped,
      failed: counts.failed,
    });

    // Clear progress after a short delay
    batch.end('subtitles', 1500);
  });

  // ✅ Author fixing via ABS + GPT for selected books
  const handleFixAuthors = cancellable('authors', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('authors');
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
    let authorsCancelled = 0;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      // M-6: Cancel stops between batches; finished batches stay applied.
      if (cancel.cancelled) { authorsCancelled = selectedGroups.length - i; break; }
      const chunk = selectedGroups.slice(i, i + batchSize);
      authorChunkOffset = i;

      // Update progress with current batch
      batch.update('authors', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          // D-5: "Last, First" is inverted only for a locally scanned book.
          source: isLocalGroup(g) ? 'local' : 'abs',
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
    if (failedCount > 0 || authorWarnings > 0 || authorsCancelled > 0) {
      const summary = summarizeBatch({ op: 'authors', succeeded: fixedCount, skipped: skippedCount, warnings: authorWarnings, failed: failedCount, cancelled: authorsCancelled });
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
  });

  // ✅ Year fixing (original publication year) via ABS + GPT for selected books
  const handleFixYears = cancellable('years', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    // H3: read live groups so a Run All chain sees prior steps' merges.
    const currentGroups = groupsRef.current;
    const selectedGroups = allSelected ? currentGroups : currentGroups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('years');
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
    let yearsCancelled = 0;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      // M-6: Cancel stops between batches; finished batches stay applied.
      if (cancel.cancelled) { yearsCancelled = selectedGroups.length - i; break; }
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
              return applyMetadataToGroup(g, { ...setYear({}, yearResult.year), tags: newTags }, changedFileFields);
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
    if (failedCount > 0 || yearsCancelled > 0) {
      const summary = summarizeBatch({ op: 'years', succeeded: fixedCount, skipped: skippedCount, warnings: 0, failed: failedCount, cancelled: yearsCancelled });
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
  });

  // ✅ Check by Audio - extract metadata from audio intros via Whisper
  const extractingByAudio = batch.isActive('audio_check');
  const handleExtractByAudio = cancellable('audio_check', async (field = 'all') => {
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

    const cancel = beginCancellable('audio_check');

    batch.start('audio_check', { total: needsProcessing.length });
    logBatchStart('audio_check', needsProcessing.length);

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
      // One backend call for all books; a book with no transcript is a
      // per-book failure. Placeholder values ("Unknown") count as missing,
      // same as the skip gate above.
      const { counts } = await runAction('audio_check', needsProcessing, {
      cancel,
        ctx: { config, force: forceFresh, field },
      });
      logBatchEnd('audio_check', { books: needsProcessing.length, field, updated: counts.succeeded, failed: counts.failed });
    } catch (error) {
      logEvent('batch', 'audio_check aborted', { error: String(error?.message || error) });
      toast.error(`Check ${label}`, String(error));
    } finally {
      if (tauriUnlisten) tauriUnlisten();
      batch.end('audio_check', 1500);
    }
  });

  // ✅ Series fixing via Audible + GPT for selected books
  const handleFixSeries = cancellable('series', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('series');
    batch.start('series', { total: selectedGroups.length });
    logBatchStart('series', selectedGroups.length);


    // Chunks of 3 in parallel. The applier replaces the primary series in place
    // (all_series keeps one entry per series); a book whose series list is
    // unknown is skipped without an AI call.
    const { counts } = await runAction('series', selectedGroups, {
      cancel,
      onChunkStart: (chunk, offset) => batch.update('series', { current: offset, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') }),
      onChunkDone: (done, c) => batch.update('series', { current: done, success: c.succeeded + c.skipped + c.warnings, failed: c.failed }),
    });

    logBatchEnd('series', {
      books: selectedGroups.length,
      succeeded: counts.succeeded,
      unchanged: counts.skipped,
      warnings: counts.warnings,
      failed: counts.failed,
    });
    batch.end('series');
  });

  // ✅ Age rating lookup via web search (Goodreads, etc.)
  const handleLookupAge = cancellable('age', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('age');
    batch.start('age', { total: selectedGroups.length });
    logBatchStart('age', selectedGroups.length);


    // Chunks of 2 (web search is slow). Age tags go in through mergeClassifyTags
    // (snapshot age tags kept), the age genre through mergeGenres.
    const { counts } = await runAction('age', selectedGroups, {
      cancel,
      onChunkStart: (chunk, offset) => batch.update('age', { current: offset, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') }),
      onChunkDone: (done, c) => batch.update('age', { current: done, success: c.succeeded + c.skipped, failed: c.failed + c.warnings }),
    });

    logBatchEnd('age', {
      books: selectedGroups.length,
      succeeded: counts.succeeded + counts.skipped,
      warnings: counts.warnings,
      failed: counts.failed,
    });
    batch.end('age');
  });

  // ✅ ISBN/ASIN lookup for selected books
  const handleLookupISBN = cancellable('isbn', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const cancel = beginCancellable('isbn');

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


    // Chunks of 3, using the gather phase's ISBN/ASIN when it found one. Lookup
    // errors become per-book lastError and failures, separate from "not found".
    // Books the smart skip left out count as "already had ISBN".
    const { pairs } = await runAction('isbn', booksToProcess, {
      cancel,
      ctx: { gathered: gatheredDataRef.current },
      extraPairs: Array.from({ length: skippedIsbn }, () => ({ id: null, outcome: 'unchanged' })),
      onChunkStart: (chunk, offset) => batch.update('isbn', { current: offset, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') }),
      onChunkDone: (done, c) => batch.update('isbn', { current: done, success: c.succeeded, failed: c.failed }),
    });
    const count = (o) => pairs.filter((x) => x.outcome === o).length;

    // Same buckets as the toast: found = a new ISBN/ASIN applied; a lookup
    // that returned what the book already had joins the smart-skipped books.
    logBatchEnd('isbn', {
      books: booksToProcess.length,
      found: count('changed'),
      skipped: skippedIsbn + count('unchanged'),
      notFound: count('notfound'),
      failed: count('failed'),
    });

    // M2: ISBN lookup reads gather hints from gatheredDataRef; clear them when
    // standalone. Guarded so a Run All step never nulls the shared ref.
    if (!runAllActiveRef.current) gatheredDataRef.current = null;

    batch.end('isbn');
  });

  // ✅ CALL A: METADATA RESOLUTION, title + subtitle + author + series in ONE GPT call per book
  const resolvingMetadata = batch.isActive('metadata');
  const metadataProgress = batch.getProgress('metadata');
  const handleMetadataResolution = cancellable('metadata', async () => {
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

    const cancel = beginCancellable('metadata');

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
        external_source: gathered?.source || null,
      };
    });

    // Listen for per-book progress events (counted within each chunk)
    let metaChunkOffset = 0;
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'metadata') return;
      batch.update('metadata', {
        current: metaChunkOffset + d.current,
        currentBook: d.title,
      });
    });

    try {
      // M-6: chunks of 25, each staged as it lands; Cancel stops between chunks.
      const run = await runBatchChunks(books, {
        shouldStop: () => cancel.cancelled,
        stage: 'resolve',
        onChunkStart: (chunk, offset) => {
          metaChunkOffset = offset;
          batch.update('metadata', { current: offset });
        },
        callChunk: (chunk) => callBackend('resolve_metadata_batch', { books: chunk, config }),
        applyChunk: (result) => setGroups(prevGroups => prevGroups.map(g =>
          applyResolveResult(g, result.results?.find(r => r.id === g.id), gatheredDataRef.current?.get(g.id)?.errorDetail)
        )),
      });
      const result = { results: run.results, total_processed: run.processed, total_failed: run.failed };

      unlisten();
      const processed = result.total_processed || 0;
      const failed = result.total_failed || 0;
      // Count warnings by scanning the fresh result (sub-step warnings surface as
      // severity=warn on the book but don't live in result.total_failed).
      const warnings = (result.results || []).filter(r =>
        r.errorDetail && !r.error && r.success !== false && severityForKind(r.errorDetail.kind) === 'warn'
      ).length;
      batch.update('metadata', { current: booksToProcess.length - run.cancelled - run.notProcessed, success: processed, failed, currentBook: 'Complete' });
      const summary = summarizeBatch({ op: 'resolve', succeeded: processed, skipped, warnings, failed, cancelled: run.cancelled, notProcessed: run.notProcessed, errorMessage: run.firstError });
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
        { books: booksToProcess.length, processed, skipped, warnings, failed, cancelled: run.cancelled },
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
  });

  // ✅ CALL C: DESCRIPTION PROCESSING, validate + clean/generate in ONE GPT call per book
  const processingDescriptions = batch.isActive('descriptionProcessing');
  const descriptionProgress = batch.getProgress('descriptionProcessing');
  const handleDescriptionProcessing = cancellable('descriptionProcessing', async () => {
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

    const cancel = beginCancellable('descriptionProcessing');

    batch.start('descriptionProcessing', { total: booksToProcess.length, currentBook: 'Processing descriptions...' });
    logBatchStart('description', booksToProcess.length);

    const books = booksToProcess.map(g => ({
      id: g.id,
      title: g.metadata?.title || '',
      author: g.metadata?.author || '',
      genres: g.metadata?.genres || [],
      description: g.metadata?.description || null,
    }));

    // Listen for per-book progress events (counted within each chunk)
    let descProcChunkOffset = 0;
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'description') return;
      batch.update('descriptionProcessing', {
        current: descProcChunkOffset + d.current,
        currentBook: d.title,
      });
    });

    try {
      // M-6: chunks of 25, each staged as it lands; Cancel stops between chunks.
      const run = await runBatchChunks(books, {
        shouldStop: () => cancel.cancelled,
        stage: 'description',
        onChunkStart: (chunk, offset) => {
          descProcChunkOffset = offset;
          batch.update('descriptionProcessing', { current: offset });
        },
        callChunk: (chunk) => callBackend('process_descriptions_batch', { books: chunk, config }),
        applyChunk: (result) => setGroups(prevGroups => prevGroups.map(g =>
          // H2/H6: stamps the description; a narrator is staged only when the book has none.
          applyDescriptionProcessResult(g, result.results?.find(r => r.id === g.id))
        )),
      });
      const result = { results: run.results, total_processed: run.processed, total_failed: run.failed };

      const processed = result.total_processed || 0;
      const failed = result.total_failed || 0;
      unlisten();
      batch.update('descriptionProcessing', { current: booksToProcess.length - run.cancelled - run.notProcessed, success: processed, failed, currentBook: 'Complete' });
      const descWarnings = (result.results || []).filter(r =>
        r.errorDetail && !r.error && r.success !== false && severityForKind(r.errorDetail.kind) === 'warn'
      ).length;
      const descSummary = summarizeBatch({ op: 'description', succeeded: processed, skipped: skippedDesc, warnings: descWarnings, failed, cancelled: run.cancelled, notProcessed: run.notProcessed, errorMessage: run.firstError });
      if (descSummary) {
        const errResults = result.results || [];
        const opts = (descSummary.hasWarnings || descSummary.hasFailures)
          ? { action: { label: 'Show details', onClick: () => scrollToFirstErrorGroup(errResults, descSummary.hasFailures ? 'error' : 'warn') } }
          : undefined;
        toast[descSummary.type](descSummary.title, descSummary.message, opts);
      }
      logBatchEnd(
        'description',
        { books: booksToProcess.length, processed, skipped: skippedDesc, warnings: descWarnings, failed, cancelled: run.cancelled },
        result.results || []
      );
    } catch (e) {
      unlisten();
      console.error('Description processing error:', e);
      logEvent('batch', 'description aborted', { error: String(e?.message || e) });
      toast.error('Description Processing Failed', e.toString());
    }
    batch.end('descriptionProcessing', 2000);
  });

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
    // H-7/M-6: one cancel token for the whole chain (the steps use it).
    const cancel = startCancellable();
    runAllCancelRef.current = cancel;
    opCancelRef.current.enrichment = cancel;

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
        // M-6: a Cancel stops the chain; finished steps stay applied.
        if (cancel.cancelled) {
          const left = steps.length - i;
          logEvent('enrichment', 'cancelled', { stepsLeft: left });
          toast.warning('Run All cancelled', `${stepSucceeded + stepFailed} of ${totalSteps} steps ran; the remaining ${left} ${left === 1 ? 'was' : 'were'} cancelled.`);
          break;
        }
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
      runAllCancelRef.current = null;
      finishCancellable(cancel);
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
  const handleAssignTagsGpt = cancellable('tags', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('tags');
    batch.start('tags', { total: selectedGroups.length });
    logBatchStart('tags', selectedGroups.length);


    let successCount = 0;
    let failedCount = 0;
    let tagsPartialCount = 0; // books whose DNA step failed or whose answer was empty

    // Listen for per-book progress events within each chunk
    let tagChunkOffset = 0;
    const unlistenTags = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'tags') return;
      batch.update('tags', { current: tagChunkOffset + d.current, currentBook: d.title });
    });

    // Process in batches of 25 for efficiency while still showing progress
    const batchSize = 25;
    let tagsCancelled = 0;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      // M-6: Cancel stops between batches; finished batches stay applied.
      if (cancel.cancelled) { tagsCancelled = selectedGroups.length - i; break; }
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

        // Update groups with new tags. The partial count is taken outside the
        // updater so the toast and log below read it after it is complete.
        if (result.results && result.results.length > 0) {
          const pairs = applyEntries(setGroups, chunk, (g) => result.results.find(r => r.id === g.id), applyTagsResultToGroup);
          tagsPartialCount += pairs.filter((x) => x.outcome === 'partial' || x.outcome === 'empty').length;

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
    // (snapshot age tags kept; a failed age lookup does not replace the
    // tags-step error on a book). No toast of its own; counted below.
    batch.update('tags', { currentBook: 'Looking up age ratings...' });
    // Age tags only for the books the tags step reached (all of them unless
    // cancelled; a Cancel also stops the age step between its chunks).
    const taggedGroups = tagsCancelled > 0 ? selectedGroups.slice(0, selectedGroups.length - tagsCancelled) : selectedGroups;
    const { counts: ageCounts } = await runAction('age_tags', taggedGroups, {
      cancel,
      toast: null,
      onChunkStart: (chunk) => batch.update('tags', { currentBook: `Age: ${chunk.map(g => g.metadata?.title || g.group_name).join(', ')}` }),
    });
    const ageFailedCount = ageCounts.failed;

    logBatchEnd('tags', {
      books: selectedGroups.length,
      succeeded: successCount,
      failed: failedCount,
      partial: tagsPartialCount,
      ageFailed: ageFailedCount,
    });
    // M-7: failures are shown, not only logged.
    const tagsSummary = summarizeBatch({ op: 'tags', succeeded: Math.max(0, successCount - tagsPartialCount), warnings: tagsPartialCount, failed: failedCount, cancelled: tagsCancelled });
    if (tagsCancelled > 0) {
      toast[tagsSummary.type](tagsSummary.title, tagsSummary.message);
    } else if (tagsSummary && (tagsSummary.hasFailures || tagsSummary.hasWarnings)) {
      toast[tagsSummary.type](tagsSummary.title, 'See the book error. Existing tags were kept.');
    }
    if (ageFailedCount > 0) {
      toast.warning('Age tags not updated', `The age lookup failed for ${ageFailedCount} book${ageFailedCount > 1 ? 's' : ''}.`);
    }

    // Clear progress after a short delay
    batch.end('tags', 1500);
  });

  // ✅ BookDNA generation - creates structured fingerprint tags (dna:*)
  const handleGenerateDna = cancellable('dna', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('dna');
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
    let dnaChunkOffset = 0;
    let unlisten = null;

    try {
      // Listen for progress events (counted within each chunk)
      unlisten = subscribe('dna-progress', (data) => {
        const { current, title, success, error } = data;
        if (success) dnaSuccessCount++;
        else dnaFailedCount++;
        batch.update('dna', {
          current: dnaChunkOffset + current,
          total: items.length,
          success: dnaSuccessCount,
          failed: dnaFailedCount,
          currentBook: title,
        });

        if (error) {
          console.warn(`DNA generation failed for "${title}": ${error}`);
        }
      });

      // M-6: chunks of 25, each staged as it lands; Cancel stops between
      // chunks. Merge new dna: tags into existing tags (audit C-2). A failed
      // or empty answer leaves tags untouched and shows a per-book error.
      const run = await runBatchChunks(items, {
        shouldStop: () => cancel.cancelled,
        stage: 'dna',
        onChunkStart: (chunk, offset) => { dnaChunkOffset = offset; },
        callChunk: async (chunk) => {
          const chunkResults = normalizeResults(await callBackend('generate_book_dna_batch', { request: { items: chunk } }));
          return {
            results: chunkResults,
            total_processed: chunkResults.filter(r => r.success).length,
            total_failed: chunkResults.filter(r => !r.success).length,
          };
        },
        applyChunk: (result) => setGroups(prevGroups => prevGroups.map(g =>
          applyDnaResultToGroup(g, result.results.find(r => r.id === g.id)).group
        )),
      });
      const dnaResults = run.results;

      const successCount = dnaResults.filter(r => r.success).length;
      const failedCount = dnaResults.filter(r => !r.success).length;

      // Show toast
      // A cancelled run, a run stopped after repeated errors, or a thrown batch
      // gets the shared summary (with the first error); otherwise the usual toasts.
      const dnaUnusual = run.cancelled > 0 || run.notProcessed > 0 || run.firstError;
      if (dnaUnusual) {
        const dnaSummary = summarizeBatch({ op: 'dna', succeeded: successCount, failed: failedCount, cancelled: run.cancelled, notProcessed: run.notProcessed, errorMessage: run.firstError });
        if (dnaSummary) toast[dnaSummary.type](dnaSummary.title, dnaSummary.message);
      } else if (successCount > 0) {
        toast.success('BookDNA Generated', `Generated DNA fingerprints for ${successCount} book${successCount > 1 ? 's' : ''}`);
      }

      logBatchEnd(
        'dna',
        { books: selectedGroups.length, succeeded: successCount, failed: failedCount, cancelled: run.cancelled },
        dnaResults
      );
      if (failedCount > 0 && !dnaUnusual) {
        toast.error('Some DNA not generated', `${failedCount} book${failedCount > 1 ? 's' : ''} kept their existing tags`);
      }
    } catch (error) {
      console.error('BookDNA generation failed:', error);
      logEvent('batch', 'dna aborted', { error: String(error?.message || error) });
      toast.error('DNA Generation Failed', error.toString());
    } finally {
      // LOW: the progress listener is released on failure too.
      if (unlisten) unlisten();
    }

    // Clear progress after a short delay
    batch.end('dna', 1500);
  });

  // ✅ CONSOLIDATED CLASSIFY, replaces genres + tags + age + DNA + description in ONE GPT call per book
  const classifying = batch.isActive('classify');
  const classifyProgress = batch.getProgress('classify');

  const handleClassifyAll = cancellable('classify', async (includeDescription = true) => {
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

    const cancel = beginCancellable('classify');

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

    // Listen for per-book progress events (counted within each chunk)
    let classifyChunkOffset = 0;
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'classify') return;
      batch.update('classify', {
        current: classifyChunkOffset + d.current,
        currentBook: d.title,
      });
    });

    try {
      // M-6: chunks of 25, each staged as it lands; Cancel stops between
      // chunks. Local AI still batches 5 books per prompt inside each call.
      const run = await runBatchChunks(books, {
        shouldStop: () => cancel.cancelled,
        stage: 'classify',
        onChunkStart: (chunk, offset) => {
          classifyChunkOffset = offset;
          batch.update('classify', { current: offset });
        },
        callChunk: (chunk) => callBackend('classify_books_batch', {
          books: chunk,
          includeDescription,
          forceFresh: forceFresh,
          dnaEnabled,
          config,
        }),
        // Update groups with this chunk's classification results
        applyChunk: (result) => setGroups(prevGroups => {
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

            const isForceReset = idsToForceReset?.has(g.id) === true;

            // Genres/tags go through the pure applyClassifyResult (audit C-1/H-1):
            // an empty AI answer changes nothing, Force only discards an array when
            // the AI supplied a replacement for it, genres supplement by default,
            // and curated ABS tags survive via the import snapshot.
            // D-3/D-7: a book with no import snapshot (local files) passes []: none
            // of its tags is an earlier AI answer unless ai_tags says so, so a
            // tag added by hand stays. Only tags in ai_tags are replaced.
            const applied = applyClassifyResult(g.metadata, r, {
              force: isForceReset,
              preserveGenres: config?.preserve_existing_genres !== false,
              originalTags: g.abs_original?.tags ?? [],
              aiTags: g.ai_tags ?? [],
            });
            if (applied.error === 'empty-answer') {
              return {
                ...g,
                lastError: { stage: 'classify', kind: 'parse', message: 'The AI returned no genres or tags, so nothing was changed.', severity: 'error' },
              };
            }
            const updatedMeta = { ...applied.metadata };
            const genresChanged = applied.changedFields.includes('genre');
            const tagsChanged = applied.changedFields.includes('tags');

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
            return { ...next, changedFields: [...cf], lastError, ai_tags: applied.aiTags ?? g.ai_tags };
          });
        }),
      });
      const result = { results: run.results, total_processed: run.processed, total_failed: run.failed };

      unlisten();
      const successCount = result.total_processed || 0;
      const failedCount = result.total_failed || 0;

      batch.update('classify', { current: booksToProcess.length - run.cancelled - run.notProcessed, success: successCount, failed: failedCount, currentBook: 'Complete!' });

      const classifyWarnings = (result.results || []).filter(r =>
        r.errorDetail && !r.error && r.success !== false && severityForKind(r.errorDetail.kind) === 'warn'
      ).length;
      const classifySummary = summarizeBatch({ op: 'classify', succeeded: successCount, skipped: skippedClassify, warnings: classifyWarnings, failed: failedCount, cancelled: run.cancelled, notProcessed: run.notProcessed, errorMessage: run.firstError });
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
          cancelled: run.cancelled,
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
  });

  // ✅ GPT-powered description fixing for selected books (with progress)
  const handleFixDescriptionsGpt = cancellable('descriptions', async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    const cancel = beginCancellable('descriptions');
    batch.start('descriptions', { total: selectedGroups.length, fixed: 0, skipped: 0 });
    logBatchStart('descriptions', selectedGroups.length);


    // Listen for per-book progress events within each chunk
    let descChunkOffset = 0;
    const unlistenDescs = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'description') return;
      batch.update('descriptions', { current: descChunkOffset + d.current, currentBook: d.title });
    });

    // Chunks of 25; each is staged as it lands and Cancel stops between them.
    // A failed chunk puts the error on each of its books and the toast names
    // the failure count.
    const pairs = [];
    const run = await runBatchChunks(selectedGroups, {
      shouldStop: () => cancel.cancelled,
      stage: 'description',
      onChunkStart: (chunk, offset) => {
        descChunkOffset = offset;
        batch.update('descriptions', { current: offset, currentBook: chunk.map(g => g.metadata?.title).join(', ') });
      },
      callChunk: (chunk) => callBackend('fix_descriptions_with_gpt', {
        books: chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          genres: g.metadata?.genres || [],
          description: g.metadata?.description || null,
        })),
        config,
        force: forceFresh,
      }),
      applyChunk: (result, chunk) => {
        const entries = new Map((result?.results || []).map(r => [r.id, r]));
        pairs.push(...applyEntries(setGroups, chunk, g => entries.get(g.id), applyFixDescriptionResult));
        const c = tallyOutcomes(pairs).counts;
        batch.update('descriptions', { current: pairs.length, fixed: c.succeeded, skipped: c.skipped, failed: c.failed });
      },
    });
    unlistenDescs();
    const counts = reportOutcomes(toast, 'fix_descriptions', pairs, run.cancelled, { notProcessed: run.notProcessed, errorMessage: run.firstError });
    logBatchEnd('descriptions', {
      books: selectedGroups.length,
      fixed: counts.succeeded,
      skipped: counts.skipped,
      failed: counts.failed,
      cancelled: run.cancelled,
    });

    // Clear progress after a short delay
    batch.end('descriptions', 1500);
  });

  // ✅ Fix a single issue on a single book. W-8: stamps file.changes
  // (lib/applyValidationFixes.js) so Write Tags writes the fix.
  const handleFixSingleIssue = useCallback((groupId, field, suggestedValue) => {
    setGroups(prevGroups => prevGroups.map(group => (
      group.id === groupId ? applyFieldFixes(group, [{ field, value: suggestedValue }]) : group
    )));
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
        return applyFieldFixes(group, [{ field: 'author', value: canonicalAuthor }], {
          sources: { ...group.metadata?.sources, author: 'normalized' },
        });
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
        return applyFieldFixes(group, bookFixes.map(fix => ({ field: fix.field, value: fix.suggestedValue })));
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
    try {
      await runSeriesAnalysis(groupsToAnalyze);
    } catch (error) {
      toast.error('Series Analysis Failed', String(error?.message || error));
      return;
    }
    // Show modal after analysis completes
    modals.open('series');
  }, [groups, runSeriesAnalysis, selectedGroupIds, allSelected, toast]);

  // ✅ Apply selected series fixes from the review modal
  const handleApplySeriesFixes = useCallback(async (fixes) => {
    if (!fixes || fixes.length === 0) return;

    try {
      const updatedGroups = await applySeriesFixes(groups, fixes);
      if (updatedGroups.error) {
        toast.error('Series Fixes Failed', updatedGroups.error);
        return;
      }
      setGroups(updatedGroups.updatedGroups);
      clearValidation();
    } catch (error) {
      console.error('Failed to apply series fixes:', error);
      toast.error('Series Fixes Failed', String(error?.message || error));
    }
  }, [groups, setGroups, applySeriesFixes, clearValidation, toast]);

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
      if (seriesResult.error) toast.error('Series Fixes Failed', seriesResult.error);
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
    // Only process ABS-backed books (imported books may carry files, #60)
    const absImports = selectedGroups.filter(isAbsBacked);

    if (absImports.length === 0) {
      return;
    }

    try {
      const result = await handlePipelineRescan(absImports);
      if (result?.cancelled > 0) {
        toast.warning('Pipeline cancelled', `${result.count || 0} processed; the remaining ${result.cancelled} ${result.cancelled === 1 ? 'was' : 'were'} cancelled.`);
      }
      reportAutoPush(result);
      handleClearSelection();
    } catch (error) {
      console.error('Pipeline rescan failed:', error);
    }
  };

  // ✅ Selected books that live in ABS (imported books may carry files, #60)
  const getSelectedAbsImports = () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    return selectedGroups.filter(isAbsBacked);
  };

  // ✅ Clean ALL genres for all loaded books (no selection needed)
  const handleCleanupAllGenres = async () => {
    if (groups.length === 0) return;

    try {
      // ABS-backed books go through the ABS genre cleanup, local ones through
      // the regular cleanup (#60: was all-or-nothing on "no files").
      const absImports = groups.filter(isAbsBacked);
      const localGroups = groups.filter(g => !isAbsBacked(g));

      if (absImports.length > 0) {
        await handleRescanAbsImports(absImports, 'genres_only');
      }
      if (localGroups.length > 0) {
        const result = await handleCleanupGenres(localGroups);
        reportOutcomes(toast, 'genres', result.pairs || []);
      }
    } catch (error) {
      console.error('Genre cleanup failed:', error);
      toast.error('Genre Cleanup Failed', String(error?.message || error));
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
      reportAutoPush(result);
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
    // H-7: one push at a time; a second Confirm while one runs does nothing.
    if (absPushingRef.current) return;
    absPushingRef.current = true;
    setAbsPushing(true);
    // H-7: this push's own token; a Cancel left over from anything else
    // can never skip its books.
    const cancel = startCancellable();
    pushCancelRef.current = cancel;

    // #60: route by ABS item id, not by files.length - ABS-imported books
    // carry their audio files too, and the path-based branch cannot push them.
    // Outcomes are surfaced via toast and the session log instead of console.
    try {
      logEvent('push', 'ABS push start', { books: pushGroups.length });
      // #62: local folders have no ABS item; runPush skips them with the reason.
      const outcome = await runPush(pushGroups, {
        pushById: handlePushAbsImports,
        cancel,
      });
      const { summary } = outcome;
      (toast[summary.type] || toast.info)(summary.title, summary.message);
      logEvent('push', 'ABS push complete', {
        books: outcome.attempted,
        byId: outcome.absCount,
        byPath: outcome.localCount,
        updated: outcome.updated.length,
        skipped: outcome.skipped.length,
        failed: outcome.failed.length,
        failedBooks: outcome.failed.slice(0, 5),
      });
    } catch (error) {
      console.error('Push failed:', error);
      toast.error('Push Failed', String(error?.message || error));
      logEvent('push', 'ABS push threw', { error: String(error?.message || error) });
    } finally {
      absPushingRef.current = false;
      setAbsPushing(false);
      pushCancelRef.current = null;
      finishCancellable(cancel);
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
        onScan={handleScanFolder}
        onRescan={handleRescanClick}
        onPipelineRescan={handlePipelineClick}
        onWrite={handleWriteClick}
        onRename={handleRenameClick}
        onUndo={handleUndo}
        undoAvailable={!!undoStatus?.available}
        undoing={undoing}
        selectedGroups={getSelectedGroups()}
        onPush={handlePushClick}
        onPull={handleImportFromAbsNotify}
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
        filteredGroups={listFilteredGroups}
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
        pushing={pushing || absPushing}
        scanning={scanning}
        scanningFolder={scanningFolder}
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
        hasAbsConnection={hasAbsConnection(config)}
        hasOpenAiKey={hasAiProvider(config)}
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
          onScan={handleScanFolder}
          onImportFromAbs={handleImportFromAbsNotify}
          onCleanupAllGenres={handleCleanupAllGenres}
          scanning={scanning}
          onSelectAll={handleSelectAll}
          onSelectFiltered={handleSelectFiltered}
          onFilteredGroupsChange={setListFilteredGroups}
          onClearSelection={handleClearSelection}
          onExport={() => modals.open('export')}
          validationResults={validationResults}
          hasAbsConnection={hasAbsConnection(config)}
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
              // H-2: a year edit moves `year` and `published_year` together.
              const patch = field === 'year' || field === 'published_year'
                ? setYear({}, value)
                : { [field]: value };
              return applyMetadataToGroup(
                g,
                { ...patch, ...userClearedPatch(g.metadata, patch) },
                [field === 'published_year' ? 'year' : fileField]
              );
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
          // H-7: only operations that stop on a Cancel offer one.
          onCancel={scanCancellable ? cancelScan : undefined}
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
          onCancel={() => handleCancelBatch('tags')}
        />
      )}

      {fixingDescriptions && descProgress.total > 0 && (
        <ProgressBar
          type="descriptions"
          progress={descProgress}
          onCancel={() => handleCancelBatch('descriptions')}
        />
      )}

      {fixingTitles && titleProgress.total > 0 && (
        <ProgressBar
          type="titles"
          progress={titleProgress}
          onCancel={() => handleCancelBatch('titles')}
        />
      )}

      {fixingSubtitles && subtitleProgress.total > 0 && (
        <ProgressBar
          type="subtitles"
          progress={subtitleProgress}
          onCancel={() => handleCancelBatch('subtitles')}
        />
      )}

      {fixingAuthors && authorProgress.total > 0 && (
        <ProgressBar
          type="authors"
          progress={authorProgress}
          onCancel={() => handleCancelBatch('authors')}
        />
      )}

      {fixingYears && yearProgress.total > 0 && (
        <ProgressBar
          type="years"
          progress={yearProgress}
          onCancel={() => handleCancelBatch('years')}
        />
      )}

      {fixingSeries && seriesProgress.total > 0 && (
        <ProgressBar
          type="series"
          progress={seriesProgress}
          onCancel={() => handleCancelBatch('series')}
        />
      )}

      {lookingUpAge && ageProgress.total > 0 && (
        <ProgressBar
          type="age"
          progress={ageProgress}
          onCancel={() => handleCancelBatch('age')}
        />
      )}

      {lookingUpISBN && isbnProgress.total > 0 && (
        <ProgressBar
          type="isbn"
          progress={isbnProgress}
          onCancel={() => handleCancelBatch('isbn')}
        />
      )}

      {runningAll && runAllProgress.total > 0 && (
        <ProgressBar
          type="enrichment"
          progress={runAllProgress}
          onCancel={() => handleCancelBatch('enrichment')}
        />
      )}

      {generatingDna && dnaProgress.total > 0 && (
        <ProgressBar
          type="dna"
          progress={dnaProgress}
          onCancel={() => handleCancelBatch('dna')}
        />
      )}

      {cleaningGenres && genreProgress.total > 0 && (
        <ProgressBar
          type="genres"
          progress={genreProgress}
          onCancel={() => handleCancelBatch('genres')}
        />
      )}

      {resolvingMetadata && metadataProgress.total > 0 && (
        <ProgressBar
          type="metadata"
          progress={metadataProgress}
          onCancel={() => handleCancelBatch('metadata')}
        />
      )}

      {classifying && classifyProgress.total > 0 && (
        <ProgressBar
          type="classify"
          progress={classifyProgress}
          onCancel={() => handleCancelBatch('classify')}
        />
      )}

      {processingDescriptions && descriptionProgress.total > 0 && (
        <ProgressBar
          type="descriptionProcessing"
          progress={descriptionProgress}
          onCancel={() => handleCancelBatch('descriptionProcessing')}
        />
      )}

      {extractingByAudio && batch.getProgress('audio_check').total > 0 && (
        <ProgressBar
          type="audio_check"
          progress={batch.getProgress('audio_check')}
          onCancel={async () => {
            // The Rust side has its own cancel flag for the audio check; the
            // JS token stops anything still queued behind it.
            requestCancel(opCancelRef.current.audio_check);
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
          // per-book. #62: only the selected local books' files.
          files={getSelectedGroups().filter(isLocalGroup).flatMap(group => {
            const groupFiles = group.files || [];
            return groupFiles
              .map((file, index) => ({
                fileId: file.id, path: file.path, metadata: group.metadata,
                part: index + 1, totalParts: groupFiles.length,
              }))
              .filter(f => f.fileId != null && f.path);
          })}
          onConfirm={handleConfirmRename}
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
        onCancelPush={() => { if (pushCancelRef.current) requestCancel(pushCancelRef.current); }}
        groups={modals.data.push?.groups || []}
        pushing={pushing || absPushing}
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