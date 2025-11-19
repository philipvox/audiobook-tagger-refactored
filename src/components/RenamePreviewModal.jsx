import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowRight, CheckCircle } from 'lucide-react';

export function RenamePreviewModal({ selectedFiles, metadata, onConfirm, onCancel }) {
  const [previews, setPreviews] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    generatePreviews();
  }, [selectedFiles, metadata]);

  const generatePreviews = async () => {
    setLoading(true);
    const results = [];

    for (const filePath of selectedFiles) {
      try {
        const preview = await invoke('preview_rename', {
          filePath,
          metadata,
        });
        results.push(preview);
      } catch (error) {
        console.error('Preview error:', error);
      }
    }

    setPreviews(results);
    setLoading(false);
  };

  const changedCount = previews.filter(p => p.changed).length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">Rename Preview</h2>
          <p className="text-gray-600 mt-1">Review proposed changes before renaming</p>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600"></div>
              <span className="ml-3 text-gray-600">Generating previews...</span>
            </div>
          ) : (
            <div className="space-y-4">
              {previews.map((preview, idx) => (
                <div
                  key={idx}
                  className={`p-4 rounded-lg border-2 ${
                    preview.changed ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'
                  }`}
                >
                  {preview.changed ? (
                    <div className="space-y-3">
                      <div className="text-sm">
                        <div className="text-xs text-gray-500 mb-1">From:</div>
                        <div className="font-mono text-sm bg-white px-3 py-2 rounded border">
                          {preview.old_path.split('/').pop()}
                        </div>
                      </div>
                      <div className="flex justify-center">
                        <ArrowRight className="w-5 h-5 text-blue-600" />
                      </div>
                      <div className="text-sm">
                        <div className="text-xs text-gray-500 mb-1">To:</div>
                        <div className="font-mono text-sm bg-green-50 px-3 py-2 rounded border border-green-200">
                          {preview.new_path.split('/').pop()}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 text-sm text-gray-600">
                      <CheckCircle className="w-5 h-5 text-gray-400" />
                      No changes needed
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-6 border-t border-gray-200 bg-gray-50">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">
              {changedCount > 0 && `${changedCount} file(s) will be renamed`}
            </div>
            <div className="flex gap-3">
              <button onClick={onCancel} className="btn btn-secondary">
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={changedCount === 0 || loading}
                className="btn btn-primary flex items-center gap-2"
              >
                <CheckCircle className="w-4 h-4" />
                Confirm Rename
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}