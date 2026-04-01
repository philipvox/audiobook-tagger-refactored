import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChevronDown, Check, X, Plus, Trash2, Download, Cpu, Power, AlertCircle, HardDrive } from 'lucide-react';
import { useApp } from '../context/AppContext';

const PRESETS = {
  conservative: { label: 'Conservative', multiplier: 0.5 },
  balanced: { label: 'Balanced', multiplier: 1.0 },
  performance: { label: 'Performance', multiplier: 2.0 },
  extreme: { label: 'Extreme', multiplier: 4.0 },
};

const BASE_VALUES = { metadata: 15, super_scanner: 5, json_writes: 100, abs_push: 60, file_scan: 10 };
const getPresetValue = (preset, op) => Math.max(1, Math.round(BASE_VALUES[op] * (PRESETS[preset]?.multiplier || 1.0)));

// Pricing in USD per 1M tokens [input, output]
const TOKENS_PER_BOOK_INPUT = 2000;
const TOKENS_PER_BOOK_OUTPUT = 1000;

const AI_MODELS = [
  { id: 'gpt-5.4-nano',        label: 'GPT-5.4 Nano (Recommended)',   inputPrice: 0.20,  outputPrice: 1.25,  desc: 'Best for structured extraction. Newest knowledge (Aug 2025).' },
  { id: 'gpt-5-nano',          label: 'GPT-5 Nano',                   inputPrice: 0.05,  outputPrice: 0.40,  desc: 'Cheapest option. Slightly older knowledge (Apr 2025).' },
  { id: 'gpt-5.4-mini',        label: 'GPT-5.4 Mini',                 inputPrice: 0.75,  outputPrice: 4.50,  desc: 'Higher quality. Use for difficult or ambiguous metadata.' },
  { id: 'gpt-4o-mini',         label: 'GPT-4o Mini (Legacy)',          inputPrice: 0.15,  outputPrice: 0.60,  desc: 'Older model (Oct 2023 knowledge). Being phased out.' },
  { id: 'gpt-4o',              label: 'GPT-4o',                       inputPrice: 2.50,  outputPrice: 10.00, desc: 'Premium quality but expensive. For edge cases only.' },
];

const estimateCost = (model, bookCount) => {
  if (!model || !bookCount) return null;
  const inputCost = (TOKENS_PER_BOOK_INPUT * bookCount / 1_000_000) * model.inputPrice;
  const outputCost = (TOKENS_PER_BOOK_OUTPUT * bookCount / 1_000_000) * model.outputPrice;
  return inputCost + outputCost;
};

const formatCost = (dollars) => {
  if (dollars < 0.01) return 'less than $0.01';
  if (dollars < 1) return `~$${dollars.toFixed(2)}`;
  return `~$${dollars.toFixed(2)}`;
};

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
};

export function SettingsPage() {
  const { config, saveConfig } = useApp();
  const [localConfig, setLocalConfig] = useState(config);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [customProviders, setCustomProviders] = useState([]);
  const [availableProviders, setAvailableProviders] = useState([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [libraryBookCount, setLibraryBookCount] = useState(0);
  const [cacheCleared, setCacheCleared] = useState(false);

  // Local AI state
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [modelPresets, setModelPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('qwen3:4b');
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState(null);
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState(null);
  const [ollamaError, setOllamaError] = useState(null);
  const [diskUsage, setDiskUsage] = useState(0);
  const [showCloudAi, setShowCloudAi] = useState(false);

  const installListenerRef = useRef(null);
  const pullListenerRef = useRef(null);

  useEffect(() => {
    loadProviders();
    loadAvailableProviders();
    loadOllamaStatus();
    loadModelPresets();
    invoke('get_abs_cache_status').then(status => {
      if (status?.stats?.total_items) setLibraryBookCount(status.stats.total_items);
    }).catch(() => {});

    // Set up event listeners for Ollama progress
    listen('ollama-install-progress', (event) => {
      setInstallProgress(event.payload);
    }).then(unlisten => { installListenerRef.current = unlisten; });

    listen('ollama-pull-progress', (event) => {
      setPullProgress(event.payload);
    }).then(unlisten => { pullListenerRef.current = unlisten; });

    return () => {
      if (installListenerRef.current) installListenerRef.current();
      if (pullListenerRef.current) pullListenerRef.current();
    };
  }, []);

  // Show cloud AI section when not using local AI and has API key
  useEffect(() => {
    if (localConfig.use_local_ai === false && localConfig.openai_api_key) {
      setShowCloudAi(true);
    }
  }, []);

  const loadOllamaStatus = async () => {
    try {
      const status = await invoke('ollama_get_status');
      setOllamaStatus(status);
      if (status.active_model) setSelectedPreset(status.active_model);
      // Also load disk usage
      const usage = await invoke('ollama_get_disk_usage');
      setDiskUsage(usage);
    } catch (e) {
      console.error('Failed to load Ollama status:', e);
    }
  };

  const loadModelPresets = async () => {
    try {
      const presets = await invoke('ollama_get_model_presets');
      setModelPresets(presets);
    } catch (e) { console.error(e); }
  };

  const handleInstallOllama = async () => {
    setInstalling(true);
    setOllamaError(null);
    setInstallProgress({ status: 'Starting download...', percent: 0 });
    try {
      await invoke('ollama_install');
      // After install, start it and pull the selected model
      setInstallProgress({ status: 'Starting Ollama...', percent: 100 });
      await invoke('ollama_start');
      await handlePullModel(selectedPreset);
      await loadOllamaStatus();
    } catch (e) {
      setOllamaError(typeof e === 'string' ? e : e.message || 'Install failed');
    } finally {
      setInstalling(false);
      setInstallProgress(null);
    }
  };

  const handlePullModel = async (modelName) => {
    setPulling(true);
    setOllamaError(null);
    setPullProgress({ status: 'Starting download...', percent: 0 });
    try {
      await invoke('ollama_pull_model', { modelName });
      // Update config to use this model
      const newConfig = { ...localConfig, use_local_ai: true, ollama_model: modelName, ai_model: modelName, ai_base_url: 'http://127.0.0.1:11434' };
      setLocalConfig(newConfig);
      await saveConfig(newConfig);
      await loadOllamaStatus();
    } catch (e) {
      setOllamaError(typeof e === 'string' ? e : e.message || 'Pull failed');
    } finally {
      setPulling(false);
      setPullProgress(null);
    }
  };

  const handleDeleteModel = async (modelName) => {
    if (!confirm(`Delete model "${modelName}"? This will free disk space.`)) return;
    try {
      await invoke('ollama_delete_model', { modelName });
      await loadOllamaStatus();
    } catch (e) {
      setOllamaError(typeof e === 'string' ? e : e.message || 'Delete failed');
    }
  };

  const handleUninstallOllama = async () => {
    if (!confirm('Remove Local AI? This will delete the Ollama binary and all downloaded models, freeing disk space.')) return;
    try {
      await invoke('ollama_uninstall');
      // Revert config
      const newConfig = { ...localConfig, use_local_ai: false, ollama_model: null, ai_base_url: 'https://api.openai.com', ai_model: 'gpt-5.4-nano' };
      setLocalConfig(newConfig);
      await saveConfig(newConfig);
      await loadOllamaStatus();
      setDiskUsage(0);
    } catch (e) {
      setOllamaError(typeof e === 'string' ? e : e.message || 'Uninstall failed');
    }
  };

  const handleToggleOllama = async () => {
    if (!ollamaStatus) return;
    try {
      if (ollamaStatus.running) {
        await invoke('ollama_stop');
      } else {
        await invoke('ollama_start');
      }
      await loadOllamaStatus();
    } catch (e) {
      setOllamaError(typeof e === 'string' ? e : e.message);
    }
  };

  const handleSwitchModel = async (modelId) => {
    setSelectedPreset(modelId);
    // Check if already installed
    const installed = ollamaStatus?.models?.some(m => m.name === modelId || m.name.startsWith(modelId.split(':')[0]));
    if (installed) {
      // Just update config
      const newConfig = { ...localConfig, use_local_ai: true, ollama_model: modelId, ai_model: modelId, ai_base_url: 'http://127.0.0.1:11434' };
      setLocalConfig(newConfig);
      await saveConfig(newConfig);
      await loadOllamaStatus();
    } else {
      // Need to pull first
      await handlePullModel(modelId);
    }
  };

  const loadProviders = async () => {
    try { setCustomProviders(await invoke('get_custom_providers')); } catch (e) { console.error(e); }
  };

  const loadAvailableProviders = async () => {
    try { setAvailableProviders(await invoke('get_available_providers')); } catch (e) { console.error(e); }
  };

  const toggleProvider = async (id, enabled) => {
    try { await invoke('toggle_provider', { providerId: id, enabled }); await loadProviders(); } catch (e) { alert(e); }
  };

  const removeProvider = async (id) => {
    if (!confirm('Remove?')) return;
    try { await invoke('remove_custom_provider', { providerId: id }); await loadProviders(); } catch (e) { alert(e); }
  };

  const addProvider = async (id) => {
    try { await invoke('add_abs_agg_provider', { providerId: id }); await loadProviders(); setShowAddProvider(false); } catch (e) { alert(e); }
  };

  const testProvider = async (provider) => {
    setTestingProvider(provider.provider_id);
    setTestResult(null);
    const queries = {
      'goodreads': { title: 'The Way of Kings', author: 'Sanderson' },
      'hardcover': { title: 'Mistborn', author: 'Sanderson' },
    };
    const q = queries[provider.provider_id] || { title: 'The Hobbit', author: 'Tolkien' };
    try {
      const result = await invoke('test_provider', { providerId: provider.provider_id, title: q.title, author: q.author });
      setTestResult({ success: !!result, provider: provider.provider_id });
    } catch (e) {
      setTestResult({ success: false, provider: provider.provider_id });
    }
    setTestingProvider(null);
  };

  const handleSave = async () => {
    setSaving(true);
    const result = await saveConfig(localConfig);
    setSaving(false);
    if (!result.success) alert('Failed: ' + result.error);
  };

  const testConnection = async () => {
    try {
      const result = await invoke('test_abs_connection', { config: localConfig });
      alert(result.message);
    } catch (e) { alert('Failed: ' + e); }
  };

  const Input = ({ label, type = 'text', value, onChange, placeholder }) => (
    <div>
      <label className="block text-xs text-gray-500 mb-1.5">{label}</label>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-neutral-700"
      />
    </div>
  );

  const Toggle = ({ checked, onChange, label }) => (
    <label className="flex items-center gap-3 cursor-pointer py-1.5">
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`w-8 h-5 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-blue-600' : 'bg-neutral-700'}`}
      >
        <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform mx-0.5 ${checked ? 'translate-x-3' : ''}`} />
      </button>
      <span className="text-sm text-gray-300">{label}</span>
    </label>
  );

  // Progress bar component
  const ProgressBar = ({ progress, label }) => {
    const percent = progress?.percent ?? 0;
    const status = progress?.status || label || '';
    return (
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="text-gray-400 truncate">{status}</span>
          {percent > 0 && <span className="text-gray-500 tabular-nums">{Math.round(percent)}%</span>}
        </div>
        <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
        {progress?.total && progress?.completed && (
          <div className="text-[10px] text-gray-600">
            {formatBytes(progress.completed)} / {formatBytes(progress.total)}
          </div>
        )}
      </div>
    );
  };

  const isLocalAiActive = ollamaStatus?.installed && ollamaStatus?.running && ollamaStatus?.models?.length > 0;

  return (
    <div className="h-full overflow-y-auto bg-neutral-950 p-6">
      <div className="max-w-4xl mx-auto">

        {/* Two column grid for main settings */}
        <div className="grid grid-cols-2 gap-6 mb-6">

          {/* Left: Connection */}
          <div className="bg-neutral-900/50 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-medium text-white mb-4">AudiobookShelf</h3>
            <Input
              label="Server URL"
              value={localConfig.abs_base_url}
              onChange={(v) => setLocalConfig({ ...localConfig, abs_base_url: v })}
              placeholder="http://localhost:13378"
            />
            <Input
              label="API Token"
              type="password"
              value={localConfig.abs_api_token}
              onChange={(v) => setLocalConfig({ ...localConfig, abs_api_token: v })}
              placeholder="Enter token"
            />
            <Input
              label="Library ID"
              value={localConfig.abs_library_id}
              onChange={(v) => setLocalConfig({ ...localConfig, abs_library_id: v })}
              placeholder="lib_xxxxx"
            />
            <button
              onClick={testConnection}
              className="text-xs text-gray-500 hover:text-white transition-colors"
            >
              Test connection
            </button>
          </div>

          {/* Right: AI & Processing */}
          <div className="space-y-6">

            {/* ══════════════════════════════════════════════════════ */}
            {/* LOCAL AI SECTION                                       */}
            {/* ══════════════════════════════════════════════════════ */}
            <div className="bg-neutral-900/50 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-blue-400" />
                  <h3 className="text-sm font-medium text-white">Local AI</h3>
                </div>
                {ollamaStatus?.running && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-[10px] text-green-400">Running</span>
                  </div>
                )}
                {ollamaStatus?.installed && !ollamaStatus?.running && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-yellow-400" />
                    <span className="text-[10px] text-yellow-400">Stopped</span>
                  </div>
                )}
              </div>

              {/* Error display */}
              {ollamaError && (
                <div className="mb-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                  <div className="text-xs text-red-300">{ollamaError}</div>
                  <button onClick={() => setOllamaError(null)} className="text-red-400 hover:text-red-300 ml-auto flex-shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}

              {/* Not installed state */}
              {!ollamaStatus?.installed && !installing && (
                <div className="space-y-3">
                  <p className="text-xs text-gray-400">
                    Run AI locally on your machine. No API key needed, no usage costs, complete privacy.
                  </p>

                  {/* Model picker for initial install */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1.5">Choose a model</label>
                    <div className="space-y-1.5">
                      {modelPresets.map(preset => (
                        <button
                          key={preset.id}
                          onClick={() => setSelectedPreset(preset.id)}
                          className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors border ${
                            selectedPreset === preset.id
                              ? 'border-blue-500/50 bg-blue-500/10 text-white'
                              : 'border-neutral-800 bg-neutral-800/50 text-gray-400 hover:text-white hover:border-neutral-700'
                          }`}
                        >
                          <div className="flex justify-between items-center">
                            <span className="font-medium">{preset.label}</span>
                            <span className="text-gray-500">{preset.size_gb} GB</span>
                          </div>
                          <div className="text-[10px] text-gray-500 mt-0.5">
                            {preset.description} Requires {preset.ram_gb}GB+ RAM.
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={handleInstallOllama}
                    className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 transition-colors flex items-center justify-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    Install Local AI
                  </button>
                  <p className="text-[10px] text-gray-600 text-center">
                    Downloads Ollama (~50 MB) + {modelPresets.find(p => p.id === selectedPreset)?.label || 'model'} (~{modelPresets.find(p => p.id === selectedPreset)?.size_gb || '?'} GB)
                  </p>
                </div>
              )}

              {/* Installing / downloading progress */}
              {installing && installProgress && (
                <div className="space-y-3">
                  <ProgressBar progress={installProgress} label="Installing Ollama..." />
                  <button
                    onClick={() => invoke('ollama_cancel_install')}
                    className="w-full py-2 text-xs text-gray-400 hover:text-white bg-neutral-800 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Pulling model progress */}
              {pulling && pullProgress && (
                <div className="space-y-2">
                  <ProgressBar progress={pullProgress} label="Downloading model..." />
                </div>
              )}

              {/* Installed state */}
              {ollamaStatus?.installed && !installing && !pulling && (
                <div className="space-y-3">
                  {/* Active model & status */}
                  {ollamaStatus.models?.length > 0 && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1.5">Active Model</label>
                      <select
                        value={selectedPreset}
                        onChange={(e) => handleSwitchModel(e.target.value)}
                        className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                      >
                        {/* Show installed models first */}
                        {ollamaStatus.models.map(m => (
                          <option key={m.name} value={m.name}>
                            {m.name} ({formatBytes(m.size_bytes)})
                          </option>
                        ))}
                        {/* Show uninstalled presets */}
                        <optgroup label="Download new model">
                          {modelPresets
                            .filter(p => !ollamaStatus.models.some(m => m.name === p.id))
                            .map(p => (
                              <option key={p.id} value={p.id}>
                                {p.label} (~{p.size_gb} GB download)
                              </option>
                            ))}
                        </optgroup>
                      </select>
                    </div>
                  )}

                  {/* No models installed yet */}
                  {ollamaStatus.models?.length === 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-gray-400">Ollama installed but no models downloaded yet.</p>
                      <select
                        value={selectedPreset}
                        onChange={(e) => setSelectedPreset(e.target.value)}
                        className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                      >
                        {modelPresets.map(p => (
                          <option key={p.id} value={p.id}>{p.label} (~{p.size_gb} GB)</option>
                        ))}
                      </select>
                      <button
                        onClick={() => handlePullModel(selectedPreset)}
                        className="w-full py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download Model
                      </button>
                    </div>
                  )}

                  {/* Installed models list with delete */}
                  {ollamaStatus.models?.length > 1 && (
                    <div className="pt-2 border-t border-neutral-800">
                      <span className="text-[10px] text-gray-600">Installed models:</span>
                      <div className="mt-1 space-y-1">
                        {ollamaStatus.models.map(m => (
                          <div key={m.name} className="flex items-center justify-between text-xs">
                            <span className="text-gray-400">{m.name}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-gray-600">{formatBytes(m.size_bytes)}</span>
                              <button
                                onClick={() => handleDeleteModel(m.name)}
                                className="text-gray-600 hover:text-red-400 transition-colors"
                                title="Delete model"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Controls row */}
                  <div className="flex items-center gap-2 pt-1">
                    {/* Start/Stop */}
                    <button
                      onClick={handleToggleOllama}
                      className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                        ollamaStatus.running
                          ? 'bg-neutral-800 text-gray-300 hover:bg-neutral-700'
                          : 'bg-green-600/20 text-green-400 hover:bg-green-600/30'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                      {ollamaStatus.running ? 'Stop' : 'Start'}
                    </button>

                    {/* Remove */}
                    <button
                      onClick={handleUninstallOllama}
                      className="flex-1 py-2 text-xs font-medium rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors flex items-center justify-center gap-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove Local AI
                    </button>
                  </div>

                  {/* Disk usage */}
                  {diskUsage > 0 && (
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-600">
                      <HardDrive className="w-3 h-3" />
                      Using {formatBytes(diskUsage)} on disk
                      {ollamaStatus.version && <span> &middot; Ollama v{ollamaStatus.version}</span>}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ══════════════════════════════════════════════════════ */}
            {/* CLOUD AI SECTION (collapsible)                         */}
            {/* ══════════════════════════════════════════════════════ */}
            <div className="bg-neutral-900/50 rounded-xl overflow-hidden">
              <button
                onClick={() => setShowCloudAi(!showCloudAi)}
                className="w-full px-5 py-3 flex items-center justify-between text-sm text-gray-400 hover:text-white transition-colors"
              >
                <span>Cloud AI (OpenAI)</span>
                <div className="flex items-center gap-2">
                  {localConfig.openai_api_key && !localConfig.use_local_ai && (
                    <span className="text-[10px] text-green-400">Active</span>
                  )}
                  <ChevronDown className={`w-4 h-4 transition-transform ${showCloudAi ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {showCloudAi && (
                <div className="px-5 pb-4 space-y-3">
                  {isLocalAiActive && (
                    <p className="text-[10px] text-gray-600 bg-neutral-800/50 rounded px-2 py-1.5">
                      Local AI is active. Cloud AI settings are saved but not used while Local AI is running.
                    </p>
                  )}
                  <Input
                    label="API Key"
                    type="password"
                    value={localConfig.openai_api_key}
                    onChange={(v) => setLocalConfig({ ...localConfig, openai_api_key: v })}
                    placeholder="sk-..."
                  />
                  <Input
                    label="API Endpoint"
                    value={localConfig.use_local_ai ? 'http://127.0.0.1:11434' : (localConfig.ai_base_url || 'https://api.openai.com')}
                    onChange={(v) => setLocalConfig({ ...localConfig, ai_base_url: v })}
                    placeholder="https://api.openai.com"
                  />
                  <p className="text-[10px] text-gray-600">OpenAI, or any compatible endpoint (LM Studio: http://localhost:1234)</p>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1.5">AI Model</label>
                    <select
                      value={localConfig.use_local_ai ? 'local' : (localConfig.ai_model || 'gpt-5.4-nano')}
                      onChange={(e) => {
                        if (e.target.value !== 'local') {
                          setLocalConfig({ ...localConfig, ai_model: e.target.value, use_local_ai: false });
                        }
                      }}
                      className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                      disabled={localConfig.use_local_ai}
                    >
                      {localConfig.use_local_ai && (
                        <option value="local">Using Local AI</option>
                      )}
                      {AI_MODELS.map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                    {!localConfig.use_local_ai && (() => {
                      const m = AI_MODELS.find(m => m.id === (localConfig.ai_model || 'gpt-5.4-nano'));
                      if (!m) return null;
                      const perBook = estimateCost(m, 1);
                      const libSize = libraryBookCount;
                      const libEstimate = libSize > 0 ? estimateCost(m, libSize) : null;
                      return (
                        <div className="mt-2 text-xs space-y-1">
                          <div className="text-gray-500">
                            <span className="text-gray-400">${m.inputPrice.toFixed(2)} / ${m.outputPrice.toFixed(2)}</span> per 1M tokens (input/output)
                          </div>
                          <div className="text-gray-500">
                            Per book: <span className="text-gray-400">{formatCost(perBook)}</span>
                            {libEstimate !== null && (
                              <span> &middot; Your library ({libSize} books): <span className="text-green-400">{formatCost(libEstimate)}</span></span>
                            )}
                          </div>
                          <div className="text-gray-600">{m.desc}</div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* Processing */}
            <div className="bg-neutral-900/50 rounded-xl p-5">
              <h3 className="text-sm font-medium text-white mb-4">Processing</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Performance</label>
                  <select
                    value={localConfig.performance_preset || 'balanced'}
                    onChange={(e) => setLocalConfig({ ...localConfig, performance_preset: e.target.value })}
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                  >
                    {Object.entries(PRESETS).map(([k, { label }]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                  </select>
                </div>
                <Toggle
                  checked={localConfig.backup_tags}
                  onChange={(v) => setLocalConfig({ ...localConfig, backup_tags: v })}
                  label="Backup tags"
                />
                <Toggle
                  checked={localConfig.genre_enforcement}
                  onChange={(v) => setLocalConfig({ ...localConfig, genre_enforcement: v })}
                  label="Enforce genres"
                />
              </div>

              {/* Cache */}
              <div className="mt-4 pt-4 border-t border-neutral-800">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-gray-500">AI Response Cache</span>
                    <p className="text-[10px] text-gray-600 mt-0.5">Cached AI responses. Clear to force fresh results.</p>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        await invoke('clear_cache');
                        setCacheCleared(true);
                        setTimeout(() => setCacheCleared(false), 3000);
                      } catch (e) {}
                    }}
                    className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                      cacheCleared
                        ? 'bg-green-600/20 text-green-400'
                        : 'bg-neutral-800 hover:bg-neutral-700 text-gray-400'
                    }`}
                  >
                    {cacheCleared ? 'Cleared' : 'Clear Cache'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Collapsible sections */}
        <div className="space-y-2 mb-6">
          {/* Providers */}
          <div className="bg-neutral-900/50 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowProviders(!showProviders)}
              className="w-full px-5 py-3 flex items-center justify-between text-sm text-gray-400 hover:text-white transition-colors"
            >
              <span>Metadata Providers</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600">{customProviders.filter(p => p.enabled).length} active</span>
                <ChevronDown className={`w-4 h-4 transition-transform ${showProviders ? 'rotate-180' : ''}`} />
              </div>
            </button>

            {showProviders && (
              <div className="px-5 pb-4 space-y-2">
                {customProviders.map(provider => (
                  <div key={provider.provider_id} className="flex items-center justify-between py-2">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <button
                        onClick={() => toggleProvider(provider.provider_id, !provider.enabled)}
                        className={`w-8 h-5 rounded-full transition-colors ${provider.enabled ? 'bg-blue-600' : 'bg-neutral-700'}`}
                      >
                        <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform mx-0.5 ${provider.enabled ? 'translate-x-3' : ''}`} />
                      </button>
                      <span className={`text-sm ${provider.enabled ? 'text-white' : 'text-gray-500'}`}>{provider.name}</span>
                    </label>
                    <div className="flex items-center gap-1">
                      {testResult?.provider === provider.provider_id && (
                        <span className={testResult.success ? 'text-green-400' : 'text-red-400'}>
                          {testResult.success ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                        </span>
                      )}
                      <button onClick={() => testProvider(provider)} className="px-2 py-1 text-xs text-gray-600 hover:text-white">
                        {testingProvider === provider.provider_id ? '...' : 'Test'}
                      </button>
                      <button onClick={() => removeProvider(provider.provider_id)} className="p-1 text-gray-600 hover:text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}

                {showAddProvider ? (
                  <div className="pt-2 space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      {availableProviders.filter(ap => !customProviders.some(cp => cp.provider_id === ap.id)).map(p => (
                        <button
                          key={p.id}
                          onClick={() => addProvider(p.id)}
                          className="px-3 py-2 text-xs text-left bg-neutral-800 rounded-lg hover:bg-neutral-700 text-gray-300"
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setShowAddProvider(false)} className="text-xs text-gray-600">Cancel</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAddProvider(true)}
                    className="flex items-center gap-1 text-xs text-gray-600 hover:text-white pt-2"
                  >
                    <Plus className="w-3 h-3" /> Add provider
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Advanced */}
          <div className="bg-neutral-900/50 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full px-5 py-3 flex items-center justify-between text-sm text-gray-400 hover:text-white transition-colors"
            >
              <span>Advanced Settings</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            </button>

            {showAdvanced && (
              <div className="px-5 pb-4 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { key: 'concurrency_metadata', label: 'Metadata', base: 'metadata', max: 60 },
                    { key: 'concurrency_super_scanner', label: 'Scanner', base: 'super_scanner', max: 20 },
                    { key: 'concurrency_json_writes', label: 'JSON Writes', base: 'json_writes', max: 200 },
                    { key: 'concurrency_abs_push', label: 'ABS Push', base: 'abs_push', max: 120 },
                  ].map(({ key, label, base, max }) => {
                    const val = localConfig[key] ?? getPresetValue(localConfig.performance_preset || 'balanced', base);
                    return (
                      <div key={key}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-gray-500">{label}</span>
                          <span className="text-gray-400 tabular-nums">{val}</span>
                        </div>
                        <input
                          type="range"
                          min={1}
                          max={max}
                          value={val}
                          onChange={(e) => setLocalConfig({ ...localConfig, [key]: parseInt(e.target.value) })}
                          className="w-full h-1 bg-neutral-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
                        />
                      </div>
                    );
                  })}
                </div>
                <Toggle
                  checked={localConfig.enable_age_rating_lookup || false}
                  onChange={(v) => setLocalConfig({ ...localConfig, enable_age_rating_lookup: v })}
                  label="Age rating lookup (Goodreads)"
                />
              </div>
            )}
          </div>
        </div>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-2.5 bg-white text-black text-sm font-medium rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>

      </div>
    </div>
  );
}
