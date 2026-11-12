// Final review fix D-8: a push never silently discards an edit it did not
// send. Values dropped by tag policy or the genre cap are reported per book,
// named in the push summary and kept staged; staged state is cleared only for
// fields that are now in step with ABS; and when the cap or the no-empty-list
// rule is why nothing was sent, the skip reason says so.

import { describe, it, expect } from 'vitest';
import { snapshotAbsMetadata } from './absPayload.js';
import { applyMetadataToGroup } from './applyMetadata.js';
import {
  pushOneAbsItem, pushAbsItems, applyPushSnapshots, applyRefreshedLists, summarizePush, normalizePushResult, buildPushItems,
} from './absPush.js';

const mk = (meta) => {
  const metadata = { title: 'T', author: 'A B', narrator: null, genres: [], tags: [], all_series: [], ...meta };
  return { id: 'g1', abs_id: 'g1', source: 'abs', metadata, abs_original: snapshotAbsMetadata(metadata), files: [] };
};

// A fake ABS: GET returns `server`, PATCH applies the body to it.
const fakeAbs = (server) => {
  const calls = [];
  const request = async (path, opt) => {
    calls.push([opt?.method || 'GET', path, opt?.body]);
    if (opt?.method === 'PATCH') {
      if (opt.body.tags) server.tags = opt.body.tags;
      if (opt.body.metadata?.genres) server.genres = opt.body.metadata.genres;
      return {};
    }
    return { media: { tags: [...server.tags], metadata: { genres: [...server.genres] } } };
  };
  return { request, calls };
};

const push = async (groups, server, cfg = {}) => {
  const abs = fakeAbs(server);
  const raw = await pushAbsItems(buildPushItems(groups), { request: abs.request, cfg });
  const after = applyRefreshedLists(applyPushSnapshots(groups, raw.snapshots, raw.pushed), raw.refreshed);
  return { raw, after, calls: abs.calls };
};

describe('a tag dropped by policy beside a title edit', () => {
  const edited = () => applyMetadataToGroup(
    applyMetadataToGroup(mk({ tags: ['a'] }), { title: 'New' }, ['title']),
    { tags: ['a', 'signed-copy'] }, ['tags'],
  );

  it('the result names it, the summary says so, and it stays staged', async () => {
    const { raw, after, calls } = await push([edited()], { tags: ['a', 'x'], genres: [] });
    const patch = calls.find((c) => c[0] === 'PATCH');
    expect(patch[2]).toEqual({ metadata: { title: 'New' } });
    expect(raw.updated[0].notSent).toEqual([{ field: 'tags', value: 'signed-copy', reason: 'not-approved' }]);

    const summary = summarizePush(normalizePushResult(raw), 1);
    expect(summary.message).toMatch(/1 tag was not sent because it is not in the approved list: signed-copy/);
    expect(summary.type).toBe('warning');

    const g = after[0];
    expect(g.metadata.tags).toEqual(['a', 'signed-copy']);
    expect(g.metadata.title).toBe('New');
    expect(g.abs_original.title).toBe('New');
    expect(g.changedFields).toEqual(['tags']);
    expect(g.total_changes).toBe(1);
  });
});

describe('a genre trimmed by the cap', () => {
  const edited = () => applyMetadataToGroup(mk({ genres: ['Fantasy'] }), { genres: ['Fantasy', 'Thriller'] }, ['genre']);

  it('is skipped with "genre limit" as the reason and the local genres are not overwritten', async () => {
    const { raw, after, calls } = await push([edited()], { tags: [], genres: ['Fantasy', 'Horror', 'Mystery'] });
    expect(calls.some((c) => c[0] === 'PATCH')).toBe(false);
    expect(raw.skipped).toEqual([expect.objectContaining({ id: 'g1', reason: 'genre limit (3) reached' })]);
    expect(raw.skipped[0].notSent).toEqual([{ field: 'genres', value: 'Thriller', reason: 'genre-limit' }]);
    const summary = summarizePush(normalizePushResult(raw), 1);
    expect(summary.message).toMatch(/1 genre was not sent because the 3-genre limit was reached: Thriller/);
    expect(after[0].metadata.genres).toEqual(['Fantasy', 'Thriller']);
    expect(after[0].changedFields).toContain('genres');
  });
});

describe('a removal the rebase would turn into an empty list', () => {
  it('is skipped with a reason, not "no changes", and the local tags stay as they were', async () => {
    const g = applyMetadataToGroup(mk({ tags: ['a', 'b'] }), { tags: ['a'] }, ['tags']);
    const { raw, after, calls } = await push([g], { tags: ['b'], genres: [] });
    expect(calls.some((c) => c[0] === 'PATCH')).toBe(false);
    expect(raw.skipped[0].reason).toBe('would leave tags empty');
    expect(after[0].metadata.tags).toEqual(['a']);
    expect(after[0].abs_original.tags).toEqual(['a', 'b']);
    expect(after[0].changedFields).toEqual(['tags']);
  });
});

describe('a tag that cannot be sent at all and nothing else staged', () => {
  it('is skipped naming the reason, with no network call', async () => {
    const g = applyMetadataToGroup(mk({ tags: ['a'] }), { tags: ['a', 'signed-copy'] }, ['tags']);
    const { raw, calls } = await push([g], { tags: ['a'], genres: [] });
    expect(calls).toEqual([]);
    expect(raw.skipped[0]).toMatchObject({ reason: 'tags not in the approved list', notSent: [{ field: 'tags', value: 'signed-copy', reason: 'not-approved' }] });
  });
});

describe('fields that were not sent keep their staged state', () => {
  it('a staged series on a series_unresolved book survives a push of the title', async () => {
    let g = mk({ series: 'A #6, B #1', all_series: [], series_unresolved: true });
    g = applyMetadataToGroup(g, { title: 'New', sequence: '7' }, ['title', 'sequence']);
    const { after } = await push([g], { tags: [], genres: [] });
    expect(after[0].changedFields).toEqual(['sequence']);
    expect(after[0].metadata.sequence).toBe('7');
  });

  it('everything sent: all staged state is cleared, as before', async () => {
    const g = applyMetadataToGroup(mk({ tags: ['a'] }), { title: 'New', tags: ['a', 'fast-paced'] }, ['title', 'tags']);
    const { after } = await push([g], { tags: ['a', 'x'], genres: [] });
    expect(after[0].changedFields).toEqual([]);
    expect(after[0].total_changes).toBe(0);
    expect(after[0].metadata.tags).toEqual(['a', 'x', 'fast-paced']);
  });
});

describe('pushOneAbsItem keeps its result shape for a plain push', () => {
  it('no notSent key when everything was sent', async () => {
    const g = applyMetadataToGroup(mk({}), { title: 'New' }, ['title']);
    const { request } = fakeAbs({ tags: [], genres: [] });
    const out = await pushOneAbsItem(buildPushItems([g])[0], { request, cfg: {} });
    expect(out.entry).toEqual({ id: 'g1', title: 'New' });
  });
});

describe('neighbouring inputs are not reported as unsent', () => {
  it('a genre the policy maps (Sci-Fi -> Science Fiction) and an added dna: tag', async () => {
    let g = mk({ genres: ['Fantasy'], tags: ['a'] });
    g = applyMetadataToGroup(g, { genres: ['Fantasy', 'Sci-Fi'], tags: ['a', 'dna:pacing:fast'] }, ['genre', 'tags']);
    const { raw, after } = await push([g], { tags: ['a'], genres: ['Fantasy'] });
    expect(raw.updated[0].notSent).toBeUndefined();
    expect(after[0].metadata.genres).toEqual(['Fantasy', 'Science Fiction']);
    expect(after[0].changedFields).toEqual([]);
  });

  it('a user-cleared list is sent empty and settles', async () => {
    const g = { ...applyMetadataToGroup(mk({ tags: ['a'] }), { tags: [] }, ['tags']) };
    g.metadata = { ...g.metadata, user_cleared: ['tags'] };
    const { raw, after } = await push([g], { tags: ['a'], genres: [] });
    expect(raw.updated[0].notSent).toBeUndefined();
    expect(after[0].metadata.tags).toEqual([]);
    expect(after[0].changedFields).toEqual([]);
  });
});
