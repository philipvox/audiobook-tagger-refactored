import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Upload, Settings as SettingsIcon, FileAudio, Zap, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useApp } from '../context/AppContext';

// Preset configurations
const PRESETS = {
  conservative: { label: 'Conservative', multiplier: 0.5, description: 'Lower resource usage, safer for older machines' },
  balanced: { label: 'Balanced', multiplier: 1.0, description: 'Default settings, API-friendly' },
  performance: { label: 'Performance', multiplier: 2.0, description: 'Faster processing for modern machines' },
  extreme: { label: 'Extreme', multiplier: 4.0, description: 'Maximum speed - hardcore mode' },
};

// Base values for balanced preset
const BASE_VALUES = {
  metadata: 15,
  super_scanner: 5,
  json_writes: 100,
  abs_push: 60,
  file_scan: 10,
};

// Get preset-derived value for an operation
const getPresetValue = (preset, operation) => {
  const multiplier = PRESETS[preset]?.multiplier || 1.0;
  return Math.max(1, Math.round(BASE_VALUES[operation] * multiplier));
};

export function SettingsPage() {
  const { config, saveConfig } = useApp();
  const [localConfig, setLocalConfig] = useState(config);
  const [showAdvanced, setShowAdvanced] = useState(false);

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
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="p-6">
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
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">API Token</label>
                <input
                  type="password"
                  value={localConfig.abs_api_token}
                  onChange={(e) => setLocalConfig({ ...localConfig, abs_api_token: e.target.value })}
                  placeholder="Enter API token"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Library ID</label>
                <input
                  type="text"
                  value={localConfig.abs_library_id}
                  onChange={(e) => setLocalConfig({ ...localConfig, abs_library_id: e.target.value })}
                  placeholder="lib_xxxxx"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              
              <div className="flex gap-3 pt-2">
                <button 
                  onClick={testConnection} 
                  className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                >
                  Test Connection
                </button>
                <button 
                  onClick={handleSave} 
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
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
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                />
              </div>
              
              <button 
                onClick={handleSave} 
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
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
                  <p className="text-sm text-gray-600">Performance and parallelism settings</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-4">
              {/* Performance Preset */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Performance Preset</label>
                <select
                  value={localConfig.performance_preset || 'balanced'}
                  onChange={(e) => setLocalConfig({
                    ...localConfig,
                    performance_preset: e.target.value,
                    // Clear overrides when changing preset
                    concurrency_metadata: null,
                    concurrency_super_scanner: null,
                    concurrency_json_writes: null,
                    concurrency_abs_push: null,
                    concurrency_file_scan: null,
                  })}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 bg-white"
                >
                  {Object.entries(PRESETS).map(([key, { label, description }]) => (
                    <option key={key} value={key}>{label} - {description}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Controls overall parallelism level. Higher = faster but more resource intensive.
                </p>
              </div>

              {/* Advanced Concurrency Controls */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <span className="font-medium text-gray-700">Advanced Concurrency Controls</span>
                  {showAdvanced ? <ChevronUp className="w-5 h-5 text-gray-500" /> : <ChevronDown className="w-5 h-5 text-gray-500" />}
                </button>

                {showAdvanced && (
                  <div className="p-4 space-y-4 border-t border-gray-200">
                    <p className="text-sm text-gray-600">
                      Override individual concurrency limits. Leave empty to use preset defaults.
                    </p>

                    {/* Concurrency Sliders */}
                    {[
                      { key: 'concurrency_metadata', label: 'Metadata Scanning', base: 'metadata', min: 1, max: 60, desc: 'API calls for metadata enrichment' },
                      { key: 'concurrency_super_scanner', label: 'Super Scanner', base: 'super_scanner', min: 1, max: 20, desc: 'Thorough scanning with AI' },
                      { key: 'concurrency_json_writes', label: 'JSON Writes', base: 'json_writes', min: 10, max: 200, desc: 'Writing metadata.json files' },
                      { key: 'concurrency_abs_push', label: 'ABS Push', base: 'abs_push', min: 10, max: 120, desc: 'Pushing to AudiobookShelf' },
                      { key: 'concurrency_file_scan', label: 'File Scanning', base: 'file_scan', min: 1, max: 40, desc: 'Directory scanning & cover fetching' },
                    ].map(({ key, label, base, min, max, desc }) => {
                      const presetDefault = getPresetValue(localConfig.performance_preset || 'balanced', base);
                      const currentValue = localConfig[key] ?? presetDefault;
                      const isOverridden = localConfig[key] != null;

                      return (
                        <div key={key} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-gray-700">{label}</label>
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                min={min}
                                max={max}
                                value={currentValue}
                                onChange={(e) => setLocalConfig({ ...localConfig, [key]: parseInt(e.target.value) || null })}
                                className={`w-20 px-2 py-1 text-sm border rounded focus:ring-2 focus:ring-green-500 focus:border-green-500 ${
                                  isOverridden ? 'border-green-400 bg-green-50' : 'border-gray-300'
                                }`}
                              />
                              {isOverridden && (
                                <button
                                  onClick={() => setLocalConfig({ ...localConfig, [key]: null })}
                                  className="text-xs text-gray-500 hover:text-gray-700"
                                  title="Reset to preset default"
                                >
                                  Reset
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center justify-between text-xs text-gray-500">
                            <span>{desc}</span>
                            <span>Preset: {presetDefault}</span>
                          </div>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            value={currentValue}
                            onChange={(e) => setLocalConfig({ ...localConfig, [key]: parseInt(e.target.value) })}
                            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-green-500"
                          />
                        </div>
                      );
                    })}

                    <button
                      onClick={() => setLocalConfig({
                        ...localConfig,
                        concurrency_metadata: null,
                        concurrency_super_scanner: null,
                        concurrency_json_writes: null,
                        concurrency_abs_push: null,
                        concurrency_file_scan: null,
                      })}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Reset All to Preset Defaults
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <input
                    type="checkbox"
                    checked={localConfig.backup_tags}
                    onChange={(e) => setLocalConfig({ ...localConfig, backup_tags: e.target.checked })}
                    className="w-5 h-5 text-green-600 rounded focus:ring-green-500"
                  />
                  <label className="flex-1 cursor-pointer">
                    <div className="font-medium text-gray-900">Backup Original Tags</div>
                    <div className="text-sm text-gray-600">Create .backup files before writing</div>
                  </label>
                </div>

                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <input
                    type="checkbox"
                    checked={localConfig.genre_enforcement}
                    onChange={(e) => setLocalConfig({ ...localConfig, genre_enforcement: e.target.checked })}
                    className="w-5 h-5 text-green-600 rounded focus:ring-green-500"
                  />
                  <label className="flex-1 cursor-pointer">
                    <div className="font-medium text-gray-900">Enforce Approved Genres</div>
                    <div className="text-sm text-gray-600">Map genres to curated list</div>
                  </label>
                </div>
              </div>

              <button
                onClick={handleSave}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}