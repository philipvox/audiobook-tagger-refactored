// #54 push boundary: the in-app "keep existing genres/tags" work was undone by
// buildAbsPayload, which ran everything through mapGenre/mapTag on the way to
// ABS - dropping anything outside the approved vocabulary and re-casing the
// survivors. These tests pin both flags on and off at that boundary.
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

function setConfig(extra = {}) {
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    abs_base_url: 'http://abs.local',
    abs_api_token: 'token',
    ...extra,
  }));
}

beforeEach(() => {
  localStorage.clear();
  setConfig();
  vi.resetAllMocks();
  absApi.mockResolvedValue({});
});

async function pushAndGetPayload(meta) {
  const result = await callBackend('push_abs_updates', { items: [{ abs_id: 'item-1', metadata: meta }] });
  expect(result.success).toBe(1);
  return absApi.mock.calls.at(-1)[3].body;
}

describe('genres at the push boundary (#54)', () => {
  it('OFF (default): an unapproved genre is still dropped by genre policy', async () => {
    const payload = await pushAndGetPayload({ genres: ['Zzzz Custom Shelf', 'Fantasy'] });
    expect(payload.metadata.genres).toEqual(['Fantasy']);
  });

  it('ON: unapproved genres survive with their original casing', async () => {
    setConfig({ preserve_existing_genres: true });
    const payload = await pushAndGetPayload({ genres: ['Zzzz Custom Shelf', 'Fantasy'] });
    expect(payload.metadata.genres).toEqual(['Zzzz Custom Shelf', 'Fantasy']);
  });

  it('ON: no cap - more than three genres all survive', async () => {
    setConfig({ preserve_existing_genres: true });
    const genres = ['Horror', 'Thriller', 'Mystery', 'Zzzz Custom Shelf'];
    const payload = await pushAndGetPayload({ genres });
    expect(payload.metadata.genres).toEqual(genres);
  });

  it('ON: case-insensitive dedup keeps the first-seen casing', async () => {
    setConfig({ preserve_existing_genres: true });
    const payload = await pushAndGetPayload({ genres: ['Fantasy', 'fantasy', '  '] });
    expect(payload.metadata.genres).toEqual(['Fantasy']);
  });

  it('OFF with genre_enforcement disabled: unchanged legacy slice-to-3 behavior', async () => {
    setConfig({ genre_enforcement: false });
    const payload = await pushAndGetPayload({ genres: ['A', 'B', 'C', 'D'] });
    expect(payload.metadata.genres).toEqual(['A', 'B', 'C']);
  });
});

describe('tags at the push boundary (#54)', () => {
  it('OFF (default): unapproved tags are still dropped and approved ones normalized', async () => {
    const payload = await pushAndGetPayload({ tags: ['Epic Fantasy', 'Sci-Fi', 'dna:pov:first'] });
    expect(payload.tags).toEqual(['epic-fantasy', 'dna:pov:first']);
  });

  it('ON: unapproved tags survive with their casing; approved ones still normalize', async () => {
    setConfig({ preserve_existing_tags: true });
    const payload = await pushAndGetPayload({ tags: ['Epic Fantasy', 'Sci-Fi', 'dna:pov:first'] });
    expect(payload.tags).toEqual(['epic-fantasy', 'Sci-Fi', 'dna:pov:first']);
  });

  it('the two flags are independent: tags-only preservation leaves genres on policy', async () => {
    setConfig({ preserve_existing_tags: true });
    const payload = await pushAndGetPayload({ genres: ['Zzzz Custom Shelf', 'Fantasy'], tags: ['Sci-Fi'] });
    expect(payload.metadata.genres).toEqual(['Fantasy']);
    expect(payload.tags).toEqual(['Sci-Fi']);
  });
});
