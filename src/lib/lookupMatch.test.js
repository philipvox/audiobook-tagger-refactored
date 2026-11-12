import { describe, it, expect } from 'vitest';
import { titleMatch, lookupHitMatches, pickLookupHit } from './lookupMatch.js';

const toHit = (d) => ({ title: d.title, authors: d.author_name });

describe('lookupMatch: whole-word titles, exact first', () => {
  it('"It" does not match "The Pit and the Pendulum"', () => {
    expect(titleMatch('It', 'The Pit and the Pendulum')).toBeNull();
    expect(lookupHitMatches({ title: 'It', author: 'Stephen King' },
      { title: 'The Pit and the Pendulum', authors: ['Stephen King'] })).toBe(false);
  });

  it('matches whole words only, and ignores case, punctuation and trailing junk', () => {
    expect(titleMatch('Dune', 'dune messiah')).toBe('contains');
    expect(titleMatch('The Hobbit (Unabridged)', 'the hobbit')).toBe('exact');
    expect(titleMatch('Guards! Guards!', 'Guards Guards')).toBe('exact');
    expect(titleMatch('Sand', 'Dune Sandworms')).toBeNull();
  });

  it('"Dune" with hits ["Dune Messiah", "Dune"] picks "Dune"', () => {
    const docs = [
      { title: 'Dune Messiah', author_name: ['Frank Herbert'] },
      { title: 'Dune', author_name: ['Frank Herbert'] },
    ];
    expect(pickLookupHit({ title: 'Dune', author: 'Frank Herbert' }, docs, toHit)).toBe(docs[1]);
    expect(pickLookupHit({ title: 'Dune', author: 'Unknown' }, docs, toHit)).toBe(docs[1]);
  });

  it('"Dune" with only "Dune Messiah" and a placeholder author is rejected', () => {
    const docs = [{ title: 'Dune Messiah', author_name: ['Frank Herbert'] }];
    expect(pickLookupHit({ title: 'Dune', author: 'Unknown' }, docs, toHit)).toBeNull();
    expect(pickLookupHit({ title: 'Dune', author: '' }, docs, toHit)).toBeNull();
  });

  it('a containment match needs a real author whose surname matches', () => {
    const docs = [{ title: 'The Sentence: A Novel', author_name: ['Louise Erdrich'] }];
    expect(pickLookupHit({ title: 'The Sentence', author: 'Louise Erdrich' }, docs, toHit)).toBe(docs[0]);
    expect(pickLookupHit({ title: 'The Sentence', author: 'Someone Else' }, docs, toHit)).toBeNull();
  });

  it('honours the accept filter before matching', () => {
    const docs = [
      { title: 'Dune', author_name: ['Frank Herbert'] },
      { title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441013593'] },
    ];
    expect(pickLookupHit({ title: 'Dune', author: 'Frank Herbert' }, docs, toHit, (d) => !!d.isbn)).toBe(docs[1]);
  });
});
