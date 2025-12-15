import { useState, useRef, useEffect } from 'react';
import {
  CheckCircle, RefreshCw, Save, FileType, UploadCloud, Edit3, ChevronDown,
  Zap, Sparkles, Shield, Settings2, Tag, ArrowDownToLine, ArrowUpFromLine,
  RefreshCcw, Image, Database
} from 'lucide-react';

// Unified scan modes - consistent terminology per UX spec
const SCAN_MODES = [
  {
    id: 'quick',
    backendId: 'normal', // Maps to backend scan mode
    label: 'Quick',
    description: 'Skip books with complete metadata',
    icon: Zap,
    color: 'blue',
  },
  {
    id: 'standard',
    backendId: 'force_fresh',
    label: 'Standard',
    description: 'Fresh fetch from all enabled sources',
    icon: Sparkles,
    color: 'purple',
  },
  {
    id: 'deep',
    backendId: 'super_scanner',
    label: 'Deep',
    description: 'All sources + GPT validation + retries',
    icon: Shield,
    color: 'orange',
  },
  {
    id: 'pipeline',
    backendId: 'pipeline',
    label: 'Rescan ABS',
    description: 'Fresh ABS fetch → GPT → Validate pipeline',
    icon: Database,
    color: 'green',
    absOnly: true, // Only show for ABS imports
  },
];

export function ActionBar({
  selectedFiles,
  allSelected = false,
  groups,
  fileStatuses,
  selectedGroupCount = 0,
  totalBookCount = 0,
  onScan,
  onRescan,
  onPipelineRescan,
  onWrite,
  onRename,
  onPush,
  onPull,
  onFullSync,
  onBulkEdit,
  onBulkCover,
  onOpenRescanModal,
  onCleanupGenres,
  onClearSelection,
  writing,
  pushing,
  scanning,
  hasAbsConnection = false,
}) {
  const [showScanMenu, setShowScanMenu] = useState(false);
  const [showAbsMenu, setShowAbsMenu] = useState(false);
  const scanMenuRef = useRef(null);
  const absMenuRef = useRef(null);

  // Close menus when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (scanMenuRef.current && !scanMenuRef.current.contains(event.target)) {
        setShowScanMenu(false);
      }
      if (absMenuRef.current && !absMenuRef.current.contains(event.target)) {
        setShowAbsMenu(false);
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

  // Determine scan scope and label
  const hasSelection = selectedCount > 0;
  const scopeLabel = hasSelection
    ? `Scan Selection (${isAbsImport ? selectedGroupCountCalc : selectedCount} ${isAbsImport ? 'books' : 'files'})`
    : `Scan Library (${totalBookCount || totalGroupCount} books)`;

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

  // Handle scan with mode - dispatches to library scan or rescan based on selection
  const handleScanWithMode = (mode) => {
    setShowScanMenu(false);

    // Pipeline mode uses special handler for ABS items
    if (mode.backendId === 'pipeline') {
      if (onPipelineRescan && hasSelection) {
        onPipelineRescan();
      }
      return;
    }

    if (hasSelection) {
      // Rescan selected items
      onRescan(mode.backendId);
    } else {
      // Scan library (opens folder picker)
      onScan(mode.backendId);
    }
  };

  // Check if any selected books are ABS imports
  const hasAbsImports = groups.some(g => g.files.length === 0 &&
    (allSelected || selectedFiles.size === 0 ? true :
      g.files.some(f => selectedFiles.has(f.id)) || selectedGroups.has?.(g.id)));

  return (
    <>
      {/* Main Action Bar - Always visible when there are books */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center justify-between">
          {/* Left side - Selection info or book count */}
          <div className="flex items-center gap-3 text-sm">
            {hasSelection ? (
              <>
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-blue-600" />
                  <span className="font-medium text-blue-900">
                    {allSelected ? 'All ' : ''}
                    {isAbsImport
                      ? (selectedGroupCountCalc === 1 ? '1 book' : `${selectedGroupCountCalc} books`)
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
              </>
            ) : (
              <span className="text-gray-600">
                {totalGroupCount} books loaded
              </span>
            )}
          </div>

          {/* Right side - Action buttons */}
          <div className="flex items-center gap-3">
            {/* Unified Scan Split Button */}
            <div className="relative" ref={scanMenuRef}>
              <div className="flex">
                <button
                  onClick={() => handleScanWithMode(SCAN_MODES[0])} // Default to Quick
                  disabled={scanning}
                  className="px-4 py-2 bg-blue-600 text-white rounded-l-lg hover:bg-blue-700 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
                  {scanning ? 'Scanning...' : scopeLabel}
                </button>
                <button
                  onClick={() => setShowScanMenu(!showScanMenu)}
                  disabled={scanning}
                  className="px-2 py-2 bg-blue-600 text-white rounded-r-lg hover:bg-blue-700 transition-colors border-l border-blue-500 disabled:opacity-50"
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
              </div>

              {/* Scan Mode Dropdown */}
              {showScanMenu && (
                <div className="absolute right-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                  <div className="py-1">
                    {SCAN_MODES
                      .filter(mode => !mode.absOnly || (mode.absOnly && isAbsImport && hasSelection))
                      .map((mode) => {
                      const Icon = mode.icon;
                      return (
                        <button
                          key={mode.id}
                          onClick={() => handleScanWithMode(mode)}
                          className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-start gap-3"
                        >
                          <Icon className={`w-4 h-4 text-${mode.color}-500 mt-0.5`} />
                          <div>
                            <div className="font-medium text-gray-900 text-sm">{mode.label}</div>
                            <div className="text-xs text-gray-500">{mode.description}</div>
                          </div>
                        </button>
                      );
                    })}
                    <div className="border-t border-gray-200 my-1" />
                    <button
                      onClick={() => {
                        setShowScanMenu(false);
                        onOpenRescanModal && onOpenRescanModal();
                      }}
                      className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-start gap-3"
                    >
                      <Settings2 className="w-4 h-4 text-gray-500 mt-0.5" />
                      <div>
                        <div className="font-medium text-gray-900 text-sm">Custom...</div>
                        <div className="text-xs text-gray-500">Choose specific fields</div>
                      </div>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Clean Genres - Standalone button (only when selection exists) */}
            {hasSelection && onCleanupGenres && (
              <button
                onClick={onCleanupGenres}
                disabled={scanning}
                className="px-4 py-2 bg-white border border-green-300 text-green-700 rounded-lg hover:bg-green-50 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
              >
                <Tag className="w-4 h-4" />
                Clean Genres
              </button>
            )}

            {/* ABS Sync Dropdown - Only show when ABS is connected */}
            {hasAbsConnection && (
              <div className="relative" ref={absMenuRef}>
                <button
                  onClick={() => setShowAbsMenu(!showAbsMenu)}
                  disabled={pushing || scanning}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
                >
                  <RefreshCcw className={`w-4 h-4 ${pushing ? 'animate-spin' : ''}`} />
                  ABS Sync
                  <ChevronDown className="w-4 h-4" />
                </button>

                {/* ABS Sync Dropdown */}
                {showAbsMenu && (
                  <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                    <div className="py-1">
                      <button
                        onClick={() => {
                          setShowAbsMenu(false);
                          onPull && onPull();
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-purple-50 flex items-start gap-3"
                      >
                        <ArrowDownToLine className="w-4 h-4 text-purple-500 mt-0.5" />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">Pull from ABS</div>
                          <div className="text-xs text-gray-500">Import server metadata</div>
                        </div>
                      </button>
                      <button
                        onClick={() => {
                          setShowAbsMenu(false);
                          onPush && onPush();
                        }}
                        disabled={!hasSelection}
                        className="w-full px-4 py-2 text-left hover:bg-purple-50 flex items-start gap-3 disabled:opacity-50"
                      >
                        <ArrowUpFromLine className="w-4 h-4 text-purple-500 mt-0.5" />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">Push to ABS</div>
                          <div className="text-xs text-gray-500">
                            {hasSelection ? `Update ${effectiveGroupCount} book${effectiveGroupCount === 1 ? '' : 's'}` : 'Select books first'}
                          </div>
                        </div>
                      </button>
                      <button
                        onClick={() => {
                          setShowAbsMenu(false);
                          onFullSync && onFullSync();
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-purple-50 flex items-start gap-3"
                      >
                        <RefreshCcw className="w-4 h-4 text-purple-500 mt-0.5" />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">Full Sync</div>
                          <div className="text-xs text-gray-500">Bidirectional sync</div>
                        </div>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Write Files - Only when selection has changes */}
            {hasSelection && filesWithChanges.length > 0 && (
              <button
                onClick={onWrite}
                disabled={writing}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium flex items-center gap-2"
              >
                <Save className="w-4 h-4" />
                {writing ? 'Writing...' : `Write ${filesWithChanges.length} File${filesWithChanges.length === 1 ? '' : 's'}`}
              </button>
            )}

            {/* Rename Files - Only for single group selection */}
            {hasSelection && selectedGroups.size === 1 && (
              <button
                onClick={onRename}
                disabled={writing}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium flex items-center gap-2"
              >
                <FileType className="w-4 h-4" />
                Rename {selectedCount === 1 ? 'File' : 'Files'}
              </button>
            )}

            {/* Bulk Edit - Only for multiple group selection */}
            {hasSelection && effectiveGroupCount > 1 && onBulkEdit && (
              <button
                onClick={onBulkEdit}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium flex items-center gap-2"
              >
                <Edit3 className="w-4 h-4" />
                Bulk Edit {effectiveGroupCount} Books
              </button>
            )}

            {/* Bulk Cover Assignment - Only for multiple group selection */}
            {hasSelection && effectiveGroupCount > 1 && onBulkCover && (
              <button
                onClick={onBulkCover}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors font-medium flex items-center gap-2"
              >
                <Image className="w-4 h-4" />
                Bulk Covers
              </button>
            )}

            {/* Legacy Push button for ABS imports without full ABS sync - show only for ABS imports */}
            {!hasAbsConnection && isAbsImport && hasSelection && effectiveGroupCount > 0 && (
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

      {/* Success Action Bar - Show when files have been written */}
      {successCount > 0 && hasAbsConnection && (
        <div className="bg-green-50 border-b border-green-200 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm">
              <CheckCircle className="w-4 h-4 text-green-600" />
              <span className="font-medium text-green-900">
                {successCount} file{successCount === 1 ? '' : 's'} successfully written
              </span>
              <span className="text-green-700">Ready to sync with AudiobookShelf</span>
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
