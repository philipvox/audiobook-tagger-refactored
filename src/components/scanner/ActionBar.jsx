import { useState } from 'react';
import { Download, Upload, Tag, CheckCircle, Sparkles, FileText, Type, Library, X, Zap, RefreshCw, AlertTriangle, User, Search, Wrench, BookOpen, Users, Hash, Dna, ChevronDown, MoreHorizontal, Calendar } from 'lucide-react';

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
  onRefreshCache,
  onFullSync,
  onBulkEdit,
  onBulkCover,
  onOpenRescanModal,
  onCleanupGenres,
  onAssignTagsGpt,
  onFixDescriptions,
  onFixTitles,
  onFixSubtitles,
  onFixAuthors,
  onFixYears,
  onFixSeries,
  onLookupAge,
  onLookupISBN,
  onRunAll,
  onGenerateDna,
  onClassifyAll,
  classifying = false,
  onMetadataResolution,
  resolvingMetadata = false,
  onDescriptionProcessing,
  processingDescriptions = false,
  onClearSelection,
  onSelectAll,
  onScanErrors,
  onAuthorMatch,
  onBatchFix,
  onNavigateToSettings,
  writing,
  pushing,
  scanning,
  cleaningGenres = false,
  assigningTags = false,
  fixingDescriptions = false,
  fixingTitles = false,
  fixingSubtitles = false,
  fixingAuthors = false,
  fixingYears = false,
  fixingSeries = false,
  lookingUpAge = false,
  lookingUpISBN = false,
  runningAll = false,
  generatingDna = false,
  refreshingCache = false,
  hasAbsConnection = false,
  hasOpenAiKey = false,
  forceFresh = false,
  onToggleForceFresh,
  validationStats = null,
  validating = false,
  authorAnalysis = null,
  onSeriesAnalysis,
  analyzingSeries = false,
  seriesAnalysis = null,
}) {
  const [showEnrichMenu, setShowEnrichMenu] = useState(false);
  const [showValidateMenu, setShowValidateMenu] = useState(false);

  const totalGroupCount = groups.length;
  const selectedCount = allSelected ? totalGroupCount : selectedGroupCount;
  const hasSelection = selectedCount > 0;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isProcessing = scanning || cleaningGenres || assigningTags || fixingDescriptions || fixingTitles || fixingAuthors || fixingYears || fixingSeries || lookingUpAge || lookingUpISBN || runningAll || generatingDna || classifying || resolvingMetadata || processingDescriptions || pushing || validating || analyzingSeries;

  // Icon button component
  const IconBtn = ({ onClick, disabled, active, icon: Icon, title, variant = 'default', badge = null }) => {
    const baseStyles = "relative p-2.5 rounded-full transition-all flex items-center justify-center";
    const variants = {
      default: `${disabled ? 'text-gray-600' : 'text-gray-400 hover:text-white hover:bg-neutral-800'}`,
      primary: `${disabled ? 'text-gray-600' : 'text-white bg-white/10 hover:bg-white/20'}`,
      active: 'text-white bg-neutral-800',
    };

    return (
      <button
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={`${baseStyles} ${active ? variants.active : variants[variant]} ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <Icon className={`w-5 h-5 ${active ? 'animate-pulse' : ''}`} />
        {badge !== null && badge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </button>
    );
  };

  // Dropdown menu item
  const MenuItem = ({ onClick, disabled, active, icon: Icon, children, badge = null }) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) {
          onClick?.();
          setShowEnrichMenu(false);
          setShowValidateMenu(false);
        }
      }}
      disabled={disabled}
      className={`w-full px-3 py-2 text-sm text-left flex items-center gap-2.5 transition-colors ${
        disabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300 hover:bg-neutral-800 hover:text-white'
      } ${active ? 'text-white bg-neutral-800' : ''}`}
    >
      <Icon className={`w-4 h-4 ${active ? 'animate-pulse' : ''}`} />
      <span className="flex-1">{children}</span>
      {badge !== null && badge > 0 && (
        <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-medium rounded">
          {badge}
        </span>
      )}
    </button>
  );

  const hasValidationIssues = (validationStats && (validationStats.withErrors > 0 || validationStats.withWarnings > 0)) ||
    (authorAnalysis && authorAnalysis.needs_normalization && authorAnalysis.needs_normalization.length > 0) ||
    (seriesAnalysis && seriesAnalysis.total_issues > 0);

  return (
    <div className="px-4 py-3 flex items-center gap-4">
      {/* Left side - Main action buttons */}
      <div className="flex items-center gap-1">
        {/* Load from ABS */}
        <IconBtn
          onClick={onPull}
          disabled={!hasAbsConnection || isProcessing}
          active={scanning && !pushing}
          icon={Download}
          variant="primary"
          title={!hasAbsConnection ? 'Configure ABS in Settings first' : 'Load from AudiobookShelf'}
        />

        {totalGroupCount > 0 && (
          <>
            {/* Enrich dropdown */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowEnrichMenu(!showEnrichMenu);
                  setShowValidateMenu(false);
                }}
                disabled={isProcessing}
                className={`p-2.5 rounded-full transition-all flex items-center gap-1 ${
                  showEnrichMenu ? 'bg-neutral-800 text-white' : 'text-gray-400 hover:text-white hover:bg-neutral-800'
                } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                title="Enrich metadata"
              >
                <Sparkles className={`w-5 h-5 ${cleaningGenres || assigningTags || fixingDescriptions || fixingTitles || fixingAuthors || fixingYears || fixingSeries || lookingUpAge || lookingUpISBN || runningAll || generatingDna || classifying || resolvingMetadata || processingDescriptions ? 'animate-pulse' : ''}`} />
                <ChevronDown className="w-3 h-3" />
              </button>

              {showEnrichMenu && (
                <div className="absolute top-full left-0 mt-1 w-72 bg-neutral-900 rounded-xl border border-neutral-800 shadow-xl py-1 z-50">
                  {/* Consolidated GPT Calls */}
                  {hasOpenAiKey && (
                    <>
                      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600 font-semibold">
                        AI Processing
                      </div>

                      {/* Call A: Metadata Resolution */}
                      <button
                        onClick={(e) => { e.stopPropagation(); onMetadataResolution?.(); setShowEnrichMenu(false); }}
                        disabled={!hasSelection || isProcessing}
                        className={`w-full px-3 py-2.5 text-left transition-colors ${
                          !hasSelection || isProcessing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-800'
                        } ${resolvingMetadata ? 'bg-neutral-800' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <Type className={`w-4 h-4 text-blue-400 ${resolvingMetadata ? 'animate-pulse' : ''}`} />
                          <span className="text-sm text-white font-medium">Metadata Resolution</span>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-0.5 ml-6">
                          Fix titles, subtitles, authors, and series
                        </p>
                      </button>

                      {/* Call B: Classification & Tagging */}
                      <button
                        onClick={(e) => { e.stopPropagation(); onClassifyAll?.(false); setShowEnrichMenu(false); }}
                        disabled={!hasSelection || isProcessing}
                        className={`w-full px-3 py-2.5 text-left transition-colors ${
                          !hasSelection || isProcessing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-800'
                        } ${classifying ? 'bg-neutral-800' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <Sparkles className={`w-4 h-4 text-amber-400 ${classifying ? 'animate-pulse' : ''}`} />
                          <span className="text-sm text-white font-medium">Classification & Tagging</span>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-0.5 ml-6">
                          Genres, tags, age rating, and DNA in one pass
                        </p>
                      </button>

                      {/* Call C: Description Processing */}
                      <button
                        onClick={(e) => { e.stopPropagation(); onDescriptionProcessing?.(); setShowEnrichMenu(false); }}
                        disabled={!hasSelection || isProcessing}
                        className={`w-full px-3 py-2.5 text-left transition-colors ${
                          !hasSelection || isProcessing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-800'
                        } ${processingDescriptions ? 'bg-neutral-800' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <FileText className={`w-4 h-4 text-cyan-400 ${processingDescriptions ? 'animate-pulse' : ''}`} />
                          <span className="text-sm text-white font-medium">Description Processing</span>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-0.5 ml-6">
                          Validate, clean, or generate descriptions
                        </p>
                      </button>

                      <div className="h-px bg-neutral-800 my-1" />

                      {/* Run All + ISBN */}
                      <MenuItem onClick={onRunAll} disabled={!hasSelection} active={runningAll} icon={Zap}>
                        Run All
                      </MenuItem>
                      <MenuItem onClick={onLookupISBN} disabled={!hasSelection} active={lookingUpISBN} icon={Hash}>
                        Lookup ISBN
                      </MenuItem>
                      <MenuItem onClick={onFixYears} disabled={!hasSelection} active={fixingYears} icon={Calendar}>
                        Fix Pub Date
                      </MenuItem>

                      {/* Advanced — individual operations */}
                      <div className="h-px bg-neutral-800 my-1" />
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowAdvanced(!showAdvanced); }}
                        className="w-full px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600 font-semibold hover:text-gray-400 flex items-center gap-1 transition-colors"
                      >
                        <ChevronDown className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                        Individual Operations
                      </button>
                      {showAdvanced && (
                        <>
                          <MenuItem onClick={onFixTitles} disabled={!hasSelection} active={fixingTitles} icon={Type}>
                            Fix Titles
                          </MenuItem>
                          <MenuItem onClick={onFixSubtitles} disabled={!hasSelection} active={fixingSubtitles} icon={BookOpen}>
                            Fix Subtitles
                          </MenuItem>
                          <MenuItem onClick={onFixAuthors} disabled={!hasSelection} active={fixingAuthors} icon={User}>
                            Fix Authors
                          </MenuItem>
                          <MenuItem onClick={onFixSeries} disabled={!hasSelection} active={fixingSeries} icon={Library}>
                            Fix Series
                          </MenuItem>
                          <MenuItem onClick={onCleanupGenres} active={cleaningGenres} icon={Tag}>
                            Clean Genres
                          </MenuItem>
                          <MenuItem onClick={onAssignTagsGpt} disabled={!hasSelection} active={assigningTags} icon={Sparkles}>
                            AI Tags
                          </MenuItem>
                          <MenuItem onClick={onFixDescriptions} disabled={!hasSelection} active={fixingDescriptions} icon={FileText}>
                            Fix Descriptions
                          </MenuItem>
                          <MenuItem onClick={onLookupAge} disabled={!hasSelection} active={lookingUpAge} icon={Users}>
                            Lookup Age
                          </MenuItem>
                          <MenuItem onClick={onGenerateDna} disabled={!hasSelection} active={generatingDna} icon={Dna}>
                            Generate DNA
                          </MenuItem>
                        </>
                      )}
                    </>
                  )}
                  {!hasOpenAiKey && (
                    <MenuItem onClick={onCleanupGenres} active={cleaningGenres} icon={Tag}>
                      Clean Genres
                    </MenuItem>
                  )}
                </div>
              )}
            </div>

            {/* Validate dropdown */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowValidateMenu(!showValidateMenu);
                  setShowEnrichMenu(false);
                }}
                disabled={isProcessing}
                className={`p-2.5 rounded-full transition-all flex items-center gap-1 ${
                  showValidateMenu ? 'bg-neutral-800 text-white' : 'text-gray-400 hover:text-white hover:bg-neutral-800'
                } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                title="Validate & analyze"
              >
                <Search className={`w-5 h-5 ${validating || analyzingSeries ? 'animate-pulse' : ''}`} />
                <ChevronDown className="w-3 h-3" />
                {hasValidationIssues && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full" />
                )}
              </button>

              {showValidateMenu && (
                <div className="absolute top-full left-0 mt-1 w-48 bg-neutral-900 rounded-xl border border-neutral-800 shadow-xl py-1 z-50">
                  <MenuItem onClick={onScanErrors} active={validating} icon={Search} badge={validationStats?.withErrors}>
                    Scan Errors
                  </MenuItem>
                  <MenuItem onClick={onAuthorMatch} icon={User}>
                    Analyze Authors
                  </MenuItem>
                  <MenuItem onClick={onSeriesAnalysis} active={analyzingSeries} icon={BookOpen} badge={seriesAnalysis?.total_issues}>
                    Analyze Series
                  </MenuItem>
                  {hasValidationIssues && onBatchFix && (
                    <>
                      <div className="h-px bg-neutral-800 my-1" />
                      <MenuItem onClick={onBatchFix} icon={Wrench}>
                        Fix All Issues
                      </MenuItem>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Push to ABS */}
            <IconBtn
              onClick={onPush}
              disabled={isProcessing}
              active={pushing}
              icon={Upload}
              title="Push to AudiobookShelf"
            />
          </>
        )}
      </div>

      {/* Selection info */}
      <div className="flex items-center gap-3">
        {hasSelection ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-white font-medium">
              {selectedCount} selected
            </span>
            <button
              onClick={onClearSelection}
              className="p-1 rounded-full hover:bg-neutral-800 text-gray-500 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <span className="text-sm text-gray-500">
            {totalGroupCount > 0 ? `${totalGroupCount} books` : ''}
          </span>
        )}

        {/* Validation stats pills */}
        {validationStats && validationStats.scanned > 0 && (
          <div className="flex items-center gap-1.5">
            {validationStats.withErrors > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 text-xs">
                <AlertTriangle className="w-3 h-3" />
                {validationStats.withErrors}
              </span>
            )}
            {validationStats.withWarnings > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 text-xs">
                <AlertTriangle className="w-3 h-3" />
                {validationStats.withWarnings}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side - extras */}
      <div className="flex items-center gap-2">
        {/* Force Fresh Toggle */}
        {totalGroupCount > 0 && onToggleForceFresh && (
          <button
            onClick={onToggleForceFresh}
            className={`p-2 rounded-full transition-all ${
              forceFresh
                ? 'bg-orange-500/20 text-orange-400'
                : 'text-gray-600 hover:text-gray-400 hover:bg-neutral-800'
            }`}
            title={forceFresh ? 'Force re-process all (slow)' : 'Skip processed (fast)'}
          >
            <RefreshCw className={`w-4 h-4 ${forceFresh ? 'animate-spin' : ''}`} />
          </button>
        )}

        {/* Select All */}
        {totalGroupCount > 0 && !allSelected && onSelectAll && (
          <button
            onClick={onSelectAll}
            className="px-3 py-1.5 text-xs text-gray-500 hover:text-white rounded-full hover:bg-neutral-800 transition-colors"
          >
            Select all
          </button>
        )}

        {/* ABS Connection Warning */}
        {!hasAbsConnection && (
          <button
            onClick={onNavigateToSettings}
            className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
          >
            Configure ABS →
          </button>
        )}
      </div>

      {/* Click outside to close menus */}
      {(showEnrichMenu || showValidateMenu) && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => {
            setShowEnrichMenu(false);
            setShowValidateMenu(false);
          }}
        />
      )}
    </div>
  );
}
