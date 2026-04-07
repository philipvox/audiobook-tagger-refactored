import { useState, useEffect } from 'react';
import { callBackend } from '../api';
import { isTauri } from '../lib/platform.js';
import {
  SYSTEM_PROMPT as DEFAULT_SYSTEM_PROMPT,
  DEFAULT_CLASSIFICATION_INSTRUCTIONS,
  DEFAULT_DESCRIPTION_VALIDATE_RULES,
  DEFAULT_DESCRIPTION_GENERATE_RULES,
  DEFAULT_TAG_INSTRUCTIONS,
  BOOK_DNA_SYSTEM_PROMPT as DEFAULT_DNA_PROMPT,
} from '../lib/prompts';
import { APPROVED_GENRES } from '../lib/genres';
import { ChevronDown, Check, X, Plus, Trash2, AlertCircle, Library, Settings, Sparkles, Cpu, Download, HardDrive } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useToast } from '../components/Toast';
import { ConfirmModal } from '../components/ConfirmModal';

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
  // OpenAI
  { id: 'gpt-5-nano',          label: 'GPT-5 Nano (Recommended)',      inputPrice: 0.05,  outputPrice: 0.40,  desc: 'Cheapest option with great quality. Knowledge cutoff Apr 2025.', provider: 'openai' },
  { id: 'gpt-5.4-nano',        label: 'GPT-5.4 Nano',                inputPrice: 0.20,  outputPrice: 1.25,  desc: 'Newer knowledge (Aug 2025). 4x more expensive than GPT-5 Nano.', provider: 'openai' },
  { id: 'gpt-5.4-mini',        label: 'GPT-5.4 Mini',                 inputPrice: 0.75,  outputPrice: 4.50,  desc: 'Higher quality. Use for difficult or ambiguous metadata.', provider: 'openai' },
  { id: 'gpt-4o-mini',         label: 'GPT-4o Mini (Legacy)',          inputPrice: 0.15,  outputPrice: 0.60,  desc: 'Older model (Oct 2023 knowledge). Being phased out.', provider: 'openai' },
  { id: 'gpt-4o',              label: 'GPT-4o',                       inputPrice: 2.50,  outputPrice: 10.00, desc: 'Premium quality but expensive. For edge cases only.', provider: 'openai' },
  // Anthropic Claude
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (Fast & Cheap)', inputPrice: 0.80, outputPrice: 4.00, desc: 'Fast and affordable. Great for structured extraction.', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6',   label: 'Claude Sonnet 4.6',            inputPrice: 3.00,  outputPrice: 15.00, desc: 'Best quality Claude model. Excellent at nuanced metadata.', provider: 'anthropic' },
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

// Defined OUTSIDE the component so React doesn't recreate them on every render (which kills focus)
const Input = ({ label, type = 'text', value, onChange, placeholder }) => (
  <div>
    {label && <label className="block text-sm text-gray-400 mb-1.5">{label}</label>}
    <input
      type={type}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-4 py-3 bg-neutral-900 border border-neutral-800 rounded-lg text-base text-white placeholder-gray-600 focus:outline-none focus:border-neutral-700"
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

const PromptEditor = ({ label, subtitle, value, defaultValue, onChange, rows = 6 }) => {
  const isCustom = value && value.trim() !== '' && value.trim() !== defaultValue.trim();
  const displayValue = value || defaultValue;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div>
          <label className="text-xs text-gray-400 font-medium">{label}</label>
          {subtitle && <p className="text-sm text-gray-400">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {isCustom && <span className="text-xs text-amber-500/80">modified</span>}
          {isCustom && (
            <button
              onClick={() => onChange('')}
              className="text-xs text-red-400/70 hover:text-red-300 transition-colors"
            >
              Reset
            </button>
          )}
        </div>
      </div>
      <textarea
        value={displayValue}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={`w-full px-3 py-2 bg-neutral-900 border rounded-lg text-xs text-white focus:outline-none focus:border-neutral-600 font-mono resize-y leading-relaxed ${
          isCustom ? 'border-amber-500/30' : 'border-neutral-800'
        }`}
      />
    </div>
  );
};

/** Validate ABS server URL — must be HTTPS (or localhost for dev). */
function validateAbsUrl(url) {
  if (!url || !url.trim()) return null; // empty is OK (not configured yet)
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      return 'Server URL must use HTTPS (except localhost for local development)';
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      // Allow trailing slash but warn about paths
    }
    return null; // valid
  } catch {
    return 'Invalid URL format. Example: https://your-abs-server.com';
  }
}

export function SettingsPage({ activeTab, navigateTo, logoSvg, onOpenWizard }) {
  const { config, saveConfig, groups } = useApp();
  const toast = useToast();
  const [localConfig, setLocalConfig] = useState(config);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [customProviders, setCustomProviders] = useState([]);
  const [availableProviders, setAvailableProviders] = useState([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const libraryBookCount = groups?.length || 0;
  const [cacheCleared, setCacheCleared] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);
  const [confirmClearKeys, setConfirmClearKeys] = useState(false);

  // Ollama state (only used in Tauri)
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [modelPresets, setModelPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('gemma4');
  const [installing, setInstalling] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState(null); // { completed, total, status }
  const [diskUsage, setDiskUsage] = useState(0);

  // Auto-fetch libraries when URL + token are both set
  useEffect(() => {
    const url = localConfig.abs_base_url;
    const token = localConfig.abs_api_token;
    if (!url || !token || url.length < 8 || token.length < 4) return;
    if (validateAbsUrl(url)) return; // skip auto-fetch if URL is invalid

    // Debounce — wait 800ms after last keystroke
    const timer = setTimeout(async () => {
      try {
        const { absApi } = await import('../lib/proxy');
        const data = await absApi(url, token, '/api/libraries');
        const libs = data.libraries || [];
        setAbsLibraries(libs);
        setConnectionStatus('success');
        if (libs.length > 0 && !localConfig.abs_library_id) {
          setLocalConfig(prev => ({ ...prev, abs_library_id: libs[0].id }));
        }
      } catch {
        setConnectionStatus(null); // Don't show error during typing
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [localConfig.abs_base_url, localConfig.abs_api_token]);

  useEffect(() => {
    loadProviders();
    loadAvailableProviders();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const loadOllamaState = async () => {
      try {
        const [status, presets, usage] = await Promise.all([
          callBackend('ollama_get_status'),
          callBackend('ollama_get_model_presets'),
          callBackend('ollama_get_disk_usage'),
        ]);
        setOllamaStatus(status);
        setModelPresets(presets || []);
        setDiskUsage(usage || 0);
        if (status?.models?.length > 0) {
          setSelectedPreset(status.models[0].name);
        }
      } catch (err) {
        console.warn('Failed to load Ollama state:', err);
      }
    };
    loadOllamaState();
    const interval = setInterval(loadOllamaState, 5000);
    return () => clearInterval(interval);
  }, []);

  // Listen for Ollama pull progress events
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('ollama-pull-progress', (event) => {
        const { completed, total, status } = event.payload;
        setPullProgress({ completed, total, status });
      });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  const loadProviders = async () => {
    try { setCustomProviders(await callBackend('get_custom_providers')); } catch (e) { console.error(e); }
  };

  const loadAvailableProviders = async () => {
    try { setAvailableProviders(await callBackend('get_available_providers')); } catch (e) { console.error(e); }
  };

  const toggleProvider = async (id, enabled) => {
    try { await callBackend('toggle_provider', { providerId: id, enabled }); await loadProviders(); } catch (e) { toast.error('Provider Error', String(e)); }
  };

  const removeProvider = async (id) => {
    setConfirmRemoveId(id);
  };

  const doRemoveProvider = async (id) => {
    try { await callBackend('remove_custom_provider', { providerId: id }); await loadProviders(); } catch (e) { toast.error('Remove Failed', String(e)); }
  };

  const addProvider = async (id) => {
    try { await callBackend('add_abs_agg_provider', { providerId: id }); await loadProviders(); setShowAddProvider(false); } catch (e) { toast.error('Add Failed', String(e)); }
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
      const result = await callBackend('test_provider', { providerId: provider.provider_id, title: q.title, author: q.author });
      setTestResult({ success: !!result, provider: provider.provider_id });
    } catch (e) {
      setTestResult({ success: false, provider: provider.provider_id });
    }
    setTestingProvider(null);
  };

  const [saved, setSaved] = useState(false);
  const handleSave = async () => {
    // Validate ABS URL before saving
    const urlError = validateAbsUrl(localConfig.abs_base_url);
    if (urlError) {
      toast.error('Invalid Server URL', urlError);
      return;
    }
    setSaving(true);
    try {
      await saveConfig(localConfig);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      toast.error('Save Failed', String(e));
    }
    setSaving(false);
  };

  const [absLibraries, setAbsLibraries] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState(null); // 'success' | 'error' | null

  const testConnection = async () => {
    setConnectionStatus(null);
    const urlError = validateAbsUrl(localConfig.abs_base_url);
    if (urlError) {
      toast.error('Invalid Server URL', urlError);
      setConnectionStatus('error');
      return;
    }
    try {
      const { absApi } = await import('../lib/proxy');
      const data = await absApi(localConfig.abs_base_url, localConfig.abs_api_token, '/api/libraries');
      const libs = data.libraries || [];
      setAbsLibraries(libs);
      setConnectionStatus('success');
      if (libs.length > 0 && !localConfig.abs_library_id) {
        setLocalConfig(prev => ({ ...prev, abs_library_id: libs[0].id }));
      }
    } catch (e) {
      setConnectionStatus('error');
      console.error('Connection failed:', e);
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  };

  const handleInstallOllama = async () => {
    setInstalling(true);
    try {
      toast.info('Installing Ollama...');
      await callBackend('ollama_install');
      toast.info('Starting Ollama...');
      await callBackend('ollama_start');
      if (selectedPreset) {
        setPulling(true);
        toast.info(`Downloading model ${selectedPreset}...`);
        await callBackend('ollama_pull_model', { modelName: selectedPreset });
        setPulling(false); setPullProgress(null);
      }
      const newConfig = { ...localConfig, use_local_ai: true, ollama_model: selectedPreset };
      setLocalConfig(newConfig);
      await saveConfig(newConfig);
      const status = await callBackend('ollama_get_status');
      setOllamaStatus(status);
      toast.success('Local AI installed and running!');
    } catch (err) {
      toast.error(`Install failed: ${err.message || err}`);
    } finally {
      setInstalling(false);
      setPulling(false); setPullProgress(null);
    }
  };

  const handleToggleOllama = async () => {
    try {
      if (ollamaStatus?.running) {
        await callBackend('ollama_stop');
        const newConfig = { ...localConfig, use_local_ai: false };
        setLocalConfig(newConfig);
        await saveConfig(newConfig);
        toast.info('Local AI stopped');
      } else {
        await callBackend('ollama_start');
        const newConfig = { ...localConfig, use_local_ai: true, ollama_model: selectedPreset };
        setLocalConfig(newConfig);
        await saveConfig(newConfig);
        toast.success('Local AI started');
      }
      const status = await callBackend('ollama_get_status');
      setOllamaStatus(status);
    } catch (err) {
      toast.error(`Failed: ${err.message || err}`);
    }
  };

  const handleSwitchModel = async (modelId) => {
    setSelectedPreset(modelId);
    const isDownloaded = ollamaStatus?.models?.some(m => m.name === modelId);
    if (!isDownloaded) {
      setPulling(true);
      try {
        toast.info(`Downloading model ${modelId}...`);
        await callBackend('ollama_pull_model', { modelName: modelId });
        toast.success(`Model ${modelId} ready`);
      } catch (err) {
        toast.error(`Model pull failed: ${err.message || err}`);
        setPulling(false); setPullProgress(null);
        return;
      }
      setPulling(false); setPullProgress(null);
    }
    const newConfig = { ...localConfig, ollama_model: modelId };
    setLocalConfig(newConfig);
    await saveConfig(newConfig);
    const status = await callBackend('ollama_get_status');
    setOllamaStatus(status);
  };

  const handleUninstallOllama = async () => {
    try {
      await callBackend('ollama_uninstall');
      const newConfig = { ...localConfig, use_local_ai: false, ollama_model: null };
      setLocalConfig(newConfig);
      await saveConfig(newConfig);
      setOllamaStatus({ installed: false, running: false, models: [], version: null });
      setDiskUsage(0);
      toast.info('Local AI removed');
    } catch (err) {
      toast.error(`Uninstall failed: ${err.message || err}`);
    }
  };

  // Input, Toggle defined outside component (above) to preserve focus on re-render

  return (
    <div className="h-full overflow-y-auto bg-neutral-950">
      {/* Nav header — matches ActionBar sizing */}
      {navigateTo && (
        <div className="px-4 py-3 flex items-center gap-2">
          {logoSvg && (
            <img src={logoSvg} alt="Audiobook Tagger" style={{ height: '36px' }} className="invert opacity-90 mr-1" />
          )}
          <nav className="flex items-center gap-0.5 bg-neutral-900/50 rounded-full p-1 mr-2">
            <button
              onClick={() => navigateTo('scanner')}
              className="px-4 py-2 text-sm font-medium rounded-full transition-all flex items-center gap-2 text-gray-500 hover:text-gray-300"
            >
              <Library className="w-4 h-4" />
              Library
            </button>
            <button
              onClick={() => navigateTo('settings')}
              className="px-4 py-2 text-sm font-medium rounded-full transition-all flex items-center gap-2 bg-neutral-800 text-white"
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>
          </nav>
          {onOpenWizard && (
            <button
              onClick={onOpenWizard}
              className="px-3 py-2 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1.5"
            >
              <Sparkles className="w-4 h-4" />
              Setup Wizard
            </button>
          )}
        </div>
      )}
      <div className="max-w-full mx-auto px-6 pb-6">

        {/* Full-width grid — ABS + AI side by side above the fold */}
        <div className="grid grid-cols-2 gap-6 mb-6">

          {/* Left: Connection */}
          <div className="bg-neutral-900/50 rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-white">AudiobookShelf</h3>
              <a href="https://www.audiobookshelf.org" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">What is ABS? →</a>
            </div>
            <Input
              label="Server URL"
              value={localConfig.abs_base_url}
              onChange={(v) => setLocalConfig({ ...localConfig, abs_base_url: v })}
              placeholder="https://your-abs-server.com"
            />
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm text-gray-400">API Token</label>
                {localConfig.abs_base_url && (
                  <a href={`${localConfig.abs_base_url.replace(/\/$/, '')}/config/api-keys`} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">Get API key from your ABS →</a>
                )}
              </div>
              <Input
                type="password"
                value={localConfig.abs_api_token}
                onChange={(v) => setLocalConfig({ ...localConfig, abs_api_token: v })}
                placeholder="Enter token"
              />
            </div>

            {/* Library picker — auto-populated after connection test */}
            {absLibraries.length > 0 ? (
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Library</label>
                <select
                  value={localConfig.abs_library_id || ''}
                  onChange={(e) => setLocalConfig({ ...localConfig, abs_library_id: e.target.value })}
                  className="w-full px-4 py-3 bg-neutral-900 border border-neutral-800 rounded-lg text-base text-white focus:outline-none cursor-pointer"
                >
                  <option value="">Select a library...</option>
                  {absLibraries.map(lib => (
                    <option key={lib.id} value={lib.id}>{lib.name} ({lib.mediaType})</option>
                  ))}
                </select>
              </div>
            ) : (
              <Input
                label="Library ID"
                value={localConfig.abs_library_id}
                onChange={(v) => setLocalConfig({ ...localConfig, abs_library_id: v })}
                placeholder="Connect first to auto-detect"
              />
            )}

            <button
              onClick={testConnection}
              className={`w-full py-3 text-sm font-medium rounded-lg transition-colors ${
                connectionStatus === 'success'
                  ? 'bg-green-600/20 text-green-400'
                  : connectionStatus === 'error'
                  ? 'bg-red-600/20 text-red-400'
                  : 'bg-neutral-800 text-gray-400 hover:text-white hover:bg-neutral-700'
              }`}
            >
              {connectionStatus === 'success' ? 'Connected' : connectionStatus === 'error' ? 'Connection Failed — Retry' : 'Connect & Detect Libraries'}
            </button>
          </div>

          {/* Right: AI & Processing */}
          <div className="space-y-6">

            {isTauri() && (
              <div className="bg-neutral-900/50 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-blue-400" />
                    <h3 className="text-lg font-semibold text-white">Local AI</h3>
                  </div>
                  {ollamaStatus?.running && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-xs text-green-400">Running</span>
                    </div>
                  )}
                  {ollamaStatus?.installed && !ollamaStatus?.running && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-yellow-400" />
                      <span className="text-xs text-yellow-400">Stopped</span>
                    </div>
                  )}
                </div>

                {/* Not installed */}
                {!ollamaStatus?.installed && !installing && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-400">
                      Run AI locally on your machine. No API key needed, no usage costs, complete privacy.
                    </p>
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5">Choose a model</label>
                      <div className="space-y-1.5">
                        {modelPresets.map(preset => (
                          <button
                            key={preset.id}
                            onClick={() => setSelectedPreset(preset.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                              selectedPreset === preset.id
                                ? 'border-blue-500 bg-blue-500/10 text-white'
                                : 'border-neutral-700 bg-neutral-800 text-gray-400 hover:border-neutral-600'
                            }`}
                          >
                            <div className="flex justify-between items-center">
                              <span className="font-medium">{preset.label}</span>
                              <span className="text-gray-500">{preset.size_gb} GB</span>
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
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
                  </div>
                )}

                {/* Installing / Downloading */}
                {(installing || pulling) && (
                  <div className="py-4 space-y-3">
                    {pulling && pullProgress?.total > 0 ? (
                      <>
                        <div className="w-full bg-neutral-800 rounded-full h-2.5 overflow-hidden">
                          <div
                            className="bg-blue-500 h-full rounded-full transition-all duration-300"
                            style={{ width: `${Math.round((pullProgress.completed / pullProgress.total) * 100)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs text-gray-500">
                          <span>{pullProgress.status || 'Downloading...'}</span>
                          <span>
                            {(pullProgress.completed / 1e9).toFixed(1)} / {(pullProgress.total / 1e9).toFixed(1)} GB
                            {' · '}
                            {Math.round((pullProgress.completed / pullProgress.total) * 100)}%
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="text-center">
                        <div className="animate-spin w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full mx-auto mb-2" />
                        <p className="text-sm text-gray-400">
                          {pulling ? 'Downloading model...' : 'Installing Ollama...'}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Installed */}
                {ollamaStatus?.installed && !installing && !pulling && (
                  <div className="space-y-3">
                    {ollamaStatus.models?.length > 0 && (
                      <div>
                        <label className="block text-sm text-gray-500 mb-1.5">Active Model</label>
                        <select
                          value={selectedPreset}
                          onChange={(e) => handleSwitchModel(e.target.value)}
                          className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                        >
                          {ollamaStatus.models.map(m => (
                            <option key={m.name} value={m.name}>
                              {m.name} ({formatBytes(m.size_bytes)})
                            </option>
                          ))}
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

                    {/* Custom model input */}
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5">Or use any model</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="e.g. mistral:7b, deepseek-r1:8b"
                          className="flex-1 px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-neutral-600"
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && e.target.value.trim()) {
                              await handleSwitchModel(e.target.value.trim());
                              e.target.value = '';
                            }
                          }}
                          id="custom-model-input"
                        />
                        <button
                          onClick={async () => {
                            const input = document.getElementById('custom-model-input');
                            if (input?.value.trim()) {
                              await handleSwitchModel(input.value.trim());
                              input.value = '';
                            }
                          }}
                          className="px-3 py-2 bg-neutral-700 text-sm text-white rounded-lg hover:bg-neutral-600 transition-colors"
                        >
                          Pull
                        </button>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">Enter any Ollama model name. It will be downloaded if not already installed.</p>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={handleToggleOllama}
                        className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
                          ollamaStatus.running
                            ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                            : 'bg-green-600/20 text-green-400 hover:bg-green-600/30'
                        }`}
                      >
                        {ollamaStatus.running ? 'Stop Local AI' : 'Start Local AI'}
                      </button>
                      <button
                        onClick={handleUninstallOllama}
                        className="px-3 py-2 text-sm text-gray-500 hover:text-red-400 transition-colors"
                      >
                        Remove
                      </button>
                    </div>

                    {diskUsage > 0 && (
                      <div className="flex items-center gap-1.5 text-xs text-gray-600">
                        <HardDrive className="w-3 h-3" />
                        Using {formatBytes(diskUsage)} on disk
                        {ollamaStatus.version && <span> · Ollama v{ollamaStatus.version}</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="bg-neutral-900/50 rounded-xl p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white mb-3">AI Provider</h3>
              <p className="text-sm text-gray-400">Enter your API key for OpenAI or Anthropic Claude. Keys are stored in your browser only — never sent to our server.</p>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-sm text-gray-400">OpenAI API Key</label>
                      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">Get a key →</a>
                    </div>
                    <Input
                      type="password"
                      value={localConfig.openai_api_key}
                      onChange={(v) => setLocalConfig({ ...localConfig, openai_api_key: v })}
                      placeholder="sk-..."
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-sm text-gray-400">Anthropic (Claude) API Key</label>
                      <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">Get a key →</a>
                    </div>
                    <Input
                      type="password"
                      value={localConfig.anthropic_api_key}
                      onChange={(v) => setLocalConfig({ ...localConfig, anthropic_api_key: v })}
                      placeholder="sk-ant-..."
                    />
                  </div>
                  <div className="text-xs text-amber-500/70 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 flex-shrink-0" />
                    <span>API keys are stored in your browser's local storage. Do not use this on shared computers.</span>
                  </div>
                  <p className="text-sm text-gray-400">Enter one or both. The model you select below determines which key is used.</p>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">AI Model</label>
                    <select
                      value={localConfig.ai_model || 'gpt-5-nano'}
                      onChange={(e) => {
                          const model = AI_MODELS.find(m => m.id === e.target.value);
                          const isAnthropic = model?.provider === 'anthropic';
                          setLocalConfig({
                            ...localConfig,
                            ai_model: e.target.value,
                            ai_base_url: isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com',
                          });
                      }}
                      className="w-full px-4 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-base text-white focus:outline-none cursor-pointer"
                    >
                      <optgroup label="OpenAI">
                        {AI_MODELS.filter(m => m.provider === 'openai').map(m => {
                          const libCost = libraryBookCount > 0 ? estimateCost(m, libraryBookCount) * 3 : null;
                          const costStr = libCost != null ? ` — Run All: ${formatCost(libCost)}` : '';
                          return <option key={m.id} value={m.id}>{m.label}{costStr}</option>;
                        })}
                      </optgroup>
                      <optgroup label="Anthropic Claude">
                        {AI_MODELS.filter(m => m.provider === 'anthropic').map(m => {
                          const libCost = libraryBookCount > 0 ? estimateCost(m, libraryBookCount) * 3 : null;
                          const costStr = libCost != null ? ` — Run All: ${formatCost(libCost)}` : '';
                          return <option key={m.id} value={m.id}>{m.label}{costStr}</option>;
                        })}
                      </optgroup>
                    </select>
                    {(() => {
                      const m = AI_MODELS.find(m => m.id === (localConfig.ai_model || 'gpt-5-nano'));
                      if (!m) return null;
                      const perBook = estimateCost(m, 1);
                      const libSize = libraryBookCount;
                      const runAllPerBook = estimateCost(m, 1) * 3; // 3 AI calls per book
                      const runAllLib = libSize > 0 ? estimateCost(m, libSize) * 3 : null;
                      return (
                        <div className="mt-3 text-sm space-y-2">
                          <div className="text-gray-500">
                            <span className="text-gray-300">${m.inputPrice.toFixed(2)} / ${m.outputPrice.toFixed(2)}</span> per 1M tokens (input/output)
                          </div>
                          <div className="text-gray-400">
                            Per book: <span className="text-white font-medium">{formatCost(perBook)}</span> (single operation)
                            {' '}&middot;{' '}
                            <span className="text-white font-medium">{formatCost(runAllPerBook)}</span> (Run All)
                          </div>
                          {libSize > 0 && (
                            <div className="bg-neutral-800/50 rounded-lg px-3 py-2 text-gray-400">
                              Full library Run All ({libSize} books): <span className="text-green-400 font-semibold">{formatCost(runAllLib)}</span>
                            </div>
                          )}
                          <div className="text-gray-500">{m.desc}</div>
                        </div>
                      );
                    })()}
                  </div>
            </div>

          </div>
        </div>

        {/* Second row — Processing + Save side by side */}
        <div className="grid grid-cols-2 gap-6 mb-6">
            <div className="bg-neutral-900/50 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Processing</h3>
              <div className="space-y-3">
                <Toggle
                  checked={localConfig.genre_enforcement}
                  onChange={(v) => setLocalConfig({ ...localConfig, genre_enforcement: v })}
                  label="Enforce approved genres"
                />
                <p className="text-sm text-gray-400">When enabled, AI genre suggestions are filtered to the approved list only. Disable to allow free-form genres.</p>
              </div>
            </div>

            <div className="flex flex-col justify-start">
              {/* Collapsible sections */}
              <div className="space-y-2 mt-4">
          {/* Prompt Customization */}
          <div className="bg-neutral-900/50 rounded-xl border border-neutral-800 overflow-hidden">
            <button
              onClick={() => setShowPrompts(!showPrompts)}
              className="w-full px-5 py-3 flex items-center justify-between text-sm text-gray-400 hover:text-white transition-colors"
            >
              <span>Prompt Customization</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${showPrompts ? 'rotate-180' : ''}`} />
            </button>

            {showPrompts && (
              <div className="px-5 pb-4 space-y-5">
                <p className="text-sm text-gray-400">
                  Edit the AI prompts used for metadata enrichment. The text below is the active prompt — edit it directly. Hit "Reset" to restore any section to its default.
                </p>

                {/* System Prompt */}
                <PromptEditor
                  label="System Prompt"
                  subtitle="Sent as the system message for all AI calls"
                  value={localConfig.custom_system_prompt}
                  defaultValue={DEFAULT_SYSTEM_PROMPT}
                  onChange={(v) => setLocalConfig({ ...localConfig, custom_system_prompt: v })}
                  rows={2}
                />

                {/* Approved Genres */}
                <PromptEditor
                  label="Approved Genres"
                  subtitle="Comma-separated list — AI will only assign genres from this list"
                  value={localConfig.custom_approved_genres}
                  defaultValue={APPROVED_GENRES.join(', ')}
                  onChange={(v) => setLocalConfig({ ...localConfig, custom_approved_genres: v })}
                  rows={4}
                />

                {/* Classification Instructions */}
                <PromptEditor
                  label="Classification Instructions"
                  subtitle="Genre, tag, age rating, and theme rules for the classification prompt"
                  value={localConfig.custom_classification_rules}
                  defaultValue={DEFAULT_CLASSIFICATION_INSTRUCTIONS}
                  onChange={(v) => setLocalConfig({ ...localConfig, custom_classification_rules: v })}
                  rows={12}
                />

                {/* Description — Validate */}
                <PromptEditor
                  label="Description Rules (Existing)"
                  subtitle="Rules for validating/cleaning an existing description"
                  value={localConfig.custom_description_validate_rules}
                  defaultValue={DEFAULT_DESCRIPTION_VALIDATE_RULES}
                  onChange={(v) => setLocalConfig({ ...localConfig, custom_description_validate_rules: v })}
                  rows={8}
                />

                {/* Description — Generate */}
                <PromptEditor
                  label="Description Rules (Generate)"
                  subtitle="Rules for writing a new description when none exists"
                  value={localConfig.custom_description_generate_rules}
                  defaultValue={DEFAULT_DESCRIPTION_GENERATE_RULES}
                  onChange={(v) => setLocalConfig({ ...localConfig, custom_description_generate_rules: v })}
                  rows={6}
                />

                {/* Tag Instructions */}
                <PromptEditor
                  label="Tag Assignment Instructions"
                  subtitle="Approved tag list and assignment rules"
                  value={localConfig.custom_tag_instructions}
                  defaultValue={DEFAULT_TAG_INSTRUCTIONS}
                  onChange={(v) => setLocalConfig({ ...localConfig, custom_tag_instructions: v })}
                  rows={12}
                />

                {/* DNA Prompt */}
                <PromptEditor
                  label="DNA Fingerprint Prompt"
                  subtitle="System prompt for BookDNA generation"
                  value={localConfig.custom_dna_prompt}
                  defaultValue={DEFAULT_DNA_PROMPT}
                  onChange={(v) => setLocalConfig({ ...localConfig, custom_dna_prompt: v })}
                  rows={12}
                />

                <button
                  onClick={() => setLocalConfig({
                    ...localConfig,
                    custom_system_prompt: '',
                    custom_approved_genres: '',
                    custom_classification_rules: '',
                    custom_description_validate_rules: '',
                    custom_description_generate_rules: '',
                    custom_tag_instructions: '',
                    custom_dna_prompt: '',
                  })}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Reset all prompts to defaults
                </button>
              </div>
            )}
          </div>

              </div>
              <button
                onClick={handleSave}
                disabled={saving}
                className={`w-full py-3 mt-4 text-sm font-medium rounded-xl transition-colors disabled:opacity-50 ${
                  saved
                    ? 'bg-green-500 text-white'
                    : 'bg-white text-black hover:bg-gray-100'
                }`}
              >
                {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Settings'}
              </button>

              {/* Security: clear all stored credentials */}
              <button
                onClick={() => setConfirmClearKeys(true)}
                className="w-full py-2 mt-2 text-xs text-red-400/70 hover:text-red-300 transition-colors"
              >
                Clear all stored API keys &amp; tokens
              </button>
            </div>
        </div>

      </div>

      <ConfirmModal
        isOpen={!!confirmRemoveId}
        onClose={() => setConfirmRemoveId(null)}
        onConfirm={() => doRemoveProvider(confirmRemoveId)}
        title="Remove Provider"
        message="Are you sure you want to remove this metadata provider?"
        confirmText="Remove"
        type="danger"
      />
      <ConfirmModal
        isOpen={confirmClearKeys}
        onClose={() => setConfirmClearKeys(false)}
        onConfirm={() => {
          setLocalConfig(prev => ({
            ...prev,
            abs_api_token: '',
            openai_api_key: null,
            anthropic_api_key: null,
          }));
          saveConfig({
            ...localConfig,
            abs_api_token: '',
            openai_api_key: null,
            anthropic_api_key: null,
          });
          setConfirmClearKeys(false);
          toast.success('Keys Cleared', 'All API keys and tokens have been removed from browser storage.');
        }}
        title="Clear All API Keys"
        message="This will remove your ABS token, OpenAI key, and Anthropic key from browser storage. You'll need to re-enter them to use the app."
        confirmText="Clear All Keys"
        type="danger"
      />
    </div>
  );
}
