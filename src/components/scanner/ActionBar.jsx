import { CheckCircle, RefreshCw, Save, FileType, UploadCloud } from 'lucide-react';

export function ActionBar({ 
  selectedFiles, 
  groups,
  fileStatuses,
  onRescan,
  onWrite,
  onRename,
  onPush,
  onClearSelection,
  writing,
  pushing,
  scanning
}) {
  const getSuccessCount = () => {
    return Array.from(selectedFiles).filter(id => fileStatuses[id] === 'success').length;
  };

  const getFilesWithChanges = () => {
    return Array.from(selectedFiles).filter(id => {
      for (const group of groups) {
        const file = group.files.find(f => f.id === id);
        if (file && Object.keys(file.changes).length > 0) return true;
      }
      return false;
    });
  };

  const getSelectedGroups = () => {
    const selectedGroups = new Set();
    groups.forEach(group => {
      if (group.files.some(f => selectedFiles.has(f.id))) {
        selectedGroups.add(group.id);
      }
    });
    return selectedGroups;
  };

  const filesWithChanges = getFilesWithChanges();
  const successCount = getSuccessCount();
  const selectedGroups = getSelectedGroups();

  return (
    <>
      {/* Selection Action Bar */}
      {selectedFiles.size > 0 && (
        <div className="bg-blue-50 border-b border-blue-200 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-blue-600" />
                <span className="font-medium text-blue-900">
                  {selectedFiles.size === 1 ? '1 file' : `${selectedFiles.size} files`} selected
                </span>
              </div>
              
              {selectedFiles.size > 1 && (
                <div className="flex items-center gap-3 text-xs">
                  {filesWithChanges.length > 0 && (
                    <span className="text-amber-600">{filesWithChanges.length} with changes</span>
                  )}
                  {successCount > 0 && (
                    <span className="text-green-600">{successCount} written</span>
                  )}
                </div>
              )}
              
              <button 
                onClick={onClearSelection}
                className="text-blue-600 hover:text-blue-800 underline"
              >
                Clear
              </button>
            </div>
            
            <div className="flex items-center gap-3">
              <button 
                onClick={onRescan} 
                disabled={scanning} 
                className="px-4 py-2 bg-white border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors font-medium flex items-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? 'Rescanning...' : `Rescan ${selectedFiles.size === 1 ? 'File' : `${selectedFiles.size} Files`}`}
              </button>
              
              {filesWithChanges.length > 0 && (
                <button 
                  onClick={onWrite} 
                  disabled={writing} 
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium flex items-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  {writing ? 'Writing...' : `Write ${filesWithChanges.length} File${filesWithChanges.length === 1 ? '' : 's'}`}
                </button>
              )}
              
              {selectedGroups.size === 1 && (
                <button 
                  onClick={onRename} 
                  disabled={writing} 
                  className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium flex items-center gap-2"
                >
                  <FileType className="w-4 h-4" />
                  Rename {selectedFiles.size === 1 ? 'File' : 'Files'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Success Action Bar */}
      {successCount > 0 && (
        <div className="bg-green-50 border-b border-green-200 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm">
              <CheckCircle className="w-4 h-4 text-green-600" />
              <span className="font-medium text-green-900">
                {successCount} file{successCount === 1 ? '' : 's'} successfully written
              </span>
              <span className="text-green-700">Ready to push to AudiobookShelf</span>
            </div>
            
            <button
              onClick={onPush}
              disabled={pushing}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium flex items-center gap-2"
            >
              <UploadCloud className={`w-4 h-4 ${pushing ? 'animate-pulse' : ''}`} />
              {pushing ? 'Pushing…' : `Push ${successCount} to AudiobookShelf`}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
