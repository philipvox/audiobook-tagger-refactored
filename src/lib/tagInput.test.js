import { describe, it, expect } from 'vitest';
import { normalizeTagInput, addTagToList, replaceTagInList } from './tagInput';

describe('normalizeTagInput (#54 tag-casing preservation)', () => {
  it('keeps the casing the user typed', () => {
    expect(normalizeTagInput('Sci-Fi')).toBe('Sci-Fi');
    expect(normalizeTagInput('Coming Of Age')).toBe('Coming-Of-Age');
  });

  it('trims and hyphenates whitespace', () => {
    expect(normalizeTagInput('  epic   fantasy  ')).toBe('epic-fantasy');
  });

  it('still normalizes the generated vocabulary tags the app matches literally', () => {
    // isDnaTag() uses a case-sensitive startsWith('dna:'), so DNA tags must
    // stay lowercase or they fall out of the DNA branch of the tag policy.
    expect(normalizeTagInput('DNA:Pacing:Fast')).toBe('dna:pacing:fast');
    expect(normalizeTagInput('Age-Teens')).toBe('age-teens');
    expect(normalizeTagInput('Rated-PG13')).toBe('rated-pg13');
    expect(normalizeTagInput('For-Kids')).toBe('for-kids');
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeTagInput('   ')).toBe('');
    expect(normalizeTagInput(null)).toBe('');
    expect(normalizeTagInput(undefined)).toBe('');
  });
});

describe('addTagToList', () => {
  it('appends the tag with its casing intact', () => {
    expect(addTagToList(['favorite'], 'Sci-Fi')).toEqual(['favorite', 'Sci-Fi']);
  });

  it('dedups case-insensitively', () => {
    const list = ['Fantasy'];
    expect(addTagToList(list, 'fantasy')).toBe(list);
    expect(addTagToList(list, 'FANTASY')).toBe(list);
  });

  it('ignores blank input', () => {
    const list = ['Fantasy'];
    expect(addTagToList(list, '   ')).toBe(list);
  });

  it('handles a null list', () => {
    expect(addTagToList(null, 'Fantasy')).toEqual(['Fantasy']);
  });
});

describe('replaceTagInList', () => {
  it('replaces the tag at the index, preserving casing', () => {
    expect(replaceTagInList(['favorite', 'scifi'], 1, 'Sci-Fi')).toEqual(['favorite', 'Sci-Fi']);
  });

  it('does not treat the edited slot as its own duplicate', () => {
    expect(replaceTagInList(['Fantasy'], 0, 'Fantasy')).toEqual(['Fantasy']);
    expect(replaceTagInList(['Fantasy'], 0, 'fantasy ')).toEqual(['fantasy']);
  });

  it('removes the tag when the value is cleared', () => {
    expect(replaceTagInList(['favorite', 'scifi'], 0, '  ')).toEqual(['scifi']);
  });

  it('collapses the edited tag into an existing one instead of duplicating', () => {
    expect(replaceTagInList(['Fantasy', 'horror'], 1, 'fantasy')).toEqual(['Fantasy']);
  });

  it('is a no-op for an out-of-range index', () => {
    const list = ['Fantasy'];
    expect(replaceTagInList(list, 5, 'Horror')).toBe(list);
    expect(replaceTagInList(list, null, 'Horror')).toBe(list);
  });
});
