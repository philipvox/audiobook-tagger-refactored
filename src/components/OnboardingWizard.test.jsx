import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ToastProvider } from './Toast';

vi.mock('../lib/abs-client', () => ({ importLibrary: vi.fn() }));
vi.mock('../lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, absApi: vi.fn() };
});

const app = {
  config: {},
  saveConfig: vi.fn(),
  setGroups: vi.fn(),
  groups: [],
};
vi.mock('../context/AppContext', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useApp: () => app };
});

const { SetupWizard, WelcomeModal, hasCompletedOnboarding } = await import('./OnboardingWizard');
const { importLibrary } = await import('../lib/abs-client');
const { DEFAULT_ANTHROPIC_MODEL } = await import('../lib/configSave.js');

const CONNECTED = { abs_base_url: 'http://abs.local', abs_api_token: 'tok', abs_library_id: 'lib1' };

function renderWizard() {
  const onClose = vi.fn();
  render(<ToastProvider><SetupWizard onClose={onClose} /></ToastProvider>);
  return { onClose };
}

const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  app.config = { ...CONNECTED };
  app.groups = [];
  app.saveConfig.mockResolvedValue({ success: true });
});

describe('SetupWizard import step (H-10)', () => {
  it('puts the imported groups in the workspace, and shows "N books imported" only once the import resolved', async () => {
    const imported = [
      { id: 'li-1', metadata: { title: 'A' }, files: [] },
      { id: 'li-2', metadata: { title: 'B' }, files: [] },
    ];
    let finish;
    importLibrary.mockImplementation((_cfg, onProgress) => new Promise((resolve) => {
      onProgress?.(1, 2, 'Processing A...');
      finish = () => resolve(imported);
    }));

    renderWizard();
    await act(async () => { next(); });
    await act(async () => { next(); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Import Library/ })); });

    // Still importing: progress is shown, the success box is not.
    await waitFor(() => expect(importLibrary).toHaveBeenCalled());
    expect(screen.queryByText(/books imported/)).not.toBeInTheDocument();
    expect(app.setGroups).not.toHaveBeenCalled();

    await act(async () => { finish(); });

    await waitFor(() => expect(screen.getByText('2 books imported')).toBeInTheDocument());
    expect(app.setGroups).toHaveBeenCalledTimes(1);
    // Applied through the same merge the Library import uses.
    const update = app.setGroups.mock.calls[0][0];
    expect(typeof update).toBe('function');
    expect(update([])).toEqual(imported);
  });

  it('keeps staged work: a book with unpushed edits is not replaced by the wizard import', async () => {
    const staged = { id: 'li-1', metadata: { title: 'Edited' }, files: [], total_changes: 1, changedFields: ['title'] };
    const fresh = { id: 'li-1', metadata: { title: 'Server' }, files: [] };
    const extra = { id: 'li-2', metadata: { title: 'New' }, files: [] };
    importLibrary.mockResolvedValue([fresh, extra]);

    renderWizard();
    await act(async () => { next(); });
    await act(async () => { next(); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Import Library/ })); });

    await waitFor(() => expect(app.setGroups).toHaveBeenCalled());
    const merged = app.setGroups.mock.calls[0][0]([staged]);
    expect(merged).toEqual([staged, extra]);
  });

  it('a failed import shows the error and no success box', async () => {
    importLibrary.mockRejectedValue(new Error('ABS API error 401: Unauthorized'));
    renderWizard();
    await act(async () => { next(); });
    await act(async () => { next(); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Import Library/ })); });

    await waitFor(() => expect(screen.getByText('Import Failed')).toBeInTheDocument());
    expect(screen.getByText('ABS API error 401: Unauthorized')).toBeInTheDocument();
    expect(screen.queryByText(/books imported/)).not.toBeInTheDocument();
    expect(app.setGroups).not.toHaveBeenCalled();
  });
});

describe('SetupWizard AI step (M-11)', () => {
  it('an Anthropic-only user leaves the AI step with an Anthropic model selected', async () => {
    renderWizard();
    await act(async () => { next(); });
    fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-ant-123' } });
    await act(async () => { next(); });

    const saved = app.saveConfig.mock.calls.at(-1)[0];
    expect(saved.ai_model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(saved.ai_base_url).toBe('https://api.anthropic.com');
  });

  it('local AI already on satisfies the AI step (no Skip offered)', async () => {
    app.config = { ...CONNECTED, use_local_ai: true, ollama_model: 'gemma4' };
    renderWizard();
    await act(async () => { next(); });
    expect(screen.getByText('Add AI Key')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });

  it('with no provider at all the AI step offers Skip', async () => {
    renderWizard();
    await act(async () => { next(); });
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  });
});

describe('WelcomeModal local-folders choice', () => {
  it('offers "I only use local folders", which completes onboarding and goes to the Library', () => {
    const onLocalOnly = vi.fn();
    const onDismiss = vi.fn();
    const onStartWizard = vi.fn();
    render(<WelcomeModal onDismiss={onDismiss} onStartWizard={onStartWizard} onLocalOnly={onLocalOnly} />);

    const option = screen.getByRole('button', { name: /I only use local folders/ });
    expect(option).toHaveTextContent('Skip the AudiobookShelf setup. Connect it later from Settings.');
    fireEvent.click(option);

    expect(hasCompletedOnboarding()).toBe(true);
    expect(onLocalOnly).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onStartWizard).not.toHaveBeenCalled();
  });
});
