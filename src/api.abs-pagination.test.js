// Regression tests for the 2026-07-21 audit: import_from_abs pagination (task 1, item 7).
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

function makeItem(id) {
  return { id, media: { metadata: { title: `Book ${id}` } } };
}

describe('import_from_abs pagination', () => {
  it('stops immediately on an empty page instead of looping forever', async () => {
    absApi.mockResolvedValueOnce({ results: [], total: 0 });

    const result = await callBackend('import_from_abs', {});
    expect(result.total).toBe(0);
    expect(absApi).toHaveBeenCalledTimes(1);
  });

  it('keeps paging past page 1 when the response omits total, stopping on a short page', async () => {
    // Page 0: full page (limit=100), no `total` field at all.
    const page0 = { results: Array.from({ length: 100 }, (_, i) => makeItem(`p0-${i}`)) };
    // Page 1: short page (50 items) signals the last page.
    const page1 = { results: Array.from({ length: 50 }, (_, i) => makeItem(`p1-${i}`)) };
    absApi.mockResolvedValueOnce(page0).mockResolvedValueOnce(page1);

    const result = await callBackend('import_from_abs', {});
    expect(absApi).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(150);
  });

  it('stops when the reported total is reached', async () => {
    const page0 = { results: Array.from({ length: 100 }, (_, i) => makeItem(`p0-${i}`)), total: 150 };
    const page1 = { results: Array.from({ length: 50 }, (_, i) => makeItem(`p1-${i}`)), total: 150 };
    absApi.mockResolvedValueOnce(page0).mockResolvedValueOnce(page1);

    const result = await callBackend('import_from_abs', {});
    expect(absApi).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(150);
  });

  it('enforces a hard page cap and warns instead of looping forever', async () => {
    // Every page comes back full (limit items) and total is never reported:
    // without a hard cap this loop would never terminate.
    absApi.mockImplementation(async () => ({
      results: Array.from({ length: 100 }, (_, i) => makeItem(`x-${i}`)),
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await callBackend('import_from_abs', {});

    expect(absApi.mock.calls.length).toBeLessThanOrEqual(1002);
    expect(absApi.mock.calls.length).toBeGreaterThan(1000);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
