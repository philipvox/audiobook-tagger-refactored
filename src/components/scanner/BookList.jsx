import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Upload, CheckCircle, FileAudio, ChevronRight, ChevronDown, Book } from 'lucide-react';

// Virtualized item height (approximate)
const ITEM_HEIGHT = 140;
const BUFFER_SIZE = 10;

export function BookList({ 
  groups, 
  selectedFiles,
  selectedGroup,
  selectedGroupIds,
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
  const [coverCache, setCoverCache] = useState({});
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 30 });
  const listRef = useRef(null);
  const coverLoadingRef = useRef(new Set());
  const blobUrlsRef = useRef(new Map());

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
    const end = Math.min(groups.length, start + visibleCount);
    
    setVisibleRange(prev => {
      if (prev.start !== start || prev.end !== end) {
        return { start, end };
      }
      return prev;
    });
  }, [groups.length]);

  // Debounced scroll handler
  const scrollTimeoutRef = useRef(null);
  const debouncedScroll = useCallback((e) => {
    if (scrollTimeoutRef.current) {
      cancelAnimationFrame(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = requestAnimationFrame(() => handleScroll(e));
  }, [handleScroll]);

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

  // Calculate total height for virtualization
  const totalHeight = groups.length * ITEM_HEIGHT;
  const offsetY = visibleRange.start * ITEM_HEIGHT;

  return (
    <div className="w-2/5 border-r border-gray-200 overflow-hidden bg-white flex flex-col">
      {/* Stats Header */}
      <div className="border-b border-gray-200 p-4 bg-gray-50 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6 text-sm">
            <span className="font-semibold text-gray-900">
              {stats.totalBooks} book{stats.totalBooks === 1 ? '' : 's'}
            </span>
            <span className="text-gray-600">
              {stats.totalFiles} files
            </span>
            <span className="text-amber-600">
              {stats.totalChanges} changes
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

      {/* Virtualized Book Groups List */}
      <div 
        ref={listRef}
        className="flex-1 overflow-y-auto"
        onScroll={debouncedScroll}
      >
        {/* Spacer for virtualization */}
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {groups.slice(visibleRange.start, visibleRange.end).map((group, idx) => {
              const actualIndex = visibleRange.start + idx;
              const isInMultiSelect = selectedGroupIds?.has(group.id);
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
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}