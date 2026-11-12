import { describe, it, expect } from 'vitest';
import { applyTagsResultToGroup, applyDnaResultToGroup, normalizeResults } from './applyTagResults';

const EXISTING = ['favorite', 'kids-bedtime', 'dna:pacing:fast'];
const mkGroup = (extra = {}) => ({
  id: 'g1',
  metadata: { title: 'T', tags: [...EXISTING] },
  abs_original: { tags: [...EXISTING] },
  files: [{ id: 'f1', changes: {} }],
  ...extra,
});
const sorted = (a) => [...a].sort();

describe('applyTagsResultToGroup', () => {
  it('keeps curated and dna tags when the DNA step failed, and sets lastError', () => {
    const { group, outcome } = applyTagsResultToGroup(mkGroup(), {
      id: 'g1', success: true, tags: ['fast-paced'], dna_tags: [], dna_error: 'dna boom',
    });
    expect(sorted(group.metadata.tags)).toEqual(sorted([...EXISTING, 'fast-paced']));
    expect(group.lastError.message).toContain('dna boom');
    expect(group.changedFields).toContain('tags');
    expect(group.files[0].changes.tags).toBeTruthy();
    expect(outcome).toBe('partial');
  });

  it('replaces old dna tags only when new ones arrive', () => {
    const { group, outcome } = applyTagsResultToGroup(mkGroup(), {
      success: true, tags: ['fast-paced'], dna_tags: ['dna:pacing:slow'],
    });
    expect(sorted(group.metadata.tags)).toEqual(sorted(['favorite', 'kids-bedtime', 'fast-paced', 'dna:pacing:slow']));
    expect(outcome).toBe('ok');
  });

  it('keeps all tags when the group has no import snapshot', () => {
    const { group } = applyTagsResultToGroup(mkGroup({ abs_original: undefined }), {
      success: true, tags: ['fast-paced'], dna_tags: [],
    });
    expect(sorted(group.metadata.tags)).toEqual(sorted([...EXISTING, 'fast-paced']));
  });

  it('shows an error for success with no tags at all and changes nothing', () => {
    const g = mkGroup();
    const { group, outcome } = applyTagsResultToGroup(g, { success: true, tags: [], dna_tags: [] });
    expect(group.metadata.tags).toEqual(EXISTING);
    expect(group.lastError.stage).toBe('tags');
    expect(outcome).toBe('empty');
  });

  it('marks a failed book with its error and leaves tags', () => {
    const { group, outcome } = applyTagsResultToGroup(mkGroup(), { success: false, error: 'nope' });
    expect(group.metadata.tags).toEqual(EXISTING);
    expect(group.lastError.message).toBe('nope');
    expect(outcome).toBe('failed');
  });

  it('clears an earlier tags error on a clean run but not another stage error', () => {
    const clean = { success: true, tags: ['x'], dna_tags: ['dna:pacing:slow'] };
    const a = applyTagsResultToGroup(mkGroup({ lastError: { stage: 'tags', message: 'old' } }), clean).group;
    expect(a.lastError).toBeUndefined();
    const b = applyTagsResultToGroup(mkGroup({ lastError: { stage: 'classify', message: 'old' } }), clean).group;
    expect(b.lastError.stage).toBe('classify');
  });

  it('leaves the group alone when no result exists for it', () => {
    const g = mkGroup();
    expect(applyTagsResultToGroup(g, undefined).group).toBe(g);
  });
});

describe('applyDnaResultToGroup', () => {
  it('no new dna tags: every dna: tag stays and the book is marked failed', () => {
    const { group, outcome } = applyDnaResultToGroup(mkGroup(), {
      success: false, dna_tags: [], error: 'The AI returned no DNA tags',
    });
    expect(group.metadata.tags).toEqual(EXISTING);
    expect(group.lastError.stage).toBe('dna');
    expect(outcome).toBe('failed');
  });

  it('success flag with empty dna_tags is still a failure that keeps tags', () => {
    const { group } = applyDnaResultToGroup(mkGroup(), { success: true, dna_tags: [] });
    expect(group.metadata.tags).toEqual(EXISTING);
    expect(group.lastError).toBeTruthy();
  });

  it('new dna tags replace old dna tags and keep the rest', () => {
    const { group, outcome } = applyDnaResultToGroup(mkGroup(), { success: true, dna_tags: ['dna:pacing:slow'] });
    expect(sorted(group.metadata.tags)).toEqual(sorted(['favorite', 'kids-bedtime', 'dna:pacing:slow']));
    expect(group.changedFields).toContain('tags');
    expect(outcome).toBe('ok');
  });

  it('clears an earlier dna error on success', () => {
    const { group } = applyDnaResultToGroup(
      mkGroup({ lastError: { stage: 'dna', message: 'old' } }),
      { success: true, dna_tags: ['dna:pacing:slow'] }
    );
    expect(group.lastError).toBeUndefined();
  });
});

describe('normalizeResults', () => {
  it('accepts an array, an object with results, or nothing', () => {
    expect(normalizeResults([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(normalizeResults({ results: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(normalizeResults(undefined)).toEqual([]);
  });
});
