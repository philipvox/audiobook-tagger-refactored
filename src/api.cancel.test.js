// H-7: Cancel stops an ABS import or push for real. Once cancel is requested
// no new book (or page) starts; work already in flight finishes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, absApi: vi.fn() };
});

const { callBackend } = await import('./api.js');
const { absApi } = await import('./lib/proxy');
const { liveItem } = await import('./test/absLive.js');
const { requestCancel, resetCancel } = await import('./lib/cancel.js');
const { summarizePush } = await import('./lib/absPush.js');

const setConfig = (extra = {}) => localStorage.setItem('audiobook_tagger_config', JSON.stringify({
  abs_base_url: 'http://abs.local', abs_api_token: 'token', abs_library_id: 'lib-1', ...extra,
}));

const books = (n) => Array.from({ length: n }, (_, i) => ({
  id: `g${i + 1}`, abs_id: `li-${i + 1}`, metadata: { title: `Book ${i + 1}` }, original: { title: 'old' },
}));

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  resetCancel();
});

describe('push cancel (H-7)', () => {
  it('requestCancel() during a 50-book push stops after the in-flight book; the rest are skipped "cancelled"', async () => {
    setConfig({ concurrency_abs_push: 1 });
    let gets = 0;
    absApi.mockImplementation(async (_b, _t, _path, opts) => {
      if (opts?.method === 'PATCH') return {};
      gets++;
      if (gets === 3) requestCancel(); // cancel while book 3 is in flight
      return liveItem([], []);
    });

    const out = await callBackend('push_abs_imports', { request: { items: books(50) } });

    expect(out.updated.map((u) => u.id)).toEqual(['g1', 'g2', 'g3']);
    expect(out.skipped).toHaveLength(47);
    expect(out.skipped.every((s) => s.reason === 'cancelled')).toBe(true);
    expect(out.skipped[0]).toEqual({ id: 'g4', title: 'Book 4', reason: 'cancelled' });
    expect(out.failed).toEqual([]);
    expect(out.cancelled).toBe(true);
    // Snapshots for the books that were written are still returned.
    expect(Object.keys(out.snapshots).sort()).toEqual(['g1', 'g2', 'g3']);
  });

  it('with three workers, the three in-flight books finish and none starts after the cancel', async () => {
    setConfig();
    let gets = 0;
    absApi.mockImplementation(async (_b, _t, _path, opts) => {
      if (opts?.method === 'PATCH') return {};
      gets++;
      if (gets === 3) requestCancel(); // all three lanes have a book in flight
      await new Promise((r) => setTimeout(r, 2));
      return liveItem([], []);
    });

    const out = await callBackend('push_abs_imports', { request: { items: books(50) } });

    expect(gets).toBe(3);
    expect(out.updated).toHaveLength(3);
    expect(out.skipped).toHaveLength(47);
  });

  it('a push with no cancel requested is not marked cancelled', async () => {
    setConfig();
    absApi.mockImplementation(async (_b, _t, _path, opts) => (opts?.method === 'PATCH' ? {} : liveItem([], [])));
    const out = await callBackend('push_abs_imports', { request: { items: books(4) } });
    expect(out.updated).toHaveLength(4);
    expect(out.cancelled).toBeFalsy();
  });

  it('the push summary says the push was cancelled and how many were not pushed', () => {
    const s = summarizePush({
      updated: [{ id: 'g1', title: 'A' }, { id: 'g2', title: 'B' }],
      skipped: Array.from({ length: 48 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, reason: 'cancelled' })),
      failed: [],
    }, 50);
    expect(s.type).toBe('warning');
    expect(s.title).toBe('Push Cancelled');
    expect(s.message).toMatch(/Updated 2 books before the push was cancelled; 48 were not pushed\./);
  });
});

describe('import cancel (H-7)', () => {
  const fullPage = (p) => ({ results: Array.from({ length: 100 }, (_, i) => ({ id: `p${p}-${i}`, media: { metadata: { title: `B ${p}-${i}` } } })) });

  it('a cancel during the page loop stops before the next page and resolves cancelled with no groups', async () => {
    setConfig();
    absApi.mockImplementation(async (_b, _t, path) => {
      if (path.includes('page=0')) { requestCancel(); return fullPage(0); }
      return fullPage(1);
    });

    const out = await callBackend('import_from_abs', {});

    expect(absApi).toHaveBeenCalledTimes(1);
    expect(out.cancelled).toBe(true);
    expect(out.groups).toEqual([]);
  });

  it('an import with no cancel requested is not marked cancelled', async () => {
    setConfig();
    absApi.mockResolvedValueOnce({ results: [{ id: 'a', media: { metadata: { title: 'A' } } }], total: 1 });
    const out = await callBackend('import_from_abs', {});
    expect(out.cancelled).toBeFalsy();
    expect(out.groups).toHaveLength(1);
  });
});
