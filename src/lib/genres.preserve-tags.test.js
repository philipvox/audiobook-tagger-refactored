// #54: `preserve_existing_tags` - the tag-enforcement path used by the ABS push
// can keep tags that do NOT map to the approved vocabulary instead of dropping
// them, with the casing the user typed. Default (option absent/false) must stay
// byte-identical to the old drop-everything-unrecognized behavior.
import { describe, it, expect } from 'vitest';
import { enforceTagPolicy, enforceTagPolicyWithDna } from './genres';

describe('enforceTagPolicy - preserveUnrecognized OFF (default)', () => {
  it('still drops tags outside the approved vocabulary', () => {
    expect(enforceTagPolicy(['Epic Fantasy', 'Zzzz Custom Shelf', 'Sci-Fi'])).toEqual(['epic-fantasy']);
  });

  it('behaves identically when the option is passed explicitly as false', () => {
    expect(enforceTagPolicy(['Epic Fantasy', 'Zzzz Custom Shelf'], { preserveUnrecognized: false }))
      .toEqual(['epic-fantasy']);
  });
});

describe('enforceTagPolicy - preserveUnrecognized ON', () => {
  const on = { preserveUnrecognized: true };

  it('keeps unrecognized tags as-is, with the original casing', () => {
    const out = enforceTagPolicy(['Zzzz Custom Shelf', 'Sci-Fi'], on);
    expect(out).toContain('Zzzz Custom Shelf');
    expect(out).toContain('Sci-Fi');
  });

  it('still normalizes tags that DO map to the approved vocabulary', () => {
    expect(enforceTagPolicy(['Epic Fantasy'], on)).toEqual(['epic-fantasy']);
  });

  it('puts the approved tags first and the preserved ones after', () => {
    expect(enforceTagPolicy(['Zzzz Custom Shelf', 'Epic Fantasy'], on))
      .toEqual(['epic-fantasy', 'Zzzz Custom Shelf']);
  });

  it('dedups preserved tags case-insensitively, keeping the first casing', () => {
    expect(enforceTagPolicy(['Sci-Fi', 'sci-fi', 'SCI-FI'], on)).toEqual(['Sci-Fi']);
  });

  it('does not re-add a preserved copy of a tag that already mapped', () => {
    // 'Epic Fantasy' maps to 'epic-fantasy'; the literal 'epic-fantasy' input
    // must not come back a second time as a preserved tag.
    expect(enforceTagPolicy(['Epic Fantasy', 'epic-fantasy'], on)).toEqual(['epic-fantasy']);
  });

  it('drops blank entries', () => {
    expect(enforceTagPolicy(['   ', ''], on)).toEqual([]);
  });

  it('keeps preserved tags outside the 15-tag approved cap so none are silently lost', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Zzzz Shelf ${i}`); // unrecognized
    const out = enforceTagPolicy(['Epic Fantasy', ...many], on);
    expect(out[0]).toBe('epic-fantasy');
    expect(out).toHaveLength(21);
  });
});

describe('enforceTagPolicyWithDna threads the option through', () => {
  it('OFF: unrecognized dropped, dna passed through', () => {
    expect(enforceTagPolicyWithDna(['Epic Fantasy', 'Sci-Fi', 'dna:pov:first']))
      .toEqual(['epic-fantasy', 'dna:pov:first']);
  });

  it('ON: unrecognized preserved, dna still passed through last and untouched', () => {
    expect(enforceTagPolicyWithDna(['Epic Fantasy', 'Sci-Fi', 'dna:pov:first'], { preserveUnrecognized: true }))
      .toEqual(['epic-fantasy', 'Sci-Fi', 'dna:pov:first']);
  });

  it('ON: approved age/rating tags are unaffected (they map, so they normalize)', () => {
    expect(enforceTagPolicyWithDna(['Age-Teens', 'rated-pg13'], { preserveUnrecognized: true }))
      .toEqual(['age-teens', 'rated-pg13']);
  });
});
