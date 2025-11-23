import { useState, useEffect } from 'react';
import { BookList } from '../components/scanner/BookList';
import { MetadataPanel } from '../components/scanner/MetadataPanel';
import { ActionBar } from '../components/scanner/ActionBar';
import { ProgressBar } from '../components/scanner/ProgressBar';
import { EditMetadataModal } from '../components/EditMetadataModal';
import { RenamePreviewModal } from '../components/RenamePreviewModal';
import { WritePreviewModal } from '../components/WritePreviewModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { useScan } from '../hooks/useScan';
import { useFileSelection } from '../hooks/useFileSelection';
import { useTagOperations } from '../hooks/useTagOperations';
import { useApp } from '../context/AppContext';

export function ScannerPage({ onActionsReady }) {
  const { groups, setGroups, fileStatuses, updateFileStatuses, clearFileStatuses, writeProgress } = useApp();
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [showWritePreview, setShowWritePreview] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  
  const {
    scanning,
    scanProgress,
    calculateETA,
    handleScan,
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
    lastSelectedIndex,
    setLastSelectedIndex,
    selectAllInGroup,
    clearSelection,
    selectAll,
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

  const showConfirm = (config) => {
    setConfirmModal(config);
  };

  const hideConfirm = () => {
    setConfirmModal(null);
  };

  // FIXED: Prevent text selection on Shift+Click and properly handle range selection
const handleGroupClick = (group, index, event) => {
  // PREVENT TEXT SELECTION on Shift+Click
  if (event.shiftKey) {
    event.preventDefault();
  }

  setSelectedGroup(group);
  
  if (event.shiftKey && lastSelectedIndex !== null) {
    // Shift-click: select range
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
    // Normal click without modifier keys: DESELECT others, select only this one
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

  const handleSelectAll = () => {
    const allFiles = new Set();
    const allGroupIds = new Set();
    
    groups.forEach(group => {
      allGroupIds.add(group.id);
      group.files.forEach(file => allFiles.add(file.id));
    });
    
    setSelectedFiles(allFiles);
    setSelectedGroupIds(allGroupIds);
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

  const handleWriteClick = () => {
    const filesWithChanges = getFilesWithChanges(groups);
    
    if (selectedFiles.size === 0) {
      showConfirm({
        title: "No Files Selected",
        message: "Please select files to write tags to before proceeding.",
        confirmText: "OK",
        type: "info",
        onConfirm: () => {}
      });
      return;
    }

    if (filesWithChanges.length === 0) {
      showConfirm({
        title: "No Changes to Write",
        message: "The selected files don't have any pending changes to write.",
        confirmText: "OK",
        type: "info",
        onConfirm: () => {}
      });
      return;
    }

    setShowWritePreview(true);
  };

  const performWrite = async () => {
    try {
      const result = await writeSelectedTags(selectedFiles);
      
      if (result.failed > 0) {
        showConfirm({
          title: "Write Results",
          message: `Successfully written: ${result.success} files\nFailed: ${result.failed} files\n\nCheck the status indicators for details.`,
          confirmText: "OK",
          type: "warning",
          onConfirm: () => {}
        });
      } else {
        showConfirm({
          title: "Write Complete",
          message: `Successfully wrote tags to ${result.success} files!`,
          confirmText: "OK",
          type: "info",
          onConfirm: () => {
            handleClearSelection();
          }
        });
      }
    } catch (error) {
      showConfirm({
        title: "Write Failed",
        message: `Failed to write tags: ${error}`,
        confirmText: "OK",
        type: "danger",
        onConfirm: () => {}
      });
    }
  };

  const handleRenameClick = () => {
    if (selectedFiles.size === 0) {
      showConfirm({
        title: "No Files Selected",
        message: "Please select files to rename before proceeding.",
        confirmText: "OK",
        type: "info",
        onConfirm: () => {}
      });
      return;
    }

    setShowRenameModal(true);
  };

  const handleRescanClick = async () => {
    if (selectedFiles.size === 0) {
      showConfirm({
        title: "No Files Selected",
        message: "Please select files to rescan before proceeding.",
        confirmText: "OK",
        type: "info",
        onConfirm: () => {}
      });
      return;
    }

    showConfirm({
      title: "Rescan Selected Files",
      message: `Re-scan ${selectedFiles.size} selected file(s) for fresh metadata?`,
      confirmText: "Rescan Files",
      type: "info",
      onConfirm: async () => {
        try {
          const result = await handleRescan(selectedFiles, groups);
          handleClearSelection();
          clearFileStatuses();
          
          showConfirm({
            title: "Rescan Complete",
            message: `Successfully rescanned ${result.count} book(s).`,
            confirmText: "OK",
            type: "info",
            onConfirm: () => {}
          });
        } catch (error) {
          showConfirm({
            title: "Rescan Failed",
            message: `Failed to rescan: ${error}`,
            confirmText: "OK",
            type: "danger",
            onConfirm: () => {}
          });
        }
      }
    });
  };

const handlePushClick = () => {
  const successCount = getSuccessCount(fileStatuses);
  
  if (successCount === 0) {
    showConfirm({
      title: "No Files Ready",
      message: "No successfully written files to push. Please write tags first.",
      confirmText: "OK",
      type: "info",
      onConfirm: () => {}
    });
    return;
  }

  showConfirm({
    title: "Push to AudiobookShelf",
    message: `Push ${successCount} file(s) to AudiobookShelf server?\n\nFiles will be processed in batches to avoid memory issues.`,
    confirmText: `Push ${successCount} Files`,
    type: "info",
    onConfirm: async () => {
      try {
        const successfulFileIds = Array.from(selectedFiles).filter(id => fileStatuses[id] === 'success');
        
        // Show progress during push
        const result = await pushToAudiobookShelf(
          new Set(successfulFileIds),
          (progress) => {
            console.log(`Progress: ${progress.itemsProcessed}/${progress.totalItems} items (chunk ${progress.current}/${progress.total})`);
          }
        );
        
        let message = `✅ Successfully updated ${result.updated || 0} item${result.updated === 1 ? '' : 's'} in AudiobookShelf!`;

        if (result.unmatched && result.unmatched.length > 0) {
          message += `\n\n⚠️ Unmatched files: ${result.unmatched.slice(0, 5).join(', ')}${
            result.unmatched.length > 5 ? `... (+${result.unmatched.length - 5} more)` : ''
          }`;
        }

        if (result.failed && result.failed.length > 0) {
          message += `\n\n❌ Failed: ${result.failed.length} item${result.failed.length === 1 ? '' : 's'}`;
        }

        showConfirm({
          title: "Push Complete",
          message: message,
          confirmText: "OK",
          type: result.failed?.length > 0 ? "warning" : "info",
          onConfirm: () => {}
        });
      } catch (error) {
        showConfirm({
          title: "Push Failed",
          message: `Failed to push updates: ${error.toString()}`,
          confirmText: "OK",
          type: "danger",
          onConfirm: () => {}
        });
      }
    }
  });
};

  return (
    <div className="h-full flex flex-col relative">
      {/* Action bars at the top */}
      <ActionBar
        selectedFiles={selectedFiles}
        groups={groups}
        fileStatuses={fileStatuses}
        onRescan={handleRescanClick}
        onWrite={handleWriteClick}
        onRename={handleRenameClick}
        onPush={handlePushClick}
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
          scanning={scanning}
          onSelectAll={handleSelectAll}
          onClearSelection={handleClearSelection}
        />

        <MetadataPanel
          group={selectedGroup}
          onEdit={handleEditMetadata}
        />
      </div>

      {/* Progress bars */}
      {(() => {
        // console.log('🔵 ScannerPage render - scanning:', scanning, 'progress:', scanProgress);
        return scanning && (
          <ProgressBar
            key={scanProgress.startTime} 
            type="scan"
            progress={scanProgress}
            onCancel={cancelScan}
            calculateETA={calculateETA}
          />
        );
      })()}

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

      {showRenameModal && (
        <RenamePreviewModal
          selectedFiles={Array.from(selectedFiles).map(id => {
            for (const group of groups) {
              const file = group.files.find(f => f.id === id);
              if (file) return file.path;
            }
            return null;
          }).filter(Boolean)}
          metadata={selectedGroup?.metadata}
          onConfirm={async () => {
            try {
              await renameFiles(selectedFiles);
              setShowRenameModal(false);
              await handleScan();
            } catch (error) {
              showConfirm({
                title: "Rename Failed",
                message: `Failed to rename files: ${error}`,
                confirmText: "OK",
                type: "danger",
                onConfirm: () => {}
              });
            }
          }}
          onCancel={() => setShowRenameModal(false)}
        />
      )}

      {showWritePreview && (
        <WritePreviewModal
          isOpen={showWritePreview}
          onClose={() => setShowWritePreview(false)}
          onConfirm={performWrite}
          selectedFiles={selectedFiles}
          groups={groups}
          backupEnabled={true}
        />
      )}

      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          onClose={hideConfirm}
          onConfirm={confirmModal.onConfirm}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          cancelText={confirmModal.cancelText}
          type={confirmModal.type}
        />
      )}
    </div>
  );
}