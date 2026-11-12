// #54 / v2.2.3 push boundary. Push diffs against the import snapshot
// (item.original): genre/tag policy only touches values ADDED this session,
// existing ones go out verbatim, and with no snapshot nothing is sent at all
// (H-4; the old behavior wiped ABS genres like ['LitRPG']).
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
const { serveLive } = await import('./test/absLive.js');

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
  serveLive(absApi);
});


// The live item matches the import snapshot (nothing changed in ABS since).
async function pushAndGetPayload(meta, original) {
  serveLive(absApi, original || {});
  const result = await callBackend('push_abs_updates', { items: [{ abs_id: 'item-1', metadata: meta, original }] });
  expect(result.updated).toHaveLength(1);
  return absApi.mock.calls.at(-1)?.[3]?.body;
}

const snap = (m) => ({ genres: [], tags: [], ...m });

describe('genres at the push boundary', () => {
  it('no snapshot: nothing is sent, so ABS genres cannot be touched (H-4)', async () => {
    const result = await callBackend('push_abs_updates', { items: [{ abs_id: 'item-1', metadata: { genres: ['LitRPG'] } }] });
    expect(result.updated).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(absApi).not.toHaveBeenCalled();
  });

  it('OFF (default): an unapproved AI-added genre is dropped by policy, existing kept', async () => {
    const payload = await pushAndGetPayload(
      { genres: ['LitRPG', 'Zzzz Custom Shelf', 'Fantasy'] },
      snap({ genres: ['LitRPG'] }),
    );
    expect(payload.metadata.genres).toEqual(['LitRPG', 'Fantasy']);
  });

  it('preserve_existing_genres ON does not bypass policy or cap for additions', async () => {
    setConfig({ preserve_existing_genres: true });
    const genres = ['Horror', 'Thriller', 'Mystery', 'Zzzz Custom Shelf'];
    const payload = await pushAndGetPayload({ genres }, snap({}));
    expect(payload.metadata.genres).toEqual(['Horror', 'Thriller', 'Mystery']);
  });

  it('case-insensitive dedup keeps the first-seen casing', async () => {
    setConfig({ preserve_existing_genres: true });
    const payload = await pushAndGetPayload({ genres: ['Fantasy', 'fantasy', '  '] }, snap({}));
    expect(payload.metadata.genres).toEqual(['Fantasy']);
  });

  it('genre_enforcement disabled: additions unmapped, capped to three in total', async () => {
    setConfig({ genre_enforcement: false });
    const payload = await pushAndGetPayload({ genres: ['A', 'B', 'C', 'D'] }, snap({}));
    expect(payload.metadata.genres).toEqual(['A', 'B', 'C']);
  });

  it('the LitRPG wipe: policy emptying the genres never sends genres: []', async () => {
    const payload = await pushAndGetPayload({ title: 'New', genres: ['LitRPG'] }, snap({ title: 'Old', genres: ['LitRPG'] }));
    expect(payload.metadata).not.toHaveProperty('genres');
  });
});

describe('tags at the push boundary', () => {
  it('OFF (default): unapproved ADDED tags are dropped, approved ones normalized, existing kept', async () => {
    const payload = await pushAndGetPayload(
      { tags: ['my-shelf', 'Epic Fantasy', 'Sci-Fi', 'dna:pov:first'] },
      snap({ tags: ['my-shelf'] }),
    );
    expect(payload.tags).toEqual(['my-shelf', 'epic-fantasy', 'dna:pov:first']);
  });

  it('ON: unapproved added tags survive with their casing; approved ones still normalize', async () => {
    setConfig({ preserve_existing_tags: true });
    const payload = await pushAndGetPayload({ tags: ['Epic Fantasy', 'Sci-Fi', 'dna:pov:first'] }, snap({}));
    expect(payload.tags).toEqual(['epic-fantasy', 'Sci-Fi', 'dna:pov:first']);
  });

  it('the two flags are independent: tags-only preservation leaves added genres on policy', async () => {
    setConfig({ preserve_existing_tags: true });
    const payload = await pushAndGetPayload({ genres: ['Zzzz Custom Shelf', 'Fantasy'], tags: ['Sci-Fi'] }, snap({}));
    expect(payload.metadata.genres).toEqual(['Fantasy']);
    expect(payload.tags).toEqual(['Sci-Fi']);
  });
});

describe('diff push end to end', () => {
  // Task 5 (M-9): a no-op used to count as an update; it is now skipped.
  it('an unchanged book is not PATCHed at all and is reported as skipped', async () => {
    const meta = { title: 'Dune', genres: ['LitRPG'], tags: ['dna:x:y'] };
    const result = await callBackend('push_abs_imports', { items: [{ id: 'g1', abs_id: 'item-1', metadata: meta, original: snap(meta) }] });
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([{ id: 'g1', title: 'Dune', reason: 'no changes' }]);
    expect(absApi).not.toHaveBeenCalled();
    expect(result.snapshots).not.toHaveProperty('g1');
  });

  it('returns the advanced snapshot for each pushed book', async () => {
    const meta = { title: 'Dune 2', genres: [], tags: [] };
    const result = await callBackend('push_abs_imports', { items: [{ id: 'g1', abs_id: 'item-1', metadata: meta, original: snap({ title: 'Dune' }) }] });
    expect(absApi.mock.calls.at(-1)[3].body).toEqual({ metadata: { title: 'Dune 2' } });
    expect(result.snapshots.g1.title).toBe('Dune 2');
  });
});
