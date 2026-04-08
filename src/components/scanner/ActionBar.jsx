import { useState, useMemo } from 'react';
import { Download, Upload, Tag, CheckCircle, Sparkles, FileText, Type, Library, X, Zap, RefreshCw, AlertTriangle, User, Search, Wrench, BookOpen, Users, Hash, Dna, ChevronDown, MoreHorizontal, Calendar, Settings } from 'lucide-react';

// Per-book cost estimate (input ~2000 tokens, output ~1000 tokens)
const MODEL_PRICES = {
  'gpt-5.4-nano':              { input: 0.20, output: 1.25 },
  'gpt-5-nano':                { input: 0.05, output: 0.40 },
  'gpt-5.4-mini':              { input: 0.75, output: 4.50 },
  'gpt-4o-mini':               { input: 0.15, output: 0.60 },
  'gpt-4o':                    { input: 2.50, output: 10.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
};

function estimateCost(modelId, bookCount, callsPerBook = 1) {
  const p = MODEL_PRICES[modelId];
  if (!p || !bookCount) return null;
  const inputCost = (2000 * bookCount * callsPerBook / 1_000_000) * p.input;
  const outputCost = (1000 * bookCount * callsPerBook / 1_000_000) * p.output;
  return inputCost + outputCost;
}

function formatCost(dollars) {
  if (dollars == null) return '';
  if (dollars < 0.005) return '<$0.01';
  if (dollars < 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(2)}`;
}

export function ActionBar({
  logoSvg,
  activeTab,
  navigateTo,
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
  useLocalAI = false,
  forceFresh = false,
  onToggleForceFresh,
  dnaEnabled = true,
  onToggleDna,
  validationStats = null,
  validating = false,
  authorAnalysis = null,
  onSeriesAnalysis,
  analyzingSeries = false,
  seriesAnalysis = null,
  aiModel = 'gpt-5-nano',
}) {
  const [showEnrichMenu, setShowEnrichMenu] = useState(false);
  const [showValidateMenu, setShowValidateMenu] = useState(false);

  const totalGroupCount = groups.length;
  const selectedCount = allSelected ? totalGroupCount : selectedGroupCount;
  const hasSelection = selectedCount > 0;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isProcessing = scanning || cleaningGenres || assigningTags || fixingDescriptions || fixingTitles || fixingAuthors || fixingYears || fixingSeries || lookingUpAge || lookingUpISBN || runningAll || generatingDna || classifying || resolvingMetadata || processingDescriptions || pushing || validating || analyzingSeries;

  // Time estimate for local AI: ~3s per book (batched 5 per prompt) + ~4s DNA per book
  const estimateLocalTime = (count, calls) => {
    const totalSecs = count * calls * 4; // ~4s per book with batching
    if (totalSecs < 60) return `~${totalSecs}s`;
    if (totalSecs < 3600) return `~${Math.ceil(totalSecs / 60)}m`;
    const h = Math.floor(totalSecs / 3600);
    const m = Math.ceil((totalSecs % 3600) / 60);
    return `~${h}h ${m}m`;
  };

  // Dropdown menu item
  const MenuItem = ({ onClick, disabled, active, icon: Icon, children, badge = null, aiCalls = 0 }) => {
    const badgeText = aiCalls > 0 && selectedCount > 0
      ? (useLocalAI ? estimateLocalTime(selectedCount, aiCalls) : formatCost(estimateCost(aiModel, selectedCount, aiCalls)))
      : null;
    const badgeLabel = useLocalAI ? 'Local' : 'AI';
    const badgeColor = useLocalAI ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400';
    return (
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
        {aiCalls > 0 && (
          <span className={`flex items-center gap-1 px-1.5 py-0.5 ${badgeColor} text-[10px] font-medium rounded`} title={useLocalAI ? 'Uses local AI (free)' : 'Uses your AI API key'}>
            {badgeText && <span>{badgeText}</span>}
            <span>{badgeLabel}</span>
          </span>
        )}
        {badge !== null && badge > 0 && (
          <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-medium rounded">
            {badge}
          </span>
        )}
      </button>
    );
  };

  const hasValidationIssues = (validationStats && (validationStats.withErrors > 0 || validationStats.withWarnings > 0)) ||
    (authorAnalysis && authorAnalysis.needs_normalization && authorAnalysis.needs_normalization.length > 0) ||
    (seriesAnalysis && seriesAnalysis.total_issues > 0);

  // Pill button component — icon + label
  const PillBtn = ({ onClick, disabled, active, icon: Icon, label, variant = 'default', badge = null }) => {
    const baseStyles = "relative flex items-center gap-2 px-4 py-2 rounded-full transition-all text-sm font-medium whitespace-nowrap";
    const variants = {
      default: `${disabled ? 'text-gray-600' : 'text-gray-400 hover:text-white hover:bg-neutral-800'}`,
      primary: `${disabled ? 'text-gray-600' : 'text-white bg-white/10 hover:bg-white/20'}`,
      active: 'text-white bg-neutral-800',
    };

    return (
      <button
        onClick={onClick}
        disabled={disabled}
        title={label}
        className={`${baseStyles} ${active ? variants.active : variants[variant]} ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <Icon className={`w-5 h-5 ${active ? 'animate-pulse' : ''}`} />
        <span className="hidden sm:inline">{label}</span>
        {badge !== null && badge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="px-5 py-3.5 flex items-center gap-3">
      {/* Logo + Nav */}
      {logoSvg && (
        <img src={logoSvg} alt="Audiobook Tagger" style={{ height: '36px' }} className="invert opacity-90 mr-1" />
      )}
      {navigateTo && (
        <nav className="flex items-center gap-0.5 bg-neutral-900/50 rounded-full p-1 mr-2">
          <button
            onClick={() => navigateTo('scanner')}
            className={`px-4 py-2 text-sm font-medium rounded-full transition-all flex items-center gap-2 ${
              activeTab === 'scanner' ? 'bg-neutral-800 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Library className="w-4 h-4" />
            Library
          </button>
          <button
            onClick={() => navigateTo('settings')}
            className={`px-4 py-2 text-sm font-medium rounded-full transition-all flex items-center gap-2 ${
              activeTab === 'settings' ? 'bg-neutral-800 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Settings className="w-4 h-4" />
            Settings
          </button>
        </nav>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Import */}
        <PillBtn
          onClick={onPull}
          disabled={!hasAbsConnection || isProcessing}
          active={scanning && !pushing}
          icon={Download}
          label="Import"
          variant="primary"
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
                className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all text-sm font-medium ${
                  showEnrichMenu ? 'bg-neutral-800 text-white' : 'text-gray-400 hover:text-white hover:bg-neutral-800'
                } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                title="Enrich metadata"
              >
                <Sparkles className={`w-5 h-5 ${cleaningGenres || assigningTags || fixingDescriptions || fixingTitles || fixingAuthors || fixingYears || fixingSeries || lookingUpAge || lookingUpISBN || runningAll || generatingDna || classifying || resolvingMetadata || processingDescriptions ? 'animate-pulse' : ''}`} />
                <span className="hidden sm:inline">Enrich</span>
                <ChevronDown className="w-3.5 h-3.5" />
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
                          <span className={`flex items-center gap-1 px-1.5 py-0.5 ${useLocalAI ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'} text-[10px] font-medium rounded ml-auto`}>
                            {selectedCount > 0 && <span>{useLocalAI ? estimateLocalTime(selectedCount, 1) : formatCost(estimateCost(aiModel, selectedCount, 1))}</span>}
                            <span>{useLocalAI ? 'Local' : 'AI'}</span>
                          </span>
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
                          <span className={`flex items-center gap-1 px-1.5 py-0.5 ${useLocalAI ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'} text-[10px] font-medium rounded ml-auto`}>
                            {selectedCount > 0 && <span>{useLocalAI ? estimateLocalTime(selectedCount, 1) : formatCost(estimateCost(aiModel, selectedCount, 1))}</span>}
                            <span>{useLocalAI ? 'Local' : 'AI'}</span>
                          </span>
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
                          <span className={`flex items-center gap-1 px-1.5 py-0.5 ${useLocalAI ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'} text-[10px] font-medium rounded ml-auto`}>
                            {selectedCount > 0 && <span>{useLocalAI ? estimateLocalTime(selectedCount, 1) : formatCost(estimateCost(aiModel, selectedCount, 1))}</span>}
                            <span>{useLocalAI ? 'Local' : 'AI'}</span>
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-0.5 ml-6">
                          Validate, clean, or generate descriptions
                        </p>
                      </button>

                      <div className="h-px bg-neutral-800 my-1" />

                      {/* Run All + ISBN */}
                      <MenuItem onClick={onRunAll} disabled={!hasSelection} active={runningAll} icon={Zap} aiCalls={3}>
                        Run All
                      </MenuItem>
                      <MenuItem onClick={onLookupISBN} disabled={!hasSelection} active={lookingUpISBN} icon={Hash}>
                        Lookup ISBN & ASIN
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
                          <MenuItem onClick={onFixTitles} disabled={!hasSelection} active={fixingTitles} icon={Type} aiCalls={1}>
                            Fix Titles
                          </MenuItem>
                          <MenuItem onClick={onFixSubtitles} disabled={!hasSelection} active={fixingSubtitles} icon={BookOpen} aiCalls={1}>
                            Fix Subtitles
                          </MenuItem>
                          <MenuItem onClick={onFixAuthors} disabled={!hasSelection} active={fixingAuthors} icon={User} aiCalls={1}>
                            Fix Authors
                          </MenuItem>
                          <MenuItem onClick={onFixSeries} disabled={!hasSelection} active={fixingSeries} icon={Library} aiCalls={1}>
                            Fix Series
                          </MenuItem>
                          <MenuItem onClick={onCleanupGenres} active={cleaningGenres} icon={Tag}>
                            Clean Genres
                          </MenuItem>
                          <MenuItem onClick={onAssignTagsGpt} disabled={!hasSelection} active={assigningTags} icon={Sparkles} aiCalls={1}>
                            AI Tags
                          </MenuItem>
                          <MenuItem onClick={onFixDescriptions} disabled={!hasSelection} active={fixingDescriptions} icon={FileText} aiCalls={1}>
                            Fix Descriptions
                          </MenuItem>
                          <MenuItem onClick={onLookupAge} disabled={!hasSelection} active={lookingUpAge} icon={Users}>
                            Lookup Age
                          </MenuItem>
                          <MenuItem onClick={onGenerateDna} disabled={!hasSelection} active={generatingDna} icon={Dna} aiCalls={1}>
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

            {/* Push */}
            <PillBtn
              onClick={onPush}
              disabled={isProcessing}
              active={pushing}
              icon={Upload}
              label="Push"
            />

            {/* Divider */}
            <div className="w-px h-6 bg-neutral-800 mx-1" />

            {/* DNA Toggle */}
            {hasOpenAiKey && onToggleDna && (
              <button
                onClick={onToggleDna}
                className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all text-sm font-medium ${
                  dnaEnabled
                    ? 'bg-orange-500/20 text-orange-400'
                    : 'text-gray-600 hover:text-gray-400 hover:bg-neutral-800'
                }`}
                title={dnaEnabled ? 'DNA generation ON (slower, adds mood/vibe tags)' : 'DNA generation OFF (faster)'}
              >
                <Dna className="w-5 h-5" />
                <span className="hidden sm:inline">DNA</span>
              </button>
            )}

            {/* Force Fresh Toggle */}
            {onToggleForceFresh && (
              <button
                onClick={onToggleForceFresh}
                className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all text-sm font-medium ${
                  forceFresh
                    ? 'bg-orange-500/20 text-orange-400'
                    : 'text-gray-600 hover:text-gray-400 hover:bg-neutral-800'
                }`}
                title={forceFresh ? 'Force re-process all (slow)' : 'Skip already processed (fast)'}
              >
                <RefreshCw className={`w-5 h-5 ${forceFresh ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Force</span>
              </button>
            )}

            {/* Select All */}
            {!allSelected && onSelectAll && (
              <PillBtn
                onClick={onSelectAll}
                icon={CheckCircle}
                label="Select All"
              />
            )}
          </>
        )}

        {/* ABS Connection Warning */}
        {!hasAbsConnection && (
          <button
            onClick={onNavigateToSettings}
            className="text-xs text-amber-500 hover:text-amber-400 transition-colors ml-2"
          >
            Configure ABS →
          </button>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side — selection info */}
      <div className="flex items-center gap-3 flex-shrink-0">
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
