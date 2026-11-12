// Final review fixes I-1, I-2, M-e: an import and a push report progress, the
// scan bar names the running operation and shows (with Cancel) before the
// total is known, and the push modal counts only the books it will push.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, absApi: vi.fn() };
});

const { callBackend, subscribe } = await import('./api.js');
const { absApi } = await import('./lib/proxy');
const { pushAbsItems } = await import('./lib/absPush.js');
const { ProgressBar } = await import('./components/scanner/ProgressBar');
const { ABSPushModal } = await import('./components/ABSPushModal');

const item = (id) => ({ id, media: { metadata: { title: `Book ${id}`, authorName: 'A' }, tags: [] } });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    abs_base_url: 'http://abs.local', abs_api_token: 'token', abs_library_id: 'lib1', concurrency_abs_push: 1,
  }));
});

describe('I-1: import_from_abs emits import_progress', () => {
  it('reports pages with the library total', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => item(`a${i}`));
    const page1 = [item('b0'), item('b1')];
    absApi.mockImplementation(async (_b, _t, path) => {
      if (path.includes('page=0')) return { results: page0, total: 102 };
      return { results: page1, total: 102 };
    });
    const events = [];
    const off = subscribe('import_progress', (d) => events.push(d));
    const out = await callBackend('import_from_abs', {});
    off();
    expect(out.groups).toHaveLength(102);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.total === 102 && e.current > 0)).toBe(true);
    expect(events.every((e) => typeof e.message === 'string' && e.message)).toBe(true);
  });
});

describe('I-2: the push pool reports each settled book', () => {
  it('a 3-book push calls onProgress with current 1, 2, 3', async () => {
    const request = vi.fn(async (path, opt) => (opt?.method === 'PATCH' ? {} : { media: { tags: [], metadata: { genres: [] } } }));
    const items = ['1', '2', '3'].map((id) => ({ id, abs_id: id, metadata: { title: `New ${id}` }, original: { title: 'Old' } }));
    const seen = [];
    await pushAbsItems(items, { request, cfg: {}, onProgress: (current, total) => seen.push([current, total]) });
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('push_abs_imports emits push_progress', async () => {
    absApi.mockImplementation(async (_b, _t, _p, opt) => (opt?.method === 'PATCH' ? {} : { media: { tags: [], metadata: { genres: [] } } }));
    const events = [];
    const off = subscribe('push_progress', (d) => events.push(d));
    await callBackend('push_abs_imports', {
      request: { items: ['1', '2'].map((id) => ({ id, abs_id: id, metadata: { title: `New ${id}` }, original: { title: 'Old' } })) },
    });
    off();
    expect(events.map((e) => e.current)).toEqual([1, 2]);
    expect(events.every((e) => e.total === 2)).toBe(true);
  });
});

describe('I-1/I-2: the scan bar', () => {
  const base = { current: 0, total: 0, currentFile: 'Connecting to AudiobookShelf...', startTime: 1 };

  it('renders with Cancel before the total is known', () => {
    render(<ProgressBar type="scan" operation="import" progress={base} onCancel={vi.fn()} calculateETA={() => 'Calculating...'} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByText(/Importing from AudiobookShelf/)).toBeInTheDocument();
  });

  it.each([
    ['import', /Importing 40 of 100 books/],
    ['push', /Pushing 2 of 5 books/],
    ['scan', /Scanning 3 of 9 files/],
    ['rescan', /Rescanning 3 of 9 files/],
  ])('names the %s operation', (operation, text) => {
    const [c, t] = operation === 'import' ? [40, 100] : operation === 'push' ? [2, 5] : [3, 9];
    render(<ProgressBar type="scan" operation={operation} progress={{ ...base, current: c, total: t }} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('ABSPushModal', () => {
  const absBook = (id, extra = {}) => ({ id, abs_id: id, source: 'abs', metadata: { title: id }, files: [], ...extra });
  const localBook = (id) => ({ id, metadata: { title: id }, files: [{ id: `${id}-f`, path: `/x/${id}.m4b`, changes: {} }] });

  it('I-2: shows "Pushed N of M" while pushing', () => {
    render(<ABSPushModal isOpen groups={[absBook('a')]} pushing progress={{ current: 2, total: 5 }} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText(/2 of 5/)).toBeInTheDocument();
  });

  it('M-e: counts only ABS books and says how many local books will be skipped', () => {
    const groups = [absBook('a'), absBook('b'), absBook('c'), localBook('l1'), localBook('l2')];
    render(<ABSPushModal isOpen groups={groups} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/2 local books will be skipped/)).toBeInTheDocument();
  });

  it('M-e: the breakdown reads changedFields for a book without files', () => {
    render(<ABSPushModal isOpen groups={[absBook('a', { changedFields: ['tags', 'series', 'description', 'year'] })]} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText(/1 tag update/)).toBeInTheDocument();
    expect(screen.getByText(/1 series update/)).toBeInTheDocument();
    expect(screen.getByText(/1 description update/)).toBeInTheDocument();
    expect(screen.getByText(/1 year update/)).toBeInTheDocument();
  });
});
