import { describe, it, expect } from 'vitest';
import { mergeClassifyTags, isAgeTag } from './mergeClassifyTags';

describe('mergeClassifyTags (H1 curated-tag preservation)', () => {
  it('DNA-only response preserves curated tags (the data-loss bug)', () => {
    const existing = ['favorite', 'reread', 'dna:pacing:fast'];
    const { tags, changed } = mergeClassifyTags(existing, {
      dna_tags: ['dna:pacing:slow', 'dna:pov:first'],
    });
    expect(changed).toBe(true);
    // curated tags survive, stale dna: tag replaced, new dna tags added
    expect(tags).toContain('favorite');
    expect(tags).toContain('reread');
    expect(tags).toContain('dna:pacing:slow');
    expect(tags).toContain('dna:pov:first');
    expect(tags).not.toContain('dna:pacing:fast');
  });

  it('age-only response preserves curated tags and swaps stale age tags', () => {
    const existing = ['favorite', 'age-adult', 'rated-r'];
    const { tags } = mergeClassifyTags(existing, {
      age_tags: ['age-teens', 'rated-pg13'],
    });
    expect(tags).toContain('favorite');
    expect(tags).toContain('age-teens');
    expect(tags).toContain('rated-pg13');
    expect(tags).not.toContain('age-adult');
    expect(tags).not.toContain('rated-r');
  });

  it('full classification tags replace but still fold in dna/age', () => {
    const existing = ['favorite', 'dna:pov:first'];
    const { tags, changed } = mergeClassifyTags(existing, {
      tags: ['fantasy', 'epic'],
      dna_tags: ['dna:pov:third'],
      age_tags: ['age-adult'],
    });
    expect(changed).toBe(true);
    expect(tags).toEqual(expect.arrayContaining(['fantasy', 'epic', 'dna:pov:third', 'age-adult']));
    // 'favorite' is NOT preserved on a full replace — replace is intentional
    expect(tags).not.toContain('favorite');
  });

  it('empty response leaves tags untouched and reports no change', () => {
    const existing = ['favorite', 'dna:pacing:fast'];
    const { tags, changed } = mergeClassifyTags(existing, {});
    expect(changed).toBe(false);
    expect(tags).toBe(existing);
  });

  it('dedups within the merged set', () => {
    const { tags } = mergeClassifyTags(['a'], { tags: ['x', 'x', 'y'], dna_tags: ['y'] });
    expect(tags).toEqual(['x', 'y']);
  });

  it('handles null/undefined existing tags safely', () => {
    expect(mergeClassifyTags(null, { dna_tags: ['dna:pov:first'] }).tags).toEqual(['dna:pov:first']);
    expect(mergeClassifyTags(undefined, {}).tags).toEqual([]);
  });

  it('isAgeTag matches the age vocabulary', () => {
    ['age-adult', 'age-teens', 'rated-pg13', 'for-kids', 'not-for-kids', 'for-ya'].forEach((t) =>
      expect(isAgeTag(t)).toBe(true)
    );
    ['fantasy', 'dna:pov:first', 'pub-2020'].forEach((t) => expect(isAgeTag(t)).toBe(false));
  });
});
