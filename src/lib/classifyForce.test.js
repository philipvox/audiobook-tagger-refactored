import { describe, it, expect } from 'vitest';
import { applyClassifyResult } from './applyClassifyResult';

const meta = () => ({ title: 'T', genres: ['Cozy Witchy', 'Fantasy'], tags: ['curated', 'dna:x'], themes: ['a'] });

describe('applyClassifyResult - never empties genres or tags', () => {
  it('force + empty answer returns metadata unchanged with empty-answer error', () => {
    const m = meta();
    const out = applyClassifyResult(m, { success: true, genres: [], tags: [] }, { force: true });
    expect(out.error).toBe('empty-answer');
    expect(out.metadata).toBe(m);
    expect(out.metadata).toEqual(meta());
    expect(out.changedFields).toEqual([]);
  });

  it('absent genres and tags are also an empty answer', () => {
    const out = applyClassifyResult(meta(), { success: true }, { force: false });
    expect(out.error).toBe('empty-answer');
  });

  it('force with genres but no tags updates genres and leaves tags alone', () => {
    const out = applyClassifyResult(meta(), { genres: ['Mystery'], tags: [] }, { force: true });
    expect(out.error).toBeUndefined();
    expect(out.metadata.genres).toEqual(['Mystery']);
    expect(out.metadata.tags).toEqual(['curated', 'dna:x']);
    expect(out.changedFields).toEqual(['genre']);
  });

  it('force with tags but no genres leaves genres alone and replaces tags', () => {
    const out = applyClassifyResult(meta(), { genres: [], tags: ['new'] }, { force: true });
    expect(out.metadata.genres).toEqual(['Cozy Witchy', 'Fantasy']);
    expect(out.metadata.tags).toEqual(['new']);
    expect(out.changedFields).toEqual(['tags']);
  });

  it('non-force supplements genres by default', () => {
    const out = applyClassifyResult(meta(), { genres: ['Adventure'] }, { preserveGenres: true });
    expect(out.metadata.genres).toEqual(['Cozy Witchy', 'Fantasy', 'Adventure']);
  });

  it('does not mutate the input metadata', () => {
    const m = meta();
    applyClassifyResult(m, { genres: ['Mystery'], tags: ['n'] }, { force: true });
    expect(m).toEqual(meta());
  });
});
