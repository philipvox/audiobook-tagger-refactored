// v2.2.3: fuzzy (partial-token) mapping must not turn short or unrelated
// strings into an approved tag/genre. Exact and alias matches are unaffected.
import { describe, it, expect } from 'vitest';
import { mapTag, mapGenre } from './genres.js';

describe('fuzzy tag mapping guard', () => {
  it('does not map a long phrase onto a one-word approved tag it merely contains', () => {
    expect(mapTag('a-dark-horse')).toBeNull();
    expect(mapTag('dark-and-gritty')).toBeNull();
    expect(mapTag('world-war-ii')).toBeNull();
    expect(mapTag('kids-books-for-car')).toBeNull();
  });

  it('does not map a negated phrase onto the thing it negates', () => {
    expect(mapTag('no-love-triangle')).toBeNull();
    expect(mapTag('not-dark-at-all')).toBeNull();
  });

  it('still maps close variants', () => {
    expect(mapTag('found-family-vibes')).toBe('found-family');
    expect(mapTag('Epic Fantasy Novel')).toBe('epic-fantasy');
  });

  it('exact matches still work', () => {
    expect(mapTag('dark')).toBe('dark');
  });
});

describe('fuzzy genre mapping guard', () => {
  it('does not map an unrelated title-like phrase', () => {
    expect(mapGenre('Science of War')).toBeNull();
    expect(mapGenre('History of Love')).toBeNull();
  });

  it('still maps close variants and aliases', () => {
    expect(mapGenre('mystery thriller')).toBe('Mystery');
    expect(mapGenre('ya')).toBe('Young Adult');
  });
});
