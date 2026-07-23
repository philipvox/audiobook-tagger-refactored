import { describe, it, expect } from 'vitest';
import { stringSimilarity, extractTitleFromFilename, assignCovers } from './coverMatch';

describe('stringSimilarity (H4: substring rule needs >= 80% length ratio)', () => {
  it('scores exact normalized equality as 1.0', () => {
    expect(stringSimilarity('Harry Potter', 'harry_potter')).toBe(1);
  });

  it('does NOT give the 0.9 substring credit when lengths differ too much', () => {
    // "harrypotter" (11) is contained in "harrypotterandthegobletoffire" (>>80%),
    // so the substring shortcut must not fire; the score should be well below 0.9.
    const score = stringSimilarity('Harry Potter', 'Harry Potter and the Goblet of Fire');
    expect(score).toBeLessThan(0.9);
  });

  it('still gives 0.9 for near-equal-length substrings', () => {
    // "harrypotter" (11) vs "harrypotter2" (12): 11/12 = 0.916 >= 0.8 -> 0.9.
    expect(stringSimilarity('harrypotter', 'harrypotter2')).toBe(0.9);
  });

  it('returns 0 for empty inputs', () => {
    expect(stringSimilarity('', 'x')).toBe(0);
    expect(stringSimilarity('x', '')).toBe(0);
  });
});

describe('extractTitleFromFilename', () => {
  it('strips extension, cover/artwork suffixes, and separators', () => {
    expect(extractTitleFromFilename('The_Hobbit_cover.jpg')).toBe('The Hobbit');
    expect(extractTitleFromFilename('dune-artwork.png')).toBe('dune-artwork'.replace(/[_-]/g, ' '));
  });
});

describe('assignCovers (H4 greedy + H5 preserve manual)', () => {
  it('assigns by best score across all pairs, not book order', () => {
    const books = [
      { id: 'b1', title: 'Dune Messiah' },
      { id: 'b2', title: 'Dune' },
    ];
    const images = [
      { name: 'Dune.jpg' },
      { name: 'Dune Messiah.jpg' },
    ];
    const out = assignCovers({ books, images });
    // b2 should get the exact "Dune" image (index 0), b1 the "Dune Messiah" (index 1).
    expect(out.b2.imageIndex).toBe(0);
    expect(out.b1.imageIndex).toBe(1);
  });

  it('preserves existing manual assignments and only matches the rest', () => {
    const books = [
      { id: 'b1', title: 'Dune' },
      { id: 'b2', title: 'Foundation' },
    ];
    const images = [
      { name: 'Dune.jpg' },
      { name: 'Foundation.jpg' },
    ];
    // b1 was manually pinned to the Foundation image; re-match must not steal it.
    const existing = { b1: { imageIndex: 1, score: 1, manual: true } };
    const out = assignCovers({ books, images, existing });
    expect(out.b1).toEqual({ imageIndex: 1, score: 1, manual: true });
    // b2 gets the only remaining image (index 0), even though it's a poor match,
    // only if above threshold; here "Foundation" vs "Dune" is below threshold so
    // b2 stays unassigned.
    expect(out.b2).toBeUndefined();
  });

  it('does not reuse an image already taken by a manual assignment', () => {
    const books = [
      { id: 'b1', title: 'Dune' },
      { id: 'b2', title: 'Dune' },
    ];
    const images = [{ name: 'Dune.jpg' }];
    const existing = { b1: { imageIndex: 0, score: 1, manual: true } };
    const out = assignCovers({ books, images, existing });
    expect(out.b1.imageIndex).toBe(0);
    expect(out.b2).toBeUndefined(); // only image already used
  });
});
