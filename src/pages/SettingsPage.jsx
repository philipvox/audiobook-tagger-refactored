import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, Check, X, Plus, Trash2 } from 'lucide-react';
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
// Each book uses ~2K input + ~1K output tokens across all enrichment calls
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

  useEffect(() => {
    loadProviders();
    loadAvailableProviders();
    // Get library size for cost estimate
    invoke('get_abs_cache_status').then(status => {
      if (status?.stats?.total_items) setLibraryBookCount(status.stats.total_items);
    }).catch(() => {});
  }, []);

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

          {/* Right: API & Processing */}
          <div className="space-y-6">
            {/* API Key & Model */}
            <div className="bg-neutral-900/50 rounded-xl p-5">
              <h3 className="text-sm font-medium text-white mb-4">AI Configuration</h3>
              <Input
                label="API Key"
                type="password"
                value={localConfig.openai_api_key}
                onChange={(v) => setLocalConfig({ ...localConfig, openai_api_key: v })}
                placeholder="sk-..."
              />
              <div className="mt-3">
                <Input
                  label="API Endpoint"
                  value={localConfig.ai_base_url || 'https://api.openai.com'}
                  onChange={(v) => setLocalConfig({ ...localConfig, ai_base_url: v })}
                  placeholder="https://api.openai.com"
                />
                <p className="text-[10px] text-gray-600 mt-1">OpenAI, or any compatible endpoint (Ollama: http://localhost:11434, LM Studio: http://localhost:1234)</p>
              </div>
              <div className="mt-3">
                <label className="block text-xs text-gray-500 mb-1.5">AI Model</label>
                <select
                  value={localConfig.ai_model || 'gpt-5.4-nano'}
                  onChange={(e) => setLocalConfig({ ...localConfig, ai_model: e.target.value })}
                  className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                >
                  {AI_MODELS.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                {(() => {
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
                    <span className="text-xs text-gray-500">GPT & DNA Cache</span>
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
