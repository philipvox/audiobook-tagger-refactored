import { RefreshCw, Save } from 'lucide-react';

export function ProgressBar({ type = 'scan', progress, onCancel, calculateETA }) {
  if (type === 'scan' && progress.total > 0) {
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
              {onCancel && (
                <button 
                  onClick={onCancel}
                  className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-sm font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
              )}
              <div className="text-sm text-gray-600">
                {progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}% complete
              </div>
            </div>
            
            <div className="text-right">
              {calculateETA && (
                <div className="font-semibold text-gray-900">
                  ETA: {calculateETA()}
                </div>
              )}
              <div className="text-sm text-gray-600">
                {Math.round((progress.current / progress.total) * 100)}% complete
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
        </div>
      </div>
    );
  }

  if (type === 'write' && progress.total > 0) {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Save className="w-5 h-5 text-blue-600 animate-pulse" />
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
              className="bg-blue-600 h-3 rounded-full transition-all duration-300"
              style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
            ></div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
