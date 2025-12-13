// src/components/scanner/ProgressBar.jsx
import { useState } from 'react';
import { RefreshCw, Save, AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react';

export function ProgressBar({ type = 'scan', progress, onCancel, calculateETA }) {
  const [showErrors, setShowErrors] = useState(false);

  const isVisible = progress.total > 0;

  if (!isVisible) return null;

  const hasErrors = progress.error_count > 0;
  const errorCount = progress.error_count || 0;
  const recentErrors = progress.recent_errors || [];

  if (type === 'scan') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-5 h-5 text-blue-600 animate-spin" />
                <span className="font-semibold text-gray-900">
                  Scanning {progress.current} of {progress.total} files
                </span>
              </div>

              {/* Error indicator */}
              {hasErrors && (
                <button
                  onClick={() => setShowErrors(!showErrors)}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-700 text-sm font-medium rounded-lg transition-colors"
                >
                  <AlertTriangle className="w-4 h-4" />
                  <span>{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
                  {showErrors ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              )}

              {onCancel && (
                <button
                  onClick={onCancel}
                  className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-sm font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>

            <div className="text-right">
              {calculateETA && (
                <div className="font-semibold text-gray-900">
                  ETA: {calculateETA()}
                </div>
              )}
              <div className="text-sm text-gray-600">
                {Math.round((progress.current / progress.total) * 100)}% complete
                {progress.covers_found > 0 && (
                  <span className="ml-2 text-green-600">• {progress.covers_found} covers</span>
                )}
              </div>
            </div>
          </div>

          <div className="mb-3">
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className="bg-gradient-to-r from-blue-500 to-blue-600 h-3 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentFile && (
            <div className="text-sm text-gray-700 truncate">
              <span className="font-medium">Processing:</span> {progress.currentFile}
            </div>
          )}

          {/* Error details panel */}
          {showErrors && recentErrors.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-red-700">Recent Errors</span>
                <button
                  onClick={() => setShowErrors(false)}
                  className="p-1 hover:bg-gray-100 rounded"
                >
                  <X className="w-4 h-4 text-gray-500" />
                </button>
              </div>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {recentErrors.map((err, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-xs bg-red-50 rounded p-2">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${
                      err.error_type === 'api' ? 'bg-purple-100 text-purple-700' :
                      err.error_type === 'io' ? 'bg-blue-100 text-blue-700' :
                      err.error_type === 'timeout' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {err.error_type}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-800 truncate">{err.item}</div>
                      <div className="text-gray-600 truncate">{err.error}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'write') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Save className="w-5 h-5 text-green-600 animate-pulse" />
              <span className="font-semibold text-gray-900">
                Writing tags {progress.current} of {progress.total}
              </span>
            </div>
            <div className="text-sm text-gray-600">
              {Math.round((progress.current / progress.total) * 100)}% complete
            </div>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div 
              className="bg-green-600 h-3 rounded-full transition-all duration-300"
              style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
            ></div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}