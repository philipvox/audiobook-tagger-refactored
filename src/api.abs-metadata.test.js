// Regression tests for the 2026-07-22 audit (task 4, item 2 continuation):
// api.js has its own copy of absItemToBookGroup (used by import_from_abs),
// separate from src/lib/abs-client.js's copy (used by the onboarding
// wizard's importLibrary). The CR-3 fix (stable file ids + changes) and the
// M-4/L-14 year fix need to hold regardless of which path builds groups.
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

describe('import_from_abs group construction (CR-3 + M-4/L-14)', () => {
  it('gives every file a stable id and an empty changes object', async () => {
    absApi.mockResolvedValueOnce({
      results: [{
        id: 'item-1',
        media: {
          metadata: { title: 'Book One' },
          audioFiles: [
            { metadata: { path: '/a/1.m4b', filename: '1.m4b' }, duration: 100 },
            { metadata: { path: '/a/2.m4b', filename: '2.m4b' }, duration: 200 },
          ],
        },
      }],
      total: 1,
    });

    const { groups } = await callBackend('import_from_abs', {});
    const [group] = groups;

    expect(group.files).toHaveLength(2);
    expect(group.files[0].id).toBe('item-1-f0');
    expect(group.files[1].id).toBe('item-1-f1');
    expect(group.files[0].changes).toEqual({});
    expect(group.files[1].changes).toEqual({});
  });

  it('sets both published_year and year from a 4-digit tagDate', async () => {
    absApi.mockResolvedValueOnce({
      results: [{
        id: 'item-2',
        media: {
          metadata: { title: 'Book Two' },
          audioFiles: [{ metaTags: { tagDate: '2015-03-01' } }],
        },
      }],
      total: 1,
    });

    const { groups } = await callBackend('import_from_abs', {});
    expect(groups[0].metadata.published_year).toBe('2015');
    expect(groups[0].metadata.year).toBe('2015');
  });

  it('does not fabricate a year when tagDate/publishedDate are unparseable', async () => {
    absApi.mockResolvedValueOnce({
      results: [{
        id: 'item-3',
        media: {
          metadata: { title: 'Book Three', publishedDate: 'not-a-real-date' },
          audioFiles: [{ metaTags: { tagDate: 'also garbage' } }],
        },
      }],
      total: 1,
    });

    const { groups } = await callBackend('import_from_abs', {});
    expect(groups[0].metadata.published_year).toBeNull();
    expect(groups[0].metadata.year).toBeNull();
  });
});
