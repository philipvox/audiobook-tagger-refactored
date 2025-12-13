import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Upload, CheckCircle, FileAudio, ChevronRight, ChevronDown, Book, Search, Filter, X, Download, FolderPlus, Sparkles, FileJson, Zap, Cloud, Tag, ArrowRight } from 'lucide-react';

// Virtualized item height (approximate)
const ITEM_HEIGHT = 140;
const BUFFER_SIZE = 10;

// Inline change preview tooltip component
function ChangePreviewTooltip({ group, position }) {
  if (!group || !group.files) return null;

  // Collect all changes from all files in the group
  const allChanges = {};
  group.files.forEach(file => {
    if (file.changes) {
      Object.entries(file.changes).forEach(([field, change]) => {
        // Use the first file's change for each field as representative
        if (!allChanges[field]) {
          allChanges[field] = change;
        }
      });
    }
  });

  const changeEntries = Object.entries(allChanges);
  if (changeEntries.length === 0) return null;

  const fieldColors = {
    title: 'text-blue-600',
    author: 'text-purple-600',
    narrator: 'text-green-600',
    genre: 'text-orange-600',
    year: 'text-gray-600',
    series: 'text-indigo-600',
    publisher: 'text-pink-600',
  };

  return (
    <div
      className="absolute z-50 bg-white border border-gray-200 rounded-lg shadow-xl p-3 w-72 pointer-events-none"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translateX(-50%)',
      }}
    >
      <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
        <span className="w-2 h-2 bg-amber-400 rounded-full"></span>
        Pending Changes Preview
      </div>
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {changeEntries.slice(0, 5).map(([field, change]) => (
          <div key={field} className="text-xs">
            <span className={`font-semibold capitalize ${fieldColors[field] || 'text-gray-600'}`}>
              {field}:
            </span>
            <div className="flex items-start gap-1 mt-0.5 pl-2">
              <span className="text-red-500 line-through truncate max-w-[100px]" title={change.old || '(empty)'}>
                {change.old || <em className="text-gray-400">(empty)</em>}
              </span>
              <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0 mt-0.5" />
              <span className="text-green-600 truncate max-w-[100px] font-medium" title={change.new || '(empty)'}>
                {change.new || <em className="text-gray-400">(empty)</em>}
              </span>
            </div>
          </div>
        ))}
        {changeEntries.length > 5 && (
          <div className="text-[10px] text-gray-500 italic pt-1 border-t border-gray-100">
            +{changeEntries.length - 5} more changes...
          </div>
        )}
      </div>
      <div className="text-[10px] text-gray-400 mt-2 pt-2 border-t border-gray-100">
        Click to view full details
      </div>
    </div>
  );
}

export function BookList({
  groups,
  selectedFiles,
  allSelected = false,
  selectedGroup,
  selectedGroupIds,
  expandedGroups,
  fileStatuses,
  onGroupClick,
  onToggleGroup,
  onSelectGroup,
  onSelectFile,
  onScan,
  onImport,
  onImportFromAbs,
  onCleanupAllGenres,
  scanning,
  onSelectAll,
  onClearSelection,
  onExport
}) {
  const [coverCache, setCoverCache] = useState({});
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 30 });
  const listRef = useRef(null);
  const coverLoadingRef = useRef(new Set());
  const blobUrlsRef = useRef(new Map());

  // Hover preview state
  const [hoverPreview, setHoverPreview] = useState({ group: null, position: { x: 0, y: 0 } });
  const hoverTimeoutRef = useRef(null);

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    hasCover: null,    // null = all, true = with cover, false = without
    hasSeries: null,   // null = all, true = in series, false = standalone
    hasChanges: null,  // null = all, true = has changes, false = no changes
    genre: '',         // empty = all, or specific genre
    scanStatus: '',    // empty = all, 'new_scan' = freshly scanned, 'loaded_from_file' = loaded from metadata.json
    confidenceLevel: '', // empty = all, 'low' = <60%, 'medium' = 60-84%, 'high' = 85%+
  });

  // Calculate confidence statistics for triage view
  const confidenceStats = useMemo(() => {
    let low = 0, medium = 0, high = 0, noConfidence = 0;
    groups.forEach(group => {
      const confidence = group.metadata?.confidence?.overall;
      if (confidence === undefined || confidence === null) {
        noConfidence++;
      } else if (confidence < 60) {
        low++;
      } else if (confidence < 85) {
        medium++;
      } else {
        high++;
      }
    });
    return { low, medium, high, noConfidence, total: groups.length };
  }, [groups]);

  // Get unique genres from all groups
  const availableGenres = useMemo(() => {
    const genreSet = new Set();
    groups.forEach(group => {
      group.metadata?.genres?.forEach(g => genreSet.add(g));
    });
    return Array.from(genreSet).sort();
  }, [groups]);

  // Filter groups based on search and filters
  const filteredGroups = useMemo(() => {
    return groups.filter(group => {
      const metadata = group.metadata;
      const searchLower = searchQuery.toLowerCase().trim();

      // Search filter
      if (searchLower) {
        const matchesTitle = metadata.title?.toLowerCase().includes(searchLower);
        const matchesAuthor = metadata.author?.toLowerCase().includes(searchLower);
        const matchesSeries = metadata.series?.toLowerCase().includes(searchLower);
        const matchesNarrator = metadata.narrator?.toLowerCase().includes(searchLower) ||
                               metadata.narrators?.some(n => n.toLowerCase().includes(searchLower));

        if (!matchesTitle && !matchesAuthor && !matchesSeries && !matchesNarrator) {
          return false;
        }
      }

      // Cover filter
      if (filters.hasCover !== null) {
        const hasCover = !!coverCache[group.id];
        if (filters.hasCover !== hasCover) return false;
      }

      // Series filter
      if (filters.hasSeries !== null) {
        const hasSeries = !!metadata.series;
        if (filters.hasSeries !== hasSeries) return false;
      }

      // Changes filter
      if (filters.hasChanges !== null) {
        const hasChanges = group.total_changes > 0;
        if (filters.hasChanges !== hasChanges) return false;
      }

      // Genre filter
      if (filters.genre) {
        const hasGenre = metadata.genres?.includes(filters.genre);
        if (!hasGenre) return false;
      }

      // Scan status filter
      if (filters.scanStatus) {
        if (filters.scanStatus !== group.scan_status) return false;
      }

      // Confidence level filter
      if (filters.confidenceLevel) {
        const confidence = metadata.confidence?.overall;
        if (filters.confidenceLevel === 'low' && (confidence === undefined || confidence >= 60)) return false;
        if (filters.confidenceLevel === 'medium' && (confidence === undefined || confidence < 60 || confidence >= 85)) return false;
        if (filters.confidenceLevel === 'high' && (confidence === undefined || confidence < 85)) return false;
      }

      return true;
    });
  }, [groups, searchQuery, filters, coverCache]);

  // Reset filters
  const clearFilters = () => {
    setSearchQuery('');
    setFilters({
      hasCover: null,
      hasSeries: null,
      hasChanges: null,
      genre: '',
      scanStatus: '',
      confidenceLevel: '',
    });
  };

  const hasActiveFilters = searchQuery || filters.hasCover !== null ||
    filters.hasSeries !== null || filters.hasChanges !== null || filters.genre ||
    filters.scanStatus || filters.confidenceLevel;

  // Hover preview handlers
  const handleChangesBadgeHover = useCallback((group, event) => {
    if (group.total_changes === 0) return;

    // Clear any pending timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }

    // Delay showing tooltip slightly for better UX
    hoverTimeoutRef.current = setTimeout(() => {
      const rect = event.target.getBoundingClientRect();
      const listRect = listRef.current?.getBoundingClientRect() || { left: 0, top: 0 };

      setHoverPreview({
        group,
        position: {
          x: rect.left - listRect.left + rect.width / 2,
          y: rect.bottom - listRect.top + 8,
        },
      });
    }, 300);
  }, []);

  const handleChangesBadgeLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setHoverPreview({ group: null, position: { x: 0, y: 0 } });
  }, []);

  // Cleanup hover timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          // Ignore
        }
      });
      blobUrlsRef.current.clear();
    };
  }, []);

  // Handle scroll to determine visible items
  const handleScroll = useCallback((e) => {
    const container = e.target;
    const scrollTop = container.scrollTop;
    const clientHeight = container.clientHeight;

    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
    const visibleCount = Math.ceil(clientHeight / ITEM_HEIGHT) + BUFFER_SIZE * 2;
    const end = Math.min(filteredGroups.length, start + visibleCount);

    setVisibleRange(prev => {
      if (prev.start !== start || prev.end !== end) {
        return { start, end };
      }
      return prev;
    });
  }, [filteredGroups.length]);

  // Debounced scroll handler
  const scrollTimeoutRef = useRef(null);
  const debouncedScroll = useCallback((e) => {
    // Dismiss hover preview on scroll
    if (hoverPreview.group) {
      setHoverPreview({ group: null, position: { x: 0, y: 0 } });
    }
    if (scrollTimeoutRef.current) {
      cancelAnimationFrame(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = requestAnimationFrame(() => handleScroll(e));
  }, [handleScroll, hoverPreview.group]);

  // Load covers only for visible groups
  useEffect(() => {
    if (groups.length === 0) return;
    
    let cancelled = false;
    
    const loadVisibleCovers = async () => {
      const visibleGroups = groups.slice(visibleRange.start, Math.min(visibleRange.end, groups.length));
      
      // Load in batches of 5
      for (let i = 0; i < visibleGroups.length && !cancelled; i += 5) {
        const batch = visibleGroups.slice(i, i + 5);
        
        await Promise.all(batch.map(async (group) => {
          if (coverCache[group.id] || coverLoadingRef.current.has(group.id) || cancelled) return;
          
          coverLoadingRef.current.add(group.id);
          
          try {
            const cover = await invoke('get_cover_for_group', { groupId: group.id });
            if (cover && cover.data && !cancelled) {
              const blob = new Blob([new Uint8Array(cover.data)], { type: cover.mime_type || 'image/jpeg' });
              const url = URL.createObjectURL(blob);
              blobUrlsRef.current.set(group.id, url);
              setCoverCache(prev => ({ ...prev, [group.id]: url }));
            }
          } catch (error) {
            // Silently fail
          } finally {
            coverLoadingRef.current.delete(group.id);
          }
        }));
      }
    };

    const timeoutId = setTimeout(loadVisibleCovers, 150);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [visibleRange.start, visibleRange.end, groups]);

  const getFileStatusIcon = (fileId) => {
    const status = fileStatuses[fileId];
    if (status === 'success') return <span className="text-green-600 font-bold">✓</span>;
    if (status === 'failed') return <span className="text-red-600 font-bold">✗</span>;
    return null;
  };

  // Memoize stats to prevent recalculation
  const stats = useMemo(() => ({
    totalBooks: groups.length,
    totalFiles: groups.reduce((sum, g) => sum + g.files.length, 0),
    totalChanges: groups.reduce((sum, g) => sum + g.total_changes, 0)
  }), [groups]);

  if (groups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-white">
        <div className="text-center max-w-md">
          <div className="bg-gradient-to-br from-blue-50 to-indigo-100 rounded-2xl p-8 border border-blue-200">
            <Upload className="w-12 h-12 text-blue-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No Files Scanned</h3>
            <p className="text-gray-600 mb-6 text-sm">Select a folder to scan for audiobook files and view metadata</p>
            <div className="flex flex-col gap-3">
              {/* Smart Scan - default */}
              <button
                onClick={() => onScan('normal')}
                disabled={scanning}
                className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Zap className="w-4 h-4" />
                {scanning ? 'Scanning...' : 'Smart Scan'}
              </button>

              {/* Clean Scan - secondary */}
              <button
                onClick={() => onScan('force_fresh')}
                disabled={scanning}
                className="w-full px-4 py-2.5 bg-white border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
              >
                <Sparkles className="w-4 h-4" />
                Clean Scan (Clear Caches)
              </button>

              {onImport && (
                <button
                  onClick={onImport}
                  disabled={scanning}
                  className="w-full px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium disabled:opacity-50 text-sm flex items-center justify-center gap-2"
                >
                  <FolderPlus className="w-4 h-4" />
                  Import Without Scanning
                </button>
              )}
              {onImportFromAbs && (
                <button
                  onClick={onImportFromAbs}
                  disabled={scanning}
                  className="w-full px-4 py-2 bg-gradient-to-r from-purple-500 to-indigo-500 text-white rounded-lg hover:from-purple-600 hover:to-indigo-600 transition-colors font-medium disabled:opacity-50 text-sm flex items-center justify-center gap-2"
                >
                  <Cloud className="w-4 h-4" />
                  Import from ABS Library
                </button>
              )}
            </div>
            <div className="mt-4 text-xs text-gray-500 space-y-1">
              <p><strong>Smart Scan:</strong> Skips books with existing metadata</p>
              <p><strong>Clean Scan:</strong> Fetches fresh data for all books</p>
              <p><strong>Import from ABS:</strong> Load books from AudiobookShelf</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Calculate total height for virtualization
  const totalHeight = filteredGroups.length * ITEM_HEIGHT;
  const offsetY = visibleRange.start * ITEM_HEIGHT;

  return (
    <div className="w-2/5 border-r border-gray-200 overflow-hidden bg-white flex flex-col">
      {/* Search & Filter Header */}
      <div className="border-b border-gray-200 bg-gray-50 flex-shrink-0">
        {/* Search Bar */}
        <div className="p-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search title, author, series..."
              className="w-full pl-9 pr-8 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-200 rounded"
              >
                <X className="w-3 h-3 text-gray-500" />
              </button>
            )}
          </div>
        </div>

        {/* Triage Quick Filters */}
        {(confidenceStats.low > 0 || confidenceStats.medium > 0 || confidenceStats.high > 0) && (
          <div className="px-3 pb-2 flex items-center gap-2">
            <span className="text-[10px] text-gray-500 uppercase font-semibold">Triage:</span>
            <button
              onClick={() => setFilters(f => ({ ...f, confidenceLevel: f.confidenceLevel === 'low' ? '' : 'low' }))}
              className={`px-2 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${
                filters.confidenceLevel === 'low'
                  ? 'bg-red-100 text-red-700 border border-red-300 shadow-sm'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-red-50 hover:border-red-200'
              }`}
              title="Show low confidence books that need review"
            >
              <span>🔴</span>
              <span>Needs Review</span>
              {confidenceStats.low > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  filters.confidenceLevel === 'low' ? 'bg-red-200 text-red-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  {confidenceStats.low}
                </span>
              )}
            </button>
            <button
              onClick={() => setFilters(f => ({ ...f, confidenceLevel: f.confidenceLevel === 'medium' ? '' : 'medium' }))}
              className={`px-2 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${
                filters.confidenceLevel === 'medium'
                  ? 'bg-yellow-100 text-yellow-700 border border-yellow-300 shadow-sm'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-yellow-50 hover:border-yellow-200'
              }`}
              title="Show medium confidence books to verify"
            >
              <span>🟡</span>
              <span>Verify</span>
              {confidenceStats.medium > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  filters.confidenceLevel === 'medium' ? 'bg-yellow-200 text-yellow-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  {confidenceStats.medium}
                </span>
              )}
            </button>
            <button
              onClick={() => setFilters(f => ({ ...f, confidenceLevel: f.confidenceLevel === 'high' ? '' : 'high' }))}
              className={`px-2 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${
                filters.confidenceLevel === 'high'
                  ? 'bg-green-100 text-green-700 border border-green-300 shadow-sm'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-green-50 hover:border-green-200'
              }`}
              title="Show high confidence books ready to write"
            >
              <span>🟢</span>
              <span>Ready</span>
              {confidenceStats.high > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  filters.confidenceLevel === 'high' ? 'bg-green-200 text-green-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  {confidenceStats.high}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Filter Toggle & Stats */}
        <div className="px-3 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs">
            <span className="font-semibold text-gray-900">
              {filteredGroups.length}{filteredGroups.length !== stats.totalBooks && ` / ${stats.totalBooks}`} books
            </span>
            <span className="text-gray-500">
              {stats.totalFiles} files
            </span>
            {stats.totalChanges > 0 && (
              <span className="text-amber-600">
                {stats.totalChanges} changes
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`px-2 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${
                showFilters || hasActiveFilters
                  ? 'bg-blue-100 text-blue-700 border border-blue-200'
                  : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Filter className="w-3 h-3" />
              Filters
              {hasActiveFilters && <span className="w-1.5 h-1.5 bg-blue-600 rounded-full" />}
            </button>
            {onImport && (
              <button
                onClick={onImport}
                disabled={scanning}
                className="px-2 py-1 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md transition-colors flex items-center gap-1 disabled:opacity-50"
                title="Import folders without metadata scanning"
              >
                <FolderPlus className="w-3 h-3" />
                Import
              </button>
            )}
            {onImportFromAbs && (
              <button
                onClick={onImportFromAbs}
                disabled={scanning}
                className="px-2 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors flex items-center gap-1 disabled:opacity-50"
                title="Import books from AudiobookShelf library"
              >
                <Cloud className="w-3 h-3" />
                ABS
              </button>
            )}
            {onCleanupAllGenres && groups.length > 0 && (
              <button
                onClick={onCleanupAllGenres}
                disabled={scanning}
                className="px-2 py-1 text-xs bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors flex items-center gap-1 disabled:opacity-50"
                title="Clean all genres and push to ABS"
              >
                <Tag className="w-3 h-3" />
                Clean & Push
              </button>
            )}
            {onExport && (
              <button
                onClick={onExport}
                className="px-2 py-1 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md transition-colors flex items-center gap-1"
              >
                <Download className="w-3 h-3" />
                Export
              </button>
            )}
            <button
              onClick={onSelectAll}
              className="px-2 py-1 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md transition-colors"
            >
              Select All
            </button>
            <button
              onClick={onClearSelection}
              className="px-2 py-1 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Filter Panel */}
        {showFilters && (
          <div className="px-3 pb-3 border-t border-gray-200 pt-3 bg-white">
            <div className="flex flex-wrap gap-3">
              {/* Genre Filter */}
              <select
                value={filters.genre}
                onChange={(e) => setFilters(f => ({ ...f, genre: e.target.value }))}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">All Genres</option>
                {availableGenres.map(genre => (
                  <option key={genre} value={genre}>{genre}</option>
                ))}
              </select>

              {/* Series Filter */}
              <select
                value={filters.hasSeries === null ? '' : filters.hasSeries.toString()}
                onChange={(e) => setFilters(f => ({
                  ...f,
                  hasSeries: e.target.value === '' ? null : e.target.value === 'true'
                }))}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">All Books</option>
                <option value="true">In Series</option>
                <option value="false">Standalone</option>
              </select>

              {/* Changes Filter */}
              <select
                value={filters.hasChanges === null ? '' : filters.hasChanges.toString()}
                onChange={(e) => setFilters(f => ({
                  ...f,
                  hasChanges: e.target.value === '' ? null : e.target.value === 'true'
                }))}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Any Status</option>
                <option value="true">Has Changes</option>
                <option value="false">No Changes</option>
              </select>

              {/* Scan Status Filter */}
              <select
                value={filters.scanStatus}
                onChange={(e) => setFilters(f => ({ ...f, scanStatus: e.target.value }))}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">All Sources</option>
                <option value="new_scan">New Scans</option>
                <option value="loaded_from_file">From metadata.json</option>
                <option value="not_scanned">Not Scanned</option>
              </select>

              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="text-xs px-2 py-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Virtualized Book Groups List */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto relative"
        onScroll={debouncedScroll}
      >
        {/* Hover preview tooltip */}
        {hoverPreview.group && (
          <ChangePreviewTooltip
            group={hoverPreview.group}
            position={hoverPreview.position}
          />
        )}
        {/* No results message */}
        {filteredGroups.length === 0 && groups.length > 0 && (
          <div className="flex items-center justify-center p-8">
            <div className="text-center">
              <Search className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-600 font-medium mb-1">No books found</p>
              <p className="text-gray-500 text-sm mb-3">Try adjusting your search or filters</p>
              <button
                onClick={clearFilters}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Clear Filters
              </button>
            </div>
          </div>
        )}

        {/* Spacer for virtualization */}
        {filteredGroups.length > 0 && (
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {filteredGroups.slice(visibleRange.start, visibleRange.end).map((group, idx) => {
              const actualIndex = visibleRange.start + idx;
              const isInMultiSelect = allSelected || selectedGroupIds?.has(group.id);
              const isSingleSelected = selectedGroup?.id === group.id;
              const isSelected = isInMultiSelect || isSingleSelected;
              const metadata = group.metadata;
              
              return (
                <div 
                  key={group.id} 
                  className={`border-b border-gray-100 transition-colors cursor-pointer ${
                    isSelected 
                      ? 'bg-blue-50 border-l-4 border-l-blue-600' 
                      : 'hover:bg-gray-50 border-l-4 border-l-transparent'
                  }`}
                  style={{ minHeight: ITEM_HEIGHT }}
                  onClick={(e) => {
                    onSelectFile(group, actualIndex, e);
                  }}
                >
                  <div className="p-4">
                    <div className="flex items-start gap-3">
                      {/* Thumbnail */}
                      <div className="flex-shrink-0 w-16 h-24 bg-gradient-to-br from-gray-100 to-gray-200 rounded shadow-sm overflow-hidden relative">
                        {coverCache[group.id] ? (
                          <img 
                            src={coverCache[group.id]} 
                            alt={metadata.title}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            onError={(e) => {
                              e.target.style.display = 'none';
                            }}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Book className="w-6 h-6 text-gray-400" />
                          </div>
                        )}
                      </div>

                      {/* Book Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between mb-1">
                          <h4 className={`font-medium text-sm leading-tight line-clamp-2 pr-2 ${
                            isSelected ? 'text-blue-900' : 'text-gray-900'
                          }`}>
                            {metadata.title}
                          </h4>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {/* Confidence Badge */}
                            {metadata.confidence && (
                              <span
                                className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                                  metadata.confidence.overall >= 85
                                    ? 'bg-green-100 text-green-700'
                                    : metadata.confidence.overall >= 60
                                      ? 'bg-yellow-100 text-yellow-700'
                                      : 'bg-red-100 text-red-700'
                                }`}
                                title={`Confidence: ${metadata.confidence.overall}%`}
                              >
                                {metadata.confidence.overall >= 85 ? '🟢' : metadata.confidence.overall >= 60 ? '🟡' : '🔴'}
                                {metadata.confidence.overall}%
                              </span>
                            )}
                            {/* Scan Status Badge */}
                            {group.scan_status === 'new_scan' && (
                              <span className="px-2 py-0.5 bg-cyan-100 text-cyan-700 text-[10px] rounded-full font-medium flex items-center gap-1" title="Freshly scanned from APIs">
                                <Sparkles className="w-3 h-3" />
                                New
                              </span>
                            )}
                            {group.scan_status === 'loaded_from_file' && (
                              <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-[10px] rounded-full font-medium flex items-center gap-1" title="Loaded from existing metadata.json">
                                <FileJson className="w-3 h-3" />
                                Saved
                              </span>
                            )}
                            {group.total_changes > 0 && (
                              <span
                                className="px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs rounded-full font-medium cursor-help hover:bg-yellow-200 transition-colors"
                                onMouseEnter={(e) => handleChangesBadgeHover(group, e)}
                                onMouseLeave={handleChangesBadgeLeave}
                                title={`${group.total_changes} pending changes - hover for preview`}
                              >
                                {group.total_changes}
                              </span>
                            )}
                            {group.files.some(f => fileStatuses[f.id] === 'success') && (
                              <CheckCircle className="w-4 h-4 text-green-600" />
                            )}
                          </div>
                        </div>
                        
                        <p className={`text-xs mb-2 ${
                          isSelected ? 'text-blue-700' : 'text-gray-600'
                        }`}>
                          by {metadata.author}
                        </p>

                        {metadata.series && (
                          <div className="flex items-center gap-1 mb-1.5">
                            <span className="text-[11px] font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded truncate max-w-[160px] flex items-center gap-1">
                              {metadata.series}
                              {metadata.sequence && (
                                <span className="font-bold">#{metadata.sequence}</span>
                              )}
                            </span>
                          </div>
                        )}

                        {metadata.genres && metadata.genres.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-1.5">
                            {metadata.genres.slice(0, 2).map((genre, gIdx) => (
                              <span 
                                key={gIdx}
                                className="text-[10px] px-1.5 py-0.5 bg-gray-900 text-white rounded-full"
                              >
                                {genre}
                              </span>
                            ))}
                            {metadata.genres.length > 2 && (
                              <span className="text-[10px] px-1.5 py-0.5 bg-gray-300 text-gray-700 rounded-full">
                                +{metadata.genres.length - 2}
                              </span>
                            )}
                          </div>
                        )}

                        {metadata.description && (
                          <p className="text-[11px] text-gray-600 line-clamp-1 leading-tight mb-1.5">
                            {metadata.description}
                          </p>
                        )}
                        
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 text-xs text-gray-500">
                            <span>{group.files.length} files</span>
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
                  
                  {/* Expanded Files - Shows chapter order for ABS */}
                  {expandedGroups.has(group.id) && (
                    <div className="bg-gray-50 border-t border-gray-200">
                      {group.files.map((file, fileIndex) => (
                        <div
                          key={file.id}
                          className="px-4 py-3 hover:bg-gray-100 transition-colors border-b border-gray-200 last:border-b-0"
                        >
                          <div className="flex items-center gap-3 pl-7">
                            <input
                              type="checkbox"
                              checked={allSelected || selectedFiles.has(file.id)}
                              onChange={(e) => {
                                e.stopPropagation();
                              }}
                              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />

                            {/* Chapter number badge */}
                            <span className="flex-shrink-0 w-7 h-5 bg-purple-100 text-purple-700 rounded text-xs font-bold flex items-center justify-center">
                              {fileIndex + 1}
                            </span>

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
              );
            })}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}