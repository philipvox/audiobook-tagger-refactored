// Regression tests for the 2026-07-21 audit: abs-client.js importLibrary
// pagination (task 1, item 7). Mirrors src/api.abs-pagination.test.js for the
// import_from_abs handler.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    absApi: vi.fn(),
  };
});

const { importLibrary } = await import('./abs-client.js');
const { absApi } = await import('./proxy');

const config = { abs_base_url: 'http://abs.local', abs_api_token: 'token', abs_library_id: 'lib-1' };

beforeEach(() => {
  vi.resetAllMocks();
});

function makeItem(id) {
  return { id, media: { metadata: { title: `Book ${id}` } } };
}

describe('importLibrary pagination', () => {
  it('stops immediately on an empty page instead of looping forever', async () => {
    absApi.mockResolvedValueOnce({ results: [], total: 0 });

    const groups = await importLibrary(config);
    expect(groups).toHaveLength(0);
    expect(absApi).toHaveBeenCalledTimes(1);
  });

  it('keeps paging past page 1 when the response omits total, stopping on a short page', async () => {
    const page0 = { results: Array.from({ length: 100 }, (_, i) => makeItem(`p0-${i}`)) };
    const page1 = { results: Array.from({ length: 50 }, (_, i) => makeItem(`p1-${i}`)) };
    absApi.mockResolvedValueOnce(page0).mockResolvedValueOnce(page1);

    const groups = await importLibrary(config);
    expect(absApi).toHaveBeenCalledTimes(2);
    expect(groups).toHaveLength(150);
  });

  it('calls a real onProgress callback without throwing (regression: total went out of scope)', async () => {
    const page0 = { results: Array.from({ length: 100 }, (_, i) => makeItem(`p0-${i}`)), total: 150 };
    const page1 = { results: Array.from({ length: 50 }, (_, i) => makeItem(`p1-${i}`)), total: 150 };
    absApi.mockResolvedValueOnce(page0).mockResolvedValueOnce(page1);

    const onProgress = vi.fn();
    const groups = await importLibrary(config, onProgress);

    expect(groups).toHaveLength(150);
    // Must not throw, and must have reported completion progress after the loop.
    expect(onProgress).toHaveBeenCalledWith(150, 150, 'Processing...');
  });

  it('stops when the reported total is reached', async () => {
    const page0 = { results: Array.from({ length: 100 }, (_, i) => makeItem(`p0-${i}`)), total: 150 };
    const page1 = { results: Array.from({ length: 50 }, (_, i) => makeItem(`p1-${i}`)), total: 150 };
    absApi.mockResolvedValueOnce(page0).mockResolvedValueOnce(page1);

    const groups = await importLibrary(config);
    expect(absApi).toHaveBeenCalledTimes(2);
    expect(groups).toHaveLength(150);
  });

  it('enforces a hard page cap and warns instead of looping forever', async () => {
    absApi.mockImplementation(async () => ({
      results: Array.from({ length: 100 }, (_, i) => makeItem(`x-${i}`)),
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await importLibrary(config);

    expect(absApi.mock.calls.length).toBeLessThanOrEqual(1002);
    expect(absApi.mock.calls.length).toBeGreaterThan(1000);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
