import { Upload, CheckCircle, FileAudio, ChevronRight, ChevronDown } from 'lucide-react';

export function BookList({ 
  groups, 
  selectedFiles,
  selectedGroup,
  expandedGroups,
  fileStatuses,
  onGroupClick,
  onToggleGroup,
  onSelectGroup,
  onSelectFile,
  onScan,
  scanning,
  onSelectAll,
  onClearSelection
}) {
  const getFileStatusIcon = (fileId) => {
    const status = fileStatuses[fileId];
    if (status === 'success') return <span className="text-green-600 font-bold">✓</span>;
    if (status === 'failed') return <span className="text-red-600 font-bold">✗</span>;
    return null;
  };

  if (groups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-white">
        <div className="text-center max-w-sm">
          <div className="bg-gradient-to-br from-blue-50 to-indigo-100 rounded-2xl p-8 border border-blue-200">
            <Upload className="w-12 h-12 text-blue-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No Files Scanned</h3>
            <p className="text-gray-600 mb-6 text-sm">Select a folder to scan for audiobook files and view metadata</p>
            <button 
              onClick={onScan} 
              disabled={scanning}
              className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
            >
              {scanning ? 'Scanning...' : 'Scan Library'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-2/5 border-r border-gray-200 overflow-y-auto bg-white flex flex-col">
      {/* Stats Header */}
      <div className="border-b border-gray-200 p-4 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6 text-sm">
            <span className="font-semibold text-gray-900">
              {groups.length} book{groups.length === 1 ? '' : 's'}
            </span>
            <span className="text-gray-600">
              {groups.reduce((sum, g) => sum + g.files.length, 0)} files
            </span>
            <span className="text-amber-600">
              {groups.reduce((sum, g) => sum + g.total_changes, 0)} changes
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onSelectAll}
              className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md transition-colors"
            >
              Select All
            </button>
            <button
              onClick={onClearSelection}
              className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Book Groups List */}
      <div className="flex-1 overflow-y-auto">
        {groups.map((group, index) => (
          <div 
            key={group.id} 
            className={`border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer ${
              selectedGroup?.id === group.id ? 'bg-blue-50 border-r-4 border-blue-500' : ''
            }`}
            onClick={(e) => {
              onSelectFile(group, index, e.shiftKey);
            }}
          >
            <div className="p-4">
              <div className="flex items-start gap-3">
                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={group.files.every(f => selectedFiles.has(f.id))}
                  onChange={(e) => {
                    e.stopPropagation();
                    onSelectGroup(group, e.target.checked);
                  }}
                  className="mt-1 w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />

                {/* Book Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between mb-2">
                    <h4 className="font-medium text-gray-900 text-sm leading-tight truncate pr-2">
                      {group.metadata.title}
                    </h4>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {group.total_changes > 0 && (
                        <span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs rounded-full font-medium">
                          {group.total_changes}
                        </span>
                      )}
                      {group.files.some(f => fileStatuses[f.id] === 'success') && (
                        <CheckCircle className="w-4 h-4 text-green-600" />
                      )}
                    </div>
                  </div>
                  
                  <p className="text-sm text-gray-600 mb-2 leading-relaxed">
                    by {group.metadata.author}
                  </p>
                  
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span>{group.files.length} file{group.files.length === 1 ? '' : 's'}</span>
                      <span className="capitalize">{group.group_type}</span>
                    </div>
                    
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleGroup(group.id);
                      }}
                      className="p-1 hover:bg-gray-200 rounded transition-colors"
                    >
                      {expandedGroups.has(group.id) ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Expanded Files */}
            {expandedGroups.has(group.id) && (
              <div className="bg-gray-50 border-t border-gray-200">
                {group.files.map((file) => (
                  <div
                    key={file.id}
                    className="px-4 py-3 hover:bg-gray-100 transition-colors border-b border-gray-200 last:border-b-0"
                  >
                    <div className="flex items-center gap-3 pl-7">
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(file.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          // Toggle individual file
                        }}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      
                      <div className="flex items-center gap-2">
                        {getFileStatusIcon(file.id)}
                        <FileAudio className="w-4 h-4 text-gray-400" />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-900 truncate">
                          {file.filename}
                        </div>
                        {Object.keys(file.changes).length > 0 && (
                          <div className="text-xs text-amber-600 mt-0.5">
                            {Object.keys(file.changes).length} pending changes
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
