// #60: "Pushing to AudiobookShelf does nothing - no error, nothing in logs".
// ABS-imported books carry files, so routing by files.length sent them to the
// path-based push, which had no ABS id and failed silently.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, absApi: vi.fn() };
});

const { callBackend } = await import('../api.js');
const { absApi } = await import('./proxy');
const {
  getAbsId, isAbsBacked, fileIdsInGroups, partitionPushGroups, normalizePushResult, mergePushResults,
  summarizePush, runPush,
} = await import('./absPush.js');

// Shape produced by absItemToBookGroup (src/api.js / src/lib/abs-client.js).
const absGroupWithFiles = {
  id: 'li-123',
  abs_id: 'li-123',
  source: 'abs',
  metadata: { title: 'Imported Book', author: 'A. Author' },
  files: [{ id: 'li-123-f0', path: '/audiobooks/A/Book/book.m4b', changes: {} }],
};
const localGroup = {
  id: 'local-uuid',
  metadata: { title: 'Local Book' },
  files: [{ id: 'f-local', path: '/Users/me/Book/book.m4b' }],
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    abs_base_url: 'http://abs.local',
    abs_api_token: 'token',
  }));
  vi.resetAllMocks();
  absApi.mockResolvedValue({});
});

describe('routing (#60)', () => {
  it('treats an ABS-imported group WITH files as ABS-backed', () => {
    expect(getAbsId(absGroupWithFiles)).toBe('li-123');
    expect(getAbsId({ id: 'x', source: 'abs', files: [] })).toBe('x');
    expect(getAbsId(localGroup)).toBeNull();
    const { absGroups, localGroups } = partitionPushGroups([absGroupWithFiles, localGroup]);
    expect(absGroups).toEqual([absGroupWithFiles]);
    expect(localGroups).toEqual([localGroup]);
  });

  it('pushes an ABS-imported group with files by id and PATCHes /api/items/:id/media', async () => {
    // Task 5: the push reads the live item first, then PATCHes.
    absApi.mockImplementation(async (_b, _t, _p, opts) => (opts?.method === 'PATCH' ? {} : { media: { tags: [], metadata: { genres: [] } } }));
    const pushByFileIds = vi.fn();
    // Mirror handlePushAbsImports' request shape.
    const pushById = (groups) => callBackend('push_abs_imports', {
      request: { items: groups.map(g => ({ id: g.id, abs_id: getAbsId(g), metadata: g.metadata })) },
    });

    const out = await runPush([absGroupWithFiles], { pushById, pushByFileIds });

    expect(pushByFileIds).not.toHaveBeenCalled();
    expect(absApi).toHaveBeenCalledTimes(2);
    expect(absApi.mock.calls[0][2]).toBe('/api/items/li-123?expanded=1');
    expect(absApi.mock.calls[1][2]).toBe('/api/items/li-123/media');
    expect(absApi.mock.calls[1][3].method).toBe('PATCH');
    // buildAbsPayload used splitAuthors without importing it, so any book
    // with an author threw a ReferenceError at the push boundary.
    expect(absApi.mock.calls[1][3].body.metadata.authors).toEqual([{ id: 'new-1', name: 'A. Author' }]);
    expect(out.updated).toEqual([{ id: 'li-123', title: 'Imported Book' }]);
    expect(out.failed).toEqual([]);
    expect(out.summary.type).toBe('success');
  });

  it('keeps genuinely local groups on the file-id branch', async () => {
    const pushById = vi.fn();
    const pushByFileIds = vi.fn().mockResolvedValue({ updated: 1, failed: 0, errors: [] });
    await runPush([localGroup], { pushById, pushByFileIds });
    expect(pushById).not.toHaveBeenCalled();
    expect(pushByFileIds).toHaveBeenCalledWith(new Set(['f-local']));
  });
});

describe('result accounting and reporting (#60)', () => {
  it('normalises numeric failed counts without throwing', () => {
    // Task 5 (M-9): results are per-book arrays; legacy counts still expand
    // into entries so no failure is lost.
    const r = normalizePushResult({ success: 2, failed: 3, errors: [{ id: 'unknown', error: 'Missing item ID' }] });
    expect(r.updated).toHaveLength(2);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toHaveLength(3);
    expect(r.failed[0].error).toBe('Missing item ID');
    expect(normalizePushResult({ updated: 0, failed: ['a', 'b'] }).failed).toHaveLength(2);
    expect(normalizePushResult(undefined)).toEqual({ updated: [], skipped: [], failed: [] });
    const merged = mergePushResults({ updated: 1, failed: 0 }, { success: 2, failed: 1, errors: ['boom'] });
    expect(merged.updated).toHaveLength(3);
    expect(merged.failed).toHaveLength(1);
    expect(merged.failed[0].error).toBe('boom');
  });

  it('reports a total failure as an error with the first error message', async () => {
    absApi.mockRejectedValue(new Error('HTTP 404'));
    const pushById = (groups) => callBackend('push_abs_imports', {
      request: { items: groups.map(g => ({ abs_id: getAbsId(g), metadata: g.metadata })) },
    });
    const out = await runPush([absGroupWithFiles], { pushById, pushByFileIds: vi.fn() });
    expect(out.failed).toHaveLength(1);
    expect(out.summary.type).toBe('error');
    expect(out.summary.message).toMatch(/HTTP 404/);
  });

  it('records a throwing branch as failed instead of losing it', async () => {
    const out = await runPush([absGroupWithFiles, localGroup], {
      pushById: vi.fn().mockRejectedValue(new Error('network down')),
      pushByFileIds: vi.fn().mockResolvedValue({ updated: [{ id: 'local-uuid', title: 'Local Book' }], skipped: [], failed: [] }),
    });
    expect(out.updated).toHaveLength(1);
    expect(out.failed).toEqual([{ id: 'li-123', title: 'Imported Book', error: 'network down' }]);
    expect(out.summary.type).toBe('warning');
    expect(out.summary.message).toMatch(/Updated 1, failed 1.*network down/);
  });

  it('summarises a partial push and an empty push', () => {
    const updated = [{ id: '1', title: 'A' }, { id: '2', title: 'B' }];
    expect(summarizePush({ updated, skipped: [], failed: [{ id: '3', title: 'C', error: 'x' }] }, 3).message)
      .toBe('Updated 2, failed 1. Failed: C. First error: x');
    expect(summarizePush({ updated: [], skipped: [], failed: [] }, 2).type).toBe('warning');
  });
});

describe('isAbsBacked / fileIdsInGroups (#60 follow-up: rescan + genre cleanup routing)', () => {
  it('is the single "lives in ABS" test, independent of files', () => {
    expect(isAbsBacked(absGroupWithFiles)).toBe(true);
    expect(isAbsBacked({ ...absGroupWithFiles, files: [] })).toBe(true);
    expect(isAbsBacked(localGroup)).toBe(false);
    // The old heuristic's false positive: a local group with no files is not ABS.
    expect(isAbsBacked({ id: 'u', metadata: {}, files: [] })).toBe(false);
    expect(isAbsBacked(null)).toBe(false);
  });

  it('keeps only file ids belonging to the given groups', () => {
    const selected = new Set(['li-123-f0', 'f-local', 'stale']);
    expect(fileIdsInGroups(selected, [localGroup])).toEqual(new Set(['f-local']));
    expect(fileIdsInGroups(selected, [])).toEqual(new Set());
    expect(fileIdsInGroups(undefined, [localGroup])).toEqual(new Set());
  });
});

describe('v2.2.3 diff push plumbing', () => {
  it('buildPushItems carries the import snapshot as `original`', async () => {
    const { buildPushItems } = await import('./absPush.js');
    const g = { id: 'g1', abs_id: 'a1', metadata: { title: 'T' }, abs_original: { title: 'T0' } };
    expect(buildPushItems([g])).toEqual([{ id: 'g1', abs_id: 'a1', metadata: { title: 'T' }, original: { title: 'T0' } }]);
    expect(buildPushItems([{ id: 'g2', source: 'abs', metadata: {} }])[0].original).toBeNull();
  });

  it('applyPushSnapshots advances abs_original only for pushed groups', async () => {
    const { applyPushSnapshots } = await import('./absPush.js');
    const a = { id: 'g1', abs_original: { title: 'old' } };
    const b = { id: 'g2', abs_original: { title: 'keep' } };
    const out = applyPushSnapshots([a, b], { g1: { title: 'new' } });
    expect(out[0].abs_original).toEqual({ title: 'new' });
    expect(out[1]).toBe(b);
    expect(applyPushSnapshots([a], undefined)[0]).toBe(a);
  });
});

// Task 5 (H-5, M-9, H-11): a push re-reads the live item and applies only the
// local delta (added and removed tags/genres) to it, so values added in ABS
// since import survive. Results are reported per book.
describe('rebaseArrayOnLive (H-5)', () => {
  it('applies local additions and removals to the live list', async () => {
    const { rebaseArrayOnLive } = await import('./absPayload.js');
    expect(rebaseArrayOnLive(['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'x'])).toEqual(['a', 'b', 'x', 'c']);
    expect(rebaseArrayOnLive(['a', 'b'], ['a'], ['a', 'b', 'x'])).toEqual(['a', 'x']);
  });

  it('matches case-insensitively and keeps the live order and casing', async () => {
    const { rebaseArrayOnLive } = await import('./absPayload.js');
    expect(rebaseArrayOnLive(['Fantasy', 'Old'], ['fantasy', 'New'], ['Zed', 'FANTASY', 'OLD']))
      .toEqual(['Zed', 'FANTASY', 'New']);
    // An addition already on the server is not duplicated.
    expect(rebaseArrayOnLive([], ['x'], ['X'])).toEqual(['X']);
    // No snapshot: nothing counts as removed, so live values all survive.
    expect(rebaseArrayOnLive(null, ['c'], ['a'])).toEqual(['a', 'c']);
  });
});

const liveItem = (tags, genres) => ({ media: { tags, metadata: { genres } } });

/** absApi mock: GET returns `live` (or throws `getError`), PATCH returns {} (or throws `patchError`). */
function mockAbs({ live, getError, patchError } = {}) {
  absApi.mockImplementation(async (_base, _token, path, opts) => {
    if (opts?.method === 'PATCH') {
      if (patchError) throw patchError;
      return {};
    }
    if (getError) throw getError;
    return live;
  });
}

const pushImports = (items) => callBackend('push_abs_imports', { request: { items } });

describe('push_abs_imports rebases on the live item (H-5)', () => {
  beforeEach(() => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      abs_base_url: 'http://abs.local', abs_api_token: 'token', preserve_existing_tags: true,
    }));
  });

  it('GETs the live item before the PATCH and sends the rebased tags and genres', async () => {
    mockAbs({ live: liveItem(['a', 'b', 'x'], ['Fantasy', 'Horror', 'Mystery']) });
    const out = await pushImports([{
      id: 'g1', abs_id: 'li-1',
      metadata: { title: 'Book', tags: ['a', 'b', 'c'], genres: ['Fantasy'] },
      original: { title: 'Book', tags: ['a', 'b'], genres: ['Fantasy', 'Horror'] },
    }]);

    expect(absApi.mock.calls.map((c) => [c[3]?.method || 'GET', c[2]])).toEqual([
      ['GET', '/api/items/li-1?expanded=1'],
      ['PATCH', '/api/items/li-1/media'],
    ]);
    const body = absApi.mock.calls[1][3].body;
    expect(body.tags).toEqual(['a', 'b', 'x', 'c']);
    expect(body.metadata.genres).toEqual(['Fantasy', 'Mystery']);
    expect(out.updated).toEqual([{ id: 'g1', title: 'Book' }]);
    expect(out.skipped).toEqual([]);
    expect(out.failed).toEqual([]);
    // The advanced snapshot is what the server now holds.
    expect(out.snapshots.g1.tags).toEqual(['a', 'b', 'x', 'c']);
    expect(out.snapshots.g1.genres).toEqual(['Fantasy', 'Mystery']);
  });

  it('drops a list that already matches the live item; skips the book when nothing is left', async () => {
    mockAbs({ live: liveItem(['A', 'b'], ['Fantasy']) });
    const out = await pushImports([{
      id: 'g1', abs_id: 'li-1',
      metadata: { title: 'Book', tags: ['a', 'b'], genres: ['Fantasy'] },
      original: { title: 'Book', tags: ['a'], genres: ['Fantasy'] },
    }]);
    expect(absApi.mock.calls.some((c) => c[3]?.method === 'PATCH')).toBe(false);
    expect(out.updated).toEqual([]);
    expect(out.skipped).toEqual([{ id: 'g1', title: 'Book', reason: 'no changes' }]);
  });

  it('keeps scalar changes when the lists already match the live item', async () => {
    mockAbs({ live: liveItem(['a', 'b'], []) });
    await pushImports([{
      id: 'g1', abs_id: 'li-1',
      metadata: { title: 'New Title', tags: ['a', 'b'] },
      original: { title: 'Old Title', tags: ['a'] },
    }]);
    expect(absApi.mock.calls[1][3].body).toEqual({ metadata: { title: 'New Title' } });
  });

  it('never sends an empty list the user did not clear, even when the rebase empties it', async () => {
    // Removed 'b' locally while someone removed 'a' in ABS.
    mockAbs({ live: liveItem(['b'], []) });
    await pushImports([{
      id: 'g1', abs_id: 'li-1',
      metadata: { title: 'New', tags: ['a'] },
      original: { title: 'Old', tags: ['a', 'b'] },
    }]);
    const body = absApi.mock.calls[1][3].body;
    expect(body).not.toHaveProperty('tags');
    expect(body.metadata.title).toBe('New');
  });

  it('without a snapshot, the push adds to the live lists and removes nothing', async () => {
    mockAbs({ live: liveItem(['server-tag'], ['Mystery']) });
    await pushImports([{ id: 'g1', abs_id: 'li-1', metadata: { title: 'Book', tags: ['local-tag'], genres: ['Fantasy'] } }]);
    const body = absApi.mock.calls[1][3].body;
    expect(body.tags).toEqual(['server-tag', 'local-tag']);
    expect(body.metadata.genres).toEqual(['Mystery', 'Fantasy']);
  });

  it('caps added genres against the live list; live genres are never trimmed', async () => {
    mockAbs({ live: liveItem([], ['Fantasy', 'Horror', 'Mystery']) });
    const out = await pushImports([{
      id: 'g1', abs_id: 'li-1',
      metadata: { title: 'Book', genres: ['Fantasy', 'Thriller'] },
      original: { title: 'Book', genres: ['Fantasy'] },
    }]);
    expect(absApi.mock.calls.some((c) => c[3]?.method === 'PATCH')).toBe(false);
    expect(out.skipped).toEqual([{ id: 'g1', title: 'Book', reason: 'no changes' }]);
  });
});

describe('per-book push results (M-9)', () => {
  it('an unchanged book is skipped with reason "no changes" and never contacts ABS', async () => {
    const meta = { title: 'Dune', tags: ['t'] };
    const out = await pushImports([{ id: 'g1', abs_id: 'li-1', metadata: meta, original: { ...meta, genres: [] } }]);
    expect(absApi).not.toHaveBeenCalled();
    expect(out).toMatchObject({ updated: [], failed: [], skipped: [{ id: 'g1', title: 'Dune', reason: 'no changes' }] });
  });

  it('a 500 on the PATCH lands in failed with the id and title', async () => {
    mockAbs({ live: liveItem([], []), patchError: new Error('HTTP 500') });
    const out = await pushImports([{ id: 'g1', abs_id: 'li-1', metadata: { title: 'Dune 2' }, original: { title: 'Dune' } }]);
    expect(out.updated).toEqual([]);
    expect(out.failed).toEqual([{ id: 'g1', title: 'Dune 2', error: 'HTTP 500' }]);
    expect(out.snapshots).not.toHaveProperty('g1');
  });

  it('a failed GET fails the book and sends no PATCH', async () => {
    mockAbs({ getError: new Error('HTTP 404') });
    const out = await pushImports([{ id: 'g1', abs_id: 'li-1', metadata: { title: 'Dune 2' }, original: { title: 'Dune' } }]);
    expect(absApi).toHaveBeenCalledTimes(1);
    expect(out.failed).toEqual([{ id: 'g1', title: 'Dune 2', error: 'HTTP 404' }]);
  });

  it('a live item without media fails the book and sends no PATCH', async () => {
    mockAbs({ live: {} });
    const out = await pushImports([{ id: 'g1', abs_id: 'li-1', metadata: { title: 'Dune 2' }, original: { title: 'Dune' } }]);
    expect(absApi).toHaveBeenCalledTimes(1);
    expect(out.failed[0]).toMatchObject({ id: 'g1', title: 'Dune 2' });
    expect(out.failed[0].error).toMatch(/could not read/i);
  });

  it('a live item missing its tags or genres fails the book rather than guessing', async () => {
    const { readLiveLists } = await import('./absPayload.js');
    expect(readLiveLists({ media: { metadata: { genres: [] } } })).toBeNull();
    expect(readLiveLists({ media: { tags: [], metadata: {} } })).toBeNull();
    expect(readLiveLists({ media: { tags: ['a', 'A'], metadata: { genres: ['Fantasy'] } } }))
      .toEqual({ tags: ['a'], genres: ['Fantasy'] });
  });

  it('the single-book push (push_abs_updates) goes through the same per-book path', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      abs_base_url: 'http://abs.local', abs_api_token: 'token', preserve_existing_tags: true,
    }));
    mockAbs({ live: liveItem(['a', 'x'], []) });
    const out = await callBackend('push_abs_updates', {
      items: [{ group_id: 'g1', abs_id: 'li-1', metadata: { title: 'Book', tags: ['a', 'c'] }, original: { title: 'Book', tags: ['a'] } }],
    });
    expect(absApi.mock.calls[0][2]).toBe('/api/items/li-1?expanded=1');
    expect(absApi.mock.calls[1][3].body.tags).toEqual(['a', 'x', 'c']);
    expect(out.updated).toEqual([{ id: 'g1', title: 'Book' }]);
  });
});

describe('applyPushSnapshots clears staged state for pushed books', () => {
  it('advances the snapshot, shows the server lists, and clears the staged edits', async () => {
    const { applyPushSnapshots } = await import('./absPush.js');
    const g = {
      id: 'g1',
      metadata: { title: 'T', tags: ['a', 'c'], genres: [], user_cleared: ['genres'] },
      abs_original: { title: 'T', tags: ['a'], genres: ['Fantasy'] },
      total_changes: 2,
      changedFields: ['tags', 'genres'],
      files: [{ id: 'f1', changes: { tags: { old: 'a', new: 'a, c' } } }, { id: 'f2', changes: { genre: {} } }],
    };
    const snapshot = { title: 'T', tags: ['a', 'x', 'c'], genres: [] };
    const [out] = applyPushSnapshots([g], { g1: snapshot });
    expect(out.abs_original).toBe(snapshot);
    expect(out.metadata.tags).toEqual(['a', 'x', 'c']);
    expect(out.metadata.genres).toEqual([]);
    expect(out.metadata).not.toHaveProperty('user_cleared');
    expect(out.total_changes).toBe(0);
    expect(out.changedFields).toEqual([]);
    expect(out.files.every((f) => Object.keys(f.changes).length === 0)).toBe(true);
  });
});

describe('push concurrency (H-11)', () => {
  it('runPool never has more workers in flight than the limit and keeps input order', async () => {
    const { runPool } = await import('./absPush.js');
    let inFlight = 0;
    let peak = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6, 7], async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 * (8 - n)));
      inFlight--;
      return n * 10;
    }, 3);
    expect(peak).toBe(3);
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(await runPool([], async () => 1, 3)).toEqual([]);
  });

  it('reads concurrency_abs_push, clamped to 1..10, default 3', async () => {
    const { pushConcurrency } = await import('./absPush.js');
    expect(pushConcurrency({})).toBe(3);
    expect(pushConcurrency(undefined)).toBe(3);
    expect(pushConcurrency({ concurrency_abs_push: 'abc' })).toBe(3);
    expect(pushConcurrency({ concurrency_abs_push: 5 })).toBe(5);
    expect(pushConcurrency({ concurrency_abs_push: '7' })).toBe(7);
    expect(pushConcurrency({ concurrency_abs_push: 50 })).toBe(10);
    expect(pushConcurrency({ concurrency_abs_push: 0 })).toBe(1);
    expect(pushConcurrency({ concurrency_abs_push: -4 })).toBe(1);
  });

  it('push_abs_imports runs at most concurrency_abs_push books at once', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      abs_base_url: 'http://abs.local', abs_api_token: 'token', concurrency_abs_push: 2,
    }));
    let inFlight = 0;
    let peak = 0;
    absApi.mockImplementation(async (_b, _t, _path, opts) => {
      if (opts?.method === 'PATCH') { inFlight--; return {}; }
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      return liveItem([], []);
    });
    const items = [1, 2, 3, 4, 5].map((n) => ({ id: `g${n}`, abs_id: `li-${n}`, metadata: { title: `B${n}` }, original: { title: 'old' } }));
    const out = await pushImports(items);
    expect(peak).toBe(2);
    expect(out.updated.map((u) => u.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
  });
});

describe('push summary names failed books', () => {
  it('lists the first 5 failed titles, then "and N more"', () => {
    const failed = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((t) => ({ id: t, title: t, error: 'HTTP 500' }));
    const s = summarizePush({ updated: [{ id: 'u', title: 'U' }], skipped: [], failed }, 8);
    expect(s.type).toBe('warning');
    expect(s.message).toMatch(/Updated 1, failed 7/);
    expect(s.message).toContain('Failed: A, B, C, D, E and 2 more.');
  });

  it('lists every failed title when there are 5 or fewer', () => {
    const failed = [{ id: '1', title: 'Dune', error: 'HTTP 500' }, { id: '2', title: 'Emma', error: 'HTTP 404' }];
    const s = summarizePush({ updated: [], skipped: [], failed }, 2);
    expect(s.type).toBe('error');
    expect(s.message).toContain('Failed: Dune, Emma.');
    expect(s.message).toContain('HTTP 500');
  });

  it('reports skipped books separately from updated ones', () => {
    const s = summarizePush({ updated: [], skipped: [{ id: '1', title: 'Dune', reason: 'no changes' }], failed: [] }, 1);
    expect(s.type).toBe('info');
    expect(s.message).toMatch(/1 book.*skipped/i);
    expect(s.message).toMatch(/no changes/);
  });
});
