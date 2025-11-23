import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useApp } from '../context/AppContext';

export function useTagOperations() {
  const { config, groups, updateFileStatuses, setWriteProgress } = useApp();
  const [writing, setWriting] = useState(false);
  const [pushing, setPushing] = useState(false);

  const writeSelectedTags = useCallback(async (selectedFiles) => {
    try {
      setWriting(true);
      
      // ✅ Set initial progress
      setWriteProgress({ current: 0, total: selectedFiles.size });

      const filesMap = {};
      groups.forEach(group => {
        group.files.forEach(file => {
          filesMap[file.id] = {
            path: file.path,
            changes: file.changes
          };
        });
      });
      
      const result = await invoke('write_tags', { 
        request: {
          file_ids: Array.from(selectedFiles),
          files: filesMap,
          backup: config.backup_tags
        }
      });

      const newStatuses = {};
      Array.from(selectedFiles).forEach(fileId => {
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
  }, [config, groups, updateFileStatuses, setWriteProgress]);


  const renameFiles = useCallback(async (selectedFiles) => {
    try {
      setWriting(true);

      const filePairs = [];
      groups.forEach(group => {
        group.files.forEach(file => {
          if (selectedFiles.has(file.id)) {
            filePairs.push([file.path, group.metadata]);
          }
        });
      });

      const result = await invoke('rename_files', { files: filePairs });
      
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
      const preview = await invoke('preview_rename', {
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
    
    console.log('🔍 Building items for push...');
    
    // Group files by book - ONLY SEND ONE FILE PER BOOK
    const bookMap = new Map();
    
    groups.forEach(group => {
      // Check if any file in this group is selected
      const hasSelectedFile = group.files.some(f => selectedFiles.has(f.id));
      
      if (hasSelectedFile) {
        // Only add this book once (use first file as representative)
        const firstFile = group.files[0];
        if (!bookMap.has(group.id)) {
          bookMap.set(group.id, {
            path: firstFile.path,  // ABS only needs ONE file path per book
            metadata: group.metadata
          });
        }
      }
    });
    
    const allItems = Array.from(bookMap.values());
    
    console.log(`📦 Optimized: ${selectedFiles.size} files → ${allItems.length} books`);
    console.log(`📦 Pushing ${allItems.length} books in chunks of 50...`);
    
    // CHUNK INTO BATCHES OF 50
    const CHUNK_SIZE = 50;
    let totalUpdated = 0;
    let totalUnmatched = [];
    let totalFailed = [];
    
    for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
      const chunk = allItems.slice(i, i + CHUNK_SIZE);
      const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
      const totalChunks = Math.ceil(allItems.length / CHUNK_SIZE);
      
      console.log(`🚀 Chunk ${chunkNum}/${totalChunks} (${chunk.length} books)...`);
      
      try {
        const result = await invoke('push_abs_updates', { 
          request: { items: chunk } 
        });
        
        totalUpdated += result.updated || 0;
        totalUnmatched.push(...(result.unmatched || []));
        totalFailed.push(...(result.failed || []));
        
        console.log(`   ✅ Chunk ${chunkNum} done: ${result.updated} updated`);
        
        // Small delay between chunks
        if (i + CHUNK_SIZE < allItems.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`❌ Chunk ${chunkNum} failed:`, error);
      }
    }
    
    console.log(`\n✅ Push complete:`);
    console.log(`   📚 Books updated: ${totalUpdated}`);
    console.log(`   ❌ Failed: ${totalFailed.length}`);
    console.log(`   ⚠️  Unmatched: ${totalUnmatched.length}`);
    
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