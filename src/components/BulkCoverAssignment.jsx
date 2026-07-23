import { useState, useCallback, useEffect } from 'react';
import { callBackend, pickPath } from '../api';
import { X, Upload, Image as ImageIcon, Check, AlertCircle, Sparkles, Trash2, RefreshCw } from 'lucide-react';
import { assignCovers } from '../lib/coverMatch';

export function BulkCoverAssignment({ isOpen, onClose, selectedGroups, onCoversAssigned }) {
  const [droppedImages, setDroppedImages] = useState([]);
  const [assignments, setAssignments] = useState({}); // groupId -> { imageIndex, score, manual? }
  const [isDragging, setIsDragging] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState(-1);
  // M8: books whose cover write failed on the last apply (modal stays open).
  const [failedBooks, setFailedBooks] = useState([]);

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) {
      setDroppedImages([]);
      setAssignments({});
      setFailedBooks([]);
    }
  }, [isOpen]);

  // H4/H5: auto-match via the shared greedy scorer, PRESERVING existing manual
  // assignments (only unassigned books/images are matched). Auto assignments
  // from a prior pass are discarded so re-matching can improve them.
  const autoMatchCovers = useCallback((images, baseAssignments) => {
    if (selectedGroups.length === 0) return;
    setAssignments(prev => {
      const source = baseAssignments ?? prev;
      const manual = Object.fromEntries(
        Object.entries(source).filter(([, a]) => a.manual)
      );
      return assignCovers({
        books: selectedGroups.map(g => ({ id: g.id, title: g.metadata?.title || '' })),
        images,
        existing: manual,
      });
    });
  }, [selectedGroups]);

  // Handle file drop
  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter(file =>
      file.type.startsWith('image/')
    );

    if (files.length === 0) return;

    const newImages = await Promise.all(files.map(async (file) => {
      const arrayBuffer = await file.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: file.type });
      const url = URL.createObjectURL(blob);
      return {
        name: file.name,
        url,
        data: Array.from(new Uint8Array(arrayBuffer)),
        mimeType: file.type,
      };
    }));

    setDroppedImages(prev => {
      const all = [...prev, ...newImages];
      // Auto-match after adding new images
      setTimeout(() => autoMatchCovers(all), 100);
      return all;
    });
  }, [autoMatchCovers]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  // Handle file picker
  const handleAddFiles = async () => {
    try {
      const selected = await pickPath({
        directory: false,
        multiple: true,
        filters: [{
          name: 'Images',
          extensions: ['jpg', 'jpeg', 'png', 'webp']
        }]
      });

      if (!selected || selected.length === 0) return;

      const paths = Array.isArray(selected) ? selected : [selected];

      // Read files via Tauri
      const newImages = await Promise.all(paths.map(async (path) => {
        const data = await callBackend('read_image_file', { path });
        const blob = new Blob([new Uint8Array(data.data)], { type: data.mime_type });
        const url = URL.createObjectURL(blob);
        return {
          name: path.split('/').pop() || path.split('\\').pop() || 'image',
          url,
          data: data.data,
          mimeType: data.mime_type,
        };
      }));

      setDroppedImages(prev => {
        const all = [...prev, ...newImages];
        setTimeout(() => autoMatchCovers(all), 100);
        return all;
      });
    } catch (error) {
      console.error('Failed to add files:', error);
    }
  };

  // Manual assignment
  const assignImage = (groupId, imageIndex) => {
    setAssignments(prev => {
      // If this image is already assigned elsewhere, remove that assignment
      const newAssignments = { ...prev };
      Object.entries(newAssignments).forEach(([gId, assignment]) => {
        if (assignment.imageIndex === imageIndex && gId !== groupId) {
          delete newAssignments[gId];
        }
      });
      // Manual = score 1, flagged so re-matching (H5) preserves it.
      newAssignments[groupId] = { imageIndex, score: 1, manual: true };
      return newAssignments;
    });
  };

  // Remove assignment
  const removeAssignment = (groupId) => {
    setAssignments(prev => {
      const newAssignments = { ...prev };
      delete newAssignments[groupId];
      return newAssignments;
    });
  };

  // Remove image
  const removeImage = (index) => {
    // Remove any assignments using this image
    setAssignments(prev => {
      const newAssignments = {};
      Object.entries(prev).forEach(([gId, assignment]) => {
        if (assignment.imageIndex !== index) {
          // Adjust index if higher than removed
          newAssignments[gId] = {
            ...assignment,
            imageIndex: assignment.imageIndex > index ? assignment.imageIndex - 1 : assignment.imageIndex
          };
        }
      });
      return newAssignments;
    });

    // Revoke blob URL
    URL.revokeObjectURL(droppedImages[index].url);

    setDroppedImages(prev => prev.filter((_, i) => i !== index));
  };

  // Apply all assignments. M8: on partial failure keep the modal open, keep the
  // failed books' assignments (drop only the succeeded ones), surface the failed
  // list, and report { succeeded, failed } to the parent.
  const applyAssignments = async () => {
    setApplying(true);
    setFailedBooks([]);
    const assignmentEntries = Object.entries(assignments);
    const succeeded = [];
    const failed = [];

    for (let i = 0; i < assignmentEntries.length; i++) {
      const [groupId, assignment] = assignmentEntries[i];
      setApplyingIndex(i);

      try {
        const image = droppedImages[assignment.imageIndex];
        await callBackend('set_cover_from_data', {
          groupId,
          imageData: image.data,
          mimeType: image.mimeType,
        });
        succeeded.push(groupId);
      } catch (error) {
        console.error(`Failed to set cover for group ${groupId}:`, error);
        const group = selectedGroups.find(g => g.id === groupId);
        failed.push({
          groupId,
          title: group?.metadata?.title || groupId,
          error: String(error?.message || error),
        });
      }
    }

    setApplying(false);
    setApplyingIndex(-1);

    // Report the full outcome so the parent can toast successes AND failures.
    onCoversAssigned?.({ succeeded, failed });

    if (failed.length === 0) {
      onClose();
      return;
    }

    // Keep the modal open, drop the succeeded assignments so the remaining rows
    // (and a retry) target only the failures.
    setFailedBooks(failed);
    setAssignments(prev => {
      const next = {};
      for (const [gid, a] of Object.entries(prev)) {
        if (!succeeded.includes(gid)) next[gid] = a;
      }
      return next;
    });
  };

  // Re-run auto-match (H5: preserves manual assignments, re-matches the rest).
  const reAutoMatch = () => {
    setFailedBooks([]);
    autoMatchCovers(droppedImages);
  };

  if (!isOpen) return null;

  const assignedCount = Object.keys(assignments).length;
  const unassignedBooks = selectedGroups.filter(g => !assignments[g.id]);
  const unassignedImages = droppedImages.filter((_, i) =>
    !Object.values(assignments).some(a => a.imageIndex === i)
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-neutral-800 bg-gradient-to-r from-purple-50 to-indigo-50 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-100">Bulk Cover Assignment</h2>
              <p className="text-sm text-gray-400 mt-0.5">
                {selectedGroups.length} books selected • {assignedCount} covers assigned
              </p>
            </div>
            <div className="flex items-center gap-2">
              {droppedImages.length > 0 && (
                <button
                  onClick={reAutoMatch}
                  className="px-3 py-1.5 bg-neutral-900 border border-neutral-700 text-gray-300 rounded-lg text-sm hover:bg-neutral-950 flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  Re-match
                </button>
              )}
              <button onClick={onClose} className="p-2 hover:bg-purple-100 rounded-lg transition-colors">
                <X className="w-6 h-6 text-gray-400" />
              </button>
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-hidden flex">
          {/* Left: Drop zone & images */}
          <div className="w-1/2 border-r border-neutral-800 flex flex-col">
            {/* Drop zone */}
            <div
              className={`m-4 mb-2 border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                isDragging
                  ? 'border-purple-500 bg-purple-50'
                  : 'border-neutral-700 hover:border-purple-400'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <Upload className={`w-10 h-10 mx-auto mb-3 ${isDragging ? 'text-purple-500' : 'text-gray-400'}`} />
              <p className="text-sm text-gray-400 mb-2">
                Drop cover images here
              </p>
              <p className="text-xs text-gray-400 mb-3">
                Filenames will be matched to book titles
              </p>
              <button
                onClick={handleAddFiles}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition-colors"
              >
                Browse Files
              </button>
            </div>

            {/* Dropped images grid */}
            <div className="flex-1 overflow-y-auto p-4 pt-2">
              {droppedImages.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">
                  No images added yet
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {droppedImages.map((img, idx) => {
                    const isAssigned = Object.values(assignments).some(a => a.imageIndex === idx);
                    const assignedTo = Object.entries(assignments).find(([_, a]) => a.imageIndex === idx);

                    return (
                      <div
                        key={idx}
                        className={`relative group rounded-lg overflow-hidden border-2 ${
                          isAssigned ? 'border-green-400 bg-green-50' : 'border-neutral-800'
                        }`}
                      >
                        <div className="aspect-square bg-neutral-800">
                          <img
                            src={img.url}
                            alt={img.name}
                            className="w-full h-full object-contain"
                          />
                        </div>
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <button
                            onClick={() => removeImage(idx)}
                            className="p-2 bg-red-500 text-white rounded-full hover:bg-red-600"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        {isAssigned && (
                          <div className="absolute top-1 right-1 bg-green-500 rounded-full p-1">
                            <Check className="w-3 h-3 text-white" />
                          </div>
                        )}
                        <div className="p-1.5 text-[10px] text-gray-400 truncate bg-neutral-900">
                          {img.name}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right: Books list */}
          <div className="w-1/2 flex flex-col">
            <div className="p-4 pb-2">
              <h3 className="font-semibold text-gray-100">Books to Assign</h3>
              <p className="text-xs text-gray-400">Click an image thumbnail to change assignment</p>
            </div>

            <div className="flex-1 overflow-y-auto p-4 pt-2">
              <div className="space-y-2">
                {selectedGroups.map((group) => {
                  const assignment = assignments[group.id];
                  const assignedImage = assignment ? droppedImages[assignment.imageIndex] : null;

                  return (
                    <div
                      key={group.id}
                      className={`p-3 rounded-lg border ${
                        assignment
                          ? 'border-green-200 bg-green-50'
                          : 'border-neutral-800 bg-neutral-900'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {/* Assigned cover or placeholder */}
                        <div className="w-12 h-12 bg-neutral-800 rounded flex-shrink-0 overflow-hidden flex items-center justify-center">
                          {assignedImage ? (
                            <img
                              src={assignedImage.url}
                              alt=""
                              className="max-w-full max-h-full object-contain"
                            />
                          ) : (
                            <ImageIcon className="w-5 h-5 text-gray-300" />
                          )}
                        </div>

                        {/* Book info */}
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm text-gray-100 truncate">
                            {group.metadata?.title || 'Untitled'}
                          </div>
                          <div className="text-xs text-gray-400 truncate">
                            {group.metadata?.author || 'Unknown Author'}
                          </div>
                          {assignment && (
                            <div className="text-[10px] text-green-600 flex items-center gap-1 mt-0.5">
                              <Check className="w-3 h-3" />
                              {assignment.score >= 0.9 ? 'Excellent match' :
                               assignment.score >= 0.6 ? 'Good match' :
                               assignment.score >= 0.3 ? 'Possible match' : 'Manual'}
                            </div>
                          )}
                        </div>

                        {/* Image selector */}
                        {droppedImages.length > 0 && (
                          <div className="flex-shrink-0">
                            <select
                              value={assignment?.imageIndex ?? ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val === '') {
                                  removeAssignment(group.id);
                                } else {
                                  assignImage(group.id, parseInt(val));
                                }
                              }}
                              className="text-xs border border-neutral-700 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-500"
                            >
                              <option value="">No cover</option>
                              {droppedImages.map((img, i) => (
                                <option key={i} value={i}>
                                  {img.name.substring(0, 20)}
                                  {img.name.length > 20 ? '...' : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* M8: failed-cover banner - the modal stays open so failures can be retried */}
        {failedBooks.length > 0 && (
          <div className="px-4 py-2 bg-red-500/10 border-t border-red-500/30">
            <div className="flex items-center gap-2 text-sm text-red-300 font-medium">
              <AlertCircle className="w-4 h-4" />
              {failedBooks.length} cover{failedBooks.length !== 1 ? 's' : ''} failed to apply - fix and retry
            </div>
            <ul className="mt-1 text-xs text-red-300/80 max-h-20 overflow-y-auto list-disc list-inside">
              {failedBooks.map(f => (
                <li key={f.groupId} className="truncate" title={f.error}>{f.title}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <div className="p-4 border-t border-neutral-800 bg-neutral-950 flex items-center justify-between">
          <div className="text-sm text-gray-400">
            {unassignedBooks.length > 0 && (
              <span className="text-amber-600 flex items-center gap-1">
                <AlertCircle className="w-4 h-4" />
                {unassignedBooks.length} book{unassignedBooks.length !== 1 ? 's' : ''} without covers
              </span>
            )}
            {unassignedImages.length > 0 && unassignedBooks.length === 0 && (
              <span className="text-gray-400">
                {unassignedImages.length} unused image{unassignedImages.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-neutral-900 border border-neutral-700 text-gray-300 rounded-lg hover:bg-neutral-950 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={applyAssignments}
              disabled={assignedCount === 0 || applying}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {applying ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Applying ({applyingIndex + 1}/{assignedCount})...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  Apply {assignedCount} Cover{assignedCount !== 1 ? 's' : ''}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
