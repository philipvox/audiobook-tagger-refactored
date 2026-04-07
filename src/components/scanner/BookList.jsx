import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { callBackend } from '../../api';
import { CheckCircle, FileAudio, ChevronRight, ChevronDown, Book, Search, X, Sparkles, FileJson, Cloud, ArrowRight, ArrowUpDown, ArrowUp, ArrowDown, AlertTriangle, AlertCircle, Filter } from 'lucide-react';

// Virtualized item height (approximate) - more compact
const ITEM_HEIGHT = 80;
const BUFFER_SIZE = 10;

// Check if a string looks like a person's name (2-3 words, capitalized)
const looksLikePersonName = (s) => {
  const words = s.trim().split(/\s+/);

  // Person names are typically 2-3 words
  if (words.length < 2 || words.length > 4) return false;

  // Check for series-like words that indicate it's NOT a name
  const lower = s.toLowerCase();
  const seriesIndicators = ['series', 'saga', 'chronicles', 'trilogy', 'book', 'collection',
                            'adventures', 'mysteries', 'tales', 'stories', 'cycle'];
  if (seriesIndicators.some(ind => lower.includes(ind))) return false;

  // Check if all words look like name parts
  for (const word of words) {
    const wordLower = word.toLowerCase();
    // Skip common suffixes
    if (['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'md', 'dr', 'dr.'].includes(wordLower)) {
      continue;
    }
    // Names shouldn't have numbers
    if (/\d/.test(word)) return false;
    // First letter should be uppercase for proper names
    if (word.length > 0 && word[0] !== word[0].toUpperCase()) return false;
  }

  return true;
};

// Validate series name - filter out GPT artifacts and placeholder values
const isValidSeries = (series, author = null) => {
  if (!series || typeof series !== 'string') return false;

  const s = series.trim();
  if (s.length < 2) return false;

  const lower = s.toLowerCase();

  // Reject known bad values from GPT
  const invalidValues = [
    // Placeholder values
    'null', 'or null', 'none', 'n/a', 'na', 'unknown', 'unknown series',
    'standalone', 'stand-alone', 'stand alone', 'single', 'single book',
    'not a series', 'no series', 'not part of a series', 'no series name',
    'series name', 'series', 'title', 'book', 'audiobook',
    'undefined', 'not applicable', 'not available', 'tbd', 'tba',
    // Genres that GPT incorrectly returns as series
    'biography', 'autobiography', 'memoir', 'memoirs', 'fiction', 'non-fiction',
    'nonfiction', 'mystery', 'thriller', 'romance', 'fantasy', 'science fiction',
    'sci-fi', 'horror', 'historical fiction', 'literary fiction', 'self-help',
    'self help', 'history', 'true crime', 'comedy', 'humor', 'drama',
    'adventure', 'action', 'suspense', 'classic', 'classics', 'poetry',
    'essay', 'essays', 'short stories', 'anthology', 'collection',
    'young adult', 'ya', 'children', 'kids', 'juvenile', 'teen',
    'business', 'economics', 'psychology', 'philosophy', 'religion',
    'spirituality', 'health', 'wellness', 'cooking', 'travel', 'science',
    'technology', 'politics', 'sociology', 'education', 'reference',
  ];

  if (invalidValues.includes(lower)) return false;

  // Reject if contains "or null" anywhere
  if (lower.includes('or null') || lower.includes('#or null')) return false;

  // Reject if series matches the author name
  if (author) {
    const authorLower = author.toLowerCase().trim();
    if (lower === authorLower) return false;
    // Check if series is contained in author (e.g., "Eric Carle" in "Eric Carle, Mary Smith")
    if (authorLower.includes(lower)) return false;
    // Check if first author name matches series
    const firstAuthor = authorLower.split(',')[0].trim();
    if (lower === firstAuthor) return false;
  }

  // Reject if it looks like a person's name (2 words, capitalized, no series keywords)
  if (looksLikePersonName(s)) {
    const words = s.trim().split(/\s+/);
    // Only reject simple 2-word names that look like "First Last"
    if (words.length === 2) return false;
  }

  return true;
};

// Validate sequence/book number
const isValidSequence = (seq) => {
  if (!seq || typeof seq !== 'string') return false;

  const s = seq.trim();
  if (s.length === 0) return false;

  const lower = s.toLowerCase();
  const invalidValues = ['null', 'or null', 'none', 'n/a', 'na', 'unknown', '?', 'tbd'];
  if (invalidValues.includes(lower)) return false;

  return true;
};

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
    title: 'text-blue-400',
    author: 'text-purple-400',
    narrator: 'text-green-400',
    genre: 'text-orange-400',
    year: 'text-gray-400',
    series: 'text-indigo-400',
    publisher: 'text-pink-400',
  };

  return (
    <div
      className="absolute z-50 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-3 w-72 pointer-events-none"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translateX(-50%)',
      }}
    >
      <div className="text-xs font-semibold text-gray-300 mb-2 flex items-center gap-1.5">
        <span className="w-2 h-2 bg-amber-400 rounded-full"></span>
        Pending Changes Preview
      </div>
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {changeEntries.slice(0, 5).map(([field, change]) => (
          <div key={field} className="text-xs">
            <span className={`font-semibold capitalize ${fieldColors[field] || 'text-gray-400'}`}>
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
          <div className="text-[10px] text-gray-400 italic pt-1 border-t border-neutral-800">
            +{changeEntries.length - 5} more changes...
          </div>
        )}
      </div>
      <div className="text-[10px] text-gray-400 mt-2 pt-2 border-t border-neutral-800">
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
  onToggleGroup,
  onSelectFile,
  scanning,
  onSelectAll,
  onSelectFiltered,
  onClearSelection,
  validationResults = {}, // { bookId: { issues, errorCount, warningCount } }
  hasAbsConnection = false,
  onImportFromAbs,
  onNavigateToSettings,
}) {
  const [coverCache, setCoverCache] = useState({});
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 30 });
  const listRef = useRef(null);
  const coverLoadingRef = useRef(new Set());
  const blobUrlsRef = useRef(new Map());

  // Hover preview state
  const [hoverPreview, setHoverPreview] = useState({ group: null, position: { x: 0, y: 0 } });
  const hoverTimeoutRef = useRef(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  // Sort state: 'title', 'author', 'date_added' (default), 'year'
  const [sortBy, setSortBy] = useState('date_added');
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' or 'desc'
  // Validation filter: 'all', 'errors', 'warnings', 'clean'
  const [validationFilter, setValidationFilter] = useState('all');
  const [issueTypeFilter, setIssueTypeFilter] = useState('all');
  // Edit status filter: 'all', 'edited', 'unedited'
  const [editFilter, setEditFilter] = useState('all');
  // Processed status filter: 'all', 'processed', 'unprocessed'
  const [processedFilter, setProcessedFilter] = useState('all');
  // Missing metadata filter: 'all', 'dna', 'genres', 'description', 'narrator'
  const [missingFilter, setMissingFilter] = useState('all');
  const [showMissingDropdown, setShowMissingDropdown] = useState(false);
  const missingDropdownRef = useRef(null);
  // Active view: 'all', 'recent', 'edited'
  const [activeView, setActiveView] = useState('all');

  // Compute active filter label for the dropdown button
  const activeFilterLabel = useMemo(() => {
    if (missingFilter !== 'all') {
      return `No ${({ dna: 'DNA', genres: 'Genres', description: 'Desc', narrator: 'Narrator' })[missingFilter]}`;
    }
    if (editFilter === 'edited') return 'Edited';
    if (editFilter === 'unedited') return 'Unedited';
    if (processedFilter === 'processed') return 'Processed';
    if (processedFilter === 'unprocessed') return 'Unprocessed';
    if (validationFilter === 'issues') return 'Issues';
    if (activeView === 'recent') return 'Recent';
    return 'All';
  }, [missingFilter, editFilter, processedFilter, validationFilter, activeView]);

  // Close missing dropdown on click outside
  useEffect(() => {
    if (!showMissingDropdown) return;
    const handler = (e) => {
      if (missingDropdownRef.current && !missingDropdownRef.current.contains(e.target)) {
        setShowMissingDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMissingDropdown]);

  // Check if validation data exists
  const hasValidationData = Object.keys(validationResults).length > 0;

  // Collect unique issue types for filtering
  const uniqueIssueTypes = useMemo(() => {
    if (!hasValidationData) return [];
    const types = new Set();
    Object.values(validationResults).forEach(validation => {
      validation?.issues?.forEach(issue => {
        if (issue.issue_type) {
          types.add(issue.issue_type);
        }
      });
    });
    return Array.from(types).sort();
  }, [validationResults, hasValidationData]);

  // Clear filters helper
  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setValidationFilter('all');
    setIssueTypeFilter('all');
    setEditFilter('all');
    setProcessedFilter('all');
    setMissingFilter('all');
    setActiveView('all');
  }, []);

  // Simple fuzzy matching - checks if query words are present (not necessarily contiguous)
  const fuzzyMatch = useCallback((text, query) => {
    if (!text || !query) return false;
    const textLower = text.toLowerCase();
    const queryLower = query.toLowerCase().trim();

    // Exact substring match
    if (textLower.includes(queryLower)) return true;

    // Word-based fuzzy: all query words must be present
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);
    if (queryWords.length > 1) {
      return queryWords.every(word => textLower.includes(word));
    }

    return false;
  }, []);

  // Find "did you mean" suggestions when no results
  const getSuggestions = useCallback((query, allGroups) => {
    if (!query || query.length < 3 || allGroups.length === 0) return [];

    const queryLower = query.toLowerCase().trim();
    const suggestions = new Set();

    // Check for partial matches in titles and authors
    allGroups.forEach(group => {
      const meta = group.metadata || {};
      const title = meta.title?.toLowerCase() || '';
      const author = meta.author?.toLowerCase() || '';

      // Check if query is a partial match (typo tolerance)
      if (title && title.length > 3) {
        // Check if first few chars match
        if (title.startsWith(queryLower.slice(0, 3)) ||
            queryLower.startsWith(title.slice(0, 3))) {
          suggestions.add(meta.title);
        }
      }
      if (author && author.length > 3) {
        if (author.startsWith(queryLower.slice(0, 3)) ||
            queryLower.startsWith(author.slice(0, 3))) {
          suggestions.add(meta.author);
        }
      }
    });

    return Array.from(suggestions).slice(0, 3);
  }, []);

  // Filter and sort groups
  const { filteredGroups, suggestions } = useMemo(() => {
    let result = groups;

    // Apply validation filter first (if validation data exists)
    if (hasValidationData && validationFilter !== 'all') {
      result = result.filter(group => {
        const validation = validationResults[group.id];
        switch (validationFilter) {
          case 'errors':
            return validation?.errorCount > 0;
          case 'warnings':
            return validation?.warningCount > 0 && (validation?.errorCount || 0) === 0;
          case 'issues':
            return validation?.errorCount > 0 || validation?.warningCount > 0;
          case 'clean':
            return !validation || (validation.errorCount === 0 && validation.warningCount === 0);
          default:
            return true;
        }
      });
    }

    // Apply issue type filter (if set)
    if (hasValidationData && issueTypeFilter !== 'all') {
      result = result.filter(group => {
        const validation = validationResults[group.id];
        if (!validation?.issues) return false;
        return validation.issues.some(issue => issue.issue_type === issueTypeFilter);
      });
    }

    // Apply edit filter
    if (editFilter !== 'all') {
      result = result.filter(group => {
        const hasChanges = group.total_changes > 0;
        if (editFilter === 'edited') return hasChanges;
        if (editFilter === 'unedited') return !hasChanges;
        return true;
      });
    }

    // Apply processed filter (checks DNA tags + metadata completeness)
    if (processedFilter !== 'all') {
      result = result.filter(group => {
        const meta = group.metadata || {};
        const hasDna = meta.tags?.some(t => t.startsWith('dna:'));
        const hasGenres = meta.genres?.length > 0;
        const hasDescription = !!meta.description;
        const hasNarrator = !!meta.narrator || meta.narrators?.length > 0;
        const isProcessed = hasDna && hasGenres && hasDescription && hasNarrator;
        return processedFilter === 'processed' ? isProcessed : !isProcessed;
      });
    }

    // Apply missing metadata filter
    if (missingFilter !== 'all') {
      result = result.filter(group => {
        const meta = group.metadata || {};
        switch (missingFilter) {
          case 'dna': return !meta.tags?.some(t => t.startsWith('dna:'));
          case 'genres': return !meta.genres?.length;
          case 'description': return !meta.description;
          case 'narrator': return !meta.narrator && !meta.narrators?.length;
          default: return true;
        }
      });
    }

    // Apply search filter with fuzzy matching
    if (searchQuery.trim()) {
      const searchLower = searchQuery.toLowerCase().trim();
      result = result.filter(group => {
        const metadata = group.metadata || {};
        const matchesTitle = fuzzyMatch(metadata.title, searchQuery);
        const matchesAuthor = fuzzyMatch(metadata.author, searchQuery);
        const matchesSeries = fuzzyMatch(metadata.series, searchQuery) ||
                             metadata.all_series?.some(s => fuzzyMatch(s?.name, searchQuery));
        const matchesNarrator = fuzzyMatch(metadata.narrator, searchQuery) ||
                               metadata.narrators?.some(n => fuzzyMatch(n, searchQuery));
        const matchesGroupName = fuzzyMatch(group.group_name, searchQuery);
        const matchesGenres = metadata.genres?.some(g => fuzzyMatch(g, searchQuery));
        const matchesTags = metadata.tags?.some(t => fuzzyMatch(t, searchQuery));
        return matchesTitle || matchesAuthor || matchesSeries || matchesNarrator || matchesGroupName || matchesGenres || matchesTags;
      });
    }

    // Get suggestions if no results
    const didYouMean = result.length === 0 && searchQuery.trim()
      ? getSuggestions(searchQuery, groups)
      : [];

    // Apply sorting
    result = [...result].sort((a, b) => {
      let comparison = 0;
      const metaA = a.metadata || {};
      const metaB = b.metadata || {};

      switch (sortBy) {
        case 'title':
          comparison = (metaA.title || '').localeCompare(metaB.title || '');
          break;
        case 'author':
          comparison = (metaA.author || '').localeCompare(metaB.author || '');
          break;
        case 'year':
          const yearA = parseInt(metaA.year) || 0;
          const yearB = parseInt(metaB.year) || 0;
          comparison = yearA - yearB;
          break;
        case 'missing_count': {
          const countMissing = (meta, id) => {
            let n = 0;
            if (!meta.tags?.some(t => t.startsWith('dna:'))) n++;
            if (!meta.genres?.length) n++;
            if (!meta.description) n++;
            if (!meta.narrator && !meta.narrators?.length) n++;
            return n;
          };
          comparison = countMissing(metaA, a.id) - countMissing(metaB, b.id);
          break;
        }
        case 'date_added':
        default:
          // Use added_at timestamp from ABS
          const addedA = metaA.added_at || 0;
          const addedB = metaB.added_at || 0;
          comparison = addedA - addedB;
          break;
      }

      return sortOrder === 'desc' ? -comparison : comparison;
    });

    return { filteredGroups: result, suggestions: didYouMean };
  }, [groups, searchQuery, sortBy, sortOrder, fuzzyMatch, getSuggestions, validationFilter, issueTypeFilter, editFilter, processedFilter, missingFilter, hasValidationData, validationResults]);

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

  // Load covers for visible items in the filtered list
  useEffect(() => {
    if (filteredGroups.length === 0) return;

    let cancelled = false;

    const loadVisibleCovers = async () => {
      const visible = filteredGroups.slice(visibleRange.start, Math.min(visibleRange.end, filteredGroups.length));

      // Load all visible in parallel
      await Promise.all(visible.map(async (group) => {
        if (coverCache[group.id] || coverLoadingRef.current.has(group.id) || cancelled) return;

        coverLoadingRef.current.add(group.id);

        try {
          const cover = await callBackend('get_cover_for_group', { groupId: group.id });
          if (cover && cover.blobUrl && !cancelled) {
            blobUrlsRef.current.set(group.id, cover.blobUrl);
            setCoverCache(prev => ({ ...prev, [group.id]: cover.blobUrl }));
          }
        } catch (error) {
          // Silently fail
        } finally {
          coverLoadingRef.current.delete(group.id);
        }
      }));
    };

    const timeoutId = setTimeout(loadVisibleCovers, 50);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [visibleRange.start, visibleRange.end, filteredGroups]);

  const getFileStatusIcon = (fileId) => {
    const status = fileStatuses[fileId];
    if (status === 'success') return <span className="text-green-600 font-bold">✓</span>;
    if (status === 'failed') return <span className="text-red-600 font-bold">✗</span>;
    return null;
  };

  // Memoize stats to prevent recalculation
  const stats = useMemo(() => ({
    totalBooks: groups.length,
    totalFiles: groups.reduce((sum, g) => sum + (g.files?.length || 0), 0),
    totalChanges: groups.reduce((sum, g) => sum + (g.total_changes || 0), 0)
  }), [groups]);

  if (groups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-neutral-950">
        <div className="text-center max-w-md">
          {hasAbsConnection ? (
            <>
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-orange-500 flex items-center justify-center">
                <Cloud className="w-10 h-10 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-3">Load Your Library</h2>
              <p className="text-gray-400 mb-6">
                Connect to AudiobookShelf to import your audiobook library and start enriching metadata.
              </p>
              <button
                onClick={onImportFromAbs}
                disabled={scanning}
                className="w-full px-6 py-4 bg-orange-500 hover:bg-orange-600 text-white rounded-xl font-semibold text-lg transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
              >
                {scanning ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    Loading...
                  </>
                ) : (
                  <>
                    <Cloud className="w-5 h-5" />
                    Load from AudiobookShelf
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
                <AlertTriangle className="w-10 h-10 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-3">Connect to AudiobookShelf</h2>
              <p className="text-gray-400 mb-6">
                Configure your AudiobookShelf server connection to import your library and start enriching metadata.
              </p>
              <button
                onClick={onNavigateToSettings}
                className="w-full px-6 py-4 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-xl font-semibold text-lg transition-all shadow-lg hover:shadow-xl flex items-center justify-center gap-3"
              >
                <ArrowRight className="w-5 h-5" />
                Go to Settings
              </button>
              <p className="text-gray-500 text-sm mt-4">
                You'll need your server URL and API token
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  // Calculate total height for virtualization
  const totalHeight = filteredGroups.length * ITEM_HEIGHT;
  const offsetY = visibleRange.start * ITEM_HEIGHT;

  return (
    <div className="w-2/5 overflow-hidden bg-neutral-950 flex flex-col">
      {/* Header - Minimal Filter Bar */}
      <div className="px-4 py-3 flex-shrink-0">
        {/* Filter Bar: Search + Filter Dropdown */}
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="w-full pl-9 pr-8 py-2 text-sm bg-neutral-900 border border-neutral-800 rounded-lg focus:outline-none focus:border-neutral-700 text-gray-100 placeholder-gray-600"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="w-4 h-4 text-gray-500 hover:text-gray-300" />
              </button>
            )}
          </div>

          {/* Filter dropdown */}
          <div className="relative" ref={missingDropdownRef}>
            <button
              onClick={() => setShowMissingDropdown(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-colors ${
                activeFilterLabel !== 'All'
                  ? 'border-neutral-600 text-white bg-neutral-800'
                  : 'border-neutral-800 text-gray-400 hover:text-gray-300 hover:border-neutral-700'
              }`}
            >
              <Filter className="w-3.5 h-3.5" />
              {activeFilterLabel}
              <ChevronDown className="w-3 h-3" />
            </button>
            {showMissingDropdown && (
              <div className="absolute top-full right-0 mt-1 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl z-50 py-1 min-w-[200px]">
                {/* Status filters */}
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-600 font-semibold">Status</div>
                {[
                  { label: 'All Books', active: activeView === 'all' && editFilter === 'all' && processedFilter === 'all' && missingFilter === 'all' && validationFilter === 'all', color: 'bg-white',
                    action: () => { clearFilters(); setActiveView('all'); } },
                  { label: 'Recent', active: activeView === 'recent', color: null, icon: true,
                    action: () => { setActiveView('recent'); setSortBy('date_added'); setSortOrder('desc'); setEditFilter('all'); setValidationFilter('all'); setProcessedFilter('all'); setMissingFilter('all'); } },
                  { label: `Edited${groups.filter(g => g.total_changes > 0).length > 0 ? ` (${groups.filter(g => g.total_changes > 0).length})` : ''}`, active: editFilter === 'edited', color: 'bg-amber-500',
                    action: () => { setActiveView('edited'); setEditFilter('edited'); setValidationFilter('all'); setProcessedFilter('all'); setMissingFilter('all'); } },
                  { label: 'Unedited', active: editFilter === 'unedited', color: 'bg-green-500',
                    action: () => { setActiveView('unedited'); setEditFilter('unedited'); setValidationFilter('all'); setProcessedFilter('all'); setMissingFilter('all'); } },
                  { label: 'Processed', active: processedFilter === 'processed', color: 'bg-emerald-500',
                    action: () => { setActiveView('processed'); setProcessedFilter('processed'); setEditFilter('all'); setValidationFilter('all'); setMissingFilter('all'); } },
                  { label: 'Unprocessed', active: processedFilter === 'unprocessed', color: 'bg-rose-500',
                    action: () => { setActiveView('unprocessed'); setProcessedFilter('unprocessed'); setEditFilter('all'); setValidationFilter('all'); setMissingFilter('all'); } },
                  ...(hasValidationData ? [{
                    label: `Issues${Object.values(validationResults).filter(v => v?.errorCount > 0 || v?.warningCount > 0).length > 0 ? ` (${Object.values(validationResults).filter(v => v?.errorCount > 0 || v?.warningCount > 0).length})` : ''}`,
                    active: validationFilter === 'issues', color: 'bg-red-500',
                    action: () => { setActiveView('issues'); setValidationFilter('issues'); setEditFilter('all'); setProcessedFilter('all'); setMissingFilter('all'); }
                  }] : []),
                ].map((item, i) => (
                  <button
                    key={i}
                    onClick={() => { item.action(); setShowMissingDropdown(false); }}
                    className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
                      item.active ? 'text-white bg-neutral-800' : 'text-gray-400 hover:bg-neutral-800 hover:text-white'
                    }`}
                  >
                    {item.icon
                      ? <ArrowUpDown className="w-3 h-3" />
                      : <span className={`w-1.5 h-1.5 rounded-full ${item.active ? item.color : 'bg-gray-600'}`} />
                    }
                    {item.label}
                  </button>
                ))}

                {/* Missing metadata section */}
                <div className="border-t border-neutral-800 mt-1 pt-1">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-600 font-semibold">Missing</div>
                  {[
                    { key: 'dna', label: 'DNA Tags', color: 'bg-purple-400' },
                    { key: 'genres', label: 'Genres', color: 'bg-blue-400' },
                    { key: 'description', label: 'Description', color: 'bg-cyan-400' },
                    { key: 'narrator', label: 'Narrator', color: 'bg-orange-400' },
                  ].map(f => (
                    <button
                      key={f.key}
                      onClick={() => {
                        setActiveView(f.key);
                        setMissingFilter(f.key);
                        setEditFilter('all');
                        setValidationFilter('all');
                        setProcessedFilter('all');
                        setSortBy('missing_count');
                        setSortOrder('desc');
                        setShowMissingDropdown(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
                        missingFilter === f.key ? 'text-white bg-neutral-800' : 'text-gray-400 hover:bg-neutral-800 hover:text-white'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${missingFilter === f.key ? f.color : 'bg-gray-600'}`} />
                      {f.label}
                    </button>
                  ))}
                </div>

                {/* Sort section */}
                <div className="border-t border-neutral-800 mt-1 pt-1">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-600 font-semibold">Sort By</div>
                  {[
                    { key: 'date_added', label: 'Date Added' },
                    { key: 'title', label: 'Title' },
                    { key: 'author', label: 'Author' },
                    { key: 'year', label: 'Year' },
                    { key: 'missing_count', label: 'Most Incomplete' },
                  ].map(s => (
                    <button
                      key={s.key}
                      onClick={() => {
                        if (sortBy === s.key) {
                          setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                        } else {
                          setSortBy(s.key);
                          setSortOrder(s.key === 'title' || s.key === 'author' ? 'asc' : 'desc');
                        }
                        setShowMissingDropdown(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
                        sortBy === s.key ? 'text-white bg-neutral-800' : 'text-gray-400 hover:bg-neutral-800 hover:text-white'
                      }`}
                    >
                      {sortBy === s.key
                        ? (sortOrder === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
                        : <span className="w-3" />
                      }
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Results count - shows when filtering */}
        {(editFilter !== 'all' || validationFilter !== 'all' || processedFilter !== 'all' || missingFilter !== 'all' || searchQuery) && (
          <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
            <span>
              Showing {filteredGroups.length} of {groups.length} books
            </span>
            {(editFilter !== 'all' || validationFilter !== 'all' || processedFilter !== 'all' || missingFilter !== 'all') && (
              <button
                onClick={clearFilters}
                className="text-gray-400 hover:text-white transition-colors"
              >
                Clear filters
              </button>
            )}
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
              <p className="text-gray-500 text-sm mb-3">No books found</p>
              <button
                onClick={clearFilters}
                className="text-sm text-gray-400 hover:text-white transition-colors"
              >
                Clear filters
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

              // Format duration from seconds to "Xh" or "Xm"
              const formatDuration = (seconds) => {
                if (!seconds) return null;
                const hours = Math.floor(seconds / 3600);
                const mins = Math.floor((seconds % 3600) / 60);
                if (hours > 0) return `${hours}h`;
                return `${mins}m`;
              };

              const duration = formatDuration(metadata.duration);

              // Get series display text
              const getSeriesText = () => {
                if (metadata.all_series?.length > 0) {
                  const s = metadata.all_series[0];
                  const seq = isValidSequence(s.sequence) ? ` #${s.sequence}` : '';
                  return `${s.name}${seq}`;
                }
                if (isValidSeries(metadata.series, metadata.author)) {
                  const seq = isValidSequence(metadata.sequence) ? ` #${metadata.sequence}` : '';
                  return `${metadata.series}${seq}`;
                }
                return metadata.author;
              };

              const hasIssues = validationResults[group.id]?.errorCount > 0 || validationResults[group.id]?.warningCount > 0;
              const hasChanges = group.total_changes > 0;

              return (
                <div
                  key={group.id}
                  className={`border-b border-neutral-800/50 transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-neutral-800/50'
                      : 'hover:bg-neutral-900/50'
                  }`}
                  style={{ height: ITEM_HEIGHT }}
                  onClick={(e) => {
                    onSelectFile(group, actualIndex, e, filteredGroups);
                  }}
                >
                  <div className="h-full flex items-center gap-4 px-4">
                    {/* Cover thumbnail */}
                    <div className="flex-shrink-0 w-12 h-12 bg-neutral-800 rounded-lg overflow-hidden flex items-center justify-center">
                      {coverCache[group.id] ? (
                        <img
                          src={coverCache[group.id]}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <Book className="w-5 h-5 text-gray-600" />
                      )}
                    </div>

                    {/* Title & Series */}
                    <div className="flex-1 min-w-0">
                      <h4 className={`font-medium text-[15px] leading-snug truncate ${
                        isSelected ? 'text-white' : 'text-gray-100'
                      }`}>
                        {metadata.title}
                      </h4>
                      <p className="text-sm text-gray-500 truncate mt-0.5 font-mono">
                        {getSeriesText()}
                      </p>
                    </div>

                    {/* Status indicators & Duration */}
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {/* Missing metadata indicators */}
                      {(() => {
                        const meta = group.metadata || {};
                        const missing = [];
                        if (!meta.tags?.some(t => t.startsWith('dna:'))) missing.push({ label: 'DNA', color: 'text-purple-400' });
                        if (!meta.genres?.length) missing.push({ label: 'G', color: 'text-blue-400' });
                        if (!meta.description) missing.push({ label: 'D', color: 'text-cyan-400' });
                        if (!meta.narrator && !meta.narrators?.length) missing.push({ label: 'N', color: 'text-orange-400' });
                        if (missing.length === 0) return null;
                        return (
                          <div className="flex items-center gap-1" title={`Missing: ${missing.map(m => m.label).join(', ')}`}>
                            {missing.map(m => (
                              <span key={m.label} className={`text-[10px] font-mono font-bold ${m.color} opacity-60`}>
                                {m.label}
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                      {/* Changed field indicators */}
                      {group.changedFields?.length > 0 && (
                        <div className="flex items-center gap-0.5" title={`Changed: ${group.changedFields.join(', ')}`}>
                          {group.changedFields.slice(0, 5).map(f => {
                            const fieldColors = {
                              title: 'bg-blue-500', author: 'bg-blue-400', subtitle: 'bg-blue-300',
                              series: 'bg-indigo-400', sequence: 'bg-indigo-300', narrator: 'bg-orange-400',
                              genres: 'bg-emerald-500', tags: 'bg-amber-500', description: 'bg-cyan-400',
                              themes: 'bg-purple-400', tropes: 'bg-purple-300', age: 'bg-pink-400',
                              dna: 'bg-violet-500', year: 'bg-yellow-400', isbn: 'bg-lime-400', asin: 'bg-lime-300',
                            };
                            return (
                              <span
                                key={f}
                                className={`text-[8px] font-bold uppercase px-1 py-px rounded ${fieldColors[f] || 'bg-gray-500'} text-black/80 leading-none`}
                              >
                                {f === 'description' ? 'desc' : f === 'sequence' ? 'seq' : f}
                              </span>
                            );
                          })}
                          {(group.changedFields?.length || 0) > 5 && (
                            <span className="text-[8px] text-gray-500">+{(group.changedFields?.length || 0) - 5}</span>
                          )}
                        </div>
                      )}
                      {hasChanges && !group.changedFields?.length && (
                        <span
                          className="w-2 h-2 rounded-full bg-amber-500"
                          title={`${group.total_changes} pending changes`}
                          onMouseEnter={(e) => handleChangesBadgeHover(group, e)}
                          onMouseLeave={handleChangesBadgeLeave}
                        />
                      )}
                      {hasIssues && (
                        <span
                          className={`w-2 h-2 rounded-full ${validationResults[group.id]?.errorCount > 0 ? 'bg-red-500' : 'bg-yellow-500'}`}
                          title={`${validationResults[group.id]?.errorCount || 0} errors, ${validationResults[group.id]?.warningCount || 0} warnings`}
                        />
                      )}
                      {group.files.some(f => fileStatuses[f.id] === 'success') && (
                        <CheckCircle className="w-4 h-4 text-green-500" />
                      )}

                      {/* Duration */}
                      <span className="text-sm text-gray-500 tabular-nums w-10 text-right">
                        {duration || '0h'}
                      </span>
                    </div>
                  </div>
                  
                  {/* Expanded Files */}
                  {expandedGroups.has(group.id) && (
                    <div className="bg-neutral-900/50 border-t border-neutral-800/50">
                      {(group.files || []).map((file, fileIndex) => (
                        <div
                          key={file.id}
                          className="flex items-center gap-3 px-4 py-2 pl-20 border-b border-neutral-800/30 last:border-b-0"
                        >
                          <span className="text-xs text-gray-600 font-mono w-6 text-right">
                            {fileIndex + 1}
                          </span>
                          <FileAudio className="w-3.5 h-3.5 text-gray-600" />
                          <span className="text-sm text-gray-400 truncate flex-1">
                            {file.filename}
                          </span>
                          {getFileStatusIcon(file.id)}
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