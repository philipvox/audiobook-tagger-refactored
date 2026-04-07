// src/components/ValidationIssueModal.jsx
// Modal for reviewing validation issues and selectively applying fixes

import { useState, useMemo } from 'react';
import { X, Check, AlertTriangle, Info, ChevronDown, ChevronRight, Wrench, Filter, BookOpen } from 'lucide-react';

const ISSUE_TYPE_LABELS = {
  InvalidAuthor: { label: 'Invalid Author', color: 'text-red-400' },
  AuthorNeedsNormalization: { label: 'Author Normalization', color: 'text-yellow-400' },
  SuspiciousAuthor: { label: 'Suspicious Author', color: 'text-orange-400' },
  MultipleAuthorFormats: { label: 'Multiple Author Formats', color: 'text-yellow-400' },
  AuthorMissingDiacritics: { label: 'Missing Diacritics', color: 'text-blue-400' },
  TitleContainsSeriesNumber: { label: 'Title Has Series #', color: 'text-blue-400' },
  TitleMatchesSeries: { label: 'Title = Series', color: 'text-yellow-400' },
  SuspiciousTitle: { label: 'Suspicious Title', color: 'text-orange-400' },
  TitleAllCaps: { label: 'Title ALL CAPS', color: 'text-yellow-400' },
  InvalidSeries: { label: 'Invalid Series', color: 'text-red-400' },
  SeriesMatchesAuthor: { label: 'Series = Author', color: 'text-red-400' },
  SeriesOwnershipMismatch: { label: 'Series Ownership', color: 'text-yellow-400' },
  OrphanSubseries: { label: 'Orphan Subseries', color: 'text-blue-400' },
  SuspiciousSeries: { label: 'Suspicious Series', color: 'text-orange-400' },
  MissingSequence: { label: 'Missing Sequence', color: 'text-blue-400' },
  InvalidSequence: { label: 'Invalid Sequence', color: 'text-yellow-400' },
  NarratorMatchesAuthor: { label: 'Narrator = Author', color: 'text-blue-400' },
  SuspiciousNarrator: { label: 'Suspicious Narrator', color: 'text-orange-400' },
  DescriptionTooShort: { label: 'Short Description', color: 'text-blue-400' },
  DescriptionContainsHtml: { label: 'HTML in Description', color: 'text-yellow-400' },
  DescriptionMissing: { label: 'Missing Description', color: 'text-blue-400' },
  MissingField: { label: 'Missing Field', color: 'text-blue-400' },
  InconsistentData: { label: 'Inconsistent Data', color: 'text-yellow-400' },
};

const SEVERITY_STYLES = {
  Error: 'bg-red-500/20 text-red-300 border-red-500/30',
  Warning: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  Info: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
};

export function ValidationIssueModal({
  isOpen,
  onClose,
  validationResults,
  selectedBooks,
  groups,
  onApplyFixes
}) {
  const [expandedBooks, setExpandedBooks] = useState(new Set());
  const [selectedFixes, setSelectedFixes] = useState(new Set());
  const [filterType, setFilterType] = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');
  const [filterFixable, setFilterFixable] = useState(false);

  // Get books with issues that are in selection (or all if no selection)
  const booksWithIssues = useMemo(() => {
    if (!validationResults || !groups) return [];

    const targetBooks = selectedBooks?.size > 0
      ? groups.filter(g => selectedBooks.has(g.id))
      : groups;

    return targetBooks
      .filter(g => validationResults[g.id]?.issues?.length > 0)
      .map(g => ({
        ...g,
        validation: validationResults[g.id]
      }));
  }, [validationResults, groups, selectedBooks]);

  // Get issue type counts
  const issueTypeCounts = useMemo(() => {
    const counts = {};
    for (const book of booksWithIssues) {
      for (const issue of book.validation.issues) {
        counts[issue.issue_type] = (counts[issue.issue_type] || 0) + 1;
      }
    }
    return counts;
  }, [booksWithIssues]);

  // Get severity counts
  const severityCounts = useMemo(() => {
    const counts = { Error: 0, Warning: 0, Info: 0 };
    for (const book of booksWithIssues) {
      for (const issue of book.validation.issues) {
        counts[issue.severity] = (counts[issue.severity] || 0) + 1;
      }
    }
    return counts;
  }, [booksWithIssues]);

  // Get fixable count
  const fixableCount = useMemo(() => {
    let count = 0;
    for (const book of booksWithIssues) {
      for (const issue of book.validation.issues) {
        if (issue.suggested_value) count++;
      }
    }
    return count;
  }, [booksWithIssues]);

  // Filter books based on current filters
  const filteredBooks = useMemo(() => {
    return booksWithIssues.filter(book => {
      const issues = book.validation.issues;

      // Filter by fixable
      if (filterFixable && !issues.some(i => i.suggested_value)) {
        return false;
      }

      // Filter by type
      if (filterType !== 'all' && !issues.some(i => i.issue_type === filterType)) {
        return false;
      }

      // Filter by severity
      if (filterSeverity !== 'all' && !issues.some(i => i.severity === filterSeverity)) {
        return false;
      }

      return true;
    });
  }, [booksWithIssues, filterType, filterSeverity, filterFixable]);

  // Generate fix key for tracking selections
  const getFixKey = (bookId, issueIdx) => `${bookId}:${issueIdx}`;

  // Initialize selected fixes on mount
  useState(() => {
    const keys = new Set();
    for (const book of booksWithIssues) {
      book.validation.issues.forEach((issue, idx) => {
        if (issue.suggested_value) {
          keys.add(getFixKey(book.id, idx));
        }
      });
    }
    setSelectedFixes(keys);
  }, [booksWithIssues]);

  const toggleBook = (bookId) => {
    setExpandedBooks(prev => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  };

  const toggleFix = (bookId, issueIdx) => {
    const key = getFixKey(bookId, issueIdx);
    setSelectedFixes(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const selectAllFixable = () => {
    const keys = new Set();
    for (const book of filteredBooks) {
      book.validation.issues.forEach((issue, idx) => {
        if (issue.suggested_value) {
          keys.add(getFixKey(book.id, idx));
        }
      });
    }
    setSelectedFixes(keys);
  };

  const selectNone = () => {
    setSelectedFixes(new Set());
  };

  const selectByType = (issueType) => {
    const keys = new Set(selectedFixes);
    for (const book of filteredBooks) {
      book.validation.issues.forEach((issue, idx) => {
        if (issue.issue_type === issueType && issue.suggested_value) {
          keys.add(getFixKey(book.id, idx));
        }
      });
    }
    setSelectedFixes(keys);
  };

  const handleApply = () => {
    // Build fixes array from selected items
    const fixes = [];
    for (const book of booksWithIssues) {
      book.validation.issues.forEach((issue, idx) => {
        const key = getFixKey(book.id, idx);
        if (selectedFixes.has(key) && issue.suggested_value) {
          fixes.push({
            bookId: book.id,
            field: issue.field,
            suggestedValue: issue.suggested_value,
          });
        }
      });
    }

    if (fixes.length > 0) {
      onApplyFixes(fixes);
    }
    onClose();
  };

  if (!isOpen) return null;

  const totalIssues = booksWithIssues.reduce((sum, b) => sum + b.validation.issues.length, 0);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-lg border border-neutral-700 max-w-4xl w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-400" />
            <h2 className="text-lg font-semibold text-white">Validation Issues</h2>
            <span className="text-sm text-gray-400">
              ({totalIssues} issues in {booksWithIssues.length} books)
            </span>
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

          {/* Fixable filter */}
          <button
            onClick={() => setFilterFixable(!filterFixable)}
            className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
              filterFixable
                ? 'bg-green-600/30 text-green-300 border border-green-500/30'
                : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
            }`}
          >
            <Wrench className="w-3 h-3" />
            Fixable <span className="text-[10px]">({fixableCount})</span>
          </button>

          <div className="w-px h-4 bg-neutral-700" />

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
            {severityCounts.Error > 0 && (
              <button
                onClick={() => setFilterSeverity('Error')}
                className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                  filterSeverity === 'Error'
                    ? 'bg-red-600/30 text-red-300 border border-red-500/30'
                    : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
                }`}
              >
                Errors <span className="text-[10px]">({severityCounts.Error})</span>
              </button>
            )}
            {severityCounts.Warning > 0 && (
              <button
                onClick={() => setFilterSeverity('Warning')}
                className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                  filterSeverity === 'Warning'
                    ? 'bg-yellow-600/30 text-yellow-300 border border-yellow-500/30'
                    : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
                }`}
              >
                Warnings <span className="text-[10px]">({severityCounts.Warning})</span>
              </button>
            )}
            {severityCounts.Info > 0 && (
              <button
                onClick={() => setFilterSeverity('Info')}
                className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                  filterSeverity === 'Info'
                    ? 'bg-blue-600/30 text-blue-300 border border-blue-500/30'
                    : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
                }`}
              >
                Info <span className="text-[10px]">({severityCounts.Info})</span>
              </button>
            )}
          </div>

          <div className="w-px h-4 bg-neutral-700" />

          {/* Issue type quick select */}
          <div className="flex items-center gap-1 flex-wrap">
            {Object.entries(issueTypeCounts)
              .filter(([_, count]) => count > 0)
              .slice(0, 5)
              .map(([type, count]) => {
                const typeInfo = ISSUE_TYPE_LABELS[type] || { label: type, color: 'text-gray-400' };
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
                    <span className={filterType === type ? 'text-white' : typeInfo.color}>
                      {typeInfo.label}
                    </span>
                    <span className="text-[10px] ml-1">({count})</span>
                  </button>
                );
              })}
          </div>
        </div>

        {/* Bulk select by type */}
        <div className="px-4 py-2 border-b border-neutral-800 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">Select all fixable by type:</span>
          {Object.entries(issueTypeCounts)
            .filter(([type, _]) => {
              // Only show types that have fixable issues
              return booksWithIssues.some(b =>
                b.validation.issues.some(i => i.issue_type === type && i.suggested_value)
              );
            })
            .map(([type, _]) => {
              const typeInfo = ISSUE_TYPE_LABELS[type] || { label: type, color: 'text-gray-400' };
              return (
                <button
                  key={type}
                  onClick={() => selectByType(type)}
                  className="px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-gray-400 hover:text-white rounded border border-neutral-700 transition-colors"
                >
                  + {typeInfo.label}
                </button>
              );
            })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {filteredBooks.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {totalIssues === 0
                ? 'No validation issues found!'
                : 'No issues match current filters'}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredBooks.map((book) => {
                const filteredIssues = book.validation.issues.filter(issue => {
                  if (filterType !== 'all' && issue.issue_type !== filterType) return false;
                  if (filterSeverity !== 'all' && issue.severity !== filterSeverity) return false;
                  if (filterFixable && !issue.suggested_value) return false;
                  return true;
                });

                if (filteredIssues.length === 0) return null;

                return (
                  <div key={book.id} className="bg-neutral-800/50 rounded-lg border border-neutral-700">
                    {/* Book header */}
                    <button
                      onClick={() => toggleBook(book.id)}
                      className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-neutral-800 rounded-t-lg transition-colors"
                    >
                      {expandedBooks.has(book.id)
                        ? <ChevronDown className="w-4 h-4 text-gray-500" />
                        : <ChevronRight className="w-4 h-4 text-gray-500" />
                      }
                      <BookOpen className="w-4 h-4 text-gray-500" />
                      <span className="font-medium text-white truncate max-w-[300px]">
                        {book.metadata.title}
                      </span>
                      <span className="text-xs text-gray-500">
                        by {book.metadata.author}
                      </span>
                      <div className="flex-1" />
                      <div className="flex items-center gap-1">
                        {filteredIssues.filter(i => i.severity === 'Error').length > 0 && (
                          <span className="px-1.5 py-0.5 text-[10px] bg-red-500/20 text-red-300 rounded">
                            {filteredIssues.filter(i => i.severity === 'Error').length} errors
                          </span>
                        )}
                        {filteredIssues.filter(i => i.severity === 'Warning').length > 0 && (
                          <span className="px-1.5 py-0.5 text-[10px] bg-yellow-500/20 text-yellow-300 rounded">
                            {filteredIssues.filter(i => i.severity === 'Warning').length} warnings
                          </span>
                        )}
                        {filteredIssues.filter(i => i.suggested_value).length > 0 && (
                          <span className="px-1.5 py-0.5 text-[10px] bg-green-500/20 text-green-300 rounded">
                            {filteredIssues.filter(i => i.suggested_value).length} fixable
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Expanded content */}
                    {expandedBooks.has(book.id) && (
                      <div className="px-3 pb-3 space-y-2">
                        {filteredIssues.map((issue, issueIdx) => {
                          // Find original index for fix key
                          const originalIdx = book.validation.issues.indexOf(issue);
                          const fixKey = getFixKey(book.id, originalIdx);
                          const isSelected = selectedFixes.has(fixKey);
                          const typeInfo = ISSUE_TYPE_LABELS[issue.issue_type] || { label: issue.issue_type, color: 'text-gray-400' };

                          return (
                            <div
                              key={`${book.id}-${issueIdx}`}
                              className={`p-2 rounded border ${SEVERITY_STYLES[issue.severity] || SEVERITY_STYLES.Info}`}
                            >
                              <div className="flex items-start gap-2">
                                {issue.severity === 'Error' && <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />}
                                {issue.severity === 'Warning' && <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />}
                                {issue.severity === 'Info' && <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />}

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${typeInfo.color} bg-neutral-900/50`}>
                                      {typeInfo.label}
                                    </span>
                                    <span className="text-xs text-gray-400">
                                      Field: <span className="text-white">{issue.field}</span>
                                    </span>
                                  </div>
                                  <div className="text-sm mt-1">{issue.message}</div>

                                  {issue.current_value && (
                                    <div className="mt-1 text-xs text-gray-400">
                                      Current: <span className="font-mono text-gray-300">"{issue.current_value}"</span>
                                    </div>
                                  )}

                                  {/* Suggested fix */}
                                  {issue.suggested_value && (
                                    <div className="mt-2 flex items-center gap-2">
                                      <button
                                        onClick={() => toggleFix(book.id, originalIdx)}
                                        className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
                                          isSelected
                                            ? 'bg-green-600/30 text-green-300 border border-green-500/30'
                                            : 'bg-neutral-700 text-gray-400 hover:text-white border border-neutral-600'
                                        }`}
                                      >
                                        <Check className={`w-3 h-3 ${isSelected ? 'opacity-100' : 'opacity-50'}`} />
                                        <span>Fix → </span>
                                        <span className="font-mono">"{issue.suggested_value}"</span>
                                      </button>
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
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-neutral-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={selectAllFixable}
              className="px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 text-gray-400 rounded border border-neutral-700 transition-colors"
            >
              Select All Fixable
            </button>
            <button
              onClick={selectNone}
              className="px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 text-gray-400 rounded border border-neutral-700 transition-colors"
            >
              Deselect All
            </button>
            <span className="text-xs text-gray-500">
              {selectedFixes.size} fixes selected
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
