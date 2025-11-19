import { useState } from 'react';
import { X, FileAudio, AlertTriangle, CheckCircle } from 'lucide-react';

export function WritePreviewModal({ 
  isOpen, 
  onClose, 
  onConfirm, 
  selectedFiles, 
  groups, 
  backupEnabled 
}) {
  if (!isOpen) return null;

  // Build preview data
  const previewData = [];
  groups.forEach(group => {
    group.files.forEach(file => {
      if (selectedFiles.has(file.id) && Object.keys(file.changes).length > 0) {
        previewData.push({
          filename: file.filename,
          path: file.path,
          changes: file.changes
        });
      }
    });
  });

  const totalChanges = previewData.reduce((sum, file) => sum + Object.keys(file.changes).length, 0);

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
              {backupEnabled && (
                <div className="flex items-center gap-2 mt-2 text-sm text-green-700 bg-green-50 px-3 py-1.5 rounded-lg">
                  <CheckCircle className="w-4 h-4" />
                  Original files will be backed up
                </div>
              )}
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
                    <FileAudio className="w-4 h-4 text-gray-500" />
                    <span className="font-medium text-gray-900 text-sm">{file.filename}</span>
                    <span className="text-xs text-gray-500 bg-white px-2 py-1 rounded-full">
                      {Object.keys(file.changes).length} changes
                    </span>
                  </div>
                </div>

                {/* Changes */}
                <div className="divide-y divide-gray-100">
                  {Object.entries(file.changes).map(([field, change], changeIndex) => (
                    <div key={changeIndex} className="p-4">
                      <div className="flex items-start gap-4">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getChangeTypeColor(field)}`}>
                          {field.charAt(0).toUpperCase() + field.slice(1)}
                        </span>
                        
                        <div className="flex-1 min-w-0 space-y-2">
                          {/* Old Value */}
                          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                            <div className="text-xs font-medium text-red-800 mb-1">Current:</div>
                            <div className="text-sm text-red-900 font-mono break-words">
                              {change.old || <span className="text-red-600 italic">(empty)</span>}
                            </div>
                          </div>
                          
                          {/* New Value */}
                          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                            <div className="text-xs font-medium text-green-800 mb-1">New:</div>
                            <div className="text-sm text-green-900 font-mono break-words">
                              {change.new || <span className="text-green-600 italic">(empty)</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex gap-3 justify-end border-t border-gray-200 pt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="px-4 py-2 rounded-lg transition-colors font-medium bg-yellow-600 hover:bg-yellow-700 text-white"
          >
            Write {totalChanges} Changes to {previewData.length} File{previewData.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}