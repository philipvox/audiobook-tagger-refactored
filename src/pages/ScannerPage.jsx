import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookList } from '../components/scanner/BookList';
import { MetadataPanel } from '../components/scanner/MetadataPanel';
import { ActionBar } from '../components/scanner/ActionBar';
import { ProgressBar } from '../components/scanner/ProgressBar';
import { EditMetadataModal } from '../components/EditMetadataModal';
import { BulkEditModal } from '../components/BulkEditModal';
import { RenamePreviewModal } from '../components/RenamePreviewModal';
import { ExportImportModal } from '../components/ExportImportModal';
import { RescanModal } from '../components/RescanModal';
import { ABSPushModal } from '../components/ABSPushModal';
import { UndoToast } from '../components/UndoToast';
import { useScan } from '../hooks/useScan';
import { useFileSelection } from '../hooks/useFileSelection';
import { useTagOperations } from '../hooks/useTagOperations';
import { useApp } from '../context/AppContext';

export function ScannerPage({ onActionsReady }) {
  const { config, groups, setGroups, fileStatuses, updateFileStatuses, clearFileStatuses, writeProgress } = useApp();
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showRescanModal, setShowRescanModal] = useState(false);
  const [showPushModal, setShowPushModal] = useState(false);
  const [groupsToPush, setGroupsToPush] = useState([]);

  // Undo state
  const [undoStatus, setUndoStatus] = useState(null);
  const [undoing, setUndoing] = useState(false);
  const [showUndoToast, setShowUndoToast] = useState(false);

  // Check undo status
  const checkUndoStatus = useCallback(async () => {
    try {
      const status = await invoke('get_undo_status');
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
      const result = await invoke('undo_last_write');
      console.log(`⏪ Undo complete: ${result.restored} restored, ${result.deleted} deleted`);
      setShowUndoToast(false);
      setUndoStatus(null);

      // Refresh the scan to show restored state
      if (result.success > 0) {
        // Could trigger a rescan here if needed
        console.log('Undo successful - may need to rescan to see restored data');
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
      await invoke('clear_undo_state');
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
    handlePushAbsImports,
    handleCleanupGenres,
    handleRescan,
    cancelScan
  } = useScan();

  useEffect(() => {
    if (onActionsReady) {
      onActionsReady({ handleScan, scanning });
    }
  }, [handleScan, scanning, onActionsReady]);

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
  const handleGroupClick = (group, index, event) => {
    if (event.shiftKey) {
      event.preventDefault();
    }

    setSelectedGroup(group);

    // Cancel "all selected" mode when clicking individual groups
    if (allSelected) {
      setAllSelected(false);
    }

    if (event.shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);

      const newSelectedFiles = new Set(selectedFiles);
      const newSelectedGroupIds = new Set(selectedGroupIds);

      for (let i = start; i <= end; i++) {
        const g = groups[i];
        newSelectedGroupIds.add(g.id);
        g.files.forEach(f => newSelectedFiles.add(f.id));
      }

      setSelectedFiles(newSelectedFiles);
      setSelectedGroupIds(newSelectedGroupIds);
    } else if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
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

  const handleClearSelection = () => {
    clearSelection();
    setSelectedGroupIds(new Set());
  };

  const handleEditMetadata = (group) => {
    setEditingGroup(group);
    setShowEditModal(true);
  };

  const handleSaveMetadata = (newMetadata) => {
    if (!editingGroup) return;
    
    setGroups(prevGroups => 
      prevGroups.map(group => {
        if (group.id === editingGroup.id) {
          const updatedFiles = group.files.map(file => {
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
            
            if (newMetadata.genres.length > 0) {
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
    
    setEditingGroup(null);
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
        const updatedFiles = group.files.map(file => {
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

    console.log(`✅ Bulk updated ${selectedGroupIds.size} books`);
  };

  // Handle import from CSV/JSON
  const handleDataImport = (updates) => {
    if (!updates || updates.length === 0) return;

    // If updates is an array of BookGroups (from JSON import)
    if (updates[0]?.files) {
      // Full JSON import - replace groups
      console.log(`📥 Imported ${updates.length} books from JSON`);
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
        const updatedFiles = group.files.map(file => {
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

    console.log(`📥 Applied ${updates.length} updates from import`);
  };

  // ✅ SIMPLIFIED - No popups, just write
  const handleWriteClick = async () => {
    const selectedCount = getSelectedCount(groups);
    if (selectedCount === 0 && !allSelected) {
      console.log('No files selected');
      return;
    }

    const filesWithChanges = getFilesWithChanges(groups);
    if (filesWithChanges.length === 0) {
      console.log('No changes to write');
      return;
    }

    try {
      console.log(`🚀 Writing ${filesWithChanges.length} files...`);
      const actualSelectedFiles = getSelectedFileIds(groups);
      const result = await writeSelectedTags(actualSelectedFiles, false); // false = no backup for speed
      console.log(`✅ Wrote ${result.success} files, ${result.failed} failed`);

      if (result.success > 0) {
        handleClearSelection();
        // Check undo status after successful write
        await checkUndoStatus();
      }
    } catch (error) {
      console.error('Write failed:', error);
    }
  };

  // ✅ SIMPLIFIED - No popup
  const handleRenameClick = () => {
    const selectedCount = getSelectedCount(groups);
    if (selectedCount === 0 && !allSelected) return;
    setShowRenameModal(true);
  };

  // ✅ Rescan with configurable mode and optional selective fields
  // @param {string} scanMode - 'normal', 'refresh_metadata', 'force_fresh', 'selective_refresh', 'super_scanner'
  // @param {Array} selectiveFields - Optional array of field names for selective refresh
  // @param {Object} options - Optional options like { enableTranscription: bool }
  const handleRescanClick = async (scanMode = 'force_fresh', selectiveFields = null, options = {}) => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) return;

    // Check if these are ABS imports (no local files)
    const absImports = selectedGroups.filter(g => g.files.length === 0);
    const localFiles = selectedGroups.filter(g => g.files.length > 0);

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
        console.log(`🔄 ${modeLabel} for ${absImports.length} ABS imports...`);
        // For ABS imports, use force_fresh mode which searches APIs
        // Pass selectiveFields to only update specific fields if custom rescan
        const result = await handleRescanAbsImports(absImports, 'force_fresh', true, selectiveFields);
        console.log(`✅ Rescanned ${result.count} ABS books`);
      }

      // Handle local files (if any mixed in)
      if (localFiles.length > 0) {
        const transcriptionLabel = options.enableTranscription ? ' + audio verification' : '';
        console.log(`🔄 ${modeLabel}${transcriptionLabel} for ${localFiles.length} local books...`);
        const actualSelectedFiles = getSelectedFileIds(groups);
        const result = await handleRescan(actualSelectedFiles, groups, scanMode, selectiveFields, options);
        console.log(`✅ Rescanned ${result.count} local books`);
      }

      handleClearSelection();
      clearFileStatuses();
    } catch (error) {
      console.error('Rescan failed:', error);
    }
  };

  // ✅ Genre cleanup for selected books (no rescan)
  const handleGenreCleanup = async () => {
    const selectedCount = getSelectedCount(groups);
    if (selectedCount === 0 && !allSelected) return;

    try {
      const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
      const result = await handleCleanupGenres(selectedGroups);
      console.log(`✅ Cleaned genres for ${result.count} books`);
    } catch (error) {
      console.error('Genre cleanup failed:', error);
    }
  };

  // ✅ Check if selected books are ABS-imported (no local files)
  const getSelectedAbsImports = () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    return selectedGroups.filter(g => g.files.length === 0);
  };

  // ✅ Clean ALL genres for all loaded books (no selection needed)
  const handleCleanupAllGenres = async () => {
    if (groups.length === 0) return;

    try {
      // Check if these are ABS imports (no files)
      const absImports = groups.filter(g => g.files.length === 0);

      if (absImports.length > 0) {
        // Use ABS rescan for genre cleanup
        console.log(`🧹 Cleaning genres for ${absImports.length} ABS imports...`);
        const result = await handleRescanAbsImports(absImports, 'genres_only');
        console.log(`✅ Cleaned genres for ${result.count} books`);
      } else {
        // Use regular genre cleanup
        console.log(`🧹 Cleaning genres for ${groups.length} books...`);
        const result = await handleCleanupGenres(groups);
        console.log(`✅ Cleaned genres for ${result.count} books`);
      }
    } catch (error) {
      console.error('Genre cleanup failed:', error);
    }
  };

  // ✅ Rescan ABS imports with fresh API data
  const handleAbsRescan = async (mode = 'force_fresh') => {
    const absImports = getSelectedAbsImports();
    if (absImports.length === 0) return;

    try {
      const modeLabel = mode === 'genres_only' ? 'genre cleanup' : 'fresh scan';
      console.log(`🔄 ${modeLabel} for ${absImports.length} ABS imports...`);
      const result = await handleRescanAbsImports(absImports, mode);
      console.log(`✅ ${result.count} books updated`);
      handleClearSelection();
    } catch (error) {
      console.error('ABS rescan failed:', error);
    }
  };

  // ✅ Show push confirmation modal before pushing
  const handlePushClick = () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) {
      console.log('No groups selected');
      return;
    }
    setGroupsToPush(selectedGroups);
    setShowPushModal(true);
  };

  // ✅ Actually push after confirmation
  const handleConfirmPush = async () => {
    if (groupsToPush.length === 0) return;

    // Check if these are ABS imports (no local files)
    const absImports = groupsToPush.filter(g => g.files.length === 0);
    const localFiles = groupsToPush.filter(g => g.files.length > 0);

    try {
      // Handle ABS imports - use direct ID-based push
      if (absImports.length > 0) {
        console.log(`📤 Pushing ${absImports.length} ABS imports directly...`);
        const result = await handlePushAbsImports(absImports);
        console.log(`✅ ABS push: ${result.updated} updated, ${result.failed || 0} failed`);
      }

      // Handle local files - use path-based push
      if (localFiles.length > 0) {
        console.log(`📤 Pushing ${localFiles.length} local books to AudiobookShelf...`);
        const actualSelectedFiles = getSelectedFileIds(groups);

        const result = await pushToAudiobookShelf(
          actualSelectedFiles,
          (progress) => {
            console.log(`Progress: ${progress.itemsProcessed}/${progress.totalItems} items`);
          }
        );

        console.log(`✅ Pushed ${result.updated || 0} items`);

        if (result.unmatched?.length > 0) {
          console.log(`⚠️ Unmatched: ${result.unmatched.length} files`);
        }
        if (result.failed?.length > 0) {
          console.log(`❌ Failed: ${result.failed.length} files`);
        }
      }
    } catch (error) {
      console.error('Push failed:', error);
    } finally {
      setShowPushModal(false);
      setGroupsToPush([]);
    }
  };

  return (
    <div className="h-full flex flex-col relative">
      {/* Action bars at the top */}
      <ActionBar
        selectedFiles={selectedFiles}
        allSelected={allSelected}
        groups={groups}
        fileStatuses={fileStatuses}
        selectedGroupCount={selectedGroupIds.size}
        onRescan={handleRescanClick}
        onWrite={handleWriteClick}
        onRename={handleRenameClick}
        onPush={handlePushClick}
        onBulkEdit={() => setShowBulkEditModal(true)}
        onOpenRescanModal={() => setShowRescanModal(true)}
        onCleanupGenres={handleGenreCleanup}
        onAbsRescan={handleAbsRescan}
        absImportCount={getSelectedAbsImports().length}
        onClearSelection={handleClearSelection}
        writing={writing}
        pushing={pushing}
        scanning={scanning}
      />

      {/* Main content area with book list and metadata panel */}
      <div className="flex-1 flex overflow-hidden bg-gray-50">
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
          onClearSelection={handleClearSelection}
          onExport={() => setShowExportModal(true)}
        />

        <MetadataPanel
          group={selectedGroup}
          onEdit={handleEditMetadata}
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

      {/* Modals */}
      {showEditModal && editingGroup && (
        <EditMetadataModal
          isOpen={showEditModal}
          onClose={() => {
            setShowEditModal(false);
            setEditingGroup(null);
          }}
          onSave={handleSaveMetadata}
          metadata={editingGroup.metadata}
          groupName={editingGroup.group_name}
        />
      )}

      {showBulkEditModal && (selectedGroupIds.size > 0 || allSelected) && (
        <BulkEditModal
          isOpen={showBulkEditModal}
          onClose={() => setShowBulkEditModal(false)}
          onSave={handleBulkSave}
          selectedGroups={getSelectedGroups()}
        />
      )}

      {showExportModal && (
        <ExportImportModal
          isOpen={showExportModal}
          onClose={() => setShowExportModal(false)}
          groups={groups}
          onImport={handleDataImport}
        />
      )}

      {showRenameModal && (
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
              setShowRenameModal(false);
              await handleScan();
            } catch (error) {
              console.error('Rename failed:', error);
            }
          }}
          onCancel={() => setShowRenameModal(false)}
        />
      )}

      {showRescanModal && (
        <RescanModal
          isOpen={showRescanModal}
          onClose={() => setShowRescanModal(false)}
          onRescan={handleRescanClick}
          selectedCount={allSelected ? groups.reduce((sum, g) => sum + g.files.length, 0) : selectedFiles.size}
          scanning={scanning}
        />
      )}

      {/* ABS Push Confirmation Modal */}
      <ABSPushModal
        isOpen={showPushModal}
        onClose={() => {
          setShowPushModal(false);
          setGroupsToPush([]);
        }}
        onConfirm={handleConfirmPush}
        groups={groupsToPush}
        pushing={pushing}
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