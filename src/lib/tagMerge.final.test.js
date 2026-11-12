// Final review fixes D-3, D-7, the Clean Genres ruling and the thin DNA
// answer: an AI answer never removes a tag or genre that was in ABS at
// import, nor a tag the user added by hand.

import { describe, it, expect } from 'vitest';
import { buildAbsPayload, snapshotAbsMetadata } from './absPayload.js';
import { applyMetadataToGroup } from './applyMetadata.js';
import { applyClassifyResult } from './applyClassifyResult.js';
import { applyTagsResultToGroup, applyDnaResultToGroup } from './applyTagResults.js';
import { applyGenreCleanupResult, applyAgeResult, mergeAgeTags } from './applyAiResults.js';
import { mergeClassifyTags } from './mergeClassifyTags.js';

const mk = (meta) => {
  const metadata = { title: 'T', author: 'A B', narrator: null, genres: [], tags: [], all_series: [], ...meta };
  return { id: 'g1', abs_id: 'g1', source: 'abs', metadata, abs_original: snapshotAbsMetadata(metadata), files: [] };
};

describe('D-3: Classify keeps age tags that are in the import snapshot', () => {
  const g = mk({ tags: ['favorite', 'age-adult', 'rated-r', 'dna:pacing:fast'], genres: ['Fantasy'] });

  it('full classification keeps snapshot age tags beside the new ones', () => {
    const r = applyClassifyResult(g.metadata,
      { success: true, genres: ['Fantasy'], tags: ['fast-paced'], age_tags: ['age-young-adult', 'rated-pg13'], dna_tags: [] },
      { originalTags: g.abs_original.tags });
    expect(r.metadata.tags).toEqual(expect.arrayContaining(['favorite', 'age-adult', 'rated-r', 'age-young-adult', 'rated-pg13', 'fast-paced']));
    const payload = buildAbsPayload(r.metadata, g.abs_original, {});
    expect(payload.tags).toEqual(expect.arrayContaining(['age-adult', 'rated-r']));
  });

  it('age-only answer keeps snapshot age tags', () => {
    const r2 = applyClassifyResult(g.metadata,
      { success: true, genres: [], tags: [], age_tags: ['age-young-adult'], dna_tags: [] },
      { originalTags: g.abs_original.tags });
    expect(r2.metadata.tags).toEqual(expect.arrayContaining(['favorite', 'dna:pacing:fast', 'age-adult', 'rated-r', 'age-young-adult']));
  });

  it('an age tag added earlier this session is still replaced by a new answer', () => {
    const r = mergeClassifyTags(['favorite', 'age-adult', 'age-teens'], { age_tags: ['age-kids'] }, ['favorite', 'age-adult']);
    expect(r.tags).toEqual(['favorite', 'age-adult', 'age-kids']);
  });

  it('Lookup Age follows the same rule (one policy)', () => {
    expect(mergeAgeTags(['favorite', 'age-adult', 'age-teens'], ['age-kids'], ['favorite', 'age-adult']))
      .toEqual(['favorite', 'age-adult', 'age-kids']);
    const out = applyAgeResult(g, { success: true, age_tags: ['age-young-adult'] }, { addGenre: false });
    expect(out.group.metadata.tags).toEqual(expect.arrayContaining(['age-adult', 'rated-r', 'age-young-adult']));
  });
});

describe('D-7: a tag added by hand is never removed by AI Tags or Classify', () => {
  const edited = () => applyMetadataToGroup(mk({ tags: ['favorite'] }), { tags: ['favorite', 'signed-copy'] }, ['tags']);

  it('AI Tags keeps it', () => {
    const out = applyTagsResultToGroup(edited(), { success: true, tags: ['fast-paced'], dna_tags: [] });
    expect(out.group.metadata.tags).toEqual(['favorite', 'signed-copy', 'fast-paced']);
  });

  it('Classify keeps it', () => {
    const g = edited();
    const r = applyClassifyResult(g.metadata, { success: true, genres: ['Fantasy'], tags: ['fast-paced'] },
      { originalTags: g.abs_original.tags, aiTags: g.ai_tags ?? [] });
    expect(r.metadata.tags).toEqual(['favorite', 'signed-copy', 'fast-paced']);
  });

  it('a second AI answer replaces only the tags the first one added', () => {
    let g = edited();
    g = applyTagsResultToGroup(g, { success: true, tags: ['fast-paced', 'slow-burn'], dna_tags: [] }).group;
    expect(g.ai_tags).toEqual(['fast-paced', 'slow-burn']);
    g = applyTagsResultToGroup(g, { success: true, tags: ['cozy'], dna_tags: [] }).group;
    expect(g.metadata.tags).toEqual(['favorite', 'signed-copy', 'cozy']);
    expect(g.ai_tags).toEqual(['cozy']);
    const r = applyClassifyResult(g.metadata, { success: true, genres: [], tags: ['dark'] },
      { originalTags: g.abs_original.tags, aiTags: g.ai_tags });
    expect(r.metadata.tags).toEqual(['favorite', 'signed-copy', 'dark']);
    expect(r.aiTags).toEqual(['dark']);
  });

  it('a hand-added tag that the AI also returns stays a hand-added tag', () => {
    const g = edited();
    const once = applyTagsResultToGroup(g, { success: true, tags: ['signed-copy', 'cozy'], dna_tags: [] }).group;
    expect(once.ai_tags).toEqual(['cozy']);
    const twice = applyTagsResultToGroup(once, { success: true, tags: ['dark'], dna_tags: [] }).group;
    expect(twice.metadata.tags).toEqual(['favorite', 'signed-copy', 'dark']);
  });

  it('a local book keeps its existing tags through Classify (no snapshot: nothing in it is AI vocabulary)', () => {
    const local = { id: 'l', metadata: { tags: ['mine'], genres: [] }, files: [{ id: 'f', path: '/a.m4b', changes: {} }] };
    const r = applyClassifyResult(local.metadata, { success: true, genres: [], tags: ['x'] }, { originalTags: [], aiTags: [] });
    expect(r.metadata.tags).toEqual(['mine', 'x']);
  });

  it('Force still replaces the tags when the AI returned tags (ledger exception)', () => {
    const g = edited();
    const r = applyClassifyResult(g.metadata, { success: true, genres: [], tags: ['x'] },
      { force: true, originalTags: g.abs_original.tags, aiTags: [] });
    expect(r.metadata.tags).toEqual(['x']);
  });
});

describe('Clean Genres ruling: a snapshot genre is replaced only by an exact mapping', () => {
  it('"Biography, Memoir" is not replaced by an answer that merely contains "Biography"', () => {
    const out = applyGenreCleanupResult(mk({ genres: ['Biography, Memoir', 'Cozy Witchy', 'Fantasy'] }),
      { success: true, cleaned_genres: ['Biography', 'Fantasy'] });
    expect(out.group.metadata.genres).toEqual(expect.arrayContaining(['Biography, Memoir', 'Cozy Witchy', 'Fantasy', 'Biography']));
    const p = buildAbsPayload(out.group.metadata, out.group.abs_original, { genre_enforcement: false });
    expect(p.metadata.genres || out.group.abs_original.genres).toEqual(expect.arrayContaining(['Biography, Memoir']));
  });

  it('an exact (case-only) match still counts as the replacement', () => {
    const out = applyGenreCleanupResult(mk({ genres: ['fantasy', 'Cozy Witchy'] }), { success: true, cleaned_genres: ['Fantasy'] });
    expect(out.group.metadata.genres).toEqual(['Fantasy', 'Cozy Witchy']);
  });

  it('a single genre whose whole-genre policy mapping is in the answer is replaced', () => {
    const out = applyGenreCleanupResult(mk({ genres: ['Sci-Fi'] }), { success: true, cleaned_genres: ['Science Fiction'] });
    expect(out.group.metadata.genres).toEqual(['Science Fiction']);
  });

  it('a compound genre is kept even when every part is in the answer', () => {
    const out = applyGenreCleanupResult(mk({ genres: ['Sci-Fi & Fantasy'] }), { success: true, cleaned_genres: ['Science Fiction', 'Fantasy'] });
    expect(out.group.metadata.genres).toContain('Sci-Fi & Fantasy');
  });
});

describe('a thin DNA answer does not replace a fuller set', () => {
  const full = () => mk({ tags: ['favorite', 'dna:pacing:fast', 'dna:theme:x', 'dna:trope:y'] });

  it('one dna tag against three is a failed answer and changes nothing', () => {
    const out = applyDnaResultToGroup(full(), { success: true, dna_tags: ['dna:length:2'] });
    expect(out.outcome).toBe('failed');
    expect(out.group.metadata.tags).toEqual(['favorite', 'dna:pacing:fast', 'dna:theme:x', 'dna:trope:y']);
    expect(out.group.lastError?.message).toMatch(/only 1 DNA tag/);
  });

  it('a short answer is fine when the book had no fuller set', () => {
    const out = applyDnaResultToGroup(mk({ tags: ['favorite'] }), { success: true, dna_tags: ['dna:length:2'] });
    expect(out.outcome).toBe('ok');
    expect(out.group.metadata.tags).toEqual(['favorite', 'dna:length:2']);
  });

  it('three or more dna tags replace the set', () => {
    const out = applyDnaResultToGroup(full(), { success: true, dna_tags: ['dna:a:1', 'dna:b:2', 'dna:c:3'] });
    expect(out.group.metadata.tags).toEqual(['favorite', 'dna:a:1', 'dna:b:2', 'dna:c:3']);
  });
});
