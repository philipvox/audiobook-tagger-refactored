import { useState, useCallback } from 'react';
import { callBackend } from '../api';
import { useApp } from '../context/AppContext';
import { buildWritePayload } from '../lib/writePayload';
import { getAbsId, normalizePushResult, mergePushResults, CANCELLED_REASON } from '../lib/absPush';
import { isCancelled } from '../lib/cancel';

export function useTagOperations() {
  const { config, groups, updateFileStatuses, setWriteProgress } = useApp();
  const [writing, setWriting] = useState(false);
  const [pushing, setPushing] = useState(false);
  // writeSelectedTags(selectedFiles, { backup, excludedChanges })
  //   Resolves with the write_tags result plus `sent` (the filesMap written);
  //   rejects when the command rejects (e.g. its background task crashed).
  //   backup           default true now (data-preservation: backups ON by default).
  //   excludedChanges  optional Set of "fileId:field" keys to drop from the
  //                    payload, so what gets written equals exactly what the
  //                    WritePreviewModal showed minus the unchecked rows.
  const writeSelectedTags = useCallback(async (selectedFiles, options = {}) => {
    const { backup = true, excludedChanges = null } = options;
    try {
      setWriting(true);

      // Build the payload from file.changes, honoring per-field exclusions, via
      // the shared pure builder so the write payload equals exactly what the
      // WritePreviewModal displayed minus the excluded rows.
      const { fileIds: idsToWrite, filesMap } = buildWritePayload(
        groups,
        selectedFiles,
        excludedChanges
      );

      // #62: nothing the writer would write (only app-only or excluded
      // changes): never call it, so an empty batch cannot reset the undo
      // journal of the previous write.
      if (idsToWrite.length === 0) {
        setWriting(false);
        return { success: 0, failed: 0, errors: [], results: [], sent: {} };
      }

      // ✅ Set initial progress to the count we will actually write
      setWriteProgress({ current: 0, total: idsToWrite.length });

      const result = await callBackend('write_tags', {
        request: {
          file_ids: idsToWrite,
          files: filesMap,
          backup
        }
      });

      // Visible-failure guard: the browser build has no write_tags backend, so
      // callBackend returns `{ _stub: true, message }` (no `results`). Reject
      // BEFORE marking any status so the caller shows a legible failure toast
      // instead of silently marking every file 'success' (which an unguarded
      // `result.errors.some()` would also do by throwing, but less legibly).
      if (result?._stub || !Array.isArray(result?.results)) {
        throw new Error(result?.message || 'Write backend not available.');
      }

      const newStatuses = {};
      const writeErrors = Array.isArray(result.errors) ? result.errors : [];
      idsToWrite.forEach(fileId => {
        const hasError = writeErrors.some(e => e.file_id === fileId);
        newStatuses[fileId] = hasError ? 'failed' : 'success';
      });
      updateFileStatuses(newStatuses);
      
      // ✅ Keep progress visible for 1 second before clearing
      setTimeout(() => {
        setWriteProgress({ current: 0, total: 0 });
        setWriting(false);
      }, 1000);

      // `sent` is the payload actually written, so the caller clears exactly
      // the staged changes that reached the files (lib/localWrite.js).
      return { ...result, sent: filesMap };
    } catch (error) {
      console.error('Write failed:', error);
      setWriteProgress({ current: 0, total: 0 });
      setWriting(false);
      throw error;
    }
  }, [groups, updateFileStatuses, setWriteProgress]);  // ✅ Remove config dependency
  // CR-6a: rename by explicit old->new pairs computed by RenamePreviewModal from
  // the previews it already generated with the chosen template. `pairs` is
  // [{ fileId, oldPath, newPath }]; we forward the old->new mapping to the
  // backend. (Task 9b implements the Rust `rename_files` to accept `renames`.)
  const renameFiles = useCallback(async (pairs = []) => {
    try {
      setWriting(true);

      // CR-3: skip any pair with a null/undefined fileId defensively.
      const renames = pairs
        .filter(p => p && p.fileId != null && p.oldPath && p.newPath)
        .map(p => ({ file_id: p.fileId, old_path: p.oldPath, new_path: p.newPath }));

      const result = await callBackend('rename_files', { renames });

      setWriting(false);
      return result;
    } catch (error) {
      console.error('Rename failed:', error);
      setWriting(false);
      throw error;
    }
  }, []);

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

// H-7: `cancel` is this push's token (lib/cancel.js). With no token the push
// cannot be cancelled, so a Cancel left over from another run never touches it.
const pushToAudiobookShelf = useCallback(async (selectedFiles, { cancel = null } = {}) => {
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
        // Only add this book once (use first file as representative).
        // #60: include the ABS item id when the group has one - push_abs_updates
        // PATCHes /api/items/:id/media and fails "Missing item ID" without it.
        const firstFile = group.files[0];
        if (!bookMap.has(group.id)) {
          const item = {
            path: firstFile.path,
            metadata: group.metadata,
            group_id: group.id,
            // v2.2.3: diff against the import snapshot when there is one.
            original: group.abs_original || null,
          };
          const absId = getAbsId(group);
          if (absId) item.abs_id = absId;
          bookMap.set(group.id, item);
        }
      }
    });
    
    const allItems = Array.from(bookMap.values());
    
    
    // CHUNK INTO BATCHES OF 50
    const CHUNK_SIZE = 50;
    // Task 5 (M-9): per-book { updated, skipped, failed } entries.
    let totals = { updated: [], skipped: [], failed: [] };
    const totalUnmatched = [];
    
    for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
      const chunk = allItems.slice(i, i + CHUNK_SIZE);
      const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;

      // H-7: after a Cancel no further chunk is sent; its books are skipped.
      if (isCancelled(cancel)) {
        totals = mergePushResults(totals, {
          skipped: chunk.map(item => ({ id: item.group_id, title: item.metadata?.title || '', reason: CANCELLED_REASON })),
        });
        continue;
      }
      
      try {
        const result = await callBackend('push_abs_updates', { 
          request: { items: chunk },
          ...(cancel && { cancel }),
        });
        
        totals = mergePushResults(totals, normalizePushResult(result));
        if (Array.isArray(result?.unmatched)) totalUnmatched.push(...result.unmatched);
        
        // Small delay between chunks
        if (i + CHUNK_SIZE < allItems.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`Push chunk ${chunkNum} failed:`, error);
        const message = String(error?.message || error);
        totals = mergePushResults(totals, {
          failed: chunk.map(item => ({ id: item.group_id, title: item.metadata?.title || '', error: message })),
        });
      }
    }
    
    
    setPushing(false);
    return {
      attempted: allItems.length,
      ...totals,
      unmatched: totalUnmatched
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