import { useState, useEffect, useRef } from 'react';
import { callBackend, ollamaCall } from '../api';
import { isTauri } from '../lib/platform.js';
import {
  SYSTEM_PROMPT as DEFAULT_SYSTEM_PROMPT,
  DEFAULT_CLASSIFICATION_INSTRUCTIONS,
  DEFAULT_DESCRIPTION_VALIDATE_RULES,
  DEFAULT_DESCRIPTION_GENERATE_RULES,
  DEFAULT_TAG_INSTRUCTIONS,
  BOOK_DNA_SYSTEM_PROMPT as DEFAULT_DNA_PROMPT,
} from '../lib/prompts';
import { APPROVED_GENRES, MAX_GENRES } from '../lib/genres';
import { ChevronDown, Check, X, Plus, Trash2, AlertCircle, Library, Settings, Sparkles, Cpu, Download, HardDrive, Mic } from 'lucide-react';
import { useApp, shouldAutoEnableLocalAI } from '../context/AppContext';
import { useToast } from '../components/Toast';
import { ConfirmModal } from '../components/ConfirmModal';

/**
 * Shallow-equality check for two config objects. Used to detect whether the
 * user has unsaved edits (localConfig diverged from the last synced baseline)
 * so we can safely adopt an updated context config without clobbering edits.
 * Falls back to a JSON compare for nested (array/object) values.
 */
export function configsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] === b[k]) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

const PRESETS = {
  conservative: { label: 'Conservative', multiplier: 0.5 },
  balanced: { label: 'Balanced', multiplier: 1.0 },
  performance: { label: 'Performance', multiplier: 2.0 },
  extreme: { label: 'Extreme', multiplier: 4.0 },
};

const BASE_VALUES = { metadata: 15, super_scanner: 5, json_writes: 100, abs_push: 5, file_scan: 10 };
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
      role="switch"
      aria-checked={!!checked}
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

/** Validate ABS server URL format. Desktop app supports both HTTP and HTTPS. */
function validateAbsUrl(url) {
  if (!url || !url.trim()) return null; // empty is OK (not configured yet)
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Server URL must start with http:// or https://';
    }
    return null; // valid
  } catch {
    return 'Invalid URL format. Example: http://192.168.1.100:13378';
  }
}

export function SettingsPage({ activeTab, navigateTo, logoSvg, onOpenWizard }) {
  const { config, saveConfig, loadConfig, groups } = useApp();
  const toast = useToast();
  const [localConfig, setLocalConfig] = useState(config);

  // Ref mirror of localConfig so long-lived effects (the 5s Ollama poll) and
  // blur/auto-save handlers always read the latest edits, not a stale closure.
  const localConfigRef = useRef(localConfig);
  useEffect(() => { localConfigRef.current = localConfig; }, [localConfig]);

  // Baseline of the config we last synced from / saved to context. localConfig
  // differing from this means the user has unsaved edits (the "dirty" flag).
  const syncedConfigRef = useRef(config);

  // Sync localConfig when the context config changes (e.g. a wizard save while
  // this page is mounted but hidden) - but only when there are no unsaved edits,
  // so we never silently discard the user's in-progress changes.
  useEffect(() => {
    if (!config) return;
    // Dirty = localConfig has diverged from the last synced baseline.
    const dirty = !configsEqual(localConfigRef.current, syncedConfigRef.current);
    if (dirty) return; // keep the user's unsaved edits
    // Only re-render when the incoming config actually differs by value; this
    // avoids a redundant setLocalConfig (and re-render loop) when context hands
    // back a new object reference with identical values.
    if (!configsEqual(localConfigRef.current, config)) {
      setLocalConfig(config);
    }
    syncedConfigRef.current = config;
  }, [config]);

  // Centralized save: updates localConfig, persists via context, and advances
  // the synced baseline on success so future context changes can re-sync.
  // Returns the {success} result; callers surface their own success/error UI.
  const persistConfig = async (newConfig) => {
    setLocalConfig(newConfig);
    const res = await saveConfig(newConfig);
    if (res?.success) syncedConfigRef.current = newConfig;
    return res;
  };
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

  // #58: where the persistent operation log lives. No opener/shell plugin is
  // configured for this app, so rather than adding one just for a convenience
  // button, the path is shown in a copyable field. Tauri-only: the browser
  // build has no log file, so the whole block is hidden there instead of
  // showing a path that does not exist.
  const [logPath, setLogPath] = useState('');
  const [logPathCopied, setLogPathCopied] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      try {
        const path = await callBackend('get_log_path');
        if (!cancelled && typeof path === 'string' && path) setLogPath(path);
      } catch (e) {
        console.warn('Could not read the log path:', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const copyLogPath = async () => {
    try {
      await navigator.clipboard.writeText(logPath);
      setLogPathCopied(true);
      setTimeout(() => setLogPathCopied(false), 2000);
    } catch (e) {
      toast.error('Copy Failed', 'Could not copy the path to the clipboard.');
    }
  };
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);
  const [confirmClearKeys, setConfirmClearKeys] = useState(false);

  // Ollama state (only used in Tauri)
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [modelPresets, setModelPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('gemma4');
  const ollamaAutoDetectedRef = useRef(false);
  // Only initialize selectedPreset from the active model once, so repeated
  // 5s polls never clobber a model the user picked in the dropdown.
  const presetInitializedRef = useRef(false);
  const [installing, setInstalling] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState(null); // { completed, total, status }
  const [diskUsage, setDiskUsage] = useState(0);

  // Local Whisper state (only used in Tauri)
  const [whisperStatus, setWhisperStatus] = useState(null);
  const [whisperPresets, setWhisperPresets] = useState([]);
  const [selectedWhisperModel, setSelectedWhisperModel] = useState('base');
  const [whisperInstalling, setWhisperInstalling] = useState(false);
  const [whisperDownloading, setWhisperDownloading] = useState(false);
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState(null);
  const [whisperDiskUsage, setWhisperDiskUsage] = useState(0);

  // Auto-fetch libraries when URL + token are both set
  useEffect(() => {
    if (!localConfig) return;
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
  }, [localConfig?.abs_base_url, localConfig?.abs_api_token]);

  useEffect(() => {
    loadProviders();
    loadAvailableProviders();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const loadOllamaState = async () => {
      try {
        const [status, presets, usage] = await Promise.all([
          ollamaCall('ollama_get_status'),
          callBackend('ollama_get_model_presets'),
          callBackend('ollama_get_disk_usage'),
        ]);
        setOllamaStatus(status);
        setModelPresets(presets || []);
        setDiskUsage(usage || 0);
        if (status?.models?.length > 0) {
          // Initialize the active-model selection only once so later polls
          // don't overwrite a model the user chose in the dropdown.
          if (!presetInitializedRef.current) {
            presetInitializedRef.current = true;
            setSelectedPreset(status.models[0].name);
          }
          // Auto-enable local AI once, only when the user has never made an
          // explicit choice. Read the latest config from the ref (this effect
          // runs on an interval and its closure would otherwise be stale).
          if (!ollamaAutoDetectedRef.current && shouldAutoEnableLocalAI(localConfigRef.current, status)) {
            ollamaAutoDetectedRef.current = true;
            const model = status.models[0].name;
            const newConfig = { ...localConfigRef.current, use_local_ai: true, ollama_model: model };
            const res = await persistConfig(newConfig);
            if (!res?.success) {
              ollamaAutoDetectedRef.current = false; // allow a retry on the next poll
            }
          }
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

  // Load Local Whisper state
  useEffect(() => {
    if (!isTauri()) return;
    const loadWhisperState = async () => {
      try {
        const [status, presets, usage] = await Promise.all([
          callBackend('whisper_local_get_status'),
          callBackend('whisper_local_get_model_presets'),
          callBackend('whisper_local_get_disk_usage'),
        ]);
        setWhisperStatus(status);
        setWhisperPresets(presets || []);
        setWhisperDiskUsage(usage || 0);
      } catch (e) { /* whisper commands not available */ }
    };
    loadWhisperState();
  }, []);

  // Listen for whisper install/download progress events
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('whisper_install_progress', (event) => {
        const { stage, status, percent, downloaded, total } = event.payload;
        setWhisperDownloadProgress({ stage, status, percent, downloaded, total });
        if (stage === 'complete') {
          setWhisperInstalling(false);
          setWhisperDownloading(false);
          // Reload status
          callBackend('whisper_local_get_status').then(setWhisperStatus).catch(err => console.warn('Whisper post-install reload failed: status', err));
          callBackend('whisper_local_get_disk_usage').then(setWhisperDiskUsage).catch(err => console.warn('Whisper post-install reload failed: disk usage', err));
        }
      });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  const handleInstallWhisper = async () => {
    setWhisperInstalling(true);
    try {
      await callBackend('whisper_local_install');
      const status = await callBackend('whisper_local_get_status');
      setWhisperStatus(status);
      toast.success('whisper-cpp installed!');
    } catch (e) {
      toast.error('Install failed', String(e));
    }
    setWhisperInstalling(false);
  };

  const handleDownloadWhisperModel = async () => {
    setWhisperDownloading(true);
    try {
      await callBackend('whisper_local_download_model', { modelId: selectedWhisperModel });
      const status = await callBackend('whisper_local_get_status');
      setWhisperStatus(status);
      setWhisperDiskUsage(await callBackend('whisper_local_get_disk_usage'));
      // Auto-enable local whisper - persist the choice, not just local state.
      const newConfig = { ...localConfigRef.current, use_local_whisper: true, whisper_model: selectedWhisperModel };
      const res = await persistConfig(newConfig);
      if (res?.success) {
        toast.success('Whisper model downloaded!');
      } else {
        toast.error('Model downloaded, but saving settings failed', res?.error);
      }
    } catch (e) {
      toast.error('Download failed', String(e));
    }
    setWhisperDownloading(false);
  };

  const handleDeleteWhisperModel = async (modelId) => {
    try {
      await callBackend('whisper_local_delete_model', { modelId });
      const status = await callBackend('whisper_local_get_status');
      setWhisperStatus(status);
      setWhisperDiskUsage(await callBackend('whisper_local_get_disk_usage'));
      toast.info(`Model ${modelId} deleted`);
    } catch (e) {
      toast.error('Delete failed', String(e));
    }
  };

  const handleUninstallWhisper = async () => {
    try {
      await callBackend('whisper_local_uninstall');
      setWhisperStatus({ installed: false, binary_path: null, models: [], active_model: null });
      setWhisperDiskUsage(0);
      const res = await persistConfig({ ...localConfigRef.current, use_local_whisper: false, whisper_model: null });
      if (res?.success) {
        toast.info('Local Whisper removed');
      } else {
        toast.error('Whisper removed, but saving settings failed', res?.error);
      }
    } catch (e) {
      toast.error('Uninstall failed', String(e));
    }
  };

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
    // saveConfig returns {success} rather than throwing, so a failed write must
    // be detected from the result - never optimistically show "Saved!".
    const res = await persistConfig(localConfig);
    if (res?.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      toast.error('Save Failed', res?.error || 'Could not save settings. Your changes were not persisted.');
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
      const msg = e?.message || String(e);
      const detail = msg.includes('Failed to fetch') ? 'Could not reach server. Check the URL, firewall, and that ABS is running.'
        : msg.includes('AbortError') ? 'Connection timed out. Is the server reachable from this machine?'
        : msg;
      toast.error('Connection Failed', detail);
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
      await ollamaCall('ollama_start');
      if (selectedPreset) {
        setPulling(true);
        toast.info(`Downloading model ${selectedPreset}...`);
        await ollamaCall('ollama_pull_model', { modelName: selectedPreset });
        setPulling(false); setPullProgress(null);
      }
      const newConfig = { ...localConfig, use_local_ai: true, ollama_model: selectedPreset };
      const res = await persistConfig(newConfig);
      const status = await ollamaCall('ollama_get_status');
      setOllamaStatus(status);
      if (res?.success) {
        toast.success('Local AI installed and running!');
      } else {
        toast.error('Installed, but saving settings failed', res?.error);
      }
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
        const res = await persistConfig({ ...localConfig, use_local_ai: false });
        if (res?.success) toast.info('Local AI stopped');
        else toast.error('Stopped, but saving settings failed', res?.error);
      } else {
        await ollamaCall('ollama_start');
        const res = await persistConfig({ ...localConfig, use_local_ai: true, ollama_model: selectedPreset });
        if (res?.success) toast.success('Local AI started');
        else toast.error('Started, but saving settings failed', res?.error);
      }
      const status = await ollamaCall('ollama_get_status');
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
        await ollamaCall('ollama_pull_model', { modelName: modelId });
        toast.success(`Model ${modelId} ready`);
      } catch (err) {
        toast.error(`Model pull failed: ${err.message || err}`);
        setPulling(false); setPullProgress(null);
        return;
      }
      setPulling(false); setPullProgress(null);
    }
    const newConfig = { ...localConfig, ollama_model: modelId };
    const res = await persistConfig(newConfig);
    if (!res?.success) toast.error('Failed to save model selection', res?.error);
    const status = await ollamaCall('ollama_get_status');
    setOllamaStatus(status);
  };

  const handleUninstallOllama = async () => {
    try {
      await callBackend('ollama_uninstall');
      const res = await persistConfig({ ...localConfig, use_local_ai: false, ollama_model: null });
      setOllamaStatus({ installed: false, running: false, models: [], version: null });
      setDiskUsage(0);
      if (res?.success) toast.info('Local AI removed');
      else toast.error('Removed, but saving settings failed', res?.error);
    } catch (err) {
      toast.error(`Uninstall failed: ${err.message || err}`);
    }
  };

  // Input, Toggle defined outside component (above) to preserve focus on re-render

  // Guard: if the config never loaded, render a retry state rather than
  // dereferencing a null localConfig throughout the form below.
  if (!localConfig) {
    return (
      <div className="h-full flex items-center justify-center bg-neutral-950">
        <div className="text-center">
          <p className="text-gray-400 text-sm mb-3">Settings could not be loaded.</p>
          <button
            onClick={() => loadConfig?.()}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-neutral-800 text-white hover:bg-neutral-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

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
              placeholder="http://192.168.1.100:13378"
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

            {/* AI Provider */}
            <div className="bg-neutral-900/50 rounded-xl p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white mb-3">AI Provider</h3>
              <p className="text-sm text-gray-400">Enter your API key for OpenAI or Anthropic Claude. Keys are stored in your browser only.</p>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-sm text-gray-400">OpenAI API Key</label>
                      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">Get a key</a>
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
                      <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">Get a key</a>
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
                      className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                    >
                      <optgroup label="OpenAI">
                        {AI_MODELS.filter(m => m.provider === 'openai').map(m => {
                          const libCost = libraryBookCount > 0 ? estimateCost(m, libraryBookCount) * 3 : null;
                          const costStr = libCost != null ? ` - Run All: ${formatCost(libCost)}` : '';
                          return <option key={m.id} value={m.id}>{m.label}{costStr}</option>;
                        })}
                      </optgroup>
                      <optgroup label="Anthropic Claude">
                        {AI_MODELS.filter(m => m.provider === 'anthropic').map(m => {
                          const libCost = libraryBookCount > 0 ? estimateCost(m, libraryBookCount) * 3 : null;
                          const costStr = libCost != null ? ` - Run All: ${formatCost(libCost)}` : '';
                          return <option key={m.id} value={m.id}>{m.label}{costStr}</option>;
                        })}
                      </optgroup>
                    </select>
                  </div>
            </div>

            {/* Performance Controls */}
            {isTauri() && (
              <div className="bg-neutral-900/50 rounded-xl p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <Settings className="w-4 h-4 text-gray-400" />
                  <h3 className="text-lg font-semibold text-white">Performance</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-500 mb-1.5">Local AI Workers</label>
                    <select
                      value={localConfig.local_concurrency || 1}
                      onChange={(e) => setLocalConfig({ ...localConfig, local_concurrency: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                    >
                      <option value={1}>1 (Sequential)</option>
                      <option value={2}>2 books at once</option>
                      <option value={3}>3 books at once</option>
                      <option value={5}>5 books at once</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-500 mb-1.5">Cloud AI Workers</label>
                    <select
                      value={localConfig.cloud_concurrency || 5}
                      onChange={(e) => setLocalConfig({ ...localConfig, cloud_concurrency: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                    >
                      <option value={1}>1 (Slowest)</option>
                      <option value={3}>3</option>
                      <option value={5}>5 (Default)</option>
                      <option value={10}>10 (Fast)</option>
                      <option value={15}>15 (Aggressive)</option>
                    </select>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-sm text-gray-500">ABS Push Workers</label>
                    <input
                      type="number"
                      min={1}
                      value={localConfig.concurrency_abs_push || 5}
                      onChange={(e) => { const v = parseInt(e.target.value); if (v > 0) setLocalConfig({ ...localConfig, concurrency_abs_push: v }); }}
                      className="w-16 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm text-white text-center focus:outline-none"
                    />
                  </div>
                  <input
                    type="range" min={1} max={50}
                    value={Math.min(localConfig.concurrency_abs_push || 5, 50)}
                    onChange={(e) => setLocalConfig({ ...localConfig, concurrency_abs_push: parseInt(e.target.value) })}
                    className="w-full h-1.5 bg-neutral-700 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
                  />
                  <p className="text-xs text-gray-600 mt-1">Use 1-2 for NAS.</p>
                </div>
              </div>
            )}
          </div>

          {/* Right: Local AI & Whisper */}
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

                {/* Server URL (supports remote Ollama) */}
                <div>
                  <label className="block text-sm text-gray-500 mb-1.5">Ollama server URL</label>
                  <input
                    type="text"
                    value={localConfig?.ollama_base_url || ''}
                    onChange={(e) => {
                      const newConfig = { ...localConfig, ollama_base_url: e.target.value };
                      setLocalConfig(newConfig);
                    }}
                    onBlur={async () => {
                      const res = await persistConfig(localConfig);
                      if (!res?.success) toast.error('Failed to save server URL', res?.error);
                    }}
                    placeholder="http://127.0.0.1:11434"
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Leave empty to use local Ollama. For a remote instance (e.g. another machine on your network), enter the full URL including http:// and port.
                  </p>
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

            {/* Local Whisper - Speech-to-Text */}
            {isTauri() && (
              <div className="bg-neutral-900/50 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Mic className="w-4 h-4 text-violet-400" />
                    <h3 className="text-lg font-semibold text-white">Local Whisper</h3>
                  </div>
                  {whisperStatus?.installed && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-green-400" />
                      <span className="text-xs text-green-400">Installed</span>
                    </div>
                  )}
                </div>

                {/* Not installed */}
                {!whisperStatus?.installed && !whisperInstalling && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-400">
                      Run speech-to-text locally. Free, private, no API key needed for audio transcription.
                    </p>
                    <button
                      onClick={handleInstallWhisper}
                      className="w-full py-2.5 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-500 transition-colors flex items-center justify-center gap-2"
                    >
                      <Download className="w-4 h-4" />
                      Install Local Whisper
                    </button>
                  </div>
                )}

                {/* Installing */}
                {whisperInstalling && (
                  <div className="py-4">
                    <div className="flex items-center gap-2 text-sm text-violet-400">
                      <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                      {whisperDownloadProgress?.status || 'Installing whisper-cpp...'}
                    </div>
                  </div>
                )}

                {/* Installed - show models */}
                {whisperStatus?.installed && (
                  <div className="space-y-3">
                    {/* Toggle */}
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Use Local Whisper</span>
                      <button
                        onClick={() => setLocalConfig({ ...localConfig, use_local_whisper: !localConfig.use_local_whisper })}
                        className={`relative w-10 h-5 rounded-full transition-colors ${localConfig.use_local_whisper ? 'bg-violet-600' : 'bg-neutral-700'}`}
                      >
                        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${localConfig.use_local_whisper ? 'translate-x-5' : 'translate-x-0.5'}`} />
                      </button>
                    </div>

                    {/* Downloaded models */}
                    {whisperStatus.models?.length > 0 && (
                      <div>
                        <label className="block text-xs text-gray-500 mb-1.5">Downloaded Models</label>
                        {whisperStatus.models.map(m => (
                          <div key={m.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-neutral-800">
                            <div className="flex items-center gap-2">
                              <input
                                type="radio"
                                name="whisper_model"
                                checked={localConfig.whisper_model === m.id}
                                onChange={() => setLocalConfig({ ...localConfig, whisper_model: m.id })}
                                className="accent-violet-500"
                              />
                              <span className="text-sm text-white">{m.id}</span>
                              <span className="text-xs text-gray-500">{(m.size_bytes / 1e6).toFixed(0)} MB</span>
                            </div>
                            <button
                              onClick={() => handleDeleteWhisperModel(m.id)}
                              className="text-xs text-gray-600 hover:text-red-400"
                            >
                              Delete
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Download new model */}
                    {!whisperDownloading && (
                      <div>
                        <label className="block text-xs text-gray-500 mb-1.5">Download a Model</label>
                        <div className="space-y-1.5">
                          {whisperPresets.filter(p => !whisperStatus.models?.some(m => m.id === p.id)).map(preset => (
                            <button
                              key={preset.id}
                              onClick={() => setSelectedWhisperModel(preset.id)}
                              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                                selectedWhisperModel === preset.id
                                  ? 'border-violet-500 bg-violet-500/10 text-white'
                                  : 'border-neutral-700 bg-neutral-800 text-gray-400 hover:border-neutral-600'
                              }`}
                            >
                              <div className="flex justify-between items-center">
                                <span className="font-medium">{preset.label}</span>
                                <span className="text-gray-500">{preset.size_mb} MB</span>
                              </div>
                              <div className="text-xs text-gray-500 mt-0.5">{preset.description}</div>
                            </button>
                          ))}
                        </div>
                        {whisperPresets.some(p => !whisperStatus.models?.some(m => m.id === p.id)) && (
                          <button
                            onClick={handleDownloadWhisperModel}
                            className="mt-2 w-full py-2 bg-violet-600/20 text-violet-400 text-sm font-medium rounded-lg hover:bg-violet-600/30 transition-colors flex items-center justify-center gap-2"
                          >
                            <Download className="w-4 h-4" />
                            Download Model
                          </button>
                        )}
                      </div>
                    )}

                    {/* Downloading */}
                    {whisperDownloading && whisperDownloadProgress && (
                      <div className="space-y-2">
                        <div className="w-full bg-neutral-800 rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-violet-500 h-full rounded-full transition-all duration-300"
                            style={{ width: `${whisperDownloadProgress.percent || 0}%` }}
                          />
                        </div>
                        <div className="text-xs text-gray-500">{whisperDownloadProgress.status}</div>
                      </div>
                    )}

                    {/* Disk usage */}
                    {whisperDiskUsage > 0 && (
                      <div className="text-xs text-gray-600">
                        Disk usage: {(whisperDiskUsage / 1e6).toFixed(0)} MB
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <p className="text-xs text-gray-600">
                        Binary: {whisperStatus.binary_path || 'Not found'}
                      </p>
                      <button
                        onClick={handleUninstallWhisper}
                        className="text-xs text-red-500/60 hover:text-red-400 transition-colors"
                      >
                        Remove Local Whisper
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

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

                <Toggle
                  checked={localConfig.preserve_existing_genres === true}
                  onChange={(v) => setLocalConfig({ ...localConfig, preserve_existing_genres: v })}
                  label="Supplement genres instead of replacing"
                />
                <p className="text-sm text-gray-400">
                  Keep the genres a book already has (e.g. matched from Audible) and add the AI's
                  suggestions alongside them, instead of replacing them. Existing genres are never
                  removed, so a book already at the {MAX_GENRES}-genre limit keeps exactly what it
                  has. "Force" re-classification still starts fresh. Genres are also pushed to
                  AudiobookShelf as-is, bypassing the approved-list filter above. Note:
                  AudiobookShelf adds every genre it receives to your library-wide genre list.
                </p>

                <Toggle
                  checked={localConfig.preserve_existing_tags === true}
                  onChange={(v) => setLocalConfig({ ...localConfig, preserve_existing_tags: v })}
                  label="Keep unrecognized tags when pushing"
                />
                <p className="text-sm text-gray-400">
                  Tags that are not in the approved tag list are normally dropped when pushing to
                  AudiobookShelf. Enable this to send them as-is, with the casing you typed.
                  Recognized tags are still normalized to their standard form. Note: AudiobookShelf
                  adds every tag it receives to your library-wide tag list, so typos become
                  permanent library tags until removed in ABS.
                </p>
              </div>
            </div>

            <div className="flex flex-col justify-start">
              {/* #58: operation log location. Shown as a copyable path because
                  no opener plugin is configured for this app. */}
              {isTauri() && logPath && (
                <div className="bg-neutral-900/50 rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-white mb-2">Logs</h3>
                  <p className="text-sm text-gray-400 mb-3">
                    Batch operations and per-book failures are written here as they happen, so
                    the record survives a crash or a forced close. The file rotates at 5MB and
                    one previous copy is kept as <span className="font-mono">session.log.1</span>.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={logPath}
                      onFocus={(e) => e.target.select()}
                      aria-label="Log file path"
                      className="flex-1 min-w-0 px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-lg text-xs text-gray-300 font-mono"
                    />
                    <button
                      onClick={copyLogPath}
                      className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg text-sm text-gray-200 transition-colors flex items-center gap-2 flex-shrink-0"
                    >
                      {logPathCopied ? <Check className="w-4 h-4 text-green-400" /> : null}
                      {logPathCopied ? 'Copied' : 'Copy path'}
                    </button>
                  </div>
                </div>
              )}

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
        onConfirm={async () => {
          setConfirmClearKeys(false);
          const cleared = {
            ...localConfig,
            abs_api_token: '',
            openai_api_key: null,
            anthropic_api_key: null,
          };
          const res = await persistConfig(cleared);
          if (res?.success) {
            toast.success('Keys Cleared', 'All API keys and tokens have been removed from browser storage.');
          } else {
            toast.error('Clear Failed', res?.error || 'Could not remove keys. They may still be stored.');
          }
        }}
        title="Clear All API Keys"
        message="This will remove your ABS token, OpenAI key, and Anthropic key from browser storage. You'll need to re-enter them to use the app."
        confirmText="Clear All Keys"
        type="danger"
      />
    </div>
  );
}
