// SettingsPage.jsx - Simplified version
// You can expand this by copying the full SettingsTab from original App.jsx

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Upload, Settings as SettingsIcon, FileAudio, Zap, AlertCircle } from 'lucide-react';
import { useApp } from '../context/AppContext';

export function SettingsPage() {
  const { config, saveConfig } = useApp();
  const [localConfig, setLocalConfig] = useState(config);

  const handleSave = async () => {
    const result = await saveConfig(localConfig);
    if (result.success) {
      alert('Settings saved!');
    } else {
      alert('Failed to save: ' + result.error);
    }
  };

  const testConnection = async () => {
    try {
      const result = await invoke('test_abs_connection', { config: localConfig });
      alert(result.message);
    } catch (error) {
      alert('Connection failed: ' + error);
    }
  };

  return (
    <div className="p-6 overflow-y-auto bg-gray-50">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Application Settings</h2>
          <p className="text-gray-600">
            Configure connections, API keys, and processing options.
          </p>
        </div>

        {/* AudiobookShelf Connection */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Upload className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">AudiobookShelf Connection</h3>
                <p className="text-sm text-gray-600">Connect to your server</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Base URL</label>
              <input
                type="text"
                value={localConfig.abs_base_url}
                onChange={(e) => setLocalConfig({ ...localConfig, abs_base_url: e.target.value })}
                placeholder="http://localhost:13378"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">API Token</label>
              <input
                type="password"
                value={localConfig.abs_api_token}
                onChange={(e) => setLocalConfig({ ...localConfig, abs_api_token: e.target.value })}
                placeholder="Enter API token"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Library ID</label>
              <input
                type="text"
                value={localConfig.abs_library_id}
                onChange={(e) => setLocalConfig({ ...localConfig, abs_library_id: e.target.value })}
                placeholder="lib_xxxxx"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
            
            <div className="flex gap-3 pt-2">
              <button onClick={testConnection} className="btn btn-secondary">
                Test Connection
              </button>
              <button onClick={handleSave} className="btn btn-primary">
                Save Settings
              </button>
            </div>
          </div>
        </div>

        {/* API Keys */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-purple-50 to-pink-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <SettingsIcon className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">API Keys</h3>
                <p className="text-sm text-gray-600">External service credentials</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">OpenAI API Key</label>
              <input
                type="password"
                value={localConfig.openai_api_key || ''}
                onChange={(e) => setLocalConfig({ ...localConfig, openai_api_key: e.target.value })}
                placeholder="sk-..."
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Google Books API Key</label>
              <input
                type="password"
                value={localConfig.google_books_api_key || ''}
                onChange={(e) => setLocalConfig({ ...localConfig, google_books_api_key: e.target.value })}
                placeholder="AIza..."
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
              />
            </div>
            
            <button onClick={handleSave} className="btn btn-primary">
              Save Settings
            </button>
          </div>
        </div>

        {/* Processing Options */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Zap className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Processing Options</h3>
                <p className="text-sm text-gray-600">Performance settings</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Parallel Workers</label>
              <input
                type="number"
                min="1"
                max="50"
                value={localConfig.max_workers || 10}
                onChange={(e) => setLocalConfig({ ...localConfig, max_workers: parseInt(e.target.value) })}
                className="w-32 px-4 py-2.5 border border-gray-300 rounded-lg"
              />
              <p className="text-xs text-gray-500 mt-1">Recommended: 20-30 for M4 Mac</p>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                <input 
                  type="checkbox" 
                  checked={localConfig.backup_tags} 
                  onChange={(e) => setLocalConfig({ ...localConfig, backup_tags: e.target.checked })}
                  className="w-5 h-5 text-green-600 rounded"
                />
                <label className="flex-1">
                  <div className="font-medium text-gray-900">Backup Original Tags</div>
                  <div className="text-sm text-gray-600">Create .backup files</div>
                </label>
              </div>

              <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                <input 
                  type="checkbox" 
                  checked={localConfig.genre_enforcement} 
                  onChange={(e) => setLocalConfig({ ...localConfig, genre_enforcement: e.target.checked })}
                  className="w-5 h-5 text-green-600 rounded"
                />
                <label className="flex-1">
                  <div className="font-medium text-gray-900">Enforce Approved Genres</div>
                  <div className="text-sm text-gray-600">Map to curated list</div>
                </label>
              </div>
            </div>

            <button onClick={handleSave} className="btn btn-primary">
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
