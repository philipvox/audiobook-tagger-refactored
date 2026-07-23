import { useState, useCallback } from 'react';
import { callBackend } from '../api';
import { useApp } from '../context/AppContext';

export function useTagOperations() {
  const { config, groups, updateFileStatuses, setWriteProgress } = useApp();
  const [writing, setWriting] = useState(false);
  const [pushing, setPushing] = useState(false);
  // writeSelectedTags(selectedFiles, { backup, excludedChanges })
  //   backup           default true now (data-preservation: backups ON by default).
  //   excludedChanges  optional Set of "fileId:field" keys to drop from the
  //                    payload, so what gets written equals exactly what the
  //                    WritePreviewModal showed minus the unchecked rows.
  const writeSelectedTags = useCallback(async (selectedFiles, options = {}) => {
    const { backup = true, excludedChanges = null } = options;
    try {
      setWriting(true);

      // Build the payload from file.changes, honoring per-field exclusions.
      // Only selected files with at least one surviving change are written.
      const filesMap = {};
      const idsToWrite = [];
      groups.forEach(group => {
        group.files.forEach(file => {
          if (file.id == null || !selectedFiles.has(file.id)) return;
          const allChanges = file.changes || {};
          const changes = {};
          for (const [field, val] of Object.entries(allChanges)) {
            if (excludedChanges && excludedChanges.has(`${file.id}:${field}`)) continue;
            changes[field] = val;
          }
          if (Object.keys(changes).length === 0) return;
          filesMap[file.id] = { path: file.path, changes };
          idsToWrite.push(file.id);
        });
      });

      // ✅ Set initial progress to the count we will actually write
      setWriteProgress({ current: 0, total: idsToWrite.length });

      const result = await callBackend('write_tags', {
        request: {
          file_ids: idsToWrite,
          files: filesMap,
          backup
        }
      });

      const newStatuses = {};
      idsToWrite.forEach(fileId => {
        const hasError = result.errors.some(e => e.file_id === fileId);
        newStatuses[fileId] = hasError ? 'failed' : 'success';
      });
      updateFileStatuses(newStatuses);
      
      // ✅ Keep progress visible for 1 second before clearing
      setTimeout(() => {
        setWriteProgress({ current: 0, total: 0 });
        setWriting(false);
      }, 1000);
      
      return result;
    } catch (error) {
      console.error('Write failed:', error);
      setWriteProgress({ current: 0, total: 0 });
      setWriting(false);
      throw error;
    }
  }, [groups, updateFileStatuses, setWriteProgress]);  // ✅ Remove config dependency
  const renameFiles = useCallback(async (selectedFiles) => {
    try {
      setWriting(true);

      const filePairs = [];
      groups.forEach(group => {
        group.files.forEach(file => {
          // CR-3: skip files with a null/undefined id defensively.
          if (file.id != null && selectedFiles.has(file.id)) {
            filePairs.push([file.path, group.metadata]);
          }
        });
      });

      const result = await callBackend('rename_files', { files: filePairs });
      
      setWriting(false);
      return result;
    } catch (error) {
      console.error('Rename failed:', error);
      setWriting(false);
      throw error;
    }
  }, [groups]);

  const previewRename = useCallback(async (filePath, metadata) => {
    try {
      const preview = await callBackend('preview_rename', {
        filePath,
        metadata,
      });
      return preview;
    } catch (error) {
      console.error('Preview error:', error);
      throw error;
    }
  }, []);

 // Helper function at TOP of file
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
// src/hooks/useTagOperations.js - OPTIMIZED VERSION
// Only send ONE file per book group

const pushToAudiobookShelf = useCallback(async (selectedFiles) => {
  try {
    setPushing(true);
    
    
    // Group files by book - ONLY SEND ONE FILE PER BOOK
    const bookMap = new Map();
    
    groups.forEach(group => {
      // Check if any file in this group is selected
      // CR-3: skip files with a null/undefined id defensively (matches
      // the same guard in renameFiles above).
      const hasSelectedFile = group.files.some(f => f.id != null && selectedFiles.has(f.id));
      
      if (hasSelectedFile) {
        // Only add this book once (use first file as representative)
        const firstFile = group.files[0];
        if (!bookMap.has(group.id)) {
          bookMap.set(group.id, {
            path: firstFile.path,
            metadata: group.metadata,
            group_id: group.id
          });
        }
      }
    });
    
    const allItems = Array.from(bookMap.values());
    
    
    // CHUNK INTO BATCHES OF 50
    const CHUNK_SIZE = 50;
    let totalUpdated = 0;
    let totalUnmatched = [];
    let totalFailed = [];
    
    for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
      const chunk = allItems.slice(i, i + CHUNK_SIZE);
      const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
      const totalChunks = Math.ceil(allItems.length / CHUNK_SIZE);
      
      
      try {
        const result = await callBackend('push_abs_updates', { 
          request: { items: chunk } 
        });
        
        totalUpdated += result.updated || 0;
        totalUnmatched.push(...(result.unmatched || []));
        totalFailed.push(...(result.failed || []));
        
        
        // Small delay between chunks
        if (i + CHUNK_SIZE < allItems.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`❌ Chunk ${chunkNum} failed:`, error);
      }
    }
    
    
    setPushing(false);
    return {
      updated: totalUpdated,
      unmatched: totalUnmatched,
      failed: totalFailed
    };
  } catch (error) {
    console.error('Push failed:', error);
    setPushing(false);
    throw error;
  }
}, [groups]);
  return {
    writing,
    pushing,
    writeSelectedTags,
    renameFiles,
    previewRename,
    pushToAudiobookShelf
  };
}