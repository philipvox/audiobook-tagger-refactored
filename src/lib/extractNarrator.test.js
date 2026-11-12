import { describe, it, expect } from 'vitest';
import { extractNarrator } from './extractNarrator.js';

describe('extractNarrator', () => {
  it('rejects non-names', () => {
    expect(extractNarrator('Read by the author with a full cast.')).toBeNull();
    expect(extractNarrator('Performed by a full cast')).toBeNull();
    expect(extractNarrator('Narrated by an ensemble of actors.')).toBeNull();
    expect(extractNarrator('Read by Various Artists.')).toBeNull();
    expect(extractNarrator('Voiced by The Author')).toBeNull();
    expect(extractNarrator('Narrated by various')).toBeNull();
  });

  it('stops at connectors', () => {
    expect(extractNarrator('Narrated by John Lee and featuring original music')).toBe('John Lee');
    expect(extractNarrator('Read by Jane Doe with a full cast')).toBe('Jane Doe');
    expect(extractNarrator('Narrated by John Lee including bonus material')).toBe('John Lee');
    expect(extractNarrator('Narrated by John Lee and a full cast')).toBe('John Lee');
    expect(extractNarrator('Narrated by John Lee, author of the series')).toBe('John Lee');
  });

  it('joins two narrators with and', () => {
    expect(extractNarrator('Narrated by John Lee and Jane Doe')).toBe('John Lee, Jane Doe');
    expect(extractNarrator('Narrated by John Lee & Jane Doe.')).toBe('John Lee, Jane Doe');
  });

  it('keeps real names', () => {
    expect(extractNarrator('read by Bahni Turpin.')).toBe('Bahni Turpin');
    expect(extractNarrator('Read by January LaVoy')).toBe('January LaVoy');
    expect(extractNarrator('Narrated by R.C. Bray. A thriller.')).toBe('R.C. Bray');
    expect(extractNarrator('Performed by Simon de Deney, unabridged')).toBe('Simon de Deney');
    expect(extractNarrator('Narrated by Jean-Claude Van Damme!')).toBe('Jean-Claude Van Damme');
  });

  it('returns null when there is nothing safe', () => {
    expect(extractNarrator('')).toBeNull();
    expect(extractNarrator(null)).toBeNull();
    expect(extractNarrator('A story about a narrator.')).toBeNull();
    expect(extractNarrator('Read by Cher.')).toBeNull();
  });

  it('uses a later match when the first is not a name', () => {
    expect(extractNarrator('Read by the author. Narrated by John Lee.')).toBe('John Lee');
  });

  it('ignores html tags', () => {
    expect(extractNarrator('<p>Narrated by <b>John Lee</b></p>')).toBe('John Lee');
  });
});
