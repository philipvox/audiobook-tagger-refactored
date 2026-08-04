import { describe, it, expect } from 'vitest';
import { mergeGenres } from './mergeGenres';
import { MAX_GENRES } from './genres';

describe('mergeGenres - preserve OFF (legacy replace behavior, #54)', () => {
  it('replaces the existing genres when the AI returned genres', () => {
    const { genres, changed } = mergeGenres(['Horror'], ['Fantasy', 'Adventure']);
    expect(genres).toEqual(['Fantasy', 'Adventure']);
    expect(changed).toBe(true);
  });

  it('leaves the existing genres untouched when the AI returned none', () => {
    const existing = ['Horror'];
    const { genres, changed } = mergeGenres(existing, []);
    expect(genres).toBe(existing);
    expect(changed).toBe(false);
  });

  it('does NOT cap or dedup - the off path is byte-identical to the old inline code', () => {
    const ai = ['Fantasy', 'fantasy', 'Adventure', 'Horror'];
    expect(mergeGenres([], ai).genres).toBe(ai);
  });

  it('reports changed=true even when the AI genres equal the existing ones', () => {
    // Intentional asymmetry: with preserve OFF, `changed` mirrors the pre-#54
    // signal ("the AI returned genres"), NOT a value comparison, so the
    // default-off classify path stamps the `genre` file change exactly as before.
    const { changed } = mergeGenres(['Fantasy'], ['Fantasy']);
    expect(changed).toBe(true);
  });

  it('handles null/undefined inputs safely', () => {
    expect(mergeGenres(null, null).genres).toEqual([]);
    expect(mergeGenres(undefined, ['Fantasy']).genres).toEqual(['Fantasy']);
  });
});

describe('mergeGenres - preserve ON (supplement instead of replace, #54)', () => {
  const on = { preserve: true };

  it('unions existing + AI genres with the existing ones first', () => {
    const { genres, changed } = mergeGenres(['Horror'], ['Fantasy'], on);
    expect(genres).toEqual(['Horror', 'Fantasy']);
    expect(changed).toBe(true);
  });

  it('dedups case-insensitively and keeps the EXISTING casing', () => {
    const { genres } = mergeGenres(['Fantasy'], ['fantasy', 'Horror'], on);
    expect(genres).toEqual(['Fantasy', 'Horror']);
  });

  it('dedups repeats within the AI list too', () => {
    const { genres } = mergeGenres([], ['Fantasy', 'FANTASY'], on);
    expect(genres).toEqual(['Fantasy']);
  });

  it('caps the merged list at the genre-count policy, favoring existing genres', () => {
    expect(MAX_GENRES).toBe(3);
    const { genres } = mergeGenres(
      ['Horror', 'Thriller'],
      ['Fantasy', 'Adventure', 'Romance'],
      on
    );
    expect(genres).toEqual(['Horror', 'Thriller', 'Fantasy']);
  });

  it('never drops existing genres, even when they already exceed the cap', () => {
    const existing = ['Horror', 'Thriller', 'Mystery', 'Crime'];
    const { genres, changed } = mergeGenres(existing, ['Fantasy'], on);
    expect(genres).toEqual(existing);
    expect(changed).toBe(false);
  });

  it('reports changed=false when every AI genre is already present', () => {
    const { genres, changed } = mergeGenres(['Fantasy', 'Horror'], ['fantasy'], on);
    expect(genres).toEqual(['Fantasy', 'Horror']);
    expect(changed).toBe(false);
  });

  it('returns the AI genres when there are no existing genres (force-fresh path)', () => {
    // ScannerPage clears metadata.genres before the merge on a Force run, so
    // Force still wins over the preserve setting.
    const { genres, changed } = mergeGenres([], ['Fantasy', 'Horror'], on);
    expect(genres).toEqual(['Fantasy', 'Horror']);
    expect(changed).toBe(true);
  });

  it('drops empty/whitespace entries and trims without touching casing', () => {
    const { genres } = mergeGenres(['  Sci-Fi  ', ''], ['   ', 'Horror'], on);
    expect(genres).toEqual(['Sci-Fi', 'Horror']);
  });

  it('honors an explicit max override', () => {
    const { genres } = mergeGenres(['Horror'], ['Fantasy', 'Adventure'], { preserve: true, max: 2 });
    expect(genres).toEqual(['Horror', 'Fantasy']);
  });
});
