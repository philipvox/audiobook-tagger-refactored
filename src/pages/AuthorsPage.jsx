// src/pages/AuthorsPage.jsx
// Authors tab — mirrors the ScannerPage experience for author metadata

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { callBackend } from '../api';
import {
  RefreshCw, Search, AlertTriangle, AlertCircle, Copy, Users,
  ChevronRight, BookOpen, Clock, Edit3, GitMerge, CheckCircle,
  XCircle, Info, Loader2, Upload, Sparkles, Check, Wand2,
  RotateCcw, Download, ChevronDown, FileText, User, X,
} from 'lucide-react';
import { useAuthors } from '../hooks/useAuthors';
import { useApp } from '../context/AppContext';
import { ConfirmModal } from '../components/ConfirmModal';

export function AuthorsPage() {
  const {
    authors, detail, analysis, loading, loadingDetail, analyzing,
    fixingDescriptions, pushing, progressMessage, error,
    pendingChanges, pendingMerges, pendingCount, mergedAwayIds,
    selectedIds, allSelected,
    loadAuthors, loadDetail, runAnalysis, renameAuthor,
    stageMerge, unstageMerge, autoMergeDuplicates,
    fixDescriptions, applyNormalizationFixes, pushToAbs,
    stageChange, discardAllChanges, selectedAuthorId,
    handleAuthorClick, handleSelectAll, handleClearSelection,
    getSelectedAuthors, getSelectedCount,
    getIssuesForAuthor,
  } = useAuthors();

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [renameModal, setRenameModal] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [showEnrichMenu, setShowEnrichMenu] = useState(false);
  const [showValidateMenu, setShowValidateMenu] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  const { startGlobalProgress, updateGlobalProgress, endGlobalProgress } = useApp();
  const prevProcessing = useRef(false);

  // Forward authors_progress events to the GlobalProgressBar
  useEffect(() => {
    if (!progressMessage) return;
    const { phase, message, current, total } = progressMessage;

    if (phase === 'done') {
      updateGlobalProgress({ current: total || current || 1, total: total || current || 1, message });
      const t = setTimeout(() => endGlobalProgress(), 2000);
      return () => clearTimeout(t);
    } else {
      // First event with a total — start or update the bar
      if (total > 0) {
        startGlobalProgress({ message, total, type: 'info' });
        if (current > 0) updateGlobalProgress({ current, message, detail: message });
      } else {
        // Indeterminate — just start with a message
        startGlobalProgress({ message, total: 0, type: 'info' });
      }
    }
  }, [progressMessage]);

  // Safety net: if all operations stop but the bar is still showing, dismiss it
  const isProcessing = analyzing || fixingDescriptions || pushing;
  useEffect(() => {
    if (prevProcessing.current && !isProcessing) {
      // Operations ended — dismiss after a short delay
      const t = setTimeout(() => endGlobalProgress(), 2500);
      return () => clearTimeout(t);
    }
    prevProcessing.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => { loadAuthors(); }, [loadAuthors]);

  // Build issue lookup
  const issuesByAuthor = useMemo(() => {
    if (!analysis) return {};
    const map = {};
    for (const issue of analysis.issues) {
      if (!map[issue.author_id]) map[issue.author_id] = [];
      map[issue.author_id].push(issue);
    }
    return map;
  }, [analysis]);

  // Filtered + searched authors — hide authors that are staged to be merged away
  const filteredAuthors = useMemo(() => {
    let list = authors.filter(a => !mergedAwayIds.has(a.id));
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(a => a.name.toLowerCase().includes(q));
    }
    if (activeFilter === 'pending') {
      list = list.filter(a => pendingChanges[a.id] || pendingMerges[a.id]);
    } else if (activeFilter !== 'all' && analysis) {
      const ids = new Set();
      for (const issue of analysis.issues) {
        if (activeFilter === 'needs_fix' && (issue.issue_type === 'needs_normalization' || issue.issue_type === 'rejected')) ids.add(issue.author_id);
        else if (activeFilter === 'suspicious' && issue.issue_type === 'suspicious') ids.add(issue.author_id);
        else if (activeFilter === 'duplicates' && issue.issue_type === 'potential_duplicate') ids.add(issue.author_id);
        else if (activeFilter === 'missing_info' && (issue.issue_type === 'missing_description' || issue.issue_type === 'missing_image')) ids.add(issue.author_id);
      }
      list = list.filter(a => ids.has(a.id));
    }
    return list;
  }, [authors, searchQuery, activeFilter, analysis, pendingChanges, pendingMerges, mergedAwayIds]);

  // Auto-select first on load
  useEffect(() => {
    if (filteredAuthors.length > 0 && !selectedAuthorId) {
      loadDetail(filteredAuthors[0].id);
    }
  }, [filteredAuthors]);

  const selectedCount = getSelectedCount(filteredAuthors);
  const hasSelection = selectedCount > 0;

  // Handlers
  const handleRename = useCallback(() => {
    if (!renameModal || !renameValue.trim()) return;
    renameAuthor(renameModal.id, renameValue.trim());
    setRenameModal(null);
  }, [renameModal, renameValue, renameAuthor]);

  const handleMerge = useCallback((primaryId, _primaryName, secondaryId, secondaryName) => {
    stageMerge(primaryId, secondaryId, secondaryName);
  }, [stageMerge]);

  const handleFixDescriptions = useCallback(async (force) => {
    const selected = getSelectedAuthors(filteredAuthors);
    const ids = selected.map(a => a.id);
    if (ids.length === 0) return;
    await fixDescriptions(ids, force);
  }, [getSelectedAuthors, filteredAuthors, fixDescriptions]);

  const handleApplyNormFixes = useCallback(() => {
    const selected = getSelectedAuthors(filteredAuthors);
    const ids = selected.map(a => a.id);
    const count = applyNormalizationFixes(ids.length > 0 ? ids : null);
    if (count > 0) setActiveFilter('pending');
  }, [getSelectedAuthors, filteredAuthors, applyNormalizationFixes]);

  const handlePush = useCallback(() => {
    if (pendingCount === 0) return;
    setConfirmModal({
      title: 'Push to ABS',
      message: `Push ${pendingCount} author change(s) to AudiobookShelf?`,
      confirmText: 'Push',
      type: 'info',
      onConfirm: async () => {
        setConfirmModal(null);
        await pushToAbs();
      },
    });
  }, [pendingCount, pushToAbs]);

  const getIssueBadges = (authorId) => {
    const issues = issuesByAuthor[authorId];
    if (!issues || issues.length === 0) return null;
    const types = new Set(issues.map(i => i.issue_type));
    const badges = [];
    if (types.has('needs_normalization') || types.has('rejected')) badges.push({ color: 'bg-orange-500/20 text-orange-400', label: 'Fix' });
    if (types.has('suspicious')) badges.push({ color: 'bg-red-500/20 text-red-400', label: 'Sus' });
    if (types.has('potential_duplicate')) badges.push({ color: 'bg-blue-500/20 text-blue-400', label: 'Dup' });
    return badges;
  };

  // Shared component styles matching ActionBar
  const IconBtn = ({ onClick, disabled, active, icon: Icon, title, variant = 'default' }) => (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`relative p-2.5 rounded-full transition-all flex items-center justify-center ${
        active ? 'text-white bg-neutral-800' :
        variant === 'primary' ? (disabled ? 'text-gray-600' : 'text-white bg-white/10 hover:bg-white/20') :
        (disabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-white hover:bg-neutral-800')
      }`}>
      <Icon className={`w-5 h-5 ${active ? 'animate-pulse' : ''}`} />
    </button>
  );

  const MenuItem = ({ onClick, disabled, active, icon: Icon, children, badge }) => (
    <button onClick={(e) => { e.stopPropagation(); if (!disabled) { onClick?.(); setShowEnrichMenu(false); setShowValidateMenu(false); } }}
      disabled={disabled}
      className={`w-full px-3 py-2 text-sm text-left flex items-center gap-2.5 transition-colors ${
        disabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300 hover:bg-neutral-800 hover:text-white'
      } ${active ? 'text-white bg-neutral-800' : ''}`}>
      <Icon className={`w-4 h-4 ${active ? 'animate-pulse' : ''}`} />
      <span className="flex-1">{children}</span>
      {badge > 0 && <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-medium rounded">{badge}</span>}
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-neutral-950">
      {/* Action Bar - mirrors ScannerPage */}
      <div className="px-4 py-3 flex items-center gap-4">
        {/* Left: main action buttons */}
        <div className="flex items-center gap-1">
          {/* Refresh from ABS */}
          <IconBtn onClick={loadAuthors} disabled={isProcessing} active={loading} icon={Download} variant="primary"
            title="Load authors from ABS" />

          {authors.length > 0 && (
            <>
              {/* Enrich dropdown */}
              <div className="relative">
                <button onClick={() => { setShowEnrichMenu(!showEnrichMenu); setShowValidateMenu(false); }}
                  disabled={isProcessing}
                  className={`p-2.5 rounded-full transition-all flex items-center gap-1 ${
                    showEnrichMenu ? 'bg-neutral-800 text-white' : 'text-gray-400 hover:text-white hover:bg-neutral-800'
                  } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                  title="Enrich author metadata">
                  <Sparkles className={`w-5 h-5 ${fixingDescriptions ? 'animate-pulse' : ''}`} />
                  <ChevronDown className="w-3 h-3" />
                </button>

                {showEnrichMenu && (
                  <div className="absolute top-full left-0 mt-1 w-72 bg-neutral-900 rounded-xl border border-neutral-800 shadow-xl py-1 z-50">
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600 font-semibold">
                      AI Processing
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); handleFixDescriptions(false); setShowEnrichMenu(false); }}
                      disabled={!hasSelection || isProcessing}
                      className={`w-full px-3 py-2.5 text-left transition-colors ${
                        !hasSelection || isProcessing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-800'
                      } ${fixingDescriptions ? 'bg-neutral-800' : ''}`}>
                      <div className="flex items-center gap-2">
                        <FileText className={`w-4 h-4 text-cyan-400 ${fixingDescriptions ? 'animate-pulse' : ''}`} />
                        <span className="text-sm text-white font-medium">Fix Descriptions</span>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5 ml-6">Generate or clean author bios with GPT</p>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleFixDescriptions(true); setShowEnrichMenu(false); }}
                      disabled={!hasSelection || isProcessing}
                      className={`w-full px-3 py-2.5 text-left transition-colors ${
                        !hasSelection || isProcessing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-800'
                      }`}>
                      <div className="flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 text-orange-400" />
                        <span className="text-sm text-white font-medium">Regenerate All Descriptions</span>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5 ml-6">Force re-generate even for good descriptions</p>
                    </button>

                    <div className="h-px bg-neutral-800 my-1" />
                    <MenuItem onClick={handleApplyNormFixes}
                      disabled={!analysis || analysis.summary.needs_normalization === 0}
                      icon={Wand2}
                      badge={analysis?.summary.needs_normalization}>
                      Apply Name Fixes
                    </MenuItem>
                    <MenuItem onClick={() => { const n = autoMergeDuplicates(); setShowEnrichMenu(false); if (n > 0) setActiveFilter('pending'); }}
                      disabled={!analysis || analysis.summary.potential_duplicates === 0}
                      icon={GitMerge}
                      badge={analysis?.summary.potential_duplicates}>
                      Auto-Merge Duplicates
                    </MenuItem>
                  </div>
                )}
              </div>

              {/* Validate dropdown */}
              <div className="relative">
                <button onClick={() => { setShowValidateMenu(!showValidateMenu); setShowEnrichMenu(false); }}
                  disabled={isProcessing}
                  className={`p-2.5 rounded-full transition-all flex items-center gap-1 ${
                    showValidateMenu ? 'bg-neutral-800 text-white' : 'text-gray-400 hover:text-white hover:bg-neutral-800'
                  } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                  title="Analyze authors">
                  <Search className={`w-5 h-5 ${analyzing ? 'animate-pulse' : ''}`} />
                  <ChevronDown className="w-3 h-3" />
                  {analysis && (analysis.summary.needs_normalization > 0 || analysis.summary.suspicious > 0) && (
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full" />
                  )}
                </button>

                {showValidateMenu && (
                  <div className="absolute top-full left-0 mt-1 w-52 bg-neutral-900 rounded-xl border border-neutral-800 shadow-xl py-1 z-50">
                    <MenuItem onClick={() => { runAnalysis(); setShowValidateMenu(false); }} active={analyzing} icon={Search}
                      badge={analysis ? analysis.issues.length : null}>
                      Run Full Analysis
                    </MenuItem>
                  </div>
                )}
              </div>

              {/* Push to ABS */}
              <IconBtn onClick={handlePush} disabled={isProcessing || pendingCount === 0}
                active={pushing} icon={Upload} title={pendingCount > 0 ? `Push ${pendingCount} changes to ABS` : 'No pending changes'} />
            </>
          )}
        </div>

        {/* Selection info */}
        <div className="flex items-center gap-3">
          {hasSelection ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-white font-medium">{selectedCount} selected</span>
              <button onClick={handleClearSelection} className="p-1 rounded-full hover:bg-neutral-800 text-gray-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <span className="text-sm text-gray-500">{authors.length > 0 ? `${authors.length} authors` : ''}</span>
          )}

          {/* Pending changes pill */}
          {pendingCount > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 text-xs">
                {pendingCount} pending
              </span>
              <button onClick={discardAllChanges} className="p-1 rounded-full hover:bg-neutral-800 text-gray-600 hover:text-gray-300 transition-colors" title="Discard all changes">
                <RotateCcw className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Analysis stat pills */}
          {analysis && (
            <div className="flex items-center gap-1.5">
              {analysis.summary.needs_normalization > 0 && (
                <button onClick={() => setActiveFilter('needs_fix')}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 text-xs hover:bg-orange-500/20 transition-colors">
                  <AlertTriangle className="w-3 h-3" /> {analysis.summary.needs_normalization}
                </button>
              )}
              {analysis.summary.suspicious > 0 && (
                <button onClick={() => setActiveFilter('suspicious')}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 text-xs hover:bg-red-500/20 transition-colors">
                  <AlertCircle className="w-3 h-3" /> {analysis.summary.suspicious}
                </button>
              )}
              {analysis.summary.potential_duplicates > 0 && (
                <button onClick={() => setActiveFilter('duplicates')}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 text-xs hover:bg-blue-500/20 transition-colors">
                  <Copy className="w-3 h-3" /> {analysis.summary.potential_duplicates}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Right side */}
        <div className="flex items-center gap-2">
          {/* Filter pills (compact) */}
          {(analysis || pendingCount > 0) && (
            <div className="flex items-center gap-1">
              {[
                ['all', 'All'],
                ...(pendingCount > 0 ? [['pending', 'Pending']] : []),
                ...(analysis ? [
                  ['needs_fix', 'Fixes'],
                  ['duplicates', 'Dups'],
                  ['missing_info', 'Missing'],
                ] : []),
              ].map(([key, label]) => (
                <button key={key} onClick={() => setActiveFilter(key)}
                  className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                    activeFilter === key ? 'bg-neutral-700 text-white' : 'text-gray-600 hover:text-gray-400'
                  }`}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Select All */}
          {filteredAuthors.length > 0 && !allSelected && (
            <button onClick={() => handleSelectAll(filteredAuthors)}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-white rounded-full hover:bg-neutral-800 transition-colors">
              Select all
            </button>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input type="text" placeholder="Search..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 w-44 focus:outline-none focus:border-neutral-600" />
          </div>
        </div>
      </div>

      {/* Main split panel */}
      <div className="flex-1 flex overflow-hidden border-t border-neutral-800">
        {/* Author List (left) */}
        <div className="w-[400px] flex-shrink-0 border-r border-neutral-800 overflow-y-auto select-none">
          {loading && authors.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading authors...
            </div>
          ) : filteredAuthors.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
              {searchQuery ? 'No authors match search' : 'No authors loaded'}
            </div>
          ) : (
            filteredAuthors.map((author, index) => {
              const isActive = selectedAuthorId === author.id;
              const isInSelection = allSelected || selectedIds.has(author.id);
              const badges = getIssueBadges(author.id);
              const hasPending = !!pendingChanges[author.id];
              const mergeChildren = pendingMerges[author.id] || [];

              return (
                <div key={author.id}>
                  <div
                    onClick={(e) => handleAuthorClick(author, index, e, filteredAuthors)}
                    className={`flex items-center gap-2 px-4 py-3 border-b border-neutral-800/50 cursor-pointer transition-colors ${
                      isInSelection ? 'bg-neutral-800/60' : isActive ? 'bg-neutral-800/40' : 'hover:bg-neutral-900'
                    }`}>
                    {(hasPending || mergeChildren.length > 0) && <div className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />}
                    <span className={`text-sm font-medium truncate ${isInSelection || isActive ? 'text-white' : 'text-gray-300'}`}>
                      {author.name}
                    </span>
                    <span className="text-xs text-gray-600 flex-shrink-0">({author.num_books})</span>
                    <div className="flex-1" />
                    {mergeChildren.length > 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-400 flex-shrink-0">
                        +{mergeChildren.length} merge
                      </span>
                    )}
                    {badges && badges.map((b, i) => (
                      <span key={i} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${b.color} flex-shrink-0`}>{b.label}</span>
                    ))}
                  </div>
                  {/* Merge sub-items */}
                  {mergeChildren.map(child => (
                    <div key={child.id}
                      className="flex items-center gap-2 pl-8 pr-4 py-2 border-b border-neutral-800/30 bg-purple-500/5">
                      <GitMerge className="w-3 h-3 text-purple-400 flex-shrink-0" />
                      <span className="text-xs text-purple-300 truncate">{child.name}</span>
                      <div className="flex-1" />
                      <button onClick={(e) => { e.stopPropagation(); unstageMerge(author.id, child.id); }}
                        className="p-0.5 rounded hover:bg-neutral-800 text-gray-600 hover:text-gray-300 transition-colors"
                        title="Undo merge">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>

        {/* Author Detail (right) */}
        <div className="flex-1 overflow-y-auto">
          {loadingDetail ? (
            <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading author...
            </div>
          ) : detail ? (
            <AuthorDetail
              detail={detail}
              issues={issuesByAuthor[detail.id] || []}
              pendingChanges={pendingChanges[detail.id] || null}
              onRename={(id, name) => {
                setRenameModal({ id, name });
                const norm = (issuesByAuthor[id] || []).find(i => i.issue_type === 'needs_normalization');
                setRenameValue(norm?.suggested_value || name);
              }}
              onMerge={(primaryId, primaryName, secondaryId, secondaryName) => handleMerge(primaryId, primaryName, secondaryId, secondaryName)}
              onFixDescription={async (id) => { await fixDescriptions([id], false); }}
              onEditDescription={(id, desc) => {
                stageChange(id, 'description', desc);
                setDetail(prev => prev ? { ...prev, description: desc } : prev);
              }}
              actionLoading={actionLoading || fixingDescriptions}
            />
          ) : (
            <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
              Select an author to view details
            </div>
          )}
        </div>
      </div>

      {/* Rename Modal */}
      {renameModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setRenameModal(null)}>
          <div className="bg-neutral-900 rounded-xl border border-neutral-700 p-6 w-[480px]" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-100 mb-4">Rename Author</h3>
            <p className="text-sm text-gray-400 mb-3">Current: <span className="text-gray-200">{renameModal.name}</span></p>
            <input type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
              className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-neutral-500"
              autoFocus onKeyDown={(e) => e.key === 'Enter' && handleRename()} />
            <p className="text-xs text-gray-600 mt-2">Staged locally — push to ABS when ready.</p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setRenameModal(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
              <button onClick={handleRename} disabled={!renameValue.trim() || renameValue.trim() === renameModal.name}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg disabled:opacity-50">
                Stage Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmModal(null)}
          onConfirm={confirmModal.onConfirm}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          type={confirmModal.type}
        />
      )}

      {error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-900/90 text-red-200 px-4 py-2 rounded-lg text-sm border border-red-700 z-50 max-w-lg truncate">
          {error}
        </div>
      )}

      {/* Click outside to close menus */}
      {(showEnrichMenu || showValidateMenu) && (
        <div className="fixed inset-0 z-40" onClick={() => { setShowEnrichMenu(false); setShowValidateMenu(false); }} />
      )}
    </div>
  );
}

// ============================================================================
// Author Detail
// ============================================================================

function AuthorDetail({ detail, issues, pendingChanges, onRename, onMerge, onFixDescription, onEditDescription, actionLoading }) {
  const [imageData, setImageData] = useState(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');

  useEffect(() => {
    setImageData(null);
    setEditingDesc(false);
    if (!detail.has_image) return;
    let cancelled = false;
    setImageLoading(true);
    callBackend('get_abs_author_image', { authorId: detail.id })
      .then(bytes => {
        if (cancelled) return;
        const uint8 = new Uint8Array(bytes);
        const binary = Array.from(uint8).map(b => String.fromCharCode(b)).join('');
        setImageData(`data:image/jpeg;base64,${btoa(binary)}`);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setImageLoading(false); });
    return () => { cancelled = true; };
  }, [detail.id, detail.has_image]);

  const normIssue = issues.find(i => i.issue_type === 'needs_normalization');
  const suspIssue = issues.find(i => i.issue_type === 'suspicious' || i.issue_type === 'rejected');
  const dupIssue = issues.find(i => i.issue_type === 'potential_duplicate');

  return (
    <div className="p-6 space-y-6">
      {pendingChanges && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
          <div className="w-2 h-2 rounded-full bg-green-400" />
          <span className="text-xs text-green-400">
            Pending: {[pendingChanges.name && 'name', pendingChanges.description && 'description'].filter(Boolean).join(', ')}
          </span>
        </div>
      )}

      <div className="flex gap-5">
        <div className="w-24 h-24 rounded-xl bg-neutral-800 flex-shrink-0 overflow-hidden flex items-center justify-center">
          {imageData ? <img src={imageData} alt={detail.name} className="w-full h-full object-cover" />
            : imageLoading ? <Loader2 className="w-6 h-6 text-gray-600 animate-spin" />
            : <Users className="w-8 h-8 text-gray-700" />}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-gray-100 truncate">{detail.name}</h2>
          <p className="text-sm text-gray-500 mt-1">{detail.num_books} book{detail.num_books !== 1 ? 's' : ''}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            {normIssue && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-500/20 text-orange-400">
                <Edit3 className="w-3 h-3" /> Normalize to: {normIssue.suggested_value}
              </span>
            )}
            {suspIssue && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400">
                <AlertCircle className="w-3 h-3" /> {suspIssue.message}
              </span>
            )}
            {dupIssue && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400">
                <Copy className="w-3 h-3" /> {dupIssue.message}
              </span>
            )}
            {issues.length === 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                <CheckCircle className="w-3 h-3" /> No issues
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</span>
          <div className="flex gap-1">
            <button onClick={() => onFixDescription(detail.id)} disabled={actionLoading}
              className="flex items-center gap-1 px-2 py-1 text-xs text-purple-400 hover:bg-purple-600/20 rounded transition-colors disabled:opacity-50">
              <Sparkles className="w-3 h-3" /> GPT
            </button>
            {!editingDesc ? (
              <button onClick={() => { setEditingDesc(true); setDescDraft(detail.description || ''); }}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:bg-neutral-800 rounded transition-colors">
                <Edit3 className="w-3 h-3" /> Edit
              </button>
            ) : (
              <>
                <button onClick={() => { onEditDescription(detail.id, descDraft); setEditingDesc(false); }}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-green-400 hover:bg-green-600/20 rounded transition-colors">
                  <Check className="w-3 h-3" /> Save
                </button>
                <button onClick={() => setEditingDesc(false)}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:bg-neutral-800 rounded transition-colors">Cancel</button>
              </>
            )}
          </div>
        </div>
        {editingDesc ? (
          <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)} rows={4}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-2 text-sm text-gray-300 focus:outline-none focus:border-neutral-500 resize-y" />
        ) : detail.description ? (
          <p className="text-sm text-gray-400 leading-relaxed">{detail.description}</p>
        ) : (
          <p className="text-sm text-gray-600 italic">No description</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button onClick={() => onRename(detail.id, detail.name)} disabled={actionLoading}
          className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-sm text-gray-300 transition-colors disabled:opacity-50">
          <Edit3 className="w-4 h-4" /> Rename
        </button>
        {dupIssue && (
          <button onClick={() => onMerge(dupIssue.duplicate_of.id, dupIssue.duplicate_of.name, detail.id, detail.name)} disabled={actionLoading}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 rounded-lg text-sm text-blue-400 transition-colors disabled:opacity-50">
            <GitMerge className="w-4 h-4" /> Merge into "{dupIssue.duplicate_of.name}"
          </button>
        )}
      </div>

      {/* Books */}
      <div>
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Books ({detail.books?.length || 0})</h3>
        <div className="space-y-1">
          {(detail.books || []).map(book => (
            <div key={book.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-neutral-900 transition-colors">
              <BookOpen className="w-4 h-4 text-gray-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200 truncate">
                  {book.title}{book.subtitle && <span className="text-gray-500"> — {book.subtitle}</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                  {book.series && <span className="text-purple-400">{book.series}{book.sequence ? ` #${book.sequence}` : ''}</span>}
                  {(book.narrators?.length || 0) > 0 && <span>Narrated by {book.narrators.join(', ')}</span>}
                  {book.duration_seconds && (
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDur(book.duration_seconds)}</span>
                  )}
                </div>
              </div>
              {book.genres?.length > 0 && (
                <div className="flex gap-1 flex-shrink-0">
                  {book.genres.slice(0, 2).map((g, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-neutral-800 text-[10px] text-gray-500">{g}</span>
                  ))}
                  {book.genres.length > 2 && <span className="text-[10px] text-gray-600">+{book.genres.length - 2}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Issues */}
      {issues.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Issues ({issues.length})</h3>
          <div className="space-y-2">
            {issues.map((issue, i) => (
              <div key={i} className="flex items-start gap-3 px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800">
                {issue.severity === 'error' ? <XCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                  : issue.severity === 'warning' ? <AlertTriangle className="w-4 h-4 text-orange-400 mt-0.5 flex-shrink-0" />
                  : <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />}
                <div className="flex-1">
                  <p className="text-sm text-gray-300">{issue.message}</p>
                  {issue.suggested_value && <p className="text-xs text-gray-500 mt-0.5">Suggested: <span className="text-gray-400">{issue.suggested_value}</span></p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtDur(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
