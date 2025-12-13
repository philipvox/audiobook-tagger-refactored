import { useState, useMemo, useCallback } from 'react';
import { X, FileAudio, AlertTriangle, CheckCircle, Zap, Check, Square, CheckSquare } from 'lucide-react';

export function WritePreviewModal({
  isOpen,
  onClose,
  onConfirm,
  selectedFiles,
  groups,
  backupEnabled
}) {
  const [skipBackup, setSkipBackup] = useState(false);
  // Track excluded changes: Map of "fileId:field" -> true
  const [excludedChanges, setExcludedChanges] = useState(new Set());

  if (!isOpen) return null;

  // Build preview data with file IDs for tracking
  const previewData = [];
  groups.forEach(group => {
    group.files.forEach(file => {
      if (selectedFiles.has(file.id) && Object.keys(file.changes).length > 0) {
        previewData.push({
          fileId: file.id,
          filename: file.filename,
          path: file.path,
          changes: file.changes
        });
      }
    });
  });

  // Calculate totals considering exclusions
  const totalChanges = previewData.reduce((sum, file) => sum + Object.keys(file.changes).length, 0);
  const approvedChanges = previewData.reduce((sum, file) => {
    return sum + Object.keys(file.changes).filter(field => !excludedChanges.has(`${file.fileId}:${field}`)).length;
  }, 0);

  // Toggle a specific field change
  const toggleChange = (fileId, field) => {
    const key = `${fileId}:${field}`;
    setExcludedChanges(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Toggle all changes for a file
  const toggleAllForFile = (fileId, changes) => {
    const fields = Object.keys(changes);
    const allExcluded = fields.every(field => excludedChanges.has(`${fileId}:${field}`));

    setExcludedChanges(prev => {
      const next = new Set(prev);
      fields.forEach(field => {
        const key = `${fileId}:${field}`;
        if (allExcluded) {
          next.delete(key); // Include all
        } else {
          next.add(key); // Exclude all
        }
      });
      return next;
    });
  };

  // Check if all changes for a file are excluded
  const isFileFullyExcluded = (fileId, changes) => {
    return Object.keys(changes).every(field => excludedChanges.has(`${fileId}:${field}`));
  };

  // Handle confirm with filtered changes
  const handleConfirm = () => {
    // Pass the excluded changes to the parent so it can filter
    onConfirm(skipBackup, excludedChanges);
    onClose();
  };

  const getChangeTypeColor = (field) => {
    const colors = {
      title: 'bg-blue-100 text-blue-800',
      author: 'bg-purple-100 text-purple-800', 
      narrator: 'bg-green-100 text-green-800',
      genre: 'bg-orange-100 text-orange-800',
      year: 'bg-gray-100 text-gray-800',
      series: 'bg-indigo-100 text-indigo-800',
      publisher: 'bg-pink-100 text-pink-800'
    };
    return colors[field] || 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="p-6 pb-4 border-b border-gray-200">
          <div className="flex items-start gap-4">
            <div className="p-2 rounded-lg bg-yellow-100 flex-shrink-0">
              <AlertTriangle className="w-6 h-6 text-yellow-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                Write Tags Preview
              </h3>
              <p className="text-gray-600 text-sm">
                Review the changes that will be written to {previewData.length} file{previewData.length === 1 ? '' : 's'} 
                ({totalChanges} total changes)
              </p>
              
              {/* ✅ NEW: Backup Options */}
              <div className="mt-4 space-y-2">
                {backupEnabled && !skipBackup && (
                  <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 px-3 py-1.5 rounded-lg">
                    <CheckCircle className="w-4 h-4" />
                    Original files will be backed up (.backup extension)
                  </div>
                )}
                
                {skipBackup && (
                  <div className="flex items-center gap-2 text-sm text-orange-700 bg-orange-50 px-3 py-1.5 rounded-lg">
                    <Zap className="w-4 h-4" />
                    <span className="font-semibold">Fast mode:</span> No backups (30% faster)
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Changes List */}
        <div className="overflow-y-auto max-h-96 p-6">
          <div className="space-y-6">
            {previewData.map((file, fileIndex) => (
              <div key={fileIndex} className="border border-gray-200 rounded-lg overflow-hidden">
                {/* File Header */}
                <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggleAllForFile(file.fileId, file.changes)}
                      className="p-1 hover:bg-gray-200 rounded transition-colors"
                      title={isFileFullyExcluded(file.fileId, file.changes) ? "Include all changes" : "Exclude all changes"}
                    >
                      {isFileFullyExcluded(file.fileId, file.changes) ? (
                        <Square className="w-4 h-4 text-gray-400" />
                      ) : (
                        <CheckSquare className="w-4 h-4 text-green-600" />
                      )}
                    </button>
                    <FileAudio className="w-4 h-4 text-gray-500" />
                    <span className={`font-medium text-sm ${isFileFullyExcluded(file.fileId, file.changes) ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {file.filename}
                    </span>
                    <span className="text-xs text-gray-500 bg-white px-2 py-1 rounded-full">
                      {Object.keys(file.changes).filter(f => !excludedChanges.has(`${file.fileId}:${f}`)).length} / {Object.keys(file.changes).length} changes
                    </span>
                  </div>
                </div>

                {/* Changes */}
                <div className="divide-y divide-gray-100">
                  {Object.entries(file.changes).map(([field, change], changeIndex) => {
                    const isExcluded = excludedChanges.has(`${file.fileId}:${field}`);
                    return (
                      <div key={changeIndex} className={`p-4 transition-opacity ${isExcluded ? 'opacity-50 bg-gray-50' : ''}`}>
                        <div className="flex items-start gap-4">
                          {/* Checkbox */}
                          <button
                            onClick={() => toggleChange(file.fileId, field)}
                            className="p-1 hover:bg-gray-100 rounded transition-colors flex-shrink-0 mt-0.5"
                            title={isExcluded ? "Include this change" : "Exclude this change"}
                          >
                            {isExcluded ? (
                              <Square className="w-5 h-5 text-gray-400" />
                            ) : (
                              <CheckSquare className="w-5 h-5 text-green-600" />
                            )}
                          </button>

                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getChangeTypeColor(field)} ${isExcluded ? 'opacity-50' : ''}`}>
                            {field.charAt(0).toUpperCase() + field.slice(1)}
                          </span>

                          <div className="flex-1 min-w-0 space-y-2">
                            {/* Old Value */}
                            <div className={`bg-red-50 border border-red-200 rounded-lg p-3 ${isExcluded ? 'opacity-60' : ''}`}>
                              <div className="text-xs font-medium text-red-800 mb-1">Current:</div>
                              <div className="text-sm text-red-900 font-mono break-words">
                                {change.old || <span className="text-red-600 italic">(empty)</span>}
                              </div>
                            </div>

                            {/* New Value */}
                            <div className={`bg-green-50 border border-green-200 rounded-lg p-3 ${isExcluded ? 'opacity-60' : ''}`}>
                              <div className="text-xs font-medium text-green-800 mb-1">New:</div>
                              <div className="text-sm text-green-900 font-mono break-words">
                                {change.new || <span className="text-green-600 italic">(empty)</span>}
                              </div>
                            </div>

                            {isExcluded && (
                              <div className="text-xs text-gray-500 italic">This change will be skipped</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex flex-col gap-4 border-t border-gray-200 pt-4">
          {/* ✅ NEW: Skip Backup Toggle */}
          <div className="flex items-center justify-between p-4 bg-gradient-to-r from-orange-50 to-amber-50 rounded-lg border border-orange-200">
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-orange-600" />
              <div>
                <div className="font-medium text-gray-900">Fast Mode (Skip Backups)</div>
                <div className="text-sm text-gray-600">
                  ~30% faster, but no backup files created
                </div>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={skipBackup}
                onChange={(e) => setSkipBackup(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-600"></div>
            </label>
          </div>

          {/* Summary of approved changes */}
          {excludedChanges.size > 0 && (
            <div className="text-sm text-gray-600 text-center">
              <span className="font-medium">{approvedChanges}</span> of <span className="font-medium">{totalChanges}</span> changes will be written
              <span className="text-gray-400 ml-2">({excludedChanges.size} excluded)</span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={approvedChanges === 0}
              className={`px-4 py-2 rounded-lg transition-colors font-medium flex items-center gap-2 ${
                approvedChanges === 0
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-yellow-600 hover:bg-yellow-700 text-white'
              }`}
            >
              {skipBackup && <Zap className="w-4 h-4" />}
              Write {approvedChanges} Change{approvedChanges === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}