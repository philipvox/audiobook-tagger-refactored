// Regression/feature tests for the 2026-07-22 follow-up (task 4b):
// push_author_changes_to_abs was missing from src/api.js's HANDLERS, so
// useAuthors.pushToAbs's real push always hit the generic unimplemented-
// command stub (which the previous fix now treats as a trustworthy-failure
// case instead of destroying staged edits). This wires up the real handler
// so a push can actually succeed, and covers merge_abs_authors (already
// implemented) for the same flow.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    absApi: vi.fn(),
    callAI: vi.fn(),
    parseAIJson: vi.fn((s) => JSON.parse(s)),
  };
});

const { callBackend } = await import('./api.js');
const { absApi } = await import('./lib/proxy');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    abs_base_url: 'http://abs.local',
    abs_api_token: 'token',
    abs_library_id: 'lib-1',
  }));
  vi.resetAllMocks();
});

describe('push_author_changes_to_abs', () => {
  it('PATCHes each changed author and counts every success', async () => {
    absApi.mockResolvedValue({ id: 'ok' });

    const result = await callBackend('push_author_changes_to_abs', {
      items: [
        { id: 'a1', name: 'Author One', description: null },
        { id: 'a2', name: null, description: 'New bio' },
      ],
    });

    expect(result).toEqual({ updated: 2, failed: 0, errors: [] });
    expect(absApi).toHaveBeenCalledTimes(2);
    expect(absApi).toHaveBeenNthCalledWith(1, 'http://abs.local', 'token', '/api/authors/a1', {
      method: 'PATCH',
      body: { name: 'Author One' },
    });
    expect(absApi).toHaveBeenNthCalledWith(2, 'http://abs.local', 'token', '/api/authors/a2', {
      method: 'PATCH',
      body: { description: 'New bio' },
    });
  });

  it('omits null fields from the PATCH body so an unstaged field is never overwritten', async () => {
    absApi.mockResolvedValue({});

    await callBackend('push_author_changes_to_abs', {
      items: [{ id: 'a1', name: 'Author One', description: null }],
    });

    const [, , , options] = absApi.mock.calls[0];
    expect(options.body).toEqual({ name: 'Author One' });
    expect(options.body.description).toBeUndefined();
  });

  it('reports a per-id error and keeps the failure isolated to that item (partial failure)', async () => {
    absApi
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('ABS API error 500: internal'));

    const result = await callBackend('push_author_changes_to_abs', {
      items: [
        { id: 'a1', name: 'Author One' },
        { id: 'a2', name: 'Author Two' },
      ],
    });

    expect(result.updated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([{ id: 'a2', error: 'ABS API error 500: internal' }]);
  });

  it('fails fast with a single-failure shape when ABS is not configured', async () => {
    localStorage.clear();
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      abs_base_url: '',
      abs_api_token: '',
      abs_library_id: '',
    }));

    const result = await callBackend('push_author_changes_to_abs', {
      items: [{ id: 'a1', name: 'Author One' }],
    });

    expect(result).toEqual({
      updated: 0,
      failed: 1,
      errors: [{ id: 'config', error: 'ABS is not configured: missing base URL or API token' }],
    });
    expect(absApi).not.toHaveBeenCalled();
  });

  it('reports a per-item error for an item with no id instead of throwing', async () => {
    const result = await callBackend('push_author_changes_to_abs', {
      items: [{ name: 'No Id Here' }],
    });

    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([{ id: 'unknown', error: 'Missing author id' }]);
    expect(absApi).not.toHaveBeenCalled();
  });
});

describe('merge_abs_authors (already implemented, adding coverage)', () => {
  it('POSTs a merge request to the primary author and resolves on success', async () => {
    absApi.mockResolvedValueOnce({ merged: true });

    const result = await callBackend('merge_abs_authors', {
      primaryId: 'p1',
      secondaryIds: ['s1', 's2'],
    });

    expect(result).toEqual({ merged: true });
    expect(absApi).toHaveBeenCalledWith('http://abs.local', 'token', '/api/authors/p1/merge', {
      method: 'POST',
      body: { toMergeAuthorIds: ['s1', 's2'] },
    });
  });

  it('propagates a rejection so the caller (pushToAbs) can mark that merge as failed', async () => {
    absApi.mockRejectedValueOnce(new Error('ABS API error 404: author not found'));

    await expect(callBackend('merge_abs_authors', {
      primaryId: 'p1',
      secondaryIds: ['s1'],
    })).rejects.toThrow('ABS API error 404: author not found');
  });
});
