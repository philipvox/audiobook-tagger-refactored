import { useState, useCallback } from 'react';

export function useFileSelection() {
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState(null);

  const toggleFile = useCallback((fileId) => {
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
    const newSelected = new Set(selectedFiles);
    const start = Math.min(startIndex, endIndex);
    const end = Math.max(startIndex, endIndex);
    
    for (let i = start; i <= end; i++) {
      if (groups[i]) {
        groups[i].files.forEach(file => {
          newSelected.add(file.id);
        });
      }
    }
    
    setSelectedFiles(newSelected);
  }, [selectedFiles]);

  const clearSelection = useCallback(() => {
    setSelectedFiles(new Set());
    setLastSelectedIndex(null);
  }, []);

  const selectAll = useCallback((groups) => {
    const allFileIds = groups.flatMap(g => g.files.map(f => f.id));
    setSelectedFiles(new Set(allFileIds));
  }, []);

  const getSuccessCount = useCallback((fileStatuses) => {
    return Array.from(selectedFiles).filter(id => fileStatuses[id] === 'success').length;
  }, [selectedFiles]);

  const getFailedCount = useCallback((fileStatuses) => {
    return Array.from(selectedFiles).filter(id => fileStatuses[id] === 'failed').length;
  }, [selectedFiles]);

  const getFilesWithChanges = useCallback((groups) => {
    return Array.from(selectedFiles).filter(id => {
      for (const group of groups) {
        const file = group.files.find(f => f.id === id);
        if (file && Object.keys(file.changes).length > 0) return true;
      }
      return false;
    });
  }, [selectedFiles]);

  return {
    selectedFiles,
    setSelectedFiles,
    lastSelectedIndex,
    setLastSelectedIndex,
    toggleFile,
    selectAllInGroup,
    selectRange,
    clearSelection,
    selectAll,
    getSuccessCount,
    getFailedCount,
    getFilesWithChanges
  };
}
