import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Upload, Settings as SettingsIcon, FileAudio, Zap, AlertCircle, ChevronDown, ChevronUp, Globe, Check, X, Plus, Trash2, RefreshCw } from 'lucide-react';
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
  const [customProviders, setCustomProviders] = useState([]);
  const [availableProviders, setAvailableProviders] = useState([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(null);
  const [testResult, setTestResult] = useState(null);

  // Load custom providers on mount
  useEffect(() => {
    loadProviders();
    loadAvailableProviders();
  }, []);

  const loadProviders = async () => {
    try {
      const providers = await invoke('get_custom_providers');
      setCustomProviders(providers);
    } catch (error) {
      console.error('Failed to load custom providers:', error);
    }
  };

  const loadAvailableProviders = async () => {
    try {
      const available = await invoke('get_available_providers');
      setAvailableProviders(available);
    } catch (error) {
      console.error('Failed to load available providers:', error);
    }
  };

  const toggleProvider = async (providerId, enabled) => {
    try {
      await invoke('toggle_provider', { providerId, enabled });
      await loadProviders();
    } catch (error) {
      alert('Failed to toggle provider: ' + error);
    }
  };

  const removeProvider = async (providerId) => {
    if (!confirm('Remove this provider?')) return;
    try {
      await invoke('remove_custom_provider', { providerId });
      await loadProviders();
    } catch (error) {
      alert('Failed to remove provider: ' + error);
    }
  };

  const addProvider = async (providerId) => {
    try {
      await invoke('add_abs_agg_provider', { providerId });
      await loadProviders();
      setShowAddProvider(false);
    } catch (error) {
      alert('Failed to add provider: ' + error);
    }
  };

  const resetProviders = async () => {
    if (!confirm('Reset all providers to defaults?')) return;
    try {
      await invoke('reset_providers_to_defaults');
      await loadProviders();
    } catch (error) {
      alert('Failed to reset providers: ' + error);
    }
  };

  // Provider-specific test queries (each provider has different content)
  const getTestQuery = (providerId) => {
    const queries = {
      'goodreads': { title: 'The Way of Kings', author: 'Sanderson' },
      'hardcover': { title: 'Mistborn', author: 'Sanderson' },
      'storytel/language:en': { title: 'The Martian', author: 'Weir' },
      'storytel/language:de': { title: 'Die Zwerge', author: 'Heitz' },
      'librivox': { title: 'Pride and Prejudice', author: 'Austen' }, // Public domain
      'ardaudiothek': { title: 'Krimi', author: '' },
      'audioteka/lang:pl': { title: 'Wiedzmin', author: 'Sapkowski' },
      'bigfinish': { title: 'Doctor Who', author: '' }, // Audio dramas
      'bookbeat/market:austria': { title: 'Thriller', author: '' },
      'graphicaudio': { title: 'Mistborn', author: 'Sanderson' }, // Full-cast productions
    };
    return queries[providerId] || { title: 'The Hobbit', author: 'Tolkien' };
  };

  const testProvider = async (provider) => {
    setTestingProvider(provider.provider_id);
    setTestResult(null);
    try {
      const query = getTestQuery(provider.provider_id);
      const result = await invoke('test_provider', {
        providerId: provider.provider_id,
        title: query.title,
        author: query.author
      });
      setTestResult({ success: !!result, provider: provider.provider_id, data: result });
    } catch (error) {
      setTestResult({ success: false, provider: provider.provider_id, error: error.toString() });
    }
    setTestingProvider(null);
  };

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

          {/* Custom Metadata Providers */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-orange-50 to-amber-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-orange-100 rounded-lg">
                    <Globe className="w-5 h-5 text-orange-600" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Custom Metadata Providers</h3>
                    <p className="text-sm text-gray-600">Goodreads, Hardcover, Storytel via abs-agg</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowAddProvider(!showAddProvider)}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-orange-100 text-orange-700 rounded-lg hover:bg-orange-200 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                  <button
                    onClick={resetProviders}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Reset
                  </button>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-4">
              {/* Add Provider Panel */}
              {showAddProvider && (
                <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg space-y-3">
                  <h4 className="font-medium text-gray-900">Add abs-agg Provider</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {availableProviders
                      .filter(ap => !customProviders.some(cp => cp.provider_id === ap.id))
                      .map(provider => (
                        <button
                          key={provider.id}
                          onClick={() => addProvider(provider.id)}
                          className="flex flex-col items-start p-3 bg-white border border-gray-200 rounded-lg hover:border-orange-400 hover:bg-orange-50 transition-colors text-left"
                        >
                          <span className="font-medium text-gray-900">{provider.name}</span>
                          <span className="text-xs text-gray-500">{provider.description}</span>
                        </button>
                      ))}
                  </div>
                  <button
                    onClick={() => setShowAddProvider(false)}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Provider List */}
              {customProviders.length === 0 ? (
                <p className="text-gray-500 text-center py-4">No custom providers configured. Click "Add" to add one.</p>
              ) : (
                <div className="space-y-2">
                  {customProviders.map(provider => (
                    <div
                      key={provider.provider_id}
                      className={`flex items-center justify-between p-4 rounded-lg border ${
                        provider.enabled ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => toggleProvider(provider.provider_id, !provider.enabled)}
                          className={`w-10 h-6 rounded-full transition-colors ${
                            provider.enabled ? 'bg-green-500' : 'bg-gray-300'
                          }`}
                        >
                          <div className={`w-4 h-4 bg-white rounded-full shadow transform transition-transform mx-1 ${
                            provider.enabled ? 'translate-x-4' : ''
                          }`} />
                        </button>
                        <div>
                          <div className="font-medium text-gray-900">{provider.name}</div>
                          <div className="text-xs text-gray-500">
                            {provider.base_url}/{provider.provider_id}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Priority Badge */}
                        <span className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded">
                          Priority: {provider.priority}
                        </span>

                        {/* Test Result */}
                        {testResult?.provider === provider.provider_id && (
                          <span className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
                            testResult.success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>
                            {testResult.success ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                            {testResult.success ? 'Works!' : 'Failed'}
                          </span>
                        )}

                        {/* Test Button */}
                        <button
                          onClick={() => testProvider(provider)}
                          disabled={testingProvider === provider.provider_id}
                          className="px-3 py-1.5 text-sm bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors disabled:opacity-50"
                        >
                          {testingProvider === provider.provider_id ? 'Testing...' : 'Test'}
                        </button>

                        {/* Remove Button */}
                        <button
                          onClick={() => removeProvider(provider.provider_id)}
                          className="p-1.5 text-red-500 hover:bg-red-100 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="text-xs text-gray-500 bg-gray-50 p-3 rounded-lg">
                <p className="font-medium text-gray-700 mb-1">How it works:</p>
                <p>Custom providers search additional sources (Goodreads, Hardcover, etc.) during scanning to fill in missing metadata like series info, descriptions, and genres. Enabled providers run in parallel with ABS for faster results.</p>
              </div>
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