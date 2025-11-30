import { useState, useEffect } from 'react';
import { BookList } from '../components/scanner/BookList';
import { MetadataPanel } from '../components/scanner/MetadataPanel';
import { ActionBar } from '../components/scanner/ActionBar';
import { ProgressBar } from '../components/scanner/ProgressBar';
import { EditMetadataModal } from '../components/EditMetadataModal';
import { BulkEditModal } from '../components/BulkEditModal';
import { RenamePreviewModal } from '../components/RenamePreviewModal';
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

  // FIXED: Prevent text selection on Shift+Click and properly handle range selection
  const handleGroupClick = (group, index, event) => {
    if (event.shiftKey) {
      event.preventDefault();
    }

    setSelectedGroup(group);
    
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

  // Get selected groups for bulk edit
  const getSelectedGroups = () => {
    return groups.filter(g => selectedGroupIds.has(g.id));
  };

  // Handle bulk edit save
  const handleBulkSave = (updates) => {
    if (selectedGroupIds.size === 0) return;

    setGroups(prevGroups =>
      prevGroups.map(group => {
        if (!selectedGroupIds.has(group.id)) return group;

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

  // ✅ SIMPLIFIED - No popups, just write
  const handleWriteClick = async () => {
    if (selectedFiles.size === 0) {
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
      const result = await writeSelectedTags(selectedFiles, false); // false = no backup for speed
      console.log(`✅ Wrote ${result.success} files, ${result.failed} failed`);
      
      if (result.success > 0) {
        handleClearSelection();
      }
    } catch (error) {
      console.error('Write failed:', error);
    }
  };

  // ✅ SIMPLIFIED - No popup
  const handleRenameClick = () => {
    if (selectedFiles.size === 0) return;
    setShowRenameModal(true);
  };

  // ✅ SIMPLIFIED - No popup, just rescan
  const handleRescanClick = async () => {
    if (selectedFiles.size === 0) return;

    try {
      console.log(`🔄 Rescanning ${selectedFiles.size} files...`);
      const result = await handleRescan(selectedFiles, groups);
      console.log(`✅ Rescanned ${result.count} books`);
      handleClearSelection();
      clearFileStatuses();
    } catch (error) {
      console.error('Rescan failed:', error);
    }
  };

  // ✅ SIMPLIFIED - No popup, just push
  const handlePushClick = async () => {
    const successCount = getSuccessCount(fileStatuses);
    
    if (successCount === 0) {
      console.log('No files ready to push');
      return;
    }

    try {
      console.log(`📤 Pushing ${successCount} files to AudiobookShelf...`);
      const successfulFileIds = Array.from(selectedFiles).filter(id => fileStatuses[id] === 'success');
      
      const result = await pushToAudiobookShelf(
        new Set(successfulFileIds),
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
    } catch (error) {
      console.error('Push failed:', error);
    }
  };

  return (
    <div className="h-full flex flex-col relative">
      {/* Action bars at the top */}
      <ActionBar
        selectedFiles={selectedFiles}
        groups={groups}
        fileStatuses={fileStatuses}
        selectedGroupCount={selectedGroupIds.size}
        onRescan={handleRescanClick}
        onWrite={handleWriteClick}
        onRename={handleRenameClick}
        onPush={handlePushClick}
        onBulkEdit={() => setShowBulkEditModal(true)}
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

      {showBulkEditModal && selectedGroupIds.size > 0 && (
        <BulkEditModal
          isOpen={showBulkEditModal}
          onClose={() => setShowBulkEditModal(false)}
          onSave={handleBulkSave}
          selectedGroups={getSelectedGroups()}
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
              console.error('Rename failed:', error);
            }
          }}
          onCancel={() => setShowRenameModal(false)}
        />
      )}
    </div>
  );
}