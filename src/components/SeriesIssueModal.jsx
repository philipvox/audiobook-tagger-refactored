// src/components/SeriesIssueModal.jsx
// Modal for reviewing series analysis issues before applying fixes

import { useState, useMemo } from 'react';
import { X, Check, AlertTriangle, Info, ChevronDown, ChevronRight, BookOpen, Wrench, Filter } from 'lucide-react';

const ISSUE_TYPES = {
  inconsistent_naming: { label: 'Inconsistent Naming', color: 'text-yellow-400' },
  missing_sequence: { label: 'Missing Sequence', color: 'text-blue-400' },
  duplicate_sequence: { label: 'Duplicate Sequence', color: 'text-red-400' },
  wrong_sequence: { label: 'Wrong Sequence', color: 'text-orange-400' },
  wrong_series_name: { label: 'Wrong Series Name', color: 'text-purple-400' },
  unverified_series: { label: 'Unverified Series', color: 'text-gray-400' },
  sequence_gap: { label: 'Sequence Gap', color: 'text-cyan-400' },
  invalid_sequence: { label: 'Invalid Sequence', color: 'text-red-400' },
};

const SEVERITY_STYLES = {
  error: 'bg-red-500/20 text-red-300 border-red-500/30',
  warning: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  info: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
};

export function SeriesIssueModal({ isOpen, onClose, seriesAnalysis, onApplyFixes, groups }) {
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [selectedFixes, setSelectedFixes] = useState(new Set());
  const [filterType, setFilterType] = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');

  // Initialize selected fixes with all fixable issues
  useState(() => {
    if (seriesAnalysis?.all_fixes) {
      const fixIds = seriesAnalysis.all_fixes.map((_, idx) => idx);
      setSelectedFixes(new Set(fixIds));
    }
  }, [seriesAnalysis]);

  const toggleGroup = (groupName) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  const toggleFix = (fixIdx) => {
    setSelectedFixes(prev => {
      const next = new Set(prev);
      if (next.has(fixIdx)) {
        next.delete(fixIdx);
      } else {
        next.add(fixIdx);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (seriesAnalysis?.all_fixes) {
      setSelectedFixes(new Set(seriesAnalysis.all_fixes.map((_, idx) => idx)));
    }
  };

  const selectNone = () => {
    setSelectedFixes(new Set());
  };

  // Filter series groups
  const filteredGroups = useMemo(() => {
    if (!seriesAnalysis?.series_groups) return [];

    return seriesAnalysis.series_groups.filter(group => {
      if (group.issues.length === 0) return false;

      const hasMatchingType = filterType === 'all' ||
        group.issues.some(i => i.issue_type === filterType);

      const hasMatchingSeverity = filterSeverity === 'all' ||
        group.issues.some(i => i.severity === filterSeverity);

      return hasMatchingType && hasMatchingSeverity;
    });
  }, [seriesAnalysis, filterType, filterSeverity]);

  // Get issue type counts
  const issueTypeCounts = useMemo(() => {
    if (!seriesAnalysis?.series_groups) return {};

    const counts = {};
    for (const group of seriesAnalysis.series_groups) {
      for (const issue of group.issues) {
        counts[issue.issue_type] = (counts[issue.issue_type] || 0) + 1;
      }
    }
    return counts;
  }, [seriesAnalysis]);

  // Get severity counts
  const severityCounts = useMemo(() => {
    if (!seriesAnalysis?.series_groups) return {};

    const counts = { error: 0, warning: 0, info: 0 };
    for (const group of seriesAnalysis.series_groups) {
      for (const issue of group.issues) {
        counts[issue.severity] = (counts[issue.severity] || 0) + 1;
      }
    }
    return counts;
  }, [seriesAnalysis]);

  // Map fix index to fix object
  const fixMap = useMemo(() => {
    if (!seriesAnalysis?.all_fixes) return new Map();

    const map = new Map();
    seriesAnalysis.all_fixes.forEach((fix, idx) => {
      const key = `${fix.book_id}-${fix.field}`;
      map.set(key, idx);
    });
    return map;
  }, [seriesAnalysis]);

  const handleApply = () => {
    if (!seriesAnalysis?.all_fixes) return;

    const fixes = seriesAnalysis.all_fixes.filter((_, idx) => selectedFixes.has(idx));
    onApplyFixes(fixes);
    onClose();
  };

  // Get book title from groups
  const getBookTitle = (bookId) => {
    const group = groups?.find(g => g.id === bookId);
    return group?.metadata?.title || bookId;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-lg border border-neutral-700 max-w-4xl w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-purple-400" />
            <h2 className="text-lg font-semibold text-white">Series Analysis Results</h2>
            {seriesAnalysis && (
              <span className="text-sm text-gray-400">
                ({seriesAnalysis.total_issues} issues in {seriesAnalysis.series_groups?.filter(g => g.issues.length > 0).length || 0} series)
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-neutral-800 rounded-md text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filters */}
        <div className="px-4 py-2 border-b border-neutral-800 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs">
            <Filter className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-gray-500">Filter:</span>
          </div>

          {/* Severity filter pills */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setFilterSeverity('all')}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                filterSeverity === 'all'
                  ? 'bg-purple-600/30 text-purple-300 border border-purple-500/30'
                  : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
              }`}
            >
              All
            </button>
            {severityCounts.error > 0 && (
              <button
                onClick={() => setFilterSeverity('error')}
                className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                  filterSeverity === 'error'
                    ? 'bg-red-600/30 text-red-300 border border-red-500/30'
                    : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
                }`}
              >
                Errors <span className="text-[10px]">({severityCounts.error})</span>
              </button>
            )}
            {severityCounts.warning > 0 && (
              <button
                onClick={() => setFilterSeverity('warning')}
                className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                  filterSeverity === 'warning'
                    ? 'bg-yellow-600/30 text-yellow-300 border border-yellow-500/30'
                    : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
                }`}
              >
                Warnings <span className="text-[10px]">({severityCounts.warning})</span>
              </button>
            )}
            {severityCounts.info > 0 && (
              <button
                onClick={() => setFilterSeverity('info')}
                className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                  filterSeverity === 'info'
                    ? 'bg-blue-600/30 text-blue-300 border border-blue-500/30'
                    : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
                }`}
              >
                Info <span className="text-[10px]">({severityCounts.info})</span>
              </button>
            )}
          </div>

          <div className="w-px h-4 bg-neutral-700" />

          {/* Issue type filter pills */}
          <div className="flex items-center gap-1 flex-wrap">
            {Object.entries(ISSUE_TYPES).map(([type, { label, color }]) => {
              const count = issueTypeCounts[type] || 0;
              if (count === 0) return null;

              return (
                <button
                  key={type}
                  onClick={() => setFilterType(filterType === type ? 'all' : type)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    filterType === type
                      ? 'bg-neutral-700 text-white border border-neutral-600'
                      : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
                  }`}
                >
                  <span className={filterType === type ? 'text-white' : color}>{label}</span>
                  <span className="text-[10px] ml-1">({count})</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {filteredGroups.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {seriesAnalysis?.total_issues === 0
                ? 'No issues found in your series data!'
                : 'No issues match current filters'}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredGroups.map((group) => (
                <div key={group.normalized_name} className="bg-neutral-800/50 rounded-lg border border-neutral-700">
                  {/* Series header */}
                  <button
                    onClick={() => toggleGroup(group.normalized_name)}
                    className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-neutral-800 rounded-t-lg transition-colors"
                  >
                    {expandedGroups.has(group.normalized_name)
                      ? <ChevronDown className="w-4 h-4 text-gray-500" />
                      : <ChevronRight className="w-4 h-4 text-gray-500" />
                    }
                    <span className="font-medium text-white">
                      {group.suggested_name || group.name_variations[0]}
                    </span>
                    <span className="text-xs text-gray-500">
                      ({group.books.length} books)
                    </span>
                    {group.api_series_name && (
                      <span className="text-xs text-green-400 ml-1">API verified</span>
                    )}
                    <div className="flex-1" />
                    <div className="flex items-center gap-1">
                      {group.issues.filter(i => i.severity === 'error').length > 0 && (
                        <span className="px-1.5 py-0.5 text-[10px] bg-red-500/20 text-red-300 rounded">
                          {group.issues.filter(i => i.severity === 'error').length} errors
                        </span>
                      )}
                      {group.issues.filter(i => i.severity === 'warning').length > 0 && (
                        <span className="px-1.5 py-0.5 text-[10px] bg-yellow-500/20 text-yellow-300 rounded">
                          {group.issues.filter(i => i.severity === 'warning').length} warnings
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Expanded content */}
                  {expandedGroups.has(group.normalized_name) && (
                    <div className="px-3 pb-3 space-y-2">
                      {/* Name variations */}
                      {group.name_variations.length > 1 && (
                        <div className="text-xs text-gray-500">
                          Variations: {group.name_variations.join(', ')}
                        </div>
                      )}

                      {/* Issues */}
                      {group.issues.map((issue, issueIdx) => {
                        const fixKey = issue.suggested_fix
                          ? `${issue.suggested_fix.book_id}-${issue.suggested_fix.field}`
                          : null;
                        const fixIdx = fixKey ? fixMap.get(fixKey) : null;
                        const isSelected = fixIdx !== null && selectedFixes.has(fixIdx);

                        return (
                          <div
                            key={`${group.normalized_name}-${issueIdx}`}
                            className={`p-2 rounded border ${SEVERITY_STYLES[issue.severity]}`}
                          >
                            <div className="flex items-start gap-2">
                              {issue.severity === 'error' && <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />}
                              {issue.severity === 'warning' && <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />}
                              {issue.severity === 'info' && <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />}

                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium">{issue.message}</div>

                                {/* Show affected books */}
                                {issue.book_ids.length > 0 && (
                                  <div className="mt-1 text-xs text-gray-400">
                                    Affects: {issue.book_ids.slice(0, 3).map(id => getBookTitle(id)).join(', ')}
                                    {issue.book_ids.length > 3 && ` +${issue.book_ids.length - 3} more`}
                                  </div>
                                )}

                                {/* Suggested fix */}
                                {issue.suggested_fix && (
                                  <div className="mt-2 flex items-center gap-2">
                                    <button
                                      onClick={() => fixIdx !== null && toggleFix(fixIdx)}
                                      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
                                        isSelected
                                          ? 'bg-green-600/30 text-green-300 border border-green-500/30'
                                          : 'bg-neutral-700 text-gray-400 hover:text-white border border-neutral-600'
                                      }`}
                                    >
                                      <Check className={`w-3 h-3 ${isSelected ? 'opacity-100' : 'opacity-50'}`} />
                                      <span>Fix: </span>
                                      <span className="font-mono">
                                        {issue.suggested_fix.field}: "{issue.suggested_fix.suggested_value}"
                                      </span>
                                    </button>
                                    <span className="text-[10px] text-gray-500">
                                      {issue.suggested_fix.reason}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-neutral-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={selectAll}
              className="px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 text-gray-400 rounded border border-neutral-700 transition-colors"
            >
              Select All Fixes
            </button>
            <button
              onClick={selectNone}
              className="px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 text-gray-400 rounded border border-neutral-700 transition-colors"
            >
              Deselect All
            </button>
            <span className="text-xs text-gray-500">
              {selectedFixes.size} of {seriesAnalysis?.all_fixes?.length || 0} fixes selected
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm bg-neutral-800 hover:bg-neutral-700 text-gray-300 rounded border border-neutral-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={selectedFixes.size === 0}
              className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-500 text-white rounded border border-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Wrench className="w-3.5 h-3.5" />
              Apply {selectedFixes.size} Fixes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
