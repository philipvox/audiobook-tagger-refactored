// Final review "should fix" minors: data (description guard, one "AI
// configured" rule, bounded ABS error text) and UI (M-b, M-g, M-l).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockCallBackend = vi.hoisted(() => vi.fn());
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callBackend: (...a) => mockCallBackend(...a) };
});

const { applyDescriptionProcessResult } = await import('./lib/applyAiResults.js');
const { snapshotAbsMetadata, buildAbsPayload } = await import('./lib/absPayload.js');
const { isAiConfigured, usesLocalAi, absApi } = await import('./lib/proxy.js');
const { hasAiProvider } = await import('./hooks/useScan.js');
const { RenamePreviewModal } = await import('./components/RenamePreviewModal');
const { ActionBar } = await import('./components/scanner/ActionBar');
const { WelcomeModal } = await import('./components/OnboardingWizard');

const mk = (meta) => {
  const metadata = { title: 'T', author: 'A B', genres: [], tags: [], all_series: [], ...meta };
  return { id: 'g1', abs_id: 'g1', source: 'abs', metadata, abs_original: snapshotAbsMetadata(metadata), files: [] };
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { delete window.__TAURI_INTERNALS__; vi.unstubAllGlobals(); });

describe('Description Processing never stages an empty or placeholder description', () => {
  it.each([null, '', '   ', 'N/A', 'Unknown'])('%s keeps the curated text', (description) => {
    const g = applyDescriptionProcessResult(mk({ description: 'Curated text' }), { id: 'g1', success: true, changed: true, description });
    expect(g.metadata.description).toBe('Curated text');
    expect(g.changedFields || []).not.toContain('description');
    expect(buildAbsPayload(g.metadata, g.abs_original, {})).toEqual({ metadata: {} });
  });
});

describe('one definition of "AI configured", matching callAI', () => {
  it('local AI needs a model', () => {
    expect(usesLocalAi({ use_local_ai: true })).toBe(false);
    expect(usesLocalAi({ use_local_ai: true, ollama_model: 'm' })).toBe(true);
    expect(isAiConfigured({ use_local_ai: true })).toBe(false);
    expect(isAiConfigured({ use_local_ai: true, ollama_model: 'm' })).toBe(true);
    expect(isAiConfigured({ openai_api_key: 'sk' })).toBe(true);
    expect(hasAiProvider({ use_local_ai: true })).toBe(false);
  });
});

describe('ABS error text is bounded', () => {
  it('embeds at most 300 characters of the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'x'.repeat(5000) })));
    const err = await absApi('http://abs.local', 'tok', '/api/x').catch((e) => e);
    expect(err.message.startsWith('ABS API error 500: ')).toBe(true);
    expect(err.message.length).toBeLessThanOrEqual('ABS API error 500: '.length + 301);
  });
});

describe('M-b: Rename Confirm is disabled while the rename runs', () => {
  it('two quick clicks call onConfirm once', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_rename_templates') return [{ id: 't', name: 'T', file_template: '{title}' }];
      return { old_path: '/a/old.m4b', new_path: '/a/Book.m4b', changed: true };
    });
    const onConfirm = vi.fn(() => new Promise(() => {}));
    render(<RenamePreviewModal files={[{ fileId: 'f1', path: '/a/old.m4b', metadata: { title: 'Book' } }]} onConfirm={onConfirm} onCancel={() => {}} />);
    const btn = await screen.findByRole('button', { name: 'Rename 1 file' }, { timeout: 2000 });
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Renaming|Rename 1 file/ })).toBeDisabled();
  });
});

describe('M-g: Clean Genres needs a selection', () => {
  it('is disabled with nothing selected', () => {
    const groups = [{ id: 'g', metadata: { title: 'x' }, files: [] }];
    render(<ActionBar groups={groups} selectedFiles={new Set()} fileStatuses={{}} hasAbsConnection onPull={vi.fn()} onPush={vi.fn()} onSelectAll={vi.fn()} onClearSelection={vi.fn()} selectedGroupCount={0} onCleanupGenres={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Enrich metadata'));
    expect(screen.getByRole('button', { name: /Clean Genres/ })).toBeDisabled();
  });
});

describe('M-l: desktop copy', () => {
  it('the welcome screen does not talk about a browser in the desktop build', () => {
    window.__TAURI_INTERNALS__ = {};
    render(<WelcomeModal onDismiss={vi.fn()} onStartWizard={vi.fn()} onLocalOnly={vi.fn()} />);
    expect(screen.queryByText(/browser/i)).toBeNull();
    expect(screen.getByText(/Your data stays on this computer/)).toBeInTheDocument();
  });
});

