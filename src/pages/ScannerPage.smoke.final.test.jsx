// Smoke test (final review recommendation): mount ScannerPage with the backend
// mocked and click through the main journeys. String-based wiring tests could
// not see that the import bar never rendered (I-1) or that Check by Audio sent
// local books to ABS (I-3); this test drives the real page.
//
// Local book: Scan Folder, Write Tags, Undo (with its confirm), Check by Audio.
// ABS book: Import (with a working Cancel, then for real), Push.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

const state = vi.hoisted(() => ({ undo: null, calls: [], actual: null }));

const backend = vi.hoisted(() => vi.fn());
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  state.actual = actual;
  return {
    ...actual,
    callBackend: (...a) => backend(...a),
    pickPath: vi.fn(async () => ['/books']),
    askToConfirm: vi.fn(async () => true),
  };
});
vi.mock('../lib/proxy', async (importOriginal) => ({ ...(await importOriginal()), absApi: vi.fn() }));

const { AppProvider } = await import('../context/AppContext');
const { ToastProvider } = await import('../components/Toast');
const { ScannerPage } = await import('./ScannerPage');
const { absApi } = await import('../lib/proxy');

const CONFIG = { abs_base_url: 'http://abs.local', abs_api_token: 'tok', abs_library_id: 'lib1', openai_api_key: 'sk-test', use_local_ai: false };
const PATH = '/books/Local Book/book.m4b';
const localScan = () => ({
  total_files: 1,
  groups: [{
    id: 'uuid-1', group_name: 'Local Book', metadata: { title: 'Local Book', author: 'Unknown' },
    files: [{ id: 'file-1', path: PATH, filename: 'book.m4b', changes: { title: { old: 'Old Title', new: 'Local Book' } } }],
    total_changes: 1, changedFields: ['title'],
  }],
});
const absItem = { id: 'li-1', media: { metadata: { title: 'ABS Book', authorName: 'Jane Doe', genres: ['Fantasy'] }, tags: ['favorite'] } };

function handle(cmd, args) {
  state.calls.push([cmd, args]);
  switch (cmd) {
    case 'get_config': return { ...CONFIG };
    case 'load_session': return null;
    case 'get_undo_status': return state.undo || { available: false, count: 0, books_count: 0, age_seconds: 0, files: [] };
    case 'get_scan_progress': return { current: 0, total: 0 };
    case 'scan_library': return localScan();
    case 'write_tags':
      state.undo = { available: true, count: 1, books_count: 1, age_seconds: 7200, files: [PATH] };
      return { success: 1, failed: 0, errors: [], results: [{ file_id: 'file-1', path: PATH, status: 'success', skipped_fields: [] }] };
    case 'undo_last_write':
      state.undo = null;
      return { success: 1, failed: 0, restored_files: [PATH], files: [PATH], results: [] };
    case 'batch_extract_audio_intros':
      return args.items.map((i) => ({ item_id: i.item_id, transcript: 'Narrated by Jim Dale', narrators: ['Jim Dale'], authors: [], status: 'ok' }));
    case 'import_from_abs':
    case 'push_abs_imports':
      return state.actual.callBackend(cmd, args);
    default: return null;
  }
}

const calledWith = (cmd) => state.calls.filter(([c]) => c === cmd);
const pill = (name) => screen.getByRole('button', { name: new RegExp(`^${name}$`) });

async function mount() {
  render(<AppProvider><ToastProvider><ScannerPage onNavigateToSettings={vi.fn()} activeTab="scanner" navigateTo={vi.fn()} logoSvg="" /></ToastProvider></AppProvider>);
  await waitFor(() => expect(calledWith('get_config').length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByRole('button', { name: /^Import$/ })).not.toBeDisabled());
}

beforeEach(() => {
  window.__TAURI_INTERNALS__ = {};
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify(CONFIG));
  state.undo = null;
  state.calls = [];
  backend.mockReset();
  backend.mockImplementation(async (cmd, args) => handle(cmd, args));
  absApi.mockReset();
});
afterEach(() => { delete window.__TAURI_INTERNALS__; });

describe('ScannerPage smoke: a local book', () => {
  it('Scan Folder, Write Tags, Undo with its confirm, Check by Audio', async () => {
    await mount();

    // Scan Folder
    await act(async () => { fireEvent.click(pill('Scan Folder')); });
    await waitFor(() => expect(screen.getAllByText('Local Book').length).toBeGreaterThan(0));
    expect(calledWith('scan_library')).toHaveLength(1);

    // Write Tags
    await act(async () => { fireEvent.click(pill('Select All')); });
    await act(async () => { fireEvent.click(pill('Write Tags')); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Write 1 Change$/ })); });
    await waitFor(() => expect(calledWith('write_tags')).toHaveLength(1));
    expect(calledWith('write_tags')[0][1].request.files['file-1'].changes.title.new).toBe('Local Book');

    // Undo from the action bar asks first, stating the count and the age.
    // The write keeps its bar for a second, during which every action is disabled.
    const undoPillNow = () => screen.getByRole('button', { name: /Undo last write/ });
    await waitFor(() => expect(undoPillNow()).not.toBeDisabled(), { timeout: 3000 });
    const undoPill = undoPillNow();
    await act(async () => { fireEvent.click(undoPill); });
    expect(await screen.findByText(/Restore 1 file from the backups made 2 hours ago/)).toBeInTheDocument();
    expect(calledWith('undo_last_write')).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore files' })); });
    await waitFor(() => expect(calledWith('undo_last_write')).toHaveLength(1));
    // I-4: the book says what happened and the change is staged again.
    expect((await screen.findAllByText(/last write was undone/)).length).toBeGreaterThan(0);

    // Check by Audio on the local book: sent as local, with its file, no ABS token.
    await act(async () => { fireEvent.click(pill('Select All')); });
    await act(async () => { fireEvent.click(screen.getByTitle('Enrich metadata')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Check Narrator/ })); });
    await waitFor(() => expect(calledWith('batch_extract_audio_intros')).toHaveLength(1));
    const [item] = calledWith('batch_extract_audio_intros')[0][1].items;
    expect(item).toMatchObject({ source: 'local', file_path: PATH, abs_api_token: null });
  });
});

describe('ScannerPage smoke: an ABS book', () => {
  it('Import shows a bar with a working Cancel, then imports, then Push', async () => {
    await mount();

    // A first import that is cancelled while the first page is loading.
    let releasePage;
    absApi.mockImplementationOnce(() => new Promise((resolve) => { releasePage = () => resolve({ results: [absItem], total: 1 }); }));
    await act(async () => { fireEvent.click(pill('Import')); });
    const bar = await screen.findByText(/Importing from AudiobookShelf/);
    const cancel = within(bar.closest('div.fixed')).getByRole('button', { name: 'Cancel' });
    await act(async () => { fireEvent.click(cancel); });
    await act(async () => { releasePage(); });
    expect(await screen.findByText('Import cancelled')).toBeInTheDocument();
    expect(screen.queryByText('ABS Book')).toBeNull();

    // The real import.
    absApi.mockImplementation(async (_b, _t, path) => {
      if (path.startsWith('/api/libraries/')) return { results: [absItem], total: 1 };
      return { media: { tags: ['favorite'], metadata: { genres: ['Fantasy'] } } };
    });
    await act(async () => { fireEvent.click(pill('Import')); });
    await waitFor(() => expect(screen.getAllByText('ABS Book').length).toBeGreaterThan(0));

    // Push: the modal counts the ABS book; nothing was edited, so nothing is sent.
    await act(async () => { fireEvent.click(pill('Select All')); });
    await act(async () => { fireEvent.click(pill('Push')); });
    expect(await screen.findByText(/book will be pushed/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Push to ABS/ })); });
    await waitFor(() => expect(calledWith('push_abs_imports')).toHaveLength(1));
    expect(await screen.findByText('Nothing Pushed')).toBeInTheDocument();
    expect(absApi.mock.calls.some((c) => c[3]?.method === 'PATCH')).toBe(false);
  });

  it('M-c: an import clears the selection', async () => {
    await mount();
    await act(async () => { fireEvent.click(pill('Scan Folder')); });
    await waitFor(() => expect(screen.getAllByText('Local Book').length).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(pill('Select All')); });
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
    absApi.mockImplementation(async () => ({ results: [absItem], total: 1 }));
    await act(async () => { fireEvent.click(pill('Import')); });
    await waitFor(() => expect(screen.getAllByText('ABS Book').length).toBeGreaterThan(0));
    expect(screen.queryByText(/\d+ selected/)).toBeNull();
  });
});
