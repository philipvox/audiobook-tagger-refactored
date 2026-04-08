import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useToast } from './Toast';
import { X, ArrowRight, ArrowLeft, Shield, Server, Key, Download, Check, Sparkles, AlertTriangle } from 'lucide-react';

const ONBOARDING_KEY = 'audiobook_tagger_onboarding_completed';

export function hasCompletedOnboarding() {
  try { return localStorage.getItem(ONBOARDING_KEY) === 'true'; } catch { return false; }
}

export function markOnboardingComplete() {
  try { localStorage.setItem(ONBOARDING_KEY, 'true'); } catch {}
}

// ============================================================================
// Welcome Modal — minimal first-run screen
// ============================================================================

export function WelcomeModal({ onDismiss, onStartWizard }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden">
        <div className="p-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 mb-5">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Audiobook Tagger</h1>
          <p className="text-gray-400 text-sm mb-6">
            AI-powered metadata manager for AudiobookShelf. Fix genres, tags, descriptions, and more across your entire library.
          </p>

          <div className="space-y-3 mb-6 text-left">
            <div className="bg-neutral-800/50 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-white font-medium mb-1">Your data stays in your browser</p>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    API keys and server credentials are stored locally and never sent to us.
                    AI requests go directly from your browser to OpenAI or Anthropic.
                    This app has no backend server.
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-amber-900/20 border border-amber-600/20 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-white font-medium mb-1">Push writes to your ABS server</p>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    When you click <strong className="text-gray-300">Push</strong>, changes are written directly to your AudiobookShelf server.
                    This overwrites existing metadata (genres, tags, descriptions, series) and <strong className="text-gray-300">cannot be undone</strong> from this app.
                    Review changes carefully before pushing. Consider backing up your ABS database first.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => {
                markOnboardingComplete();
                onDismiss();
              }}
              className="flex-1 px-4 py-3 text-sm font-medium text-gray-400 bg-neutral-800 rounded-xl hover:bg-neutral-700 transition-colors"
            >
              Go to Settings
            </button>
            <button
              onClick={onStartWizard}
              className="flex-1 px-4 py-3 text-sm font-medium text-white bg-blue-600 rounded-xl hover:bg-blue-500 transition-colors flex items-center justify-center gap-2"
            >
              Setup Wizard
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Setup Wizard — interactive step-through with embedded inputs
// ============================================================================

const AI_MODELS = [
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano (Recommended)', provider: 'openai', cost: '~$0.01/book' },
  { id: 'gpt-5-nano', label: 'GPT-5 Nano (Cheapest)', provider: 'openai', cost: '~$0.003/book' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', cost: '~$0.01/book' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', cost: '~$0.05/book' },
];

function StepIndicator({ current, total }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === current ? 'w-6 bg-blue-500' : i < current ? 'w-1.5 bg-blue-500/50' : 'w-1.5 bg-neutral-700'
          }`}
        />
      ))}
    </div>
  );
}

function WizardInput({ label, type = 'text', value, onChange, placeholder, link }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-sm text-gray-400">{label}</label>
        {link && (
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">
            {link.text}
          </a>
        )}
      </div>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors"
      />
    </div>
  );
}

export function SetupWizard({ onClose }) {
  const { config, saveConfig } = useApp();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [localConfig, setLocalConfig] = useState({ ...config });
  const [connectionStatus, setConnectionStatus] = useState(null);
  const [libraries, setLibraries] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importCount, setImportCount] = useState(0);

  const STEPS = [
    { icon: Server, title: 'Connect AudiobookShelf', subtitle: 'Link your ABS server' },
    { icon: Key, title: 'Add AI Key', subtitle: 'Choose your AI provider' },
    { icon: Download, title: 'Import Library', subtitle: 'Pull your books in' },
    { icon: Check, title: 'Ready!', subtitle: "You're all set" },
  ];

  const testConnection = async () => {
    setConnectionStatus('testing');
    try {
      const { absApi } = await import('../lib/proxy');
      const data = await absApi(localConfig.abs_base_url, localConfig.abs_api_token, '/api/libraries');
      const libs = data.libraries || [];
      setLibraries(libs);
      setConnectionStatus('success');
      if (libs.length > 0 && !localConfig.abs_library_id) {
        setLocalConfig(prev => ({ ...prev, abs_library_id: libs[0].id }));
      }
    } catch {
      setConnectionStatus('error');
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      // Save config first so import can use it
      await saveConfig(localConfig);
      const { importLibrary } = await import('../lib/abs-client');
      const groups = await importLibrary(localConfig, (current, total) => {
        setImportCount(current);
      });
      setImportCount(groups.length);
      // Dispatch event so ScannerPage picks up the import
      window.dispatchEvent(new CustomEvent('wizard-import-complete', { detail: { groups } }));
      toast.success('Import Complete', `Imported ${groups.length} books from your library.`);
    } catch (e) {
      toast.error('Import Failed', String(e));
    }
    setImporting(false);
  };

  const canAdvance = () => {
    switch (step) {
      case 0: return connectionStatus === 'success';
      case 1: return !!(localConfig.openai_api_key || localConfig.anthropic_api_key);
      case 2: return true; // can skip import
      case 3: return true;
      default: return true;
    }
  };

  const handleNext = async () => {
    if (step < 3) {
      // Save config at each step
      await saveConfig(localConfig);
      setStep(step + 1);
    } else {
      markOnboardingComplete();
      onClose();
    }
  };

  const handleBack = () => {
    if (step > 0) setStep(step - 1);
  };

  const handleClose = () => {
    markOnboardingComplete();
    saveConfig(localConfig);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              {(() => {
                const Icon = STEPS[step].icon;
                return <Icon className="w-4 h-4 text-blue-400" />;
              })()}
              <h2 className="text-base font-semibold text-white">{STEPS[step].title}</h2>
            </div>
            <p className="text-sm text-gray-400">{STEPS[step].subtitle}</p>
          </div>
          <button onClick={handleClose} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 pb-4 min-h-[220px]">
          {step === 0 && (
            <div className="space-y-3">
              <WizardInput
                label="Server URL"
                value={localConfig.abs_base_url}
                onChange={(v) => { setLocalConfig({ ...localConfig, abs_base_url: v }); setConnectionStatus(null); }}
                placeholder="https://your-abs-server.com"
              />
              <WizardInput
                label="API Token"
                type="password"
                value={localConfig.abs_api_token}
                onChange={(v) => { setLocalConfig({ ...localConfig, abs_api_token: v }); setConnectionStatus(null); }}
                placeholder="Paste your ABS API token"
                link={localConfig.abs_base_url ? {
                  url: `${localConfig.abs_base_url.replace(/\/$/, '')}/config/api-keys`,
                  text: 'Get token from ABS'
                } : null}
              />
              {libraries.length > 0 && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Library</label>
                  <select
                    value={localConfig.abs_library_id || ''}
                    onChange={(e) => setLocalConfig({ ...localConfig, abs_library_id: e.target.value })}
                    className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                  >
                    {libraries.map(lib => (
                      <option key={lib.id} value={lib.id}>{lib.name} ({lib.mediaType})</option>
                    ))}
                  </select>
                </div>
              )}
              <button
                onClick={testConnection}
                disabled={!localConfig.abs_base_url || !localConfig.abs_api_token || connectionStatus === 'testing'}
                className={`w-full py-2.5 text-sm font-medium rounded-lg transition-colors ${
                  connectionStatus === 'success'
                    ? 'bg-green-600/20 text-green-400'
                    : connectionStatus === 'error'
                    ? 'bg-red-600/20 text-red-400'
                    : 'bg-neutral-800 text-gray-300 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {connectionStatus === 'testing' ? 'Connecting...'
                  : connectionStatus === 'success' ? `Connected (${libraries.length} ${libraries.length === 1 ? 'library' : 'libraries'})`
                  : connectionStatus === 'error' ? 'Connection Failed -- Check URL & Token'
                  : 'Test Connection'}
              </button>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400 mb-3">
                Enter an API key for OpenAI or Anthropic Claude. You only need one. Keys are stored in your browser only.
              </p>
              <WizardInput
                label="OpenAI API Key"
                type="password"
                value={localConfig.openai_api_key}
                onChange={(v) => setLocalConfig({ ...localConfig, openai_api_key: v })}
                placeholder="sk-..."
                link={{ url: 'https://platform.openai.com/api-keys', text: 'Get a key' }}
              />
              <WizardInput
                label="Anthropic (Claude) API Key"
                type="password"
                value={localConfig.anthropic_api_key}
                onChange={(v) => setLocalConfig({ ...localConfig, anthropic_api_key: v })}
                placeholder="sk-ant-..."
                link={{ url: 'https://console.anthropic.com/settings/keys', text: 'Get a key' }}
              />
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">AI Model</label>
                <select
                  value={localConfig.ai_model || 'gpt-5-nano'}
                  onChange={(e) => {
                    const model = AI_MODELS.find(m => m.id === e.target.value);
                    setLocalConfig({
                      ...localConfig,
                      ai_model: e.target.value,
                      ai_base_url: model?.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com',
                    });
                  }}
                  className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none cursor-pointer"
                >
                  {AI_MODELS.map(m => (
                    <option key={m.id} value={m.id}>{m.label} ({m.cost})</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400">
                Import your library from AudiobookShelf. This pulls book metadata (titles, authors, genres) into the tagger for processing.
              </p>
              {importCount > 0 ? (
                <div className="bg-green-600/10 border border-green-600/20 rounded-xl p-4 text-center">
                  <Check className="w-8 h-8 text-green-400 mx-auto mb-2" />
                  <p className="text-sm text-green-400 font-medium">{importCount} books imported</p>
                  <p className="text-sm text-gray-400 mt-1">Click Next to finish setup</p>
                </div>
              ) : (
                <button
                  onClick={handleImport}
                  disabled={importing}
                  className="w-full py-3 text-sm font-medium rounded-xl bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {importing ? (
                    <>Importing... ({importCount} books)</>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Import Library
                    </>
                  )}
                </button>
              )}
              <p className="text-xs text-gray-500 text-center">
                You can also import later from the Library toolbar.
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="text-center py-4">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-600/20 mb-4">
                <Check className="w-6 h-6 text-green-400" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">You're all set!</h3>
              <p className="text-sm text-gray-400 mb-4">
                Your library is connected and ready to go. Here's what you can do:
              </p>
              <div className="text-left space-y-2 bg-neutral-800/50 rounded-xl p-4">
                <div className="flex items-start gap-2">
                  <span className="text-blue-400 text-sm font-bold mt-0.5">1.</span>
                  <p className="text-sm text-gray-300"><strong>Enrich</strong> -- AI classifies genres, tags, and age ratings</p>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-blue-400 text-sm font-bold mt-0.5">2.</span>
                  <p className="text-sm text-gray-300"><strong>DNA</strong> -- Generates a unique fingerprint for each book (mood, pacing, themes)</p>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-blue-400 text-sm font-bold mt-0.5">3.</span>
                  <p className="text-sm text-gray-300"><strong>Push</strong> -- Sends your changes back to AudiobookShelf</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-between border-t border-neutral-800">
          <StepIndicator current={step} total={4} />
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={handleBack}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
            )}
            {step < 3 && !canAdvance() && (
              <button
                onClick={handleNext}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-400 transition-colors"
              >
                Skip
              </button>
            )}
            <button
              onClick={handleNext}
              className="px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-500 transition-colors flex items-center gap-1.5"
            >
              {step === 3 ? 'Done' : 'Next'}
              {step < 3 && <ArrowRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
