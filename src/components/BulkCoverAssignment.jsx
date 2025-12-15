import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { X, Upload, Image as ImageIcon, Check, AlertCircle, Sparkles, Trash2, RefreshCw } from 'lucide-react';

// Calculate string similarity using Levenshtein distance
function stringSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  // Check for substring containment
  if (s1.includes(s2) || s2.includes(s1)) {
    return 0.9;
  }

  // Levenshtein distance
  const matrix = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= s2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= s2.length; j++) {
    for (let i = 1; i <= s1.length; i++) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }

  const maxLen = Math.max(s1.length, s2.length);
  return 1 - matrix[s2.length][s1.length] / maxLen;
}

// Extract potential title from filename
function extractTitleFromFilename(filename) {
  // Remove extension
  let name = filename.replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');

  // Remove common suffixes
  name = name.replace(/_cover$/i, '');
  name = name.replace(/-cover$/i, '');
  name = name.replace(/_artwork$/i, '');

  // Replace underscores and dashes with spaces
  name = name.replace(/[_-]/g, ' ');

  // Clean up
  return name.trim();
}

export function BulkCoverAssignment({ isOpen, onClose, selectedGroups, onCoversAssigned }) {
  const [droppedImages, setDroppedImages] = useState([]);
  const [assignments, setAssignments] = useState({}); // groupId -> imageIndex
  const [isDragging, setIsDragging] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState(-1);

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) {
      setDroppedImages([]);
      setAssignments({});
    }
  }, [isOpen]);

  // Auto-match covers to books when images are added
  const autoMatchCovers = useCallback((images) => {
    if (images.length === 0 || selectedGroups.length === 0) return;

    const newAssignments = {};
    const usedImages = new Set();

    // For each book, find the best matching image
    selectedGroups.forEach(group => {
      const title = group.metadata?.title || '';
      let bestMatch = -1;
      let bestScore = 0;

      images.forEach((img, imgIndex) => {
        if (usedImages.has(imgIndex)) return;

        const imgTitle = extractTitleFromFilename(img.name);
        const score = stringSimilarity(title, imgTitle);

        if (score > bestScore && score > 0.3) {
          bestScore = score;
          bestMatch = imgIndex;
        }
      });

      if (bestMatch >= 0) {
        newAssignments[group.id] = { imageIndex: bestMatch, score: bestScore };
        usedImages.add(bestMatch);
      }
    });

    setAssignments(newAssignments);
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
      const selected = await open({
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
        const data = await invoke('read_image_file', { path });
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
      newAssignments[groupId] = { imageIndex, score: 1 }; // Manual = score 1
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

  // Apply all assignments
  const applyAssignments = async () => {
    setApplying(true);
    const assignmentEntries = Object.entries(assignments);
    let successCount = 0;

    for (let i = 0; i < assignmentEntries.length; i++) {
      const [groupId, assignment] = assignmentEntries[i];
      setApplyingIndex(i);

      try {
        const image = droppedImages[assignment.imageIndex];
        await invoke('set_cover_from_data', {
          groupId,
          imageData: image.data,
          mimeType: image.mimeType,
        });
        successCount++;
      } catch (error) {
        console.error(`Failed to set cover for group ${groupId}:`, error);
      }
    }

    setApplying(false);
    setApplyingIndex(-1);

    if (successCount > 0) {
      onCoversAssigned?.(successCount);
      onClose();
    }
  };

  // Re-run auto-match
  const reAutoMatch = () => {
    setAssignments({});
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
      <div className="bg-white rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 bg-gradient-to-r from-purple-50 to-indigo-50 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-900">Bulk Cover Assignment</h2>
              <p className="text-sm text-gray-600 mt-0.5">
                {selectedGroups.length} books selected • {assignedCount} covers assigned
              </p>
            </div>
            <div className="flex items-center gap-2">
              {droppedImages.length > 0 && (
                <button
                  onClick={reAutoMatch}
                  className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  Re-match
                </button>
              )}
              <button onClick={onClose} className="p-2 hover:bg-purple-100 rounded-lg transition-colors">
                <X className="w-6 h-6 text-gray-600" />
              </button>
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-hidden flex">
          {/* Left: Drop zone & images */}
          <div className="w-1/2 border-r border-gray-200 flex flex-col">
            {/* Drop zone */}
            <div
              className={`m-4 mb-2 border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                isDragging
                  ? 'border-purple-500 bg-purple-50'
                  : 'border-gray-300 hover:border-purple-400'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <Upload className={`w-10 h-10 mx-auto mb-3 ${isDragging ? 'text-purple-500' : 'text-gray-400'}`} />
              <p className="text-sm text-gray-600 mb-2">
                Drop cover images here
              </p>
              <p className="text-xs text-gray-500 mb-3">
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
                <div className="text-center py-8 text-gray-500 text-sm">
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
                          isAssigned ? 'border-green-400 bg-green-50' : 'border-gray-200'
                        }`}
                      >
                        <div className="aspect-square bg-gray-100">
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
                        <div className="p-1.5 text-[10px] text-gray-600 truncate bg-white">
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
              <h3 className="font-semibold text-gray-900">Books to Assign</h3>
              <p className="text-xs text-gray-500">Click an image thumbnail to change assignment</p>
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
                          : 'border-gray-200 bg-white'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {/* Assigned cover or placeholder */}
                        <div className="w-12 h-12 bg-gray-100 rounded flex-shrink-0 overflow-hidden flex items-center justify-center">
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
                          <div className="font-medium text-sm text-gray-900 truncate">
                            {group.metadata?.title || 'Untitled'}
                          </div>
                          <div className="text-xs text-gray-500 truncate">
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
                              className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-500"
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

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <div className="text-sm text-gray-600">
            {unassignedBooks.length > 0 && (
              <span className="text-amber-600 flex items-center gap-1">
                <AlertCircle className="w-4 h-4" />
                {unassignedBooks.length} book{unassignedBooks.length !== 1 ? 's' : ''} without covers
              </span>
            )}
            {unassignedImages.length > 0 && unassignedBooks.length === 0 && (
              <span className="text-gray-500">
                {unassignedImages.length} unused image{unassignedImages.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
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
