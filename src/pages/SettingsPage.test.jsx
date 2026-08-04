// src/pages/SettingsPage.test.jsx
// Regression tests for Task 8 (audit 2026-07-22):
// - H6: handleSave must check saveConfig's {success} result and NEVER show
//   "Saved!" optimistically when the write failed.
// - L3: configsEqual powers the dirty-flag sync of localConfig from context.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsPage, configsEqual } from './SettingsPage';
import { ToastProvider } from '../components/Toast';

// isTauri() is false in jsdom, so the Ollama/Whisper mount effects early-return.
// Only loadProviders/loadAvailableProviders run; the {} default covers them.
vi.mock('../api', () => ({
  callBackend: vi.fn(async () => ({})),
  ollamaCall: vi.fn(async () => ({})),
}));

const saveConfigMock = vi.fn();

vi.mock('../context/AppContext', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useApp: () => ({
      config: { abs_base_url: '', abs_api_token: '', openai_api_key: null, anthropic_api_key: null },
      saveConfig: saveConfigMock,
      loadConfig: vi.fn(),
      groups: [],
    }),
  };
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

// #54: "supplement genres instead of replacing". The flag must default to OFF
// (an absent key reads as false) and persist through the normal save path.
describe('SettingsPage preserve_existing_genres toggle (#54)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
  });

  it('renders unchecked when the config has no preserve_existing_genres key', async () => {
    renderPage();
    const toggle = await screen.findByLabelText(/Supplement genres instead of replacing/i);
    expect(toggle).not.toBeChecked();
  });

  it('persists the flag as true once toggled on and saved', async () => {
    renderPage();
    const toggle = await screen.findByLabelText(/Supplement genres instead of replacing/i);
    fireEvent.click(toggle);

    fireEvent.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({ preserve_existing_genres: true });
  });
});
