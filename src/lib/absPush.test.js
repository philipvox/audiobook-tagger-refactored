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
  getAbsId, partitionPushGroups, normalizePushResult, mergePushResults,
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
    const pushByFileIds = vi.fn();
    // Mirror handlePushAbsImports' request shape.
    const pushById = (groups) => callBackend('push_abs_imports', {
      request: { items: groups.map(g => ({ id: g.id, abs_id: getAbsId(g), metadata: g.metadata })) },
    });

    const out = await runPush([absGroupWithFiles], { pushById, pushByFileIds });

    expect(pushByFileIds).not.toHaveBeenCalled();
    expect(absApi).toHaveBeenCalledTimes(1);
    expect(absApi.mock.calls[0][2]).toBe('/api/items/li-123/media');
    expect(absApi.mock.calls[0][3].method).toBe('PATCH');
    // buildAbsPayload used splitAuthors without importing it, so any book
    // with an author threw a ReferenceError at the push boundary.
    expect(absApi.mock.calls[0][3].body.metadata.authors).toEqual([{ id: 'new-1', name: 'A. Author' }]);
    expect(out.updated).toBe(1);
    expect(out.failed).toBe(0);
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
    const r = normalizePushResult({ success: 2, failed: 3, errors: [{ id: 'unknown', error: 'Missing item ID' }] });
    expect(r).toEqual({ updated: 2, failed: 3, errors: ['Missing item ID'] });
    expect(normalizePushResult({ updated: 0, failed: ['a', 'b'] }).failed).toBe(2);
    expect(normalizePushResult(undefined)).toEqual({ updated: 0, failed: 0, errors: [] });
    expect(mergePushResults({ updated: 1, failed: 0 }, { success: 2, failed: 1, errors: ['boom'] }))
      .toEqual({ updated: 3, failed: 1, errors: ['boom'] });
  });

  it('reports a total failure as an error with the first error message', async () => {
    absApi.mockRejectedValue(new Error('HTTP 404'));
    const pushById = (groups) => callBackend('push_abs_imports', {
      request: { items: groups.map(g => ({ abs_id: getAbsId(g), metadata: g.metadata })) },
    });
    const out = await runPush([absGroupWithFiles], { pushById, pushByFileIds: vi.fn() });
    expect(out.failed).toBe(1);
    expect(out.summary.type).toBe('error');
    expect(out.summary.message).toMatch(/HTTP 404/);
  });

  it('records a throwing branch as failed instead of losing it', async () => {
    const out = await runPush([absGroupWithFiles, localGroup], {
      pushById: vi.fn().mockRejectedValue(new Error('network down')),
      pushByFileIds: vi.fn().mockResolvedValue({ updated: 1, failed: 0, errors: [] }),
    });
    expect(out).toMatchObject({ updated: 1, failed: 1 });
    expect(out.summary.type).toBe('warning');
    expect(out.summary.message).toMatch(/Updated 1, failed 1.*network down/);
  });

  it('summarises a partial push and an empty push', () => {
    expect(summarizePush({ updated: 2, failed: 1, errors: ['x'] }, 3).message).toBe('Updated 2, failed 1. First error: x');
    expect(summarizePush({ updated: 0, failed: 0, errors: [] }, 2).type).toBe('warning');
  });
});
