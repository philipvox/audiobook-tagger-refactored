import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw, Book, Wrench, AlertCircle, ChevronRight, Trash2, Database, Tag, BarChart3, Server, Search, CheckCircle, XCircle } from 'lucide-react';
import { ConfirmModal } from '../components/ConfirmModal';
import { useApp } from '../context/AppContext';

export function MaintenancePage() {
  const { startGlobalProgress, endGlobalProgress } = useApp();
  const [confirmModal, setConfirmModal] = useState(null);
  const [cacheStats, setCacheStats] = useState(null);
  const [genreStats, setGenreStats] = useState(null);
  const [loading, setLoading] = useState({});
  const [unprocessed, setUnprocessed] = useState(null);

  const showConfirm = (config) => {
    setConfirmModal(config);
  };

  const hideConfirm = () => {
    setConfirmModal(null);
  };

  const refreshStats = async () => {
    try {
      const [cache, genres] = await Promise.all([
        invoke('get_cache_stats').catch(() => null),
        invoke('get_genre_stats').catch(() => null),
      ]);
      setCacheStats(cache);
      setGenreStats(genres);
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    }
  };

  useEffect(() => {
    refreshStats();
  }, []);

  const setButtonLoading = (key, value) => {
    setLoading(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="h-full overflow-y-auto bg-neutral-950">
      <div className="p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-100 mb-2">Genre & Tag Maintenance</h2>
                <p className="text-gray-400">
                  Manage genres and tags in your AudiobookShelf library.
                </p>
              </div>
              <button
                onClick={refreshStats}
                className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
                title="Refresh stats"
              >
                <RefreshCw className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* Stats Row */}
            {(cacheStats || genreStats) && (
              <div className="mt-4 pt-4 border-t border-neutral-800 flex flex-wrap gap-6 text-sm">
                {genreStats && (
                  <div className="flex items-center gap-2 text-gray-400">
                    <Tag className="w-4 h-4" />
                    <span>Genres: {genreStats}</span>
                  </div>
                )}
                {cacheStats && (
                  <div className="flex items-center gap-2 text-gray-400">
                    <Database className="w-4 h-4" />
                    <span>Cache: {cacheStats}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Genre Management - Primary Section */}
          <div className="bg-neutral-900 rounded-xl border border-neutral-800 overflow-hidden">
            <div className="bg-gradient-to-r from-purple-900/50 to-pink-900/30 px-6 py-4 border-b border-neutral-800">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-500/20 rounded-lg">
                  <Tag className="w-5 h-5 text-purple-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">Genre Management</h3>
                  <p className="text-sm text-gray-400">Normalize and manage genres in AudiobookShelf</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-3">
              <button
                onClick={() => showConfirm({
                  title: "Normalize Book Genres",
                  message: "This will update all genre assignments in AudiobookShelf to use the approved genre list (e.g., 'Sci-Fi' becomes 'Science Fiction'). This uses the new taxonomy with 50+ approved genres. Continue?",
                  confirmText: "Normalize Genres",
                  type: "info",
                  onConfirm: async () => {
                    try {
                      setButtonLoading('normalizeGenres', true);
                      startGlobalProgress({
                        message: 'Normalizing genres in AudiobookShelf...',
                        type: 'info'
                      });
                      const result = await invoke('normalize_genres');
                      endGlobalProgress();
                      alert(result);
                      refreshStats();
                    } catch (error) {
                      endGlobalProgress();
                      alert('Failed: ' + error);
                    } finally {
                      setButtonLoading('normalizeGenres', false);
                    }
                  }
                })}
                disabled={loading.normalizeGenres}
                className="w-full flex items-center justify-between px-4 py-3 bg-purple-900/30 hover:bg-purple-900/50 border border-purple-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Wrench className={`w-5 h-5 text-purple-400 ${loading.normalizeGenres ? 'animate-spin' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">Normalize Book Genres</div>
                    <div className="text-sm text-gray-400">Map all ABS genres to approved taxonomy</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-purple-400 transition-colors" />
              </button>

              <button
                onClick={() => showConfirm({
                  title: "Clear Unused Genres from ABS",
                  message: "This will find and remove genres from the ABS dropdown that are not assigned to any book. This helps clean up stale genre entries. It does NOT affect genres currently assigned to books. Continue?",
                  confirmText: "Clear Unused Genres",
                  type: "warning",
                  onConfirm: async () => {
                    try {
                      setButtonLoading('clearGenres', true);
                      startGlobalProgress({
                        message: 'Clearing unused genres from AudiobookShelf...',
                        type: 'warning'
                      });
                      const result = await invoke('clear_all_genres');
                      endGlobalProgress();
                      alert(result);
                      refreshStats();
                    } catch (error) {
                      endGlobalProgress();
                      alert('Failed: ' + error);
                    } finally {
                      setButtonLoading('clearGenres', false);
                    }
                  }
                })}
                disabled={loading.clearGenres}
                className="w-full flex items-center justify-between px-4 py-3 bg-amber-900/20 hover:bg-amber-900/40 border border-amber-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Trash2 className={`w-5 h-5 text-amber-400 ${loading.clearGenres ? 'animate-pulse' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">Clear Unused Genres</div>
                    <div className="text-sm text-gray-400">Remove genres not assigned to any book from ABS dropdown</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-amber-400 transition-colors" />
              </button>

              <button
                onClick={async () => {
                  try {
                    setButtonLoading('genreStats', true);
                    const stats = await invoke('get_genre_stats');
                    setGenreStats(stats);
                    alert(stats);
                  } catch (error) {
                    alert('Failed: ' + error);
                  } finally {
                    setButtonLoading('genreStats', false);
                  }
                }}
                disabled={loading.genreStats}
                className="w-full flex items-center justify-between px-4 py-3 bg-indigo-900/20 hover:bg-indigo-900/40 border border-indigo-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <BarChart3 className="w-5 h-5 text-indigo-400" />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">View Genre Statistics</div>
                    <div className="text-sm text-gray-400">See genre distribution and normalization status</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-indigo-400 transition-colors" />
              </button>
            </div>
          </div>

          {/* AudiobookShelf Server Section */}
          <div className="bg-neutral-900 rounded-xl border border-neutral-800 overflow-hidden">
            <div className="bg-gradient-to-r from-blue-900/50 to-indigo-900/30 px-6 py-4 border-b border-neutral-800">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-500/20 rounded-lg">
                  <Server className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">AudiobookShelf Server</h3>
                  <p className="text-sm text-gray-400">Server maintenance and cache management</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-3">
              <button
                onClick={() => showConfirm({
                  title: "Force Library Rescan",
                  message: "This will trigger AudiobookShelf to scan all library folders for new or changed files. This may take a while for large libraries. Continue?",
                  confirmText: "Start Rescan",
                  type: "info",
                  onConfirm: async () => {
                    try {
                      setButtonLoading('rescan', true);
                      startGlobalProgress({
                        message: 'Triggering AudiobookShelf library rescan...',
                        type: 'info'
                      });
                      await invoke('force_abs_rescan');
                      endGlobalProgress();
                      alert('Library rescan triggered! Check AudiobookShelf for progress.');
                    } catch (error) {
                      endGlobalProgress();
                      alert('Failed: ' + error);
                    } finally {
                      setButtonLoading('rescan', false);
                    }
                  }
                })}
                disabled={loading.rescan}
                className="w-full flex items-center justify-between px-4 py-3 bg-blue-900/30 hover:bg-blue-900/50 border border-blue-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Book className={`w-5 h-5 text-blue-400 ${loading.rescan ? 'animate-pulse' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">Force Library Rescan</div>
                    <div className="text-sm text-gray-400">Scan all folders for new/changed audiobooks</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-400 transition-colors" />
              </button>

              <button
                onClick={() => showConfirm({
                  title: "Clear ABS Server Cache",
                  message: "This clears AudiobookShelf's internal cache directory. This can help resolve issues with stale cover art or metadata. Continue?",
                  confirmText: "Clear Server Cache",
                  type: "warning",
                  onConfirm: async () => {
                    try {
                      setButtonLoading('absCache', true);
                      startGlobalProgress({
                        message: 'Clearing AudiobookShelf server cache...',
                        type: 'warning'
                      });
                      await invoke('clear_abs_cache');
                      endGlobalProgress();
                      alert('AudiobookShelf server cache cleared!');
                    } catch (error) {
                      endGlobalProgress();
                      alert('Failed: ' + error);
                    } finally {
                      setButtonLoading('absCache', false);
                    }
                  }
                })}
                disabled={loading.absCache}
                className="w-full flex items-center justify-between px-4 py-3 bg-orange-900/20 hover:bg-orange-900/40 border border-orange-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Trash2 className="w-5 h-5 text-orange-400" />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">Clear ABS Server Cache</div>
                    <div className="text-sm text-gray-400">Clear AudiobookShelf's internal cache files</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-orange-400 transition-colors" />
              </button>

              <button
                onClick={async () => {
                  try {
                    setButtonLoading('libCache', true);
                    await invoke('clear_abs_library_cache');
                    alert('Library cache cleared! Next operation will fetch fresh library data from ABS.');
                  } catch (error) {
                    alert('Failed to clear cache: ' + error);
                  } finally {
                    setButtonLoading('libCache', false);
                  }
                }}
                disabled={loading.libCache}
                className="w-full flex items-center justify-between px-4 py-3 bg-cyan-900/20 hover:bg-cyan-900/40 border border-cyan-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Database className="w-5 h-5 text-cyan-400" />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">Clear Library Item Cache</div>
                    <div className="text-sm text-gray-400">Force fresh library fetch on next operation</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-cyan-400 transition-colors" />
              </button>
            </div>
          </div>

          {/* Unprocessed Books Finder */}
          <div className="bg-neutral-900 rounded-xl border border-neutral-800 overflow-hidden">
            <div className="bg-gradient-to-r from-amber-900/50 to-orange-900/30 px-6 py-4 border-b border-neutral-800">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-500/20 rounded-lg">
                  <Search className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">Unprocessed Books</h3>
                  <p className="text-sm text-gray-400">Find books missing DNA tags or incomplete metadata</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <button
                onClick={async () => {
                  try {
                    setButtonLoading('unprocessed', true);
                    // Ensure cache is loaded first
                    const status = await invoke('get_abs_cache_status');
                    if (!status.is_loaded) {
                      startGlobalProgress({ message: 'Loading ABS library cache...', type: 'info' });
                      await invoke('refresh_abs_cache');
                      endGlobalProgress();
                    }
                    const items = await invoke('get_unprocessed_abs_items');
                    setUnprocessed(items);
                  } catch (error) {
                    alert('Failed: ' + error);
                  } finally {
                    setButtonLoading('unprocessed', false);
                  }
                }}
                disabled={loading.unprocessed}
                className="w-full flex items-center justify-between px-4 py-3 bg-amber-900/30 hover:bg-amber-900/50 border border-amber-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Search className={`w-5 h-5 text-amber-400 ${loading.unprocessed ? 'animate-pulse' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">Find Unprocessed Books</div>
                    <div className="text-sm text-gray-400">Scan ABS for books without DNA tags or missing metadata</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-amber-400 transition-colors" />
              </button>

              {unprocessed && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm text-gray-400 px-1">
                    <span>{unprocessed.length} unprocessed book{unprocessed.length !== 1 ? 's' : ''} found</span>
                    <button onClick={() => setUnprocessed(null)} className="text-gray-500 hover:text-gray-300">Clear</button>
                  </div>

                  {unprocessed.length === 0 ? (
                    <div className="flex items-center gap-2 px-4 py-3 bg-green-900/20 border border-green-700/50 rounded-lg text-green-300 text-sm">
                      <CheckCircle className="w-4 h-4" />
                      All books have been processed!
                    </div>
                  ) : (
                    <div className="max-h-96 overflow-y-auto space-y-2">
                      {unprocessed.map((item) => (
                        <div key={item.id} className="px-4 py-3 bg-neutral-800/50 border border-neutral-700/50 rounded-lg">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-gray-200 truncate">{item.title || 'Untitled'}</div>
                              <div className="text-sm text-gray-400 truncate">{item.author || 'Unknown author'}</div>
                            </div>
                            <div className="flex gap-1 flex-shrink-0">
                              <span title="DNA tags" className={`px-1.5 py-0.5 rounded text-xs ${item.has_dna ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                                DNA
                              </span>
                              <span title="Genres" className={`px-1.5 py-0.5 rounded text-xs ${item.has_genres ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                                G
                              </span>
                              <span title="Description" className={`px-1.5 py-0.5 rounded text-xs ${item.has_description ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                                D
                              </span>
                              <span title="Narrator" className={`px-1.5 py-0.5 rounded text-xs ${item.has_narrator ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                                N
                              </span>
                              <span title="Series" className={`px-1.5 py-0.5 rounded text-xs ${item.has_series ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                                S
                              </span>
                            </div>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {item.reasons.map((reason, i) => (
                              <span key={i} className="text-xs px-1.5 py-0.5 bg-amber-900/30 text-amber-400 rounded">
                                {reason}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Local Cache */}
          <div className="bg-neutral-900 rounded-xl border border-neutral-800 overflow-hidden">
            <div className="bg-gradient-to-r from-green-900/50 to-emerald-900/30 px-6 py-4 border-b border-neutral-800">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-500/20 rounded-lg">
                  <Database className="w-5 h-5 text-green-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">Local Application Cache</h3>
                  <p className="text-sm text-gray-400">Manage cached API responses stored on this computer</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-3">
              <button
                onClick={() => showConfirm({
                  title: "Clear Metadata Cache",
                  message: "This clears all cached API responses stored locally. The next operation will fetch fresh metadata from APIs. This does NOT affect AudiobookShelf. Continue?",
                  confirmText: "Clear Cache",
                  type: "danger",
                  onConfirm: async () => {
                    try {
                      setButtonLoading('metaCache', true);
                      startGlobalProgress({
                        message: 'Clearing local metadata cache...',
                        type: 'danger'
                      });
                      await invoke('clear_cache');
                      endGlobalProgress();
                      alert('Local metadata cache cleared!');
                      refreshStats();
                    } catch (error) {
                      endGlobalProgress();
                      alert('Failed: ' + error);
                    } finally {
                      setButtonLoading('metaCache', false);
                    }
                  }
                })}
                disabled={loading.metaCache}
                className="w-full flex items-center justify-between px-4 py-3 bg-red-900/20 hover:bg-red-900/40 border border-red-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Trash2 className="w-5 h-5 text-red-400" />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">Clear Metadata Cache</div>
                    <div className="text-sm text-gray-400">Force fresh API lookups on next operation</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-red-400 transition-colors" />
              </button>

              <button
                onClick={async () => {
                  try {
                    setButtonLoading('cacheStats', true);
                    const stats = await invoke('get_cache_stats');
                    setCacheStats(stats);
                    alert(`Local cache: ${stats}`);
                  } catch (error) {
                    alert('Failed: ' + error);
                  } finally {
                    setButtonLoading('cacheStats', false);
                  }
                }}
                disabled={loading.cacheStats}
                className="w-full flex items-center justify-between px-4 py-3 bg-green-900/20 hover:bg-green-900/40 border border-green-700/50 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <BarChart3 className="w-5 h-5 text-green-400" />
                  <div className="text-left">
                    <div className="font-medium text-gray-100">View Cache Statistics</div>
                    <div className="text-sm text-gray-400">See how many items are cached locally</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-green-400 transition-colors" />
              </button>
            </div>
          </div>

          {/* Info Card */}
          <div className="bg-purple-900/20 border border-purple-700/50 rounded-xl p-4">
            <div className="flex gap-3">
              <AlertCircle className="w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-purple-200">
                <p className="font-medium mb-1">About Genre & Tag Management</p>
                <p className="text-purple-300/80">Genre operations only affect metadata stored in AudiobookShelf. The new taxonomy includes 50+ approved genres and 200+ descriptive tags for comprehensive audiobook categorization.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          onClose={hideConfirm}
          onConfirm={confirmModal.onConfirm}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          type={confirmModal.type}
        />
      )}
    </div>
  );
}
