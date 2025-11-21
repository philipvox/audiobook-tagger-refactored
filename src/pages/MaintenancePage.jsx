import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Upload, RefreshCw, Book, Wrench, Folder, AlertCircle, ChevronRight } from 'lucide-react';
import { ConfirmModal } from '../components/ConfirmModal';

export function MaintenancePage() {
  const [confirmModal, setConfirmModal] = useState(null);

  const showConfirm = (config) => {
    setConfirmModal(config);
  };

  const hideConfirm = () => {
    setConfirmModal(null);
  };

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Library Maintenance</h2>
            <p className="text-gray-600">
              Advanced maintenance features for AudiobookShelf and local library management.
            </p>
          </div>

          {/* AudiobookShelf Server Section */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Upload className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">AudiobookShelf Server</h3>
                  <p className="text-sm text-gray-600">Manage your AudiobookShelf Docker container</p>
                </div>
              </div>
            </div>
            
            <div className="p-6 space-y-3">
              <button 
                onClick={() => showConfirm({
                  title: "Restart Docker Container",
                  message: "This will temporarily stop the AudiobookShelf server. Continue?",
                  confirmText: "Restart",
                  type: "warning",
                  onConfirm: async () => {
                    try {
                      await invoke('restart_abs_docker');
                      alert('✅ Container restarted!');
                    } catch (error) {
                      alert('❌ Failed: ' + error);
                    }
                  }
                })}
                className="w-full flex items-center justify-between px-4 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <RefreshCw className="w-5 h-5 text-blue-600" />
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
                  message: "Scan all library folders for changes. Continue?",
                  confirmText: "Start Rescan",
                  type: "info",
                  onConfirm: async () => {
                    try {
                      await invoke('force_abs_rescan');
                      alert('✅ Rescan triggered!');
                    } catch (error) {
                      alert('❌ Failed: ' + error);
                    }
                  }
                })}
                className="w-full flex items-center justify-between px-4 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <Book className="w-5 h-5 text-blue-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Force Library Rescan</div>
                    <div className="text-sm text-gray-600">Refresh all books</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
              </button>

              <button 
                onClick={async () => {
                  try {
                    await invoke('clear_abs_library_cache');
                    alert('✅ Library cache cleared! Next push will fetch fresh data.');
                  } catch (error) {
                    alert('❌ Failed to clear cache: ' + error);
                  }
                }}
                className="w-full flex items-center justify-between px-4 py-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <RefreshCw className="w-5 h-5 text-purple-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Clear Library Cache</div>
                    <div className="text-sm text-gray-600">Force fresh library fetch on next push</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-purple-600 transition-colors" />
              </button>
            </div>
          </div>

          {/* Genre Management */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-purple-50 to-pink-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <Folder className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Genre Management</h3>
                  <p className="text-sm text-gray-600">Clean up genre tags</p>
                </div>
              </div>
            </div>
            
            <div className="p-6 space-y-3">
              <button 
                onClick={() => showConfirm({
                  title: "Clear Unused Genres",
                  message: "Remove genres not assigned to any books. Continue?",
                  confirmText: "Clear Genres",
                  type: "danger",
                  onConfirm: async () => {
                    try {
                      const result = await invoke('clear_all_genres');
                      alert('✅ ' + result);
                    } catch (error) {
                      alert('❌ Failed: ' + error);
                    }
                  }
                })}
                className="w-full flex items-center justify-between px-4 py-3 bg-yellow-50 hover:bg-yellow-100 border border-yellow-200 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-yellow-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Clear Unused Genres</div>
                    <div className="text-sm text-gray-600">Remove unused entries</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-yellow-600 transition-colors" />
              </button>

              <button 
                onClick={() => showConfirm({
                  title: "Normalize Book Genres",
                  message: "Map all genres to approved list. Continue?",
                  confirmText: "Normalize Genres",
                  type: "warning",
                  onConfirm: async () => {
                    try {
                      const result = await invoke('normalize_genres');
                      alert('✅ ' + result);
                    } catch (error) {
                      alert('❌ Failed: ' + error);
                    }
                  }
                })}
                className="w-full flex items-center justify-between px-4 py-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <Book className="w-5 h-5 text-purple-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Normalize Book Genres</div>
                    <div className="text-sm text-gray-600">Map to approved list</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-purple-600 transition-colors" />
              </button>
            </div>
          </div>

          {/* Local Library */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-green-50 to-emerald-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Book className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Local Library</h3>
                  <p className="text-sm text-gray-600">Manage local cache</p>
                </div>
              </div>
            </div>
            
            <div className="p-6">
              <button 
                onClick={() => showConfirm({
                  title: "Clear Metadata Cache",
                  message: "Force fresh API lookups on next scan. Continue?",
                  confirmText: "Clear Cache",
                  type: "danger",
                  onConfirm: async () => {
                    try {
                      await invoke('clear_cache');
                      alert('✅ Cache cleared!');
                    } catch (error) {
                      alert('❌ Failed: ' + error);
                    }
                  }
                })}
                className="w-full flex items-center justify-between px-4 py-3 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-red-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">Clear Metadata Cache</div>
                    <div className="text-sm text-gray-600">Force fresh lookups</div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-red-600 transition-colors" />
              </button>
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