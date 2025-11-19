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
      
      setWriting(false);
      return result;
    } catch (error) {
      console.error('Write failed:', error);
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

  const pushToAudiobookShelf = useCallback(async (selectedFiles) => {
    try {
      setPushing(true);
      
      const items = [];
      groups.forEach(group => {
        group.files.forEach(file => {
          if (selectedFiles.has(file.id)) {
            items.push({
              path: file.path,
              metadata: group.metadata
            });
          }
        });
      });

      const result = await invoke('push_abs_updates', { request: { items } });
      setPushing(false);
      return result;
    } catch (error) {
      console.error('Push to AudiobookShelf failed:', error);
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
