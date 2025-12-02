import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Upload, RefreshCw, Book, Wrench, Folder, AlertCircle, ChevronRight, Trash2, Database, Tag, BarChart3, Server, User } from 'lucide-react';
import { ConfirmModal } from '../components/ConfirmModal';
import { useApp } from '../context/AppContext';

export function MaintenancePage() {
  const { startGlobalProgress, updateGlobalProgress, endGlobalProgress } = useApp();
  const [confirmModal, setConfirmModal] = useState(null);
  const [cacheStats, setCacheStats] = useState(null);
  const [genreStats, setGenreStats] = useState(null);
  const [authorStats, setAuthorStats] = useState(null);
  const [loading, setLoading] = useState({});

  const showConfirm = (config) => {
    setConfirmModal(config);
  };

  const hideConfirm = () => {
    setConfirmModal(null);
  };

  const refreshStats = async () => {
    try {
      const [cache, genres, authors] = await Promise.all([
        invoke('get_cache_stats').catch(() => null),
        invoke('get_genre_stats').catch(() => null),
        invoke('get_author_stats').catch(() => null)
      ]);
      setCacheStats(cache);
      setGenreStats(genres);
      setAuthorStats(authors);
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
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 mb-2">Library Maintenance</h2>
                <p className="text-gray-600">
                  Manage AudiobookShelf server and local cache settings.
                </p>
              </div>
              <button
                onClick={refreshStats}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                title="Refresh stats"
              >
                <RefreshCw className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {/* Stats Row */}
            {(cacheStats || genreStats || authorStats) && (
              <div className="mt-4 pt-4 border-t border-gray-200 flex flex-wrap gap-6 text-sm">
                {cacheStats && (
                  <div className="flex items-center gap-2 text-gray-600">
                    <Database className="w-4 h-4" />
                    <span>Local Cache: {cacheStats}</span>
                  </div>
                )}
                {genreStats && (
                  <div className="flex items-center gap-2 text-gray-600">
                    <Tag className="w-4 h-4" />
                    <span>Genres: {genreStats}</span>
                  </div>
                )}
                {authorStats && (
                  <div className="flex items-center gap-2 text-gray-600">
                    <User className="w-4 h-4" />
                    <span>Authors: {authorStats}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* AudiobookShelf Server Section */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Server className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">AudiobookShelf Server</h3>
                  <p className="text-sm text-gray-600">Manage your AudiobookShelf Docker container and server cache</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-3">
              <button
                onClick={() => showConfirm({
                  title: "Restart Docker Container",
                  message: "This will temporarily stop the AudiobookShelf server while it restarts. Users will be disconnected briefly. Continue?",
                  confirmText: "Restart",
                  type: "warning",
                  onConfirm: async () => {
                    try {
                      setButtonLoading('restart', true);
                      startGlobalProgress({
                        message: 'Restarting AudiobookShelf Docker container...',
                        type: 'warning'
                      });
                      await invoke('restart_abs_docker');
                      endGlobalProgress();
                      alert('Container restarted successfully!');
                    } catch (error) {
                      endGlobalProgress();
                      alert('Failed: ' + error);
                    } finally {
                      setButtonLoading('restart', false);
                    }
                  }
                })}
                disabled={loading.restart}
                className="w-full flex items-center justify-between px-4 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <RefreshCw className={`w-5 h-5 text-blue-600 ${loading.restart ? 'animate-spin' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Restart Docker Container</div>
                    <div className="text-sm text-gray-600">Restart the AudiobookShelf service</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
              </button>

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
                className="w-full flex items-center justify-between px-4 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Book className={`w-5 h-5 text-blue-600 ${loading.rescan ? 'animate-pulse' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Force Library Rescan</div>
                    <div className="text-sm text-gray-600">Scan all folders for new/changed audiobooks</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
              </button>

              <button
                onClick={() => showConfirm({
                  title: "Clear ABS Server Cache",
                  message: "This clears AudiobookShelf's internal cache directory (/config/cache). This can help resolve issues with stale cover art or metadata. Continue?",
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
                className="w-full flex items-center justify-between px-4 py-3 bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Trash2 className="w-5 h-5 text-orange-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Clear ABS Server Cache</div>
                    <div className="text-sm text-gray-600">Clear AudiobookShelf's internal cache files</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-orange-600 transition-colors" />
              </button>

              <button
                onClick={async () => {
                  try {
                    setButtonLoading('libCache', true);
                    await invoke('clear_abs_library_cache');
                    alert('Library cache cleared! Next push will fetch fresh library data from ABS.');
                  } catch (error) {
                    alert('Failed to clear cache: ' + error);
                  } finally {
                    setButtonLoading('libCache', false);
                  }
                }}
                disabled={loading.libCache}
                className="w-full flex items-center justify-between px-4 py-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Database className="w-5 h-5 text-purple-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Clear Library Item Cache</div>
                    <div className="text-sm text-gray-600">Force fresh library fetch on next push (in-memory)</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-purple-600 transition-colors" />
              </button>
            </div>
          </div>

          {/* Genre Management (ABS) */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-purple-50 to-pink-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <Tag className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">ABS Genre Management</h3>
                  <p className="text-sm text-gray-600">Manage genres in AudiobookShelf (not file tags)</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-3">
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
                className="w-full flex items-center justify-between px-4 py-3 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Trash2 className={`w-5 h-5 text-amber-600 ${loading.clearGenres ? 'animate-pulse' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Clear Unused Genres</div>
                    <div className="text-sm text-gray-600">Remove genres not assigned to any book from ABS dropdown</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-amber-600 transition-colors" />
              </button>

              <button
                onClick={() => showConfirm({
                  title: "Normalize Book Genres",
                  message: "This will update all genre assignments in AudiobookShelf to use the approved genre list (e.g., 'Sci-Fi' becomes 'Science Fiction'). This does NOT modify your audio files. Continue?",
                  confirmText: "Normalize Genres",
                  type: "warning",
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
                className="w-full flex items-center justify-between px-4 py-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Wrench className={`w-5 h-5 text-purple-600 ${loading.normalizeGenres ? 'animate-spin' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Normalize Book Genres</div>
                    <div className="text-sm text-gray-600">Map all ABS genres to approved standard list</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-purple-600 transition-colors" />
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
                className="w-full flex items-center justify-between px-4 py-3 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <BarChart3 className="w-5 h-5 text-indigo-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">View Genre Statistics</div>
                    <div className="text-sm text-gray-600">See how many genres need normalization</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-indigo-600 transition-colors" />
              </button>
            </div>
          </div>

          {/* Author Management (ABS) */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-red-50 to-orange-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-lg">
                  <User className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">ABS Author Management</h3>
                  <p className="text-sm text-gray-600">Fix author mismatches in AudiobookShelf by comparing with file tags</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-3">
              <button
                onClick={() => showConfirm({
                  title: "Fix Author Mismatches",
                  message: "This will compare authors in AudiobookShelf with the author tags embedded in your audio files. If they don't match (e.g., ABS shows 'J.K. Rowling' but file says 'Will Wight'), it will update ABS to match your file tags. This is useful if previous scans assigned wrong authors. Continue?",
                  confirmText: "Fix Authors",
                  type: "warning",
                  onConfirm: async () => {
                    try {
                      setButtonLoading('fixAuthors', true);
                      startGlobalProgress({
                        message: 'Fixing author mismatches in AudiobookShelf...',
                        type: 'warning'
                      });
                      const result = await invoke('fix_author_mismatches');
                      endGlobalProgress();
                      alert(result);
                      refreshStats();
                    } catch (error) {
                      endGlobalProgress();
                      alert('Failed: ' + error);
                    } finally {
                      setButtonLoading('fixAuthors', false);
                    }
                  }
                })}
                disabled={loading.fixAuthors}
                className="w-full flex items-center justify-between px-4 py-3 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Wrench className={`w-5 h-5 text-red-600 ${loading.fixAuthors ? 'animate-spin' : ''}`} />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Fix Author Mismatches</div>
                    <div className="text-sm text-gray-600">Update ABS authors to match your file tags</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-red-600 transition-colors" />
              </button>

              <button
                onClick={async () => {
                  try {
                    setButtonLoading('authorStats', true);
                    const stats = await invoke('get_author_stats');
                    setAuthorStats(stats);
                    alert(stats);
                  } catch (error) {
                    alert('Failed: ' + error);
                  } finally {
                    setButtonLoading('authorStats', false);
                  }
                }}
                disabled={loading.authorStats}
                className="w-full flex items-center justify-between px-4 py-3 bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <BarChart3 className="w-5 h-5 text-orange-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">View Author Statistics</div>
                    <div className="text-sm text-gray-600">See how many author mismatches exist</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-orange-600 transition-colors" />
              </button>
            </div>
          </div>

          {/* Local Cache */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-green-50 to-emerald-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Database className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Local Application Cache</h3>
                  <p className="text-sm text-gray-600">Manage cached API responses and cover art stored on this computer</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-3">
              <button
                onClick={() => showConfirm({
                  title: "Clear Metadata Cache",
                  message: "This clears all cached API responses (Audible, OpenAI, etc.) stored locally. The next scan will fetch fresh metadata from APIs. This does NOT affect AudiobookShelf. Continue?",
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
                className="w-full flex items-center justify-between px-4 py-3 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Trash2 className="w-5 h-5 text-red-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Clear Metadata Cache</div>
                    <div className="text-sm text-gray-600">Force fresh API lookups on next scan</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-red-600 transition-colors" />
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
                className="w-full flex items-center justify-between px-4 py-3 bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg transition-colors group disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <BarChart3 className="w-5 h-5 text-green-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">View Cache Statistics</div>
                    <div className="text-sm text-gray-600">See how many items are cached locally</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-green-600 transition-colors" />
              </button>
            </div>
          </div>

          {/* Info Card */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <div className="flex gap-3">
              <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-1">About Genre Management</p>
                <p>Genre operations in the "ABS Genre Management" section only affect metadata stored in AudiobookShelf. They do <strong>not</strong> modify the genre tags embedded in your audio files. To update file tags, use the "Write Tags" feature after scanning your library.</p>
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
