import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Search, Trash2, FolderOpen, CheckCircle, AlertTriangle,
  HardDrive, FileAudio, Clock, Star, ChevronDown, ChevronRight,
  Loader2, Copy, Check, X, Folder, Image
} from 'lucide-react';

// Reusable component for a duplicate group card
function DuplicateGroupCard({
  group,
  expandedGroups,
  toggleGroup,
  selectedForDeletion,
  toggleSelection,
  getMatchTypeColor,
  getMatchTypeLabel,
  formatBytes,
  formatDuration,
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 mb-3">
      {/* Group Header */}
      <div
        className="p-4 cursor-pointer hover:bg-gray-50 flex items-center gap-3"
        onClick={() => toggleGroup(group.id)}
      >
        {expandedGroups.has(group.id) ? (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronRight className="w-5 h-5 text-gray-400" />
        )}

        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">
              {group.books[0]?.title || 'Unknown Title'}
            </span>
            <span className="text-gray-500">by</span>
            <span className="text-gray-700">
              {group.books[0]?.author || 'Unknown Author'}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${getMatchTypeColor(group.match_type)}`}>
              {getMatchTypeLabel(group.match_type)}
            </span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
              group.confidence >= 0.95 ? 'bg-green-100 text-green-800' :
              group.confidence >= 0.85 ? 'bg-blue-100 text-blue-800' :
              'bg-yellow-100 text-yellow-800'
            }`}>
              {Math.round(group.confidence * 100)}% match
            </span>
            <span className="text-xs text-gray-500">
              {group.books.length} copies
            </span>
          </div>
        </div>

        <Copy className="w-5 h-5 text-red-500" />
      </div>

      {/* Expanded Details */}
      {expandedGroups.has(group.id) && (
        <div className="border-t border-gray-200 p-4 space-y-3">
          {group.books.map((book) => {
            const isRecommended = book.folder_path === group.recommended_keep;
            const isSelected = selectedForDeletion.has(book.folder_path);

            return (
              <div
                key={book.folder_path}
                className={`p-3 rounded-lg border-2 ${
                  isRecommended
                    ? 'border-green-300 bg-green-50'
                    : isSelected
                    ? 'border-red-300 bg-red-50'
                    : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Selection checkbox (not for recommended) */}
                  {!isRecommended && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelection(book.folder_path)}
                      className="mt-1 rounded"
                    />
                  )}

                  {/* Recommended badge */}
                  {isRecommended && (
                    <div className="flex items-center gap-1 text-green-600 mt-1">
                      <Star className="w-4 h-4 fill-current" />
                    </div>
                  )}

                  {/* Cover image - Square */}
                  <div className="w-16 h-16 flex-shrink-0 rounded overflow-hidden bg-gray-200 flex items-center justify-center">
                    {book.cover_path ? (
                      <img
                        src={convertFileSrc(book.cover_path)}
                        alt={book.title}
                        className="max-w-full max-h-full object-contain"
                        onError={(e) => {
                          e.target.style.display = 'none';
                          e.target.nextSibling.style.display = 'flex';
                        }}
                      />
                    ) : null}
                    <div className={`flex items-center justify-center ${book.cover_path ? 'hidden' : ''}`}>
                      <Image className="w-6 h-6 text-gray-400" />
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-medium text-gray-900 truncate">
                        {book.title}
                      </span>
                      {isRecommended && (
                        <>
                          <span className="px-2 py-0.5 bg-green-100 text-green-800 text-xs rounded font-medium">
                            ★ Keep This One
                          </span>
                          {/* Show reasons for recommendation */}
                          <span className="text-xs text-gray-500">
                            ({[
                              book.in_correct_folder && 'correct folder',
                              book.has_metadata_file && 'has metadata',
                              book.has_cover && 'has cover',
                              book.audio_format === 'm4b' && 'm4b format',
                              book.file_count === 1 && 'single file',
                            ].filter(Boolean).join(', ') || 'highest quality'})
                          </span>
                        </>
                      )}
                    </div>

                    <div className="text-sm text-gray-600 truncate mb-2">
                      <FolderOpen className="w-3 h-3 inline mr-1" />
                      {book.folder_path}
                    </div>

                    <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <HardDrive className="w-3 h-3" />
                        {formatBytes(book.total_size_bytes)}
                      </span>
                      <span className="flex items-center gap-1">
                        <FileAudio className="w-3 h-3" />
                        {book.file_count} files
                      </span>
                      {book.audio_format && (
                        <span className="px-1.5 py-0.5 bg-gray-200 rounded">
                          {book.audio_format.toUpperCase()}
                        </span>
                      )}
                      {book.has_metadata_file && (
                        <span className="flex items-center gap-1 text-green-600">
                          <Check className="w-3 h-3" />
                          Metadata
                        </span>
                      )}
                      {book.has_cover && (
                        <span className="flex items-center gap-1 text-green-600">
                          <Check className="w-3 h-3" />
                          Cover
                        </span>
                      )}
                      {book.in_correct_folder === false && (
                        <span className="flex items-center gap-1 text-orange-600 font-medium">
                          <AlertTriangle className="w-3 h-3" />
                          Wrong Folder
                        </span>
                      )}
                      {book.in_correct_folder === true && (
                        <span className="flex items-center gap-1 text-green-600">
                          <Check className="w-3 h-3" />
                          Correct Folder
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDuration(book.duration_seconds)}
                      </span>
                      <span className="text-blue-600">
                        Quality: {book.quality_score.toFixed(0)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DuplicateFinderPage() {
  const [libraryPath, setLibraryPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [selectedForDeletion, setSelectedForDeletion] = useState(new Set());
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [minConfidence, setMinConfidence] = useState(0); // Filter by minimum confidence

  // Scan options
  const [options, setOptions] = useState({
    checkExactTitles: true,
    checkSimilarTitles: true,
    checkAsin: true,
    checkDuration: true,
    similarityThreshold: 0.85,
  });

  // Load library path from config
  useEffect(() => {
    invoke('get_config').then(config => {
      if (config.library_path) {
        setLibraryPath(config.library_path);
      }
    }).catch(console.error);
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Audiobook Library Folder',
      });
      if (selected) {
        setLibraryPath(selected);
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err);
    }
  };

  const handleScan = async () => {
    if (!libraryPath) {
      setError('Please select a library folder');
      return;
    }

    setScanning(true);
    setError(null);
    setScanResult(null);
    setSelectedForDeletion(new Set());

    try {
      const result = await invoke('scan_for_duplicates', {
        libraryPath,
        checkExactTitles: options.checkExactTitles,
        checkSimilarTitles: options.checkSimilarTitles,
        checkAsin: options.checkAsin,
        checkDuration: options.checkDuration,
        similarityThreshold: options.similarityThreshold,
      });

      setScanResult(result);

      // Auto-expand first few groups
      const firstGroups = result.duplicate_groups.slice(0, 3).map(g => g.id);
      setExpandedGroups(new Set(firstGroups));
    } catch (err) {
      setError(err.toString());
    } finally {
      setScanning(false);
    }
  };

  const toggleGroup = (groupId) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const toggleSelection = (folderPath) => {
    setSelectedForDeletion(prev => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const selectRecommendedDeletions = () => {
    if (!scanResult) return;

    const toDelete = new Set();
    for (const group of scanResult.duplicate_groups) {
      // Select all but the recommended one for deletion
      for (const book of group.books) {
        if (book.folder_path !== group.recommended_keep) {
          toDelete.add(book.folder_path);
        }
      }
    }
    setSelectedForDeletion(toDelete);
  };

  const selectWrongFolders = () => {
    if (!scanResult) return;

    const toDelete = new Set();
    for (const group of scanResult.duplicate_groups) {
      for (const book of group.books) {
        // Only select books in wrong folders (but not the recommended one)
        if (book.in_correct_folder === false && book.folder_path !== group.recommended_keep) {
          toDelete.add(book.folder_path);
        }
      }
    }
    setSelectedForDeletion(toDelete);
  };

  const selectAllDuplicates = () => {
    if (!scanResult) return;

    const toDelete = new Set();
    for (const group of scanResult.duplicate_groups) {
      for (const book of group.books) {
        // Select all except recommended
        if (book.folder_path !== group.recommended_keep) {
          toDelete.add(book.folder_path);
        }
      }
    }
    setSelectedForDeletion(toDelete);
  };

  const selectLowQuality = () => {
    if (!scanResult) return;

    const toDelete = new Set();
    for (const group of scanResult.duplicate_groups) {
      // Find the max quality in this group
      const maxQuality = Math.max(...group.books.map(b => b.quality_score));
      for (const book of group.books) {
        // Select books with significantly lower quality (more than 20 points below max)
        if (book.quality_score < maxQuality - 20 && book.folder_path !== group.recommended_keep) {
          toDelete.add(book.folder_path);
        }
      }
    }
    setSelectedForDeletion(toDelete);
  };

  const clearSelection = () => {
    setSelectedForDeletion(new Set());
  };

  // Get filtered and sorted groups
  const getFilteredGroups = () => {
    if (!scanResult) return { selected: [], unselected: [] };

    // Filter by confidence
    const filtered = scanResult.duplicate_groups.filter(
      group => group.confidence >= minConfidence / 100
    );

    // Separate into groups with selections and without
    const selected = [];
    const unselected = [];

    for (const group of filtered) {
      const hasSelection = group.books.some(book => selectedForDeletion.has(book.folder_path));
      if (hasSelection) {
        selected.push(group);
      } else {
        unselected.push(group);
      }
    }

    return { selected, unselected };
  };

  const { selected: selectedGroups, unselected: unselectedGroups } = getFilteredGroups();

  const handleDeleteSelected = async (moveToTrash = true) => {
    if (selectedForDeletion.size === 0) return;

    const confirmed = window.confirm(
      `Are you sure you want to ${moveToTrash ? 'move to trash' : 'permanently delete'} ${selectedForDeletion.size} folders?`
    );

    if (!confirmed) return;

    setDeleting(true);
    let successCount = 0;
    let errors = [];

    for (const folderPath of selectedForDeletion) {
      try {
        if (moveToTrash) {
          await invoke('move_duplicate_to_trash', { folderPath });
        } else {
          await invoke('delete_duplicate', { folderPath });
        }
        successCount++;
      } catch (err) {
        errors.push(`${folderPath}: ${err}`);
      }
    }

    setDeleting(false);

    if (errors.length > 0) {
      setError(`Deleted ${successCount}, failed ${errors.length}: ${errors[0]}`);
    }

    // Refresh scan
    if (successCount > 0) {
      handleScan();
    }
  };

  const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDuration = (seconds) => {
    if (!seconds) return 'Unknown';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const getMatchTypeLabel = (matchType) => {
    switch (matchType) {
      case 'ExactTitle': return 'Exact Title Match';
      case 'SimilarTitle': return 'Similar Title';
      case 'SameAsin': return 'Same ASIN';
      case 'SameIsbn': return 'Same ISBN';
      case 'DurationAndTitle': return 'Duration + Title';
      case 'AudioFingerprint': return 'Audio Fingerprint';
      default: return matchType;
    }
  };

  const getMatchTypeColor = (matchType) => {
    switch (matchType) {
      case 'ExactTitle':
      case 'SameAsin':
      case 'SameIsbn':
        return 'bg-red-100 text-red-800';
      case 'SimilarTitle':
      case 'DurationAndTitle':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="h-full flex flex-col p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Duplicate Finder</h2>
          <p className="text-sm text-gray-600">Find and remove duplicate audiobooks from your library</p>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Library Folder</label>
            <div className="flex gap-2">
              <button
                onClick={handleBrowse}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 flex items-center gap-2 border border-gray-300"
              >
                <Folder className="w-4 h-4" />
                Browse...
              </button>
              {libraryPath && (
                <div className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-700 truncate flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-gray-500 flex-shrink-0" />
                  <span className="truncate">{libraryPath}</span>
                </div>
              )}
            </div>
          </div>
          <button
            onClick={handleScan}
            disabled={scanning || !libraryPath}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {scanning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <Search className="w-4 h-4" />
                Scan for Duplicates
              </>
            )}
          </button>
        </div>

        {/* Options */}
        <div className="mt-4 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={options.checkExactTitles}
              onChange={(e) => setOptions(prev => ({ ...prev, checkExactTitles: e.target.checked }))}
              className="rounded"
            />
            Exact Titles
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={options.checkSimilarTitles}
              onChange={(e) => setOptions(prev => ({ ...prev, checkSimilarTitles: e.target.checked }))}
              className="rounded"
            />
            Similar Titles
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={options.checkAsin}
              onChange={(e) => setOptions(prev => ({ ...prev, checkAsin: e.target.checked }))}
              className="rounded"
            />
            ASIN Match
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={options.checkDuration}
              onChange={(e) => setOptions(prev => ({ ...prev, checkDuration: e.target.checked }))}
              className="rounded"
            />
            Duration Match
          </label>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600" />
          <span className="text-red-800">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="w-4 h-4 text-red-600" />
          </button>
        </div>
      )}

      {/* Results Summary */}
      {scanResult && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex gap-6">
              <div>
                <span className="text-2xl font-bold text-gray-900">{scanResult.total_books_scanned}</span>
                <span className="text-sm text-gray-600 ml-2">books scanned</span>
              </div>
              <div>
                <span className="text-2xl font-bold text-red-600">{scanResult.duplicate_groups.length}</span>
                <span className="text-sm text-gray-600 ml-2">duplicate groups</span>
              </div>
              <div>
                <span className="text-2xl font-bold text-orange-600">{scanResult.total_duplicates_found}</span>
                <span className="text-sm text-gray-600 ml-2">total duplicates</span>
              </div>
              <div>
                <span className="text-2xl font-bold text-green-600">{formatBytes(scanResult.potential_space_savings_bytes)}</span>
                <span className="text-sm text-gray-600 ml-2">potential savings</span>
              </div>
            </div>

            <div className="flex gap-2 flex-wrap items-center">
              {/* Confidence filter */}
              <div className="flex items-center gap-1 mr-2">
                <span className="text-xs text-gray-500">Min confidence:</span>
                {[0, 50, 75, 85, 95, 100].map(conf => (
                  <button
                    key={conf}
                    onClick={() => setMinConfidence(conf)}
                    className={`px-2 py-1 text-xs rounded ${
                      minConfidence === conf
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {conf}%
                  </button>
                ))}
              </div>

              {/* Selection dropdown */}
              <div className="relative group">
                <button
                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm flex items-center gap-2"
                >
                  Select...
                  <ChevronDown className="w-3 h-3" />
                </button>
                <div className="absolute right-0 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50 hidden group-hover:block">
                  <button
                    onClick={selectRecommendedDeletions}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
                  >
                    <Star className="w-4 h-4 text-yellow-500" />
                    Recommended
                  </button>
                  <button
                    onClick={selectWrongFolders}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
                  >
                    <AlertTriangle className="w-4 h-4 text-orange-500" />
                    Wrong Folders
                  </button>
                  <button
                    onClick={selectLowQuality}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
                  >
                    <X className="w-4 h-4 text-red-500" />
                    Low Quality
                  </button>
                  <button
                    onClick={selectAllDuplicates}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2 border-t"
                  >
                    <Check className="w-4 h-4 text-gray-500" />
                    All Duplicates
                  </button>
                  {selectedForDeletion.size > 0 && (
                    <button
                      onClick={clearSelection}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2 border-t text-gray-500"
                    >
                      <X className="w-4 h-4" />
                      Clear Selection
                    </button>
                  )}
                </div>
              </div>

              {selectedForDeletion.size > 0 && (
                <>
                  <button
                    onClick={clearSelection}
                    className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 text-sm"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => handleDeleteSelected(true)}
                    disabled={deleting}
                    className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 flex items-center gap-2 text-sm"
                  >
                    <Trash2 className="w-4 h-4" />
                    Move {selectedForDeletion.size} to Trash
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Duplicate Groups List */}
      <div className="flex-1 overflow-y-auto">
        {/* Selected groups first */}
        {selectedGroups.length > 0 && (
          <>
            <div className="flex items-center gap-2 mb-3 px-1">
              <div className="flex items-center gap-2 text-sm font-medium text-orange-700">
                <Trash2 className="w-4 h-4" />
                Selected for Deletion ({selectedGroups.length} groups)
              </div>
              <div className="flex-1 h-px bg-orange-200" />
            </div>
            {selectedGroups.map((group) => (
              <DuplicateGroupCard
                key={group.id}
                group={group}
                expandedGroups={expandedGroups}
                toggleGroup={toggleGroup}
                selectedForDeletion={selectedForDeletion}
                toggleSelection={toggleSelection}
                getMatchTypeColor={getMatchTypeColor}
                getMatchTypeLabel={getMatchTypeLabel}
                formatBytes={formatBytes}
                formatDuration={formatDuration}
              />
            ))}
          </>
        )}

        {/* Separator between selected and unselected */}
        {selectedGroups.length > 0 && unselectedGroups.length > 0 && (
          <div className="flex items-center gap-2 my-4 px-1">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500">
              <CheckCircle className="w-4 h-4" />
              Not Selected ({unselectedGroups.length} groups)
            </div>
            <div className="flex-1 h-px bg-gray-300" />
          </div>
        )}

        {/* Unselected groups */}
        {unselectedGroups.map((group) => (
          <DuplicateGroupCard
            key={group.id}
            group={group}
            expandedGroups={expandedGroups}
            toggleGroup={toggleGroup}
            selectedForDeletion={selectedForDeletion}
            toggleSelection={toggleSelection}
            getMatchTypeColor={getMatchTypeColor}
            getMatchTypeLabel={getMatchTypeLabel}
            formatBytes={formatBytes}
            formatDuration={formatDuration}
          />
        ))}

        {scanResult && selectedGroups.length === 0 && unselectedGroups.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <CheckCircle className="w-12 h-12 mx-auto mb-4 text-green-500" />
            <p className="text-lg font-medium">
              {minConfidence > 0 ? 'No duplicates at this confidence level' : 'No duplicates found!'}
            </p>
            <p className="text-sm">
              {minConfidence > 0
                ? `Try lowering the minimum confidence filter (currently ${minConfidence}%)`
                : 'Your library looks clean.'
              }
            </p>
          </div>
        )}

        {!scanResult && !scanning && (
          <div className="text-center py-12 text-gray-500">
            <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium">Ready to scan</p>
            <p className="text-sm">Enter your library path and click "Scan for Duplicates"</p>
          </div>
        )}
      </div>
    </div>
  );
}
