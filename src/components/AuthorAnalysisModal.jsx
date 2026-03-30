// src/components/AuthorAnalysisModal.jsx
// Modal for reviewing author analysis and selectively applying normalizations

import { useState, useMemo } from 'react';
import { X, Check, User, AlertTriangle, ChevronDown, ChevronRight, Wrench, Filter, BookOpen } from 'lucide-react';

export function AuthorAnalysisModal({
  isOpen,
  onClose,
  authorAnalysis,
  groups,
  onApplyFixes
}) {
  const [expandedAuthors, setExpandedAuthors] = useState(new Set());
  const [selectedFixes, setSelectedFixes] = useState(new Set());
  const [filterType, setFilterType] = useState('all'); // 'all', 'normalization', 'suspicious'

  // Build author to books mapping
  const authorBooks = useMemo(() => {
    if (!groups) return {};
    const map = {};
    for (const group of groups) {
      const author = group.metadata?.author?.toLowerCase();
      if (!author) continue;
      if (!map[author]) map[author] = [];
      map[author].push(group);
    }
    return map;
  }, [groups]);

  // Get authors that need normalization with their books
  const normalizationCandidates = useMemo(() => {
    if (!authorAnalysis?.needs_normalization) return [];

    return authorAnalysis.needs_normalization.map(candidate => {
      // Find all books with this author or its variations
      const affectedBooks = [];
      const variations = [candidate.name, ...(candidate.variations || [])];

      for (const variation of variations) {
        const books = authorBooks[variation.toLowerCase()] || [];
        for (const book of books) {
          if (!affectedBooks.find(b => b.id === book.id)) {
            affectedBooks.push(book);
          }
        }
      }

      return {
        ...candidate,
        affectedBooks,
      };
    }).filter(c => c.affectedBooks.length > 0);
  }, [authorAnalysis, authorBooks]);

  // Get suspicious authors with their books
  const suspiciousAuthors = useMemo(() => {
    if (!authorAnalysis?.suspicious_authors) return [];

    return authorAnalysis.suspicious_authors.map(candidate => {
      const books = authorBooks[candidate.name.toLowerCase()] || [];
      return {
        ...candidate,
        affectedBooks: books,
      };
    }).filter(c => c.affectedBooks.length > 0);
  }, [authorAnalysis, authorBooks]);

  // Filter based on current filter
  const filteredCandidates = useMemo(() => {
    if (filterType === 'normalization') return normalizationCandidates;
    if (filterType === 'suspicious') return suspiciousAuthors;
    // 'all' - combine both, prioritizing normalization
    const seen = new Set();
    const combined = [];
    for (const c of normalizationCandidates) {
      combined.push({ ...c, type: 'normalization' });
      seen.add(c.name.toLowerCase());
    }
    for (const c of suspiciousAuthors) {
      if (!seen.has(c.name.toLowerCase())) {
        combined.push({ ...c, type: 'suspicious' });
      }
    }
    return combined;
  }, [normalizationCandidates, suspiciousAuthors, filterType]);

  // Initialize selected fixes
  useState(() => {
    const keys = new Set();
    for (const candidate of normalizationCandidates) {
      if (candidate.canonical) {
        for (const book of candidate.affectedBooks) {
          keys.add(book.id);
        }
      }
    }
    setSelectedFixes(keys);
  }, [normalizationCandidates]);

  const toggleAuthor = (authorName) => {
    setExpandedAuthors(prev => {
      const next = new Set(prev);
      if (next.has(authorName)) {
        next.delete(authorName);
      } else {
        next.add(authorName);
      }
      return next;
    });
  };

  const toggleBookFix = (bookId) => {
    setSelectedFixes(prev => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  };

  const selectAllForAuthor = (candidate) => {
    setSelectedFixes(prev => {
      const next = new Set(prev);
      for (const book of candidate.affectedBooks) {
        next.add(book.id);
      }
      return next;
    });
  };

  const deselectAllForAuthor = (candidate) => {
    setSelectedFixes(prev => {
      const next = new Set(prev);
      for (const book of candidate.affectedBooks) {
        next.delete(book.id);
      }
      return next;
    });
  };

  const selectAll = () => {
    const keys = new Set();
    for (const candidate of normalizationCandidates) {
      if (candidate.canonical) {
        for (const book of candidate.affectedBooks) {
          keys.add(book.id);
        }
      }
    }
    setSelectedFixes(keys);
  };

  const selectNone = () => {
    setSelectedFixes(new Set());
  };

  const handleApply = () => {
    // Build fixes array - map book IDs to canonical author names
    const fixes = [];

    for (const candidate of normalizationCandidates) {
      if (!candidate.canonical) continue;

      for (const book of candidate.affectedBooks) {
        if (selectedFixes.has(book.id)) {
          fixes.push({
            bookId: book.id,
            currentAuthor: book.metadata.author,
            canonicalAuthor: candidate.canonical,
          });
        }
      }
    }

    if (fixes.length > 0) {
      onApplyFixes(fixes);
    }
    onClose();
  };

  if (!isOpen) return null;

  const totalNormalization = normalizationCandidates.length;
  const totalSuspicious = suspiciousAuthors.length;
  const totalBooks = normalizationCandidates.reduce((sum, c) => sum + c.affectedBooks.length, 0);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-lg border border-neutral-700 max-w-4xl w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <div className="flex items-center gap-2">
            <User className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">Author Analysis</h2>
            <span className="text-sm text-gray-400">
              ({totalNormalization} need normalization, {totalSuspicious} suspicious)
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
        <div className="px-4 py-2 border-b border-neutral-800 flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs">
            <Filter className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-gray-500">Show:</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setFilterType('all')}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                filterType === 'all'
                  ? 'bg-purple-600/30 text-purple-300 border border-purple-500/30'
                  : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
              }`}
            >
              All ({totalNormalization + totalSuspicious})
            </button>
            <button
              onClick={() => setFilterType('normalization')}
              className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                filterType === 'normalization'
                  ? 'bg-yellow-600/30 text-yellow-300 border border-yellow-500/30'
                  : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
              }`}
            >
              Needs Normalization ({totalNormalization})
            </button>
            <button
              onClick={() => setFilterType('suspicious')}
              className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                filterType === 'suspicious'
                  ? 'bg-orange-600/30 text-orange-300 border border-orange-500/30'
                  : 'bg-neutral-800 text-gray-400 hover:text-white border border-transparent'
              }`}
            >
              Suspicious ({totalSuspicious})
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {filteredCandidates.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {totalNormalization === 0 && totalSuspicious === 0
                ? 'No author issues found!'
                : 'No authors match current filter'}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredCandidates.map((candidate) => {
                const isNormalization = candidate.type === 'normalization' || candidate.canonical;
                const selectedCount = candidate.affectedBooks.filter(b => selectedFixes.has(b.id)).length;

                return (
                  <div key={candidate.name} className="bg-neutral-800/50 rounded-lg border border-neutral-700">
                    {/* Author header */}
                    <button
                      onClick={() => toggleAuthor(candidate.name)}
                      className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-neutral-800 rounded-t-lg transition-colors"
                    >
                      {expandedAuthors.has(candidate.name)
                        ? <ChevronDown className="w-4 h-4 text-gray-500" />
                        : <ChevronRight className="w-4 h-4 text-gray-500" />
                      }
                      <User className="w-4 h-4 text-gray-500" />
                      <span className="font-medium text-white">
                        {candidate.name}
                      </span>
                      <span className="text-xs text-gray-500">
                        ({candidate.affectedBooks.length} books)
                      </span>

                      {isNormalization && candidate.canonical && (
                        <span className="text-xs text-green-400 flex items-center gap-1">
                          → <span className="font-medium">{candidate.canonical}</span>
                        </span>
                      )}

                      {!isNormalization && (
                        <span className="px-1.5 py-0.5 text-[10px] bg-orange-500/20 text-orange-300 rounded">
                          Suspicious
                        </span>
                      )}

                      <div className="flex-1" />

                      {isNormalization && candidate.canonical && (
                        <span className="text-xs text-gray-400">
                          {selectedCount}/{candidate.affectedBooks.length} selected
                        </span>
                      )}
                    </button>

                    {/* Expanded content */}
                    {expandedAuthors.has(candidate.name) && (
                      <div className="px-3 pb-3 space-y-2">
                        {/* Variations */}
                        {candidate.variations && candidate.variations.length > 1 && (
                          <div className="text-xs text-gray-500">
                            Variations found: {candidate.variations.join(', ')}
                          </div>
                        )}

                        {/* Quick select buttons */}
                        {isNormalization && candidate.canonical && (
                          <div className="flex items-center gap-2 mb-2">
                            <button
                              onClick={() => selectAllForAuthor(candidate)}
                              className="px-2 py-0.5 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-gray-300 rounded transition-colors"
                            >
                              Select All
                            </button>
                            <button
                              onClick={() => deselectAllForAuthor(candidate)}
                              className="px-2 py-0.5 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-gray-300 rounded transition-colors"
                            >
                              Deselect All
                            </button>
                          </div>
                        )}

                        {/* Affected books */}
                        <div className="space-y-1">
                          {candidate.affectedBooks.map(book => {
                            const isSelected = selectedFixes.has(book.id);
                            const canFix = isNormalization && candidate.canonical;

                            return (
                              <div
                                key={book.id}
                                className={`p-2 rounded border ${
                                  canFix
                                    ? isSelected
                                      ? 'bg-green-500/10 border-green-500/30'
                                      : 'bg-neutral-900/50 border-neutral-700'
                                    : 'bg-orange-500/10 border-orange-500/30'
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  {canFix && (
                                    <button
                                      onClick={() => toggleBookFix(book.id)}
                                      className={`p-1 rounded transition-colors ${
                                        isSelected
                                          ? 'bg-green-600/30 text-green-300'
                                          : 'bg-neutral-700 text-gray-400 hover:text-white'
                                      }`}
                                    >
                                      <Check className={`w-3 h-3 ${isSelected ? 'opacity-100' : 'opacity-50'}`} />
                                    </button>
                                  )}
                                  {!canFix && (
                                    <AlertTriangle className="w-4 h-4 text-orange-400" />
                                  )}

                                  <BookOpen className="w-3.5 h-3.5 text-gray-500" />
                                  <span className="text-sm text-white truncate max-w-[250px]">
                                    {book.metadata.title}
                                  </span>
                                  <span className="text-xs text-gray-500">
                                    by {book.metadata.author}
                                  </span>

                                  {canFix && isSelected && (
                                    <span className="text-xs text-green-400 ml-auto">
                                      → {candidate.canonical}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
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
              onClick={selectAll}
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
              {selectedFixes.size} books selected for normalization
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
              Normalize {selectedFixes.size} Authors
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
