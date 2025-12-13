import { useState, useRef, useEffect } from 'react';
import { CheckCircle, RefreshCw, Save, FileType, UploadCloud, Edit3, ChevronDown, Zap, Sparkles, Shield, Settings2, Tag, Cloud } from 'lucide-react';

export function ActionBar({
  selectedFiles,
  allSelected = false,
  groups,
  fileStatuses,
  selectedGroupCount = 0,
  onRescan,
  onWrite,
  onRename,
  onPush,
  onBulkEdit,
  onOpenRescanModal,
  onCleanupGenres,
  onAbsRescan,
  absImportCount = 0,
  onClearSelection,
  writing,
  pushing,
  scanning
}) {
  const [showRescanMenu, setShowRescanMenu] = useState(false);
  const rescanMenuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (rescanMenuRef.current && !rescanMenuRef.current.contains(event.target)) {
        setShowRescanMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  // Calculate counts (handle ABS imports with 0 files)
  const totalFileCount = groups.reduce((sum, g) => sum + g.files.length, 0);
  const totalGroupCount = groups.length;

  // For ABS imports (0 files), use group count instead
  const selectedFileCount = allSelected ? totalFileCount : selectedFiles.size;
  const selectedGroupCountCalc = allSelected ? totalGroupCount : selectedGroupCount;

  // Show action bar if we have selected files OR selected groups (for ABS imports)
  const selectedCount = selectedFileCount > 0 ? selectedFileCount : selectedGroupCountCalc;
  const isAbsImport = totalFileCount === 0 && totalGroupCount > 0;

  // Debug log for ABS imports
  if (isAbsImport && selectedGroupCount > 0) {
    console.log(`📊 ActionBar: ${selectedGroupCount} groups selected (ABS import mode)`);
  }

  const getSuccessCount = () => {
    if (allSelected) {
      return groups.reduce((count, g) => {
        return count + g.files.filter(f => fileStatuses[f.id] === 'success').length;
      }, 0);
    }
    return Array.from(selectedFiles).filter(id => fileStatuses[id] === 'success').length;
  };

  const getFilesWithChanges = () => {
    if (allSelected) {
      return groups.flatMap(g =>
        g.files.filter(f => Object.keys(f.changes).length > 0).map(f => f.id)
      );
    }
    return Array.from(selectedFiles).filter(id => {
      for (const group of groups) {
        const file = group.files.find(f => f.id === id);
        if (file && Object.keys(file.changes).length > 0) return true;
      }
      return false;
    });
  };

  const getSelectedGroups = () => {
    if (allSelected) {
      return new Set(groups.map(g => g.id));
    }
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
  const effectiveGroupCount = allSelected ? groups.length : selectedGroupCount;

  return (
    <>
      {/* Selection Action Bar */}
      {selectedCount > 0 && (
        <div className="bg-blue-50 border-b border-blue-200 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-blue-600" />
                <span className="font-medium text-blue-900">
                  {allSelected ? 'All ' : ''}
                  {isAbsImport
                    ? (selectedCount === 1 ? '1 book' : `${selectedCount} books`)
                    : (selectedCount === 1 ? '1 file' : `${selectedCount} files`)
                  } selected
                </span>
              </div>

              {selectedCount > 1 && (
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
              {/* Rescan Split Button with Dropdown */}
              <div className="relative" ref={rescanMenuRef}>
                <div className="flex">
                  <button
                    onClick={() => onRescan('force_fresh')}
                    disabled={scanning}
                    className="px-4 py-2 bg-white border border-blue-300 text-blue-700 rounded-l-lg hover:bg-blue-50 transition-colors font-medium flex items-center gap-2"
                  >
                    <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
                    {scanning ? 'Scanning...' : 'Rescan'}
                  </button>
                  <button
                    onClick={() => setShowRescanMenu(!showRescanMenu)}
                    disabled={scanning}
                    className="px-2 py-2 bg-white border border-l-0 border-blue-300 text-blue-700 rounded-r-lg hover:bg-blue-50 transition-colors"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>

                {/* Dropdown Menu - positioned to not clip */}
                {showRescanMenu && (
                  <div className="absolute right-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-[70vh] overflow-y-auto">
                    <div className="py-1">
                      <button
                        onClick={() => {
                          setShowRescanMenu(false);
                          onRescan('normal');
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-start gap-3"
                      >
                        <Zap className="w-4 h-4 text-blue-500 mt-0.5" />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">Smart Scan</div>
                          <div className="text-xs text-gray-500">Skip existing metadata</div>
                        </div>
                      </button>
                      <button
                        onClick={() => {
                          setShowRescanMenu(false);
                          onRescan('force_fresh');
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-start gap-3"
                      >
                        <Sparkles className="w-4 h-4 text-purple-500 mt-0.5" />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">Clean Scan</div>
                          <div className="text-xs text-gray-500">Fresh data from APIs</div>
                        </div>
                      </button>
                      <button
                        onClick={() => {
                          setShowRescanMenu(false);
                          onRescan('super_scanner');
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-start gap-3"
                      >
                        <Shield className="w-4 h-4 text-orange-500 mt-0.5" />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">Deep Scan</div>
                          <div className="text-xs text-gray-500">Maximum accuracy</div>
                        </div>
                      </button>
                      <div className="border-t border-gray-200 my-1" />
                      <button
                        onClick={() => {
                          setShowRescanMenu(false);
                          onOpenRescanModal && onOpenRescanModal();
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-start gap-3"
                      >
                        <Settings2 className="w-4 h-4 text-gray-500 mt-0.5" />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">Custom Rescan...</div>
                          <div className="text-xs text-gray-500">Choose specific fields</div>
                        </div>
                      </button>
                      <div className="border-t border-gray-200 my-1" />
                      <button
                        onClick={() => {
                          setShowRescanMenu(false);
                          onCleanupGenres && onCleanupGenres();
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-start gap-3"
                      >
                        <Tag className="w-4 h-4 text-green-500 mt-0.5" />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">Clean Genres</div>
                          <div className="text-xs text-gray-500">Normalize without rescanning</div>
                        </div>
                      </button>
                      {absImportCount > 0 && onAbsRescan && (
                        <>
                          <div className="border-t border-gray-200 my-1" />
                          <div className="px-4 py-1 text-[10px] font-medium text-purple-600 uppercase tracking-wide">
                            ABS Imports ({absImportCount})
                          </div>
                          <button
                            onClick={() => {
                              setShowRescanMenu(false);
                              onAbsRescan('force_fresh');
                            }}
                            className="w-full px-4 py-2 text-left hover:bg-purple-50 flex items-start gap-3"
                          >
                            <Cloud className="w-4 h-4 text-purple-500 mt-0.5" />
                            <div>
                              <div className="font-medium text-gray-900 text-sm">Fresh API Scan</div>
                              <div className="text-xs text-gray-500">Search Audible/Google/iTunes</div>
                            </div>
                          </button>
                          <button
                            onClick={() => {
                              setShowRescanMenu(false);
                              onAbsRescan('genres_only');
                            }}
                            className="w-full px-4 py-2 text-left hover:bg-purple-50 flex items-start gap-3"
                          >
                            <Tag className="w-4 h-4 text-purple-500 mt-0.5" />
                            <div>
                              <div className="font-medium text-gray-900 text-sm">Clean Genres Only</div>
                              <div className="text-xs text-gray-500">Normalize ABS genres</div>
                            </div>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

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
                  Rename {selectedCount === 1 ? 'File' : 'Files'}
                </button>
              )}

              {effectiveGroupCount > 1 && onBulkEdit && (
                <button
                  onClick={onBulkEdit}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium flex items-center gap-2"
                >
                  <Edit3 className="w-4 h-4" />
                  Bulk Edit {effectiveGroupCount} Books
                </button>
              )}

              {/* Push to ABS button - shows for ABS imports */}
              {isAbsImport && effectiveGroupCount > 0 && (
                <button
                  onClick={onPush}
                  disabled={pushing}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium flex items-center gap-2"
                >
                  <UploadCloud className={`w-4 h-4 ${pushing ? 'animate-pulse' : ''}`} />
                  {pushing ? 'Pushing…' : `Push ${effectiveGroupCount} to ABS`}
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
