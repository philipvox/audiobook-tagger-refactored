import { useState, useCallback, useMemo } from 'react';

export function useFileSelection() {
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState(null);
  // Optimization: use a flag for "all selected" instead of huge Sets
  const [allSelected, setAllSelected] = useState(false);

  const toggleFile = useCallback((fileId) => {
    setAllSelected(false); // Cancel "all selected" mode when toggling individual files
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });
  }, []);

  const selectAllInGroup = useCallback((group, checked) => {
    setAllSelected(false);
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      group.files.forEach(file => {
        if (checked) {
          newSet.add(file.id);
        } else {
          newSet.delete(file.id);
        }
      });
      return newSet;
    });
  }, []);

  const selectRange = useCallback((groups, startIndex, endIndex) => {
    setAllSelected(false);
    setSelectedFiles(prev => {
      const newSelected = new Set(prev);
      const start = Math.min(startIndex, endIndex);
      const end = Math.max(startIndex, endIndex);

      for (let i = start; i <= end; i++) {
        if (groups[i]) {
          groups[i].files.forEach(file => {
            newSelected.add(file.id);
          });
        }
      }
      return newSelected;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedFiles(new Set());
    setAllSelected(false);
    setLastSelectedIndex(null);
  }, []);

  // Optimized: Just set flag, don't build huge Set
  const selectAll = useCallback((groups) => {
    setAllSelected(true);
    // Keep selectedFiles empty - we use allSelected flag instead
    setSelectedFiles(new Set());
  }, []);

  // Check if a file is selected (handles allSelected mode)
  const isFileSelected = useCallback((fileId) => {
    if (allSelected) return true;
    return selectedFiles.has(fileId);
  }, [allSelected, selectedFiles]);

  // Check if a group is selected (handles allSelected mode)
  const isGroupSelected = useCallback((groupId, group) => {
    if (allSelected) return true;
    // A group is selected if all its files are selected
    return group.files.every(f => selectedFiles.has(f.id));
  }, [allSelected, selectedFiles]);

  // Get selected file IDs (materializes the selection when needed)
  const getSelectedFileIds = useCallback((groups) => {
    if (allSelected) {
      return new Set(groups.flatMap(g => g.files.map(f => f.id)));
    }
    return selectedFiles;
  }, [allSelected, selectedFiles]);

  // Get count of selected files
  const getSelectedCount = useCallback((groups) => {
    if (allSelected) {
      return groups.reduce((sum, g) => sum + g.files.length, 0);
    }
    return selectedFiles.size;
  }, [allSelected, selectedFiles]);

  const getSuccessCount = useCallback((fileStatuses, groups) => {
    if (allSelected) {
      return groups.reduce((count, g) => {
        return count + g.files.filter(f => fileStatuses[f.id] === 'success').length;
      }, 0);
    }
    return Array.from(selectedFiles).filter(id => fileStatuses[id] === 'success').length;
  }, [allSelected, selectedFiles]);

  const getFailedCount = useCallback((fileStatuses, groups) => {
    if (allSelected) {
      return groups.reduce((count, g) => {
        return count + g.files.filter(f => fileStatuses[f.id] === 'failed').length;
      }, 0);
    }
    return Array.from(selectedFiles).filter(id => fileStatuses[id] === 'failed').length;
  }, [allSelected, selectedFiles]);

  const getFilesWithChanges = useCallback((groups) => {
    if (allSelected) {
      return groups.flatMap(g =>
        g.files.filter(f => Object.keys(f.changes).length > 0).map(f => f.id)
      );
    }
    return Array.from(selectedFiles).filter(id => {
      for (const group of groups) {
        const file = group.files.find(f => f.id === id);
        if (file && Object.keys(file.changes).length > 0) return true;
      }
      return false;
    });
  }, [allSelected, selectedFiles]);

  return {
    selectedFiles,
    setSelectedFiles,
    allSelected,
    setAllSelected,
    lastSelectedIndex,
    setLastSelectedIndex,
    toggleFile,
    selectAllInGroup,
    selectRange,
    clearSelection,
    selectAll,
    isFileSelected,
    isGroupSelected,
    getSelectedFileIds,
    getSelectedCount,
    getSuccessCount,
    getFailedCount,
    getFilesWithChanges
  };
}
