// src/pages/SettingsPage.test.jsx
// Regression tests for Task 8 (audit 2026-07-22):
// - H6: handleSave must check saveConfig's {success} result and NEVER show
//   "Saved!" optimistically when the write failed.
// - L3: configsEqual powers the dirty-flag sync of localConfig from context.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsPage, configsEqual } from './SettingsPage';
import { ToastProvider } from '../components/Toast';

// isTauri() is false by default, so the Ollama/Whisper mount effects
// early-return and only loadProviders/loadAvailableProviders run; the {}
// default covers them. Task 11 tests switch `env.tauri` on and give the
// Ollama/Whisper commands real-shaped answers through `env.responses`.
const env = vi.hoisted(() => ({ tauri: false, responses: {}, config: null }));
const BASE_CONFIG = { abs_base_url: '', abs_api_token: '', openai_api_key: null, anthropic_api_key: null };

vi.mock('../api', () => ({
  callBackend: vi.fn(async (cmd) => (cmd in env.responses ? env.responses[cmd] : {})),
  ollamaCall: vi.fn(async (cmd) => (cmd in env.responses ? env.responses[cmd] : {})),
}));
vi.mock('../lib/platform.js', () => ({ isTauri: () => env.tauri }));
// The Tauri-mode effects subscribe to install/pull progress events.
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
// The library auto-detect calls absApi once a URL and token are typed.
vi.mock('../lib/proxy', () => ({ absApi: vi.fn(async () => ({ libraries: [] })) }));

const saveConfigMock = vi.fn();

vi.mock('../context/AppContext', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useApp: () => ({
      config: env.config || BASE_CONFIG,
      saveConfig: saveConfigMock,
      loadConfig: vi.fn(),
      groups: [],
    }),
  };
});

beforeEach(() => {
  env.tauri = false;
  env.responses = {};
  env.config = null;
});

function renderPage() {
  return render(
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>
  );
}

describe('configsEqual (L3 dirty flag)', () => {
  it('treats identical references and shallow-equal objects as equal', () => {
    const a = { x: 1, y: 'z' };
    expect(configsEqual(a, a)).toBe(true);
    expect(configsEqual({ x: 1, y: 'z' }, { x: 1, y: 'z' })).toBe(true);
  });

  it('detects a changed primitive value', () => {
    expect(configsEqual({ x: 1 }, { x: 2 })).toBe(false);
  });

  it('detects added or removed keys', () => {
    expect(configsEqual({ x: 1 }, { x: 1, y: 2 })).toBe(false);
  });

  it('compares nested arrays/objects by value', () => {
    expect(configsEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(configsEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
  });

  it('handles null operands', () => {
    expect(configsEqual(null, null)).toBe(true);
    expect(configsEqual(null, { x: 1 })).toBe(false);
  });
});

describe('SettingsPage handleSave (H6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT show "Saved!" and surfaces an error when saveConfig fails', async () => {
    saveConfigMock.mockResolvedValue({ success: false, error: 'disk full' });
    renderPage();

    const saveBtn = await screen.findByRole('button', { name: /Save Settings/i });
    fireEvent.click(saveBtn);

    // Failure must surface visibly...
    await waitFor(() => {
      expect(screen.getByText('Save Failed')).toBeInTheDocument();
    });
    // ...and the button must never claim success.
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });

  it('shows "Saved!" only when saveConfig reports success', async () => {
    saveConfigMock.mockResolvedValue({ success: true });
    renderPage();

    const saveBtn = await screen.findByRole('button', { name: /Save Settings/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText('Saved!')).toBeInTheDocument();
    });
    expect(screen.queryByText('Save Failed')).not.toBeInTheDocument();
  });
});

// #54: "supplement genres instead of replacing". The flag defaults to ON
// (an absent key reads as true) and persist through the normal save path.
describe('SettingsPage preserve_existing_genres toggle (#54)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
  });

  it('renders checked when the config has no preserve_existing_genres key (default ON)', async () => {
    renderPage();
    const toggle = await screen.findByLabelText(/Keep existing genres and add AI suggestions/i);
    expect(toggle).toBeChecked();
  });

  it('persists the flag as false once toggled off and saved', async () => {
    renderPage();
    const toggle = await screen.findByLabelText(/Keep existing genres and add AI suggestions/i);
    fireEvent.click(toggle);

    fireEvent.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ preserve_existing_genres: false });
  });
});

// #54 push boundary: same shape for the tag flag.
describe('SettingsPage preserve_existing_tags toggle (#54)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
  });

  it('renders unchecked when the config has no preserve_existing_tags key', async () => {
    renderPage();
    const toggle = await screen.findByLabelText(/Keep unrecognized tags when pushing/i);
    expect(toggle).not.toBeChecked();
  });

  it('persists the flag as true once toggled on and saved', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Keep unrecognized tags when pushing/i));
    fireEvent.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ preserve_existing_tags: true });
  });
});

// ---------------------------------------------------------------------------
// Task 11 (H-11, H-12, M-11): local-AI switch, save clean-ups, removed controls.
// ---------------------------------------------------------------------------

const { callBackend, ollamaCall } = await import('../api');
const { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } = await import('../lib/configSave.js');

function tauriWith({ running = true, models = [] } = {}) {
  env.tauri = true;
  env.responses = {
    ollama_get_status: { installed: true, running, models, version: '0.6.0' },
    ollama_get_model_presets: [],
    ollama_get_disk_usage: 0,
    ollama_stop: 'Ollama was not started by this app; leaving it running',
    whisper_local_get_status: { installed: false, models: [] },
    whisper_local_get_model_presets: [],
    whisper_local_get_disk_usage: 0,
    get_log_path: '',
    get_custom_providers: [],
    get_available_providers: [],
  };
}

const localAiSwitch = () => screen.findByRole('switch', { name: 'Use Local AI' });

// Tauri mode mounts two progress listeners, each through
// `await import('@tauri-apps/api/event')`. When two such imports race, vitest
// hands the second one the real module instead of the mock, and the real
// listen() needs the Tauri IPC bridge. A no-op bridge keeps it quiet.
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async () => 0 };
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
afterAll(() => {
  delete window.__TAURI_INTERNALS__;
  delete window.__TAURI_EVENT_PLUGIN_INTERNALS__;
});

async function renderTauriPage() {
  renderPage();
  await screen.findByRole('switch', { name: 'Use Local AI' });
}

describe('SettingsPage "Use Local AI" switch (H-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
  });

  it('shows config.use_local_ai, not whether Ollama is running, and turns it on for an Ollama the app did not start', async () => {
    tauriWith({ running: true, models: [{ name: 'llama3:8b', size_bytes: 1 }] });
    env.config = { ...BASE_CONFIG, openai_api_key: 'sk-x', use_local_ai: false };
    await renderTauriPage();

    const sw = await localAiSwitch();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    // The old toggle read "Stop Local AI" whenever Ollama ran.
    expect(screen.queryByText('Stop Local AI')).not.toBeInTheDocument();

    fireEvent.click(sw);
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ use_local_ai: true, ollama_model: 'llama3:8b', openai_api_key: 'sk-x' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('reads on when use_local_ai is set, even with Ollama stopped', async () => {
    tauriWith({ running: false, models: [] });
    env.config = { ...BASE_CONFIG, use_local_ai: true, ollama_model: 'llama3:8b' };
    await renderTauriPage();
    expect(await localAiSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('turning it on with zero models shows "Download a model first" and leaves the config unchanged', async () => {
    tauriWith({ running: true, models: [] });
    env.config = { ...BASE_CONFIG, use_local_ai: false };
    await renderTauriPage();

    const sw = await localAiSwitch();
    // Let the first status poll land.
    await waitFor(() => expect(screen.getByText('Running')).toBeInTheDocument());
    fireEvent.click(sw);

    await waitFor(() => expect(screen.getByText('Download a model first')).toBeInTheDocument());
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('"Stop Ollama" stops the process only and never changes use_local_ai', async () => {
    tauriWith({ running: true, models: [{ name: 'llama3:8b', size_bytes: 1 }] });
    env.config = { ...BASE_CONFIG, use_local_ai: true, ollama_model: 'llama3:8b' };
    await renderTauriPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Stop Ollama' }));
    await waitFor(() => expect(callBackend).toHaveBeenCalledWith('ollama_stop'));
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(await localAiSwitch()).toHaveAttribute('aria-checked', 'true');
  });
});

describe('SettingsPage save clean-ups (M-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
  });

  it('with only an Anthropic key, saving switches ai_model to the default Anthropic model', async () => {
    env.config = { ...BASE_CONFIG, anthropic_api_key: 'sk-ant', ai_model: 'gpt-5-nano' };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Save Settings/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ ai_model: DEFAULT_ANTHROPIC_MODEL, ai_base_url: 'https://api.anthropic.com' });
  });

  it('with only an OpenAI key, saving switches a Claude model to the default OpenAI model', async () => {
    env.config = { ...BASE_CONFIG, openai_api_key: 'sk-x', ai_model: 'claude-sonnet-4-6' };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Save Settings/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ ai_model: DEFAULT_OPENAI_MODEL, ai_base_url: 'https://api.openai.com' });
  });

  it('handleSave trims the ABS URL and token and strips trailing slashes', async () => {
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText('http://192.168.1.100:13378'), { target: { value: '  http://abs.local:13378//  ' } });
    fireEvent.change(screen.getByPlaceholderText('Enter token'), { target: { value: '  tok-123 \n' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Settings/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ abs_base_url: 'http://abs.local:13378', abs_api_token: 'tok-123' });
  });

  it('blurring the Ollama URL field persists only ollama_base_url, not other unsaved edits', async () => {
    tauriWith({ running: false });
    env.config = { ...BASE_CONFIG, abs_base_url: 'http://saved.local' };
    await renderTauriPage();

    fireEvent.change(await screen.findByPlaceholderText('http://192.168.1.100:13378'), { target: { value: 'not a url' } });
    const ollamaUrl = screen.getByPlaceholderText('http://127.0.0.1:11434');
    fireEvent.change(ollamaUrl, { target: { value: ' http://gpu-box:11434 ' } });
    fireEvent.blur(ollamaUrl);

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    const saved = saveConfigMock.mock.calls[0][0];
    expect(saved.ollama_base_url).toBe('http://gpu-box:11434');
    expect(saved.abs_base_url).toBe('http://saved.local');
    // The unsaved ABS edit is still in the form.
    expect(screen.getByPlaceholderText('http://192.168.1.100:13378')).toHaveValue('not a url');
  });
});

describe('SettingsPage removed and bounded controls (H-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
  });

  it('"Local AI Workers" and "Approved Genres" are gone; "ABS Push Workers" is a 1 to 10 control', async () => {
    tauriWith({ running: false });
    await renderTauriPage();
    const push = await screen.findByLabelText('ABS Push Workers');
    expect(push.tagName).toBe('SELECT');
    expect([...push.options].map(o => Number(o.value))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(push).toHaveValue('3');
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByText('Local AI Workers')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Prompt Customization' }));
    expect(screen.getByText('System Prompt')).toBeInTheDocument();
    expect(screen.queryByText('Approved Genres')).not.toBeInTheDocument();
  });

  it('a stored push-workers value above 10 shows as 10; picking a value saves it', async () => {
    tauriWith({ running: false });
    env.config = { ...BASE_CONFIG, concurrency_abs_push: 50 };
    await renderTauriPage();
    const push = await screen.findByLabelText('ABS Push Workers');
    expect(push).toHaveValue('10');
    fireEvent.change(push, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Settings/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ concurrency_abs_push: 2 });
  });

  it('stored local_concurrency and custom_approved_genres survive a save and "Reset all prompts"', async () => {
    env.config = { ...BASE_CONFIG, local_concurrency: 3, custom_approved_genres: 'Fantasy, Mystery', custom_system_prompt: 'mine' };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Prompt Customization' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all prompts to defaults' }));
    fireEvent.click(screen.getByRole('button', { name: /Save Settings/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({
      local_concurrency: 3, custom_approved_genres: 'Fantasy, Mystery', custom_system_prompt: '',
    });
  });
});

describe('SettingsPage "Use Local AI" switch with a stopped Ollama (H-12, fix round 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
  });

  it('running with models: a saved model that is not installed is replaced by the first installed one', async () => {
    tauriWith({ running: true, models: [{ name: 'qwen3:4b', size_bytes: 1 }, { name: 'llama3:8b', size_bytes: 1 }] });
    env.config = { ...BASE_CONFIG, use_local_ai: false, ollama_model: 'gone:1b' };
    await renderTauriPage();
    await waitFor(() => expect(screen.getByText('Running')).toBeInTheDocument());
    fireEvent.click(await localAiSwitch());
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ use_local_ai: true, ollama_model: 'qwen3:4b' });
  });

  it('not running with a saved model: turns on, keeps the saved model, and says to start Ollama', async () => {
    tauriWith({ running: false, models: [] });
    env.config = { ...BASE_CONFIG, use_local_ai: false, ollama_model: 'llama3:8b' };
    await renderTauriPage();
    await waitFor(() => expect(screen.getByText('Stopped')).toBeInTheDocument());
    const sw = await localAiSwitch();
    fireEvent.click(sw);

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ use_local_ai: true, ollama_model: 'llama3:8b' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('Local AI is on. Start Ollama to use it.')).toBeInTheDocument();
    expect(screen.queryByText('Download a model first')).not.toBeInTheDocument();
  });

  it('not running and no saved model: "Start Ollama first", config unchanged', async () => {
    tauriWith({ running: false, models: [] });
    env.config = { ...BASE_CONFIG, use_local_ai: false };
    await renderTauriPage();
    await waitFor(() => expect(screen.getByText('Stopped')).toBeInTheDocument());
    const sw = await localAiSwitch();
    fireEvent.click(sw);

    await waitFor(() => expect(screen.getByText('Start Ollama first')).toBeInTheDocument());
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('"Start Ollama" reads the status once after starting', async () => {
    tauriWith({ running: false, models: [] });
    env.config = { ...BASE_CONFIG, use_local_ai: false };
    await renderTauriPage();
    const start = await screen.findByRole('button', { name: 'Start Ollama' });
    const statusCalls = () => ollamaCall.mock.calls.filter(([cmd]) => cmd === 'ollama_get_status').length;
    const before = statusCalls();
    fireEvent.click(start);
    await waitFor(() => expect(ollamaCall).toHaveBeenCalledWith('ollama_start'));
    await waitFor(() => expect(screen.getByText('Ollama started')).toBeInTheDocument());
    expect(statusCalls() - before).toBe(1);
  });
});

describe('SettingsPage Ollama URL validation (M-11, fix round 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
  });

  it('an invalid Ollama URL gets an Ollama message on blur and is not saved by Save Settings either', async () => {
    tauriWith({ running: false });
    await renderTauriPage();
    const field = screen.getByPlaceholderText('http://127.0.0.1:11434');
    fireEvent.change(field, { target: { value: 'gpu-box:11434' } });
    fireEvent.blur(field);

    await waitFor(() => expect(screen.getByText('Invalid Ollama URL')).toBeInTheDocument());
    expect(screen.getByText(/for example http:\/\/localhost:11434/)).toBeInTheDocument();
    expect(screen.queryByText(/13378/)).not.toBeInTheDocument();
    expect(saveConfigMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Save Settings/i }));
    await waitFor(() => expect(screen.getAllByText('Invalid Ollama URL').length).toBeGreaterThan(1));
    expect(saveConfigMock).not.toHaveBeenCalled();
  });
});
