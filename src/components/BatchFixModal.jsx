// src/components/BatchFixModal.jsx
// Modal for selecting and applying batch fixes with type selection

import { useState } from 'react';
import { X, Wrench, AlertTriangle, User, BookOpen, Check, ChevronDown, ChevronRight, FileText, Library, Type, Mic } from 'lucide-react';

// Issue type display configuration
const ISSUE_TYPE_CONFIG = {
  AuthorNeedsNormalization: { label: 'Author Normalization', icon: User, color: 'text-blue-400' },
  DescriptionContainsHtml: { label: 'HTML in Description', icon: FileText, color: 'text-orange-400' },
  MissingSequence: { label: 'Missing Sequence', icon: Library, color: 'text-purple-400' },
  TitleMatchesSeries: { label: 'Title Matches Series', icon: Type, color: 'text-yellow-400' },
  SuspiciousAuthor: { label: 'Suspicious Author', icon: User, color: 'text-red-400' },
  SuspiciousNarrator: { label: 'Suspicious Narrator', icon: Mic, color: 'text-red-400' },
  NarratorMatchesAuthor: { label: 'Narrator = Author', icon: Mic, color: 'text-amber-400' },
  SeriesContainsNumber: { label: 'Series Has Number', icon: Library, color: 'text-purple-400' },
  MissingField: { label: 'Missing Field', icon: AlertTriangle, color: 'text-red-400' },
};

export function BatchFixModal({
  isOpen,
  onClose,
  onConfirm,
  pendingFixes,
  selectedTypes,
  onToggleType,
  // Validation sub-categories
  validationByType = {},
  selectedValidationTypes = {},
  onToggleValidationType,
  // Hints about what analysis needs to be run
  hasAuthorIssuesInValidation = false,
  hasSeriesIssuesInValidation = false,
}) {
  const [validationExpanded, setValidationExpanded] = useState(true);

  if (!isOpen) return null;

  const hasValidationSubTypes = Object.keys(validationByType).length > 0;
  const sortedValidationTypes = Object.entries(validationByType)
    .sort((a, b) => b[1] - a[1]); // Sort by count descending

  // Calculate validation selected count
  const validationSelectedCount = hasValidationSubTypes
    ? sortedValidationTypes
        .filter(([type]) => selectedValidationTypes[type])
        .reduce((sum, [_, count]) => sum + count, 0)
    : selectedTypes.validation ? pendingFixes.validation : 0;

  const totalSelected =
    validationSelectedCount +
    (selectedTypes.author ? pendingFixes.author : 0) +
    (selectedTypes.series ? pendingFixes.series : 0);

  // Check if all validation sub-types are selected
  const allValidationSelected = hasValidationSubTypes &&
    sortedValidationTypes.every(([type]) => selectedValidationTypes[type]);

  // Toggle all validation types
  const toggleAllValidation = () => {
    if (allValidationSelected) {
      // Deselect all
      sortedValidationTypes.forEach(([type]) => {
        if (selectedValidationTypes[type]) {
          onToggleValidationType(type);
        }
      });
    } else {
      // Select all
      sortedValidationTypes.forEach(([type]) => {
        if (!selectedValidationTypes[type]) {
          onToggleValidationType(type);
        }
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-yellow-900/30 rounded-lg">
              <Wrench className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Apply Fixes</h2>
              <p className="text-xs text-gray-500">Select which fix types to apply</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {/* Validation Fixes - with expandable sub-categories */}
          {pendingFixes.validation > 0 && (
            <div className="rounded-lg border border-red-800/50 bg-red-900/20 overflow-hidden">
              {/* Main header */}
              <button
                onClick={() => hasValidationSubTypes && setValidationExpanded(!validationExpanded)}
                className="w-full p-4 flex items-start gap-3 text-left hover:bg-red-900/30 transition-colors"
              >
                {/* Expand/collapse icon */}
                {hasValidationSubTypes ? (
                  validationExpanded
                    ? <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                ) : (
                  <div className="w-4" />
                )}

                {/* Checkbox for select all */}
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasValidationSubTypes) {
                      toggleAllValidation();
                    } else {
                      onToggleType('validation');
                    }
                  }}
                  className={`
                    w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 cursor-pointer
                    ${hasValidationSubTypes
                      ? allValidationSelected
                        ? 'border-green-500 bg-green-600'
                        : validationSelectedCount > 0
                          ? 'border-green-500 bg-green-600/50'
                          : 'border-neutral-500 bg-neutral-700'
                      : selectedTypes.validation
                        ? 'border-green-500 bg-green-600'
                        : 'border-neutral-500 bg-neutral-700'
                    }
                  `}
                >
                  {(hasValidationSubTypes ? (allValidationSelected || validationSelectedCount > 0) : selectedTypes.validation) && (
                    <Check className="w-3 h-3 text-white" />
                  )}
                </div>

                {/* Icon */}
                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white">Validation Fixes</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      validationSelectedCount > 0 ? 'bg-green-900/50 text-green-400' : 'bg-neutral-700 text-gray-400'
                    }`}>
                      {validationSelectedCount}/{pendingFixes.validation} selected
                    </span>
                  </div>
                  <p className="text-xs mt-1 text-gray-400">
                    {hasValidationSubTypes ? 'Click to expand and select specific issue types' : 'Fix metadata issues'}
                  </p>
                </div>
              </button>

              {/* Sub-categories */}
              {hasValidationSubTypes && validationExpanded && (
                <div className="border-t border-red-900/50 bg-neutral-900/50 p-3 space-y-1">
                  {sortedValidationTypes.map(([issueType, count]) => {
                    const config = ISSUE_TYPE_CONFIG[issueType] || {
                      label: issueType.replace(/([A-Z])/g, ' $1').trim(),
                      icon: AlertTriangle,
                      color: 'text-gray-400'
                    };
                    const Icon = config.icon;
                    const isSelected = selectedValidationTypes[issueType];

                    return (
                      <button
                        key={issueType}
                        onClick={() => onToggleValidationType(issueType)}
                        className={`
                          w-full px-3 py-2 rounded-md flex items-center gap-3 text-left transition-colors
                          ${isSelected
                            ? 'bg-green-900/30 border border-green-800/50'
                            : 'bg-neutral-800/50 border border-transparent hover:border-neutral-700'
                          }
                        `}
                      >
                        <div className={`
                          w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0
                          ${isSelected ? 'border-green-500 bg-green-600' : 'border-neutral-500 bg-neutral-700'}
                        `}>
                          {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                        </div>
                        <Icon className={`w-4 h-4 flex-shrink-0 ${config.color}`} />
                        <span className="flex-1 text-sm text-gray-200">{config.label}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          isSelected ? 'bg-green-900/50 text-green-400' : 'bg-neutral-700 text-gray-400'
                        }`}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Author Normalizations (from analysis) */}
          <div>
            <button
              onClick={() => pendingFixes.author > 0 && onToggleType('author')}
              disabled={pendingFixes.author === 0}
              className={`
                w-full p-4 rounded-lg border transition-all text-left
                ${pendingFixes.author === 0
                  ? 'opacity-60 cursor-not-allowed bg-neutral-800/50 border-neutral-700'
                  : selectedTypes.author
                    ? 'bg-blue-900/20 border-blue-800/50 border-2'
                    : 'bg-neutral-800/50 border-neutral-700 hover:border-neutral-600'
                }
              `}
            >
              <div className="flex items-start gap-3">
                <div className="w-4" />
                <div className={`
                  w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5
                  ${pendingFixes.author === 0
                    ? 'border-neutral-600 bg-neutral-700'
                    : selectedTypes.author
                      ? 'border-green-500 bg-green-600'
                      : 'border-neutral-500 bg-neutral-700'
                  }
                `}>
                  {selectedTypes.author && pendingFixes.author > 0 && <Check className="w-3 h-3 text-white" />}
                </div>
                <User className={`w-5 h-5 flex-shrink-0 mt-0.5 ${pendingFixes.author === 0 ? 'text-gray-600' : 'text-blue-400'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`font-medium ${pendingFixes.author === 0 ? 'text-gray-500' : 'text-white'}`}>
                      Author Analysis Fixes
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      pendingFixes.author === 0
                        ? 'bg-neutral-700 text-gray-500'
                        : selectedTypes.author
                          ? 'bg-green-900/50 text-green-400'
                          : 'bg-neutral-700 text-gray-400'
                    }`}>
                      {pendingFixes.author} fix{pendingFixes.author !== 1 ? 'es' : ''}
                    </span>
                  </div>
                  <p className={`text-xs mt-1 ${pendingFixes.author === 0 ? 'text-gray-600' : 'text-gray-400'}`}>
                    Normalize author names from separate analysis
                  </p>
                </div>
              </div>
            </button>
            {pendingFixes.author === 0 && hasAuthorIssuesInValidation && (
              <p className="text-xs text-amber-400 mt-1.5 ml-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Run "Authors" analysis for additional fixes
              </p>
            )}
          </div>

          {/* Series Fixes (from analysis) */}
          <div>
            <button
              onClick={() => pendingFixes.series > 0 && onToggleType('series')}
              disabled={pendingFixes.series === 0}
              className={`
                w-full p-4 rounded-lg border transition-all text-left
                ${pendingFixes.series === 0
                  ? 'opacity-60 cursor-not-allowed bg-neutral-800/50 border-neutral-700'
                  : selectedTypes.series
                    ? 'bg-purple-900/20 border-purple-800/50 border-2'
                    : 'bg-neutral-800/50 border-neutral-700 hover:border-neutral-600'
                }
              `}
            >
              <div className="flex items-start gap-3">
                <div className="w-4" />
                <div className={`
                  w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5
                  ${pendingFixes.series === 0
                    ? 'border-neutral-600 bg-neutral-700'
                    : selectedTypes.series
                      ? 'border-green-500 bg-green-600'
                      : 'border-neutral-500 bg-neutral-700'
                  }
                `}>
                  {selectedTypes.series && pendingFixes.series > 0 && <Check className="w-3 h-3 text-white" />}
                </div>
                <BookOpen className={`w-5 h-5 flex-shrink-0 mt-0.5 ${pendingFixes.series === 0 ? 'text-gray-600' : 'text-purple-400'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`font-medium ${pendingFixes.series === 0 ? 'text-gray-500' : 'text-white'}`}>
                      Series Analysis Fixes
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      pendingFixes.series === 0
                        ? 'bg-neutral-700 text-gray-500'
                        : selectedTypes.series
                          ? 'bg-green-900/50 text-green-400'
                          : 'bg-neutral-700 text-gray-400'
                    }`}>
                      {pendingFixes.series} fix{pendingFixes.series !== 1 ? 'es' : ''}
                    </span>
                  </div>
                  <p className={`text-xs mt-1 ${pendingFixes.series === 0 ? 'text-gray-600' : 'text-gray-400'}`}>
                    Fix series names and sequence numbers
                  </p>
                </div>
              </div>
            </button>
            {pendingFixes.series === 0 && hasSeriesIssuesInValidation && (
              <p className="text-xs text-amber-400 mt-1.5 ml-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Run "Analyze Series" for additional fixes
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-800 bg-neutral-950 flex items-center justify-between flex-shrink-0">
          <div className="text-sm text-gray-400">
            {totalSelected > 0 ? (
              <span><span className="text-white font-medium">{totalSelected}</span> fix{totalSelected !== 1 ? 'es' : ''} selected</span>
            ) : (
              <span>Select at least one fix type</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-300 bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-colors font-medium"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onConfirm();
                onClose();
              }}
              disabled={totalSelected === 0}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-green-600/50 disabled:cursor-not-allowed text-white rounded-lg transition-colors font-medium flex items-center gap-2"
            >
              <Wrench className="w-4 h-4" />
              Apply {totalSelected > 0 ? totalSelected : ''} Fix{totalSelected !== 1 ? 'es' : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
