// Regression test for item R (2026-07-22 task 2): cleanup_genres flagged
// changed:true whenever enforceGenrePolicyWithSplit reordered a genre array
// even when the underlying set of genres was identical - comparison must be
// order-insensitive (sort copies before stringify).
import { describe, it, expect, beforeEach } from 'vitest';

const { callBackend } = await import('./api.js');

beforeEach(() => {
  localStorage.clear();
});

describe('R: cleanup_genres compares genre arrays order-insensitively', () => {
  it('does not report changed:true when genre policy enforcement only reorders the same set', async () => {
    // "Adult" is a broad genre that enforceGenrePolicy's priority sort pushes
    // to the end - feeding it in first triggers a pure reorder (Adult,Fantasy
    // -> Fantasy,Adult) with the exact same set of genres.
    const result = await callBackend('cleanup_genres', {
      groups: [{ id: 'b1', genres: ['Adult', 'Fantasy'] }],
    });
    const r = result.results[0];
    // Sanity check that this scenario actually exercises a reorder - if it
    // stopped reordering, the test would need a new pair, not a false pass.
    expect(r.cleaned_genres).not.toEqual(r.original_genres);
    expect(new Set(r.cleaned_genres)).toEqual(new Set(r.original_genres));
    expect(r.changed).toBe(false);
  });

  it('still reports changed:true when the genre set genuinely differs', async () => {
    const result = await callBackend('cleanup_genres', {
      groups: [{ id: 'b1', genres: ['not-a-real-genre', 'Also Fake'] }],
    });
    const r = result.results[0];
    expect(r.changed).toBe(true);
  });
});
