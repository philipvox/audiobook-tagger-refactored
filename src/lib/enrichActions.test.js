import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runEnrichAction } from './enrichActions';

// H-3/M-7: the shared body of the Enrich actions, run the way ScannerPage runs
// it: a real state holder for setGroups, a toast spy, and a backend stub.

const book = (id, metadata = {}, extra = {}) => ({
  id,
  group_name: `Book ${id}`,
  metadata: { title: `Title ${id}`, author: 'Terry Pratchett', ...metadata },
  files: [],
  changedFields: [],
  ...extra,
});

function harness(initial) {
  let state = initial;
  const setGroups = (u) => { state = typeof u === 'function' ? u(state) : u; };
  const toast = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
  return { setGroups, toast, get groups() { return state; } };
}

const rejectAll = vi.fn(async (cmd) => { throw new Error(`${cmd}: HTTP 500`); });

beforeEach(() => {
  rejectAll.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('every backend call rejecting gives an error toast naming the failure count', () => {
  it.each([
    ['titles', 'Fix Titles'],
    ['series', 'Fix Series'],
    ['subtitles', 'Fix Subtitles'],
    ['age', 'Age Lookup'],
    ['audio_check', 'Audio Check'],
    ['genres', 'Genre Cleanup'],
    ['isbn', 'ISBN Lookup'],
  ])('%s', async (name, title) => {
    const groups = [book('a'), book('b'), book('c')];
    const h = harness(groups);
    const { counts } = await runEnrichAction(name, groups, { callBackend: rejectAll, setGroups: h.setGroups, toast: h.toast, ctx: { config: {} } });

    expect(rejectAll).toHaveBeenCalled();
    expect(counts.failed).toBe(3);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    expect(h.toast.error.mock.calls[0][0]).toBe(`${title}: 3 failed`);
    // Each book shows why, and nothing else changed.
    for (const g of h.groups) {
      expect(g.lastError).toMatchObject({ severity: 'error' });
      expect(g.metadata.title).toBe(`Title ${g.id}`);
    }
  });
});

describe('mixed runs report both counts', () => {
  it('Fix Titles: one fixed, one failed', async () => {
    const groups = [book('a', { title: 'mort' }), book('b')];
    const h = harness(groups);
    const callBackend = vi.fn(async (cmd, args) => {
      if (args.request.current_title === 'mort') {
        return { success: true, result: { title: 'Mort', author: 'Terry Pratchett', subtitle: null, confidence: 90 } };
      }
      throw new Error('HTTP 500');
    });
    await runEnrichAction('titles', groups, { callBackend, setGroups: h.setGroups, toast: h.toast });
    expect(h.toast.error.mock.calls[0][0]).toBe('Fix Titles: 1 fixed, 1 failed');
    expect(h.groups[0].metadata.title).toBe('Mort');
    expect(h.groups[1].lastError.message).toBe('HTTP 500');
  });

  it('Fix Subtitles: one fixed, one failed in the same chunk', async () => {
    const groups = [book('a'), book('b')];
    const h = harness(groups);
    const callBackend = vi.fn(async () => ({
      results: [
        { id: 'a', success: true, fixed: true, subtitle: 'A Discworld Novel' },
        { id: 'b', success: false, fixed: false, error: 'HTTP 429' },
      ],
    }));
    await runEnrichAction('subtitles', groups, { callBackend, setGroups: h.setGroups, toast: h.toast, ctx: { config: {} } });
    expect(h.toast.error.mock.calls[0][0]).toBe('Fix Subtitles: 1 fixed, 1 failed');
    expect(h.groups[0].metadata.subtitle).toBe('A Discworld Novel');
  });

  it('an all-success run gives a success toast', async () => {
    const groups = [book('a', { tags: [] })];
    const h = harness(groups);
    const callBackend = vi.fn(async () => ({ success: true, age_category: 'Adult', age_tags: ['age-adult'], age_rating: 'Adult' }));
    await runEnrichAction('age', groups, { callBackend, setGroups: h.setGroups, toast: h.toast });
    expect(h.toast.success).toHaveBeenCalledWith('Age Lookup Complete', '1 rated', undefined);
    expect(h.groups[0].metadata.tags).toEqual(['age-adult']);
  });
});

describe('Fix Series', () => {
  it('does not send a book with an unknown series list and reports it skipped', async () => {
    const groups = [
      book('a', { series: 'Stormlight', sequence: '1', all_series: [{ name: 'Stormlight', sequence: '1' }] }),
      book('b', { series: 'Discworld', series_unresolved: true, all_series: [] }),
    ];
    const h = harness(groups);
    const callBackend = vi.fn(async () => ({ success: true, result: { series: 'The Stormlight Archive', sequence: '1' } }));
    await runEnrichAction('series', groups, { callBackend, setGroups: h.setGroups, toast: h.toast });
    expect(callBackend).toHaveBeenCalledTimes(1);
    expect(h.groups[0].metadata.all_series).toEqual([{ name: 'The Stormlight Archive', sequence: '1' }]);
    expect(h.groups[1].metadata.series).toBe('Discworld');
    expect(h.groups[1].lastError.severity).toBe('warn');
    expect(h.toast.success).toHaveBeenCalledWith('Fix Series Complete', '1 fixed, 1 unchanged or skipped', undefined);
  });
});

describe('ISBN extra pairs and lookup errors', () => {
  it('a thrown lookup is a failure, a miss is not found, smart-skipped books are counted', async () => {
    const groups = [book('a'), book('b')];
    const h = harness(groups);
    const callBackend = vi.fn(async (cmd, args) => {
      if (args.request.title === 'Title a') throw new Error('offline');
      return { success: false, error: 'Not found' };
    });
    await runEnrichAction('isbn', groups, {
      callBackend, setGroups: h.setGroups, toast: h.toast,
      extraPairs: [{ id: null, outcome: 'unchanged' }],
    });
    expect(h.toast.error).toHaveBeenCalledWith('ISBN Lookup: 1 failed, 1 not found', '1 already had ISBN', expect.any(Object));
    expect(h.groups[0].lastError.message).toBe('offline');
    expect(h.groups[1].lastError).toBeUndefined();
  });
});

describe('AI Tags age step', () => {
  it('a failed age lookup keeps the tags-step error and reports no toast of its own', async () => {
    const tagsError = { stage: 'tags', kind: 'dna', message: 'DNA tags were not updated', severity: 'error' };
    const groups = [book('a', { tags: ['cozy'] }, { lastError: tagsError })];
    const h = harness(groups);
    const callBackend = vi.fn(async () => ({ success: false, error: 'The AI returned no age rating.' }));
    const { counts } = await runEnrichAction('age_tags', groups, { callBackend, setGroups: h.setGroups, toast: null });
    expect(counts.failed).toBe(1);
    expect(h.groups[0].lastError).toEqual(tagsError);
  });
});

describe('ScannerPage runs each action through runEnrichAction', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'ScannerPage.jsx'), 'utf8');
  it.each(['titles', 'series', 'subtitles', 'age', 'audio_check', 'genres', 'isbn', 'age_tags'])('%s', (name) => {
    expect(source).toContain(`runAction('${name}'`);
  });
});

// M-6: the big steps (Resolve, Description Processing, Classify) run in chunks
// of 25, stage each chunk as it lands, and stop between chunks on Cancel.
describe('runBatchChunks (M-6)', () => {
  const classifyBackend = () => vi.fn(async (cmd, { books }) => ({
    results: books.map((b) => ({ id: b.id, success: true, genres: ['Fantasy'] })),
    total_processed: books.length,
    total_failed: 0,
  }));

  it('classify on 60 books calls setGroups three times (25, 25, 10)', async () => {
    const { runBatchChunks } = await import('./enrichActions');
    const groups = Array.from({ length: 60 }, (_, i) => book(`b${i}`));
    const setGroups = vi.fn();
    const callBackend = classifyBackend();

    const out = await runBatchChunks(groups, {
      callChunk: (chunk) => callBackend('classify_books_batch', { books: chunk.map((g) => ({ id: g.id })) }),
      applyChunk: (result) => setGroups((prev) => prev.map((g) => g), result),
      shouldStop: () => false,
    });

    expect(callBackend.mock.calls.map(([, a]) => a.books.length)).toEqual([25, 25, 10]);
    expect(setGroups).toHaveBeenCalledTimes(3);
    expect(setGroups.mock.calls.map(([, r]) => r.results.length)).toEqual([25, 25, 10]);
    expect(out).toMatchObject({ processed: 60, failed: 0, cancelled: 0 });
    expect(out.results).toHaveLength(60);
  });

  it('a cancel during the first chunk keeps that chunk and skips the rest', async () => {
    const { runBatchChunks } = await import('./enrichActions');
    const { requestCancel, resetCancel } = await import('./cancel');
    resetCancel();
    const groups = Array.from({ length: 60 }, (_, i) => book(`b${i}`));
    const applied = [];
    const callBackend = classifyBackend();

    const out = await runBatchChunks(groups, {
      callChunk: async (chunk) => {
        const r = await callBackend('classify_books_batch', { books: chunk.map((g) => ({ id: g.id })) });
        requestCancel();
        return r;
      },
      applyChunk: (result) => applied.push(result.results.length),
    });
    resetCancel();

    expect(applied).toEqual([25]);
    expect(out).toMatchObject({ processed: 25, cancelled: 35 });
  });

  it('a chunk whose call throws counts its books as failed and the next chunk still runs', async () => {
    const { runBatchChunks } = await import('./enrichActions');
    const groups = Array.from({ length: 30 }, (_, i) => book(`b${i}`));
    let call = 0;
    const out = await runBatchChunks(groups, {
      stage: 'classify',
      callChunk: async (chunk) => {
        call++;
        if (call === 1) throw new Error('HTTP 500');
        return { results: chunk.map((g) => ({ id: g.id, success: true })), total_processed: chunk.length, total_failed: 0 };
      },
      applyChunk: () => {},
      shouldStop: () => false,
    });
    expect(out).toMatchObject({ processed: 5, failed: 25 });
    expect(out.results[0]).toMatchObject({ id: 'b0', success: false, error: 'HTTP 500' });
    expect(out.results[0].errorDetail).toMatchObject({ stage: 'classify' });
  });
});

describe('runEnrichAction stops between chunks on Cancel (M-6)', () => {
  it('what was applied stays applied and the toast says how many were processed', async () => {
    const { requestCancel, resetCancel } = await import('./cancel');
    resetCancel();
    const groups = Array.from({ length: 30 }, (_, i) => book(`b${i}`));
    const h = harness(groups);
    const callBackend = vi.fn(async () => {
      requestCancel();
      return { success: true, result: { title: 'New Title' } };
    });

    const { counts, cancelled } = await runEnrichAction('titles', groups, { callBackend, setGroups: h.setGroups, toast: h.toast });
    resetCancel();

    expect(callBackend).toHaveBeenCalledTimes(25);
    expect(cancelled).toBe(5);
    expect(counts.succeeded + counts.skipped + counts.warnings + counts.failed).toBe(25);
    const [title, message] = h.toast.warning.mock.calls[0];
    expect(title).toBe('Fix Titles cancelled');
    expect(message).toMatch(/25 of 30 processed/);
    expect(message).toMatch(/the remaining 5 were cancelled/);
  });
});
