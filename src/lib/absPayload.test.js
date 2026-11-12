// v2.2.3 push semantics: a push sends ONLY what changed since the book was
// imported from ABS. Tag/genre policy applies only to values added this
// session; existing tags/genres are never dropped by it; empty arrays are
// never sent unless the user cleared the field; no "Unknown" author.
import { describe, it, expect } from 'vitest';
import { buildAbsPayload, snapshotAbsMetadata, applyPayloadToSnapshot, syncAllSeries, parseSeriesName, isPlaceholderSeries, isMultiSeriesName } from './absPayload.js';

const base = {
  title: 'Dune',
  author: 'Frank Herbert',
  narrator: 'Scott Brick',
  series: 'Dune',
  sequence: '1',
  all_series: [{ name: 'Dune', sequence: '1', source: 'abs' }],
  genres: ['LitRPG', 'Zzzz Custom Shelf'],
  tags: ['dna:pov:first', 'my-favourites', 'Book Club 2024'],
  description: 'Spice.',
  publisher: 'Ace',
  published_year: '1965',
};

const orig = () => snapshotAbsMetadata(base);
const cfg = {};

describe('diff against the import snapshot', () => {
  it('an untouched book produces an empty payload (nothing sent)', () => {
    const payload = buildAbsPayload({ ...base }, orig(), cfg);
    expect(payload).toEqual({ metadata: {} });
  });

  it('only the edited field is sent', () => {
    const payload = buildAbsPayload({ ...base, description: 'New blurb.' }, orig(), cfg);
    expect(payload).toEqual({ metadata: { description: 'New blurb.' } });
  });

  it('existing genres outside the approved list are never re-sent or wiped', () => {
    // The bug: enforceGenrePolicyWithSplit(['LitRPG']) -> [] and genres: [] went out.
    const payload = buildAbsPayload({ ...base, title: 'Dune (Deluxe)' }, orig(), cfg);
    expect(payload.metadata).not.toHaveProperty('genres');
    expect(payload).not.toHaveProperty('tags');
  });
});

describe('genres', () => {
  it('policy applies to AI-added genres only; existing ones are kept verbatim', () => {
    const meta = { ...base, genres: ['LitRPG', 'Zzzz Custom Shelf', 'sci-fi'] };
    const payload = buildAbsPayload(meta, orig(), cfg);
    expect(payload.metadata.genres).toEqual(['LitRPG', 'Zzzz Custom Shelf', 'Science Fiction']);
  });

  it('an AI genre the policy rejects is dropped without touching existing ones', () => {
    const meta = { ...base, genres: ['LitRPG', 'Zzzz Custom Shelf', 'Qqqq Nonsense'] };
    const payload = buildAbsPayload(meta, orig(), cfg);
    expect(payload.metadata).not.toHaveProperty('genres');
  });

  it('never sends genres: [] just because the policy emptied the additions', () => {
    const payload = buildAbsPayload({ ...base, genres: ['Qqqq Nonsense'] }, snapshotAbsMetadata({ ...base, genres: [] }), cfg);
    expect(payload.metadata).not.toHaveProperty('genres');
  });

  it('sends no genres key for an empty list without the user_cleared flag', () => {
    const payload = buildAbsPayload({ ...base, genres: [] }, orig(), cfg);
    expect(payload.metadata).not.toHaveProperty('genres');
  });

  it('sends genres: [] only when user_cleared includes genres', () => {
    const payload = buildAbsPayload({ ...base, genres: [], user_cleared: ['genres'] }, orig(), cfg);
    expect(payload.metadata.genres).toEqual([]);
  });

  it('a user-removed genre is removed', () => {
    const payload = buildAbsPayload({ ...base, genres: ['LitRPG'] }, orig(), cfg);
    expect(payload.metadata.genres).toEqual(['LitRPG']);
  });

  it('preserve_existing_genres does not switch off the policy for additions', () => {
    const meta = { ...base, genres: ['LitRPG', 'Zzzz Custom Shelf', 'Qqqq Nonsense'] };
    const payload = buildAbsPayload(meta, orig(), { preserve_existing_genres: true });
    expect(payload.metadata).not.toHaveProperty('genres');
  });

  it('the cap applies to additions only, never trimming kept genres', () => {
    const o = snapshotAbsMetadata({ ...base, genres: ['A1', 'A2', 'A3', 'A4'] });
    const payload = buildAbsPayload({ ...base, genres: ['A1', 'A2', 'A3', 'A4', 'Fantasy'] }, o, {});
    expect(payload.metadata).not.toHaveProperty('genres');
  });
});

describe('tags', () => {
  it('existing dna:/user tags survive when AI tags are added; policy only on additions', () => {
    const meta = { ...base, tags: [...base.tags, 'Epic Fantasy', 'Qqqq Nonsense', 'dna:pace:slow'] };
    const payload = buildAbsPayload(meta, orig(), cfg);
    expect(payload.tags).toEqual(['dna:pov:first', 'my-favourites', 'Book Club 2024', 'epic-fantasy', 'dna:pace:slow']);
  });

  it('a user-removed tag is removed, others kept', () => {
    const meta = { ...base, tags: ['dna:pov:first', 'Book Club 2024'] };
    const payload = buildAbsPayload(meta, orig(), cfg);
    expect(payload.tags).toEqual(['dna:pov:first', 'Book Club 2024']);
  });

  it('never sends tags: [] when additions were all rejected and nothing existed', () => {
    const payload = buildAbsPayload({ ...base, tags: ['Qqqq Nonsense'] }, snapshotAbsMetadata({ ...base, tags: [] }), cfg);
    expect(payload).not.toHaveProperty('tags');
  });

  it('sends no tags key for an empty list without the user_cleared flag', () => {
    const payload = buildAbsPayload({ ...base, tags: [] }, orig(), cfg);
    expect(payload).not.toHaveProperty('tags');
  });

  it('sends tags: [] only when user_cleared includes tags', () => {
    const payload = buildAbsPayload({ ...base, tags: [], user_cleared: ['tags'] }, orig(), cfg);
    expect(payload.tags).toEqual([]);
  });
});

describe('authors and narrators', () => {
  it('never creates an "Unknown" author', () => {
    const o = snapshotAbsMetadata({ ...base, author: 'Unknown' });
    expect(buildAbsPayload({ ...base, author: 'Unknown', title: 'X' }, o, cfg).metadata).not.toHaveProperty('authors');
    expect(buildAbsPayload({ author: 'Unknown', title: 'X' }, null, cfg).metadata).not.toHaveProperty('authors');
  });

  it('inverts a single "Last, First" name and keeps suffixed names whole', () => {
    expect(buildAbsPayload({ ...base, author: 'King, Stephen' }, orig(), cfg).metadata.authors)
      .toEqual([{ id: 'new-1', name: 'Stephen King' }]);
    expect(buildAbsPayload({ ...base, author: 'Martin Luther King, Jr.' }, orig(), cfg).metadata.authors)
      .toEqual([{ id: 'new-1', name: 'Martin Luther King, Jr.' }]);
  });

  it('does not split a single narrator name on its comma', () => {
    expect(buildAbsPayload({ ...base, narrator: 'Brick, Scott' }, orig(), cfg).metadata.narrators).toEqual(['Scott Brick']);
    expect(buildAbsPayload({ ...base, narrator: 'Scott Brick, Euan Morton' }, orig(), cfg).metadata.narrators)
      .toEqual(['Scott Brick', 'Euan Morton']);
  });
});

describe('series edits', () => {
  it('a series/sequence edit wins over a stale all_series', () => {
    // Edit modal / bulk edit change only series+sequence; all_series is stale.
    const meta = { ...base, series: 'Dune Chronicles', sequence: '2' };
    const payload = buildAbsPayload(meta, orig(), cfg);
    expect(payload.metadata.series).toEqual([{ name: 'Dune Chronicles', sequence: '2' }]);
  });

  it('a sequence-only edit is pushed', () => {
    const payload = buildAbsPayload({ ...base, sequence: '3' }, orig(), cfg);
    expect(payload.metadata.series).toEqual([{ name: 'Dune', sequence: '3' }]);
  });

  it('secondary series are kept when the primary is edited', () => {
    const two = { ...base, all_series: [{ name: 'Dune', sequence: '1' }, { name: 'Sci-Fi Masterworks', sequence: '7' }] };
    const payload = buildAbsPayload({ ...two, sequence: '2' }, snapshotAbsMetadata(two), cfg);
    expect(payload.metadata.series).toEqual([{ name: 'Dune', sequence: '2' }, { name: 'Sci-Fi Masterworks', sequence: '7' }]);
  });

  it('syncAllSeries rewrites the primary entry when series/sequence change', () => {
    const prev = { ...base };
    const next = { ...base, series: 'Dune Chronicles', sequence: '2' };
    expect(syncAllSeries(prev, next).all_series).toEqual([{ name: 'Dune Chronicles', sequence: '2', source: 'abs' }]);
    expect(syncAllSeries(prev, { ...base, series: null, sequence: null }).all_series).toEqual([]);
    expect(syncAllSeries(prev, { ...base }).all_series).toBe(base.all_series);
  });
});

describe('fallback without a snapshot', () => {
  it('sends values as-is with no destructive genre/tag policy', () => {
    const payload = buildAbsPayload({ ...base }, null, cfg);
    expect(payload.metadata.genres).toEqual(['LitRPG', 'Zzzz Custom Shelf']);
    expect(payload.tags).toEqual(base.tags);
  });

  it('never sends empty arrays', () => {
    const payload = buildAbsPayload({ title: 'X', genres: [], tags: [] }, null, cfg);
    expect(payload.metadata).not.toHaveProperty('genres');
    expect(payload).not.toHaveProperty('tags');
  });
});

describe('applyPayloadToSnapshot', () => {
  it('advances the snapshot so a later revert is detected as a change', () => {
    const meta = { ...base, tags: [...base.tags, 'epic-fantasy'] };
    const payload = buildAbsPayload(meta, orig(), cfg);
    const next = applyPayloadToSnapshot(orig(), meta, payload);
    expect(next.tags).toEqual(payload.tags);
    // User now removes the tag that was pushed: must be sent.
    const again = buildAbsPayload({ ...base }, next, cfg);
    expect(again.tags).toEqual(base.tags);
  });
});

// C-3 / M-3: the ABS list endpoint sends `seriesName` ("Name #seq", several
// joined by ", "); placeholders from AI never replace a curated series.
describe('parseSeriesName', () => {
  it('splits the ABS "Name #seq" form, keeping decimal sequences', () => {
    expect(parseSeriesName('Rivers of London #8.1')).toEqual({ name: 'Rivers of London', sequence: '8.1' });
    expect(parseSeriesName('Rivers of London #9')).toEqual({ name: 'Rivers of London', sequence: '9' });
  });

  it('a name with no sequence keeps the whole name', () => {
    expect(parseSeriesName('Discworld')).toEqual({ name: 'Discworld', sequence: null });
  });

  it('any string with ", " may hold several series, so it is not parsed', () => {
    // ABS omits "#seq" for an unsequenced series, so a comma alone can join
    // two series ("Discworld, Tiffany Aching #2", "A, B"). Import fetches these.
    expect(parseSeriesName('Wallace, Gromit #2')).toBeNull();
    expect(parseSeriesName('Tales of Earth, Sea and Sky')).toBeNull();
    expect(parseSeriesName('Discworld, Tiffany Aching #2')).toBeNull();
  });

  it('returns null for empty input and for a string that may hold several series', () => {
    expect(parseSeriesName('')).toBeNull();
    expect(parseSeriesName('   ')).toBeNull();
    expect(parseSeriesName(null)).toBeNull();
    expect(parseSeriesName('The Plantagenet and Tudor #6, Tudor Court #1')).toBeNull();
  });

  it('isMultiSeriesName flags any string containing ", "', () => {
    expect(isMultiSeriesName('A #6, B #1')).toBe(true);
    expect(isMultiSeriesName('Discworld, Tiffany Aching #2')).toBe(true);
    expect(isMultiSeriesName('A, B')).toBe(true);
    expect(isMultiSeriesName('Wallace, Gromit #2')).toBe(true);
    expect(isMultiSeriesName('Discworld')).toBe(false);
    expect(isMultiSeriesName('Rivers of London #8.1')).toBe(false);
    expect(isMultiSeriesName('Wallace,Gromit')).toBe(false);
  });
});

describe('isPlaceholderSeries', () => {
  it('is true for empty and placeholder words, case-insensitively', () => {
    for (const v of ['', '  ', null, undefined, 'N/A', 'n/a', 'None', 'STANDALONE', 'unknown', 'null', 'Null']) {
      expect(isPlaceholderSeries(v)).toBe(true);
    }
  });

  it('is false for a real series name', () => {
    expect(isPlaceholderSeries('Discworld')).toBe(false);
    expect(isPlaceholderSeries('Unknown Armies')).toBe(false);
  });
});

describe('series guards in buildAbsPayload', () => {
  it('never sends series when the import could not resolve them', () => {
    const meta = { ...base, series: 'A #6, B #1', sequence: null, all_series: [], series_unresolved: true };
    expect(buildAbsPayload({ ...meta, title: 'Edited' }, snapshotAbsMetadata(meta), cfg).metadata).not.toHaveProperty('series');
    expect(buildAbsPayload({ ...meta, series: 'A', sequence: '6' }, snapshotAbsMetadata(meta), cfg).metadata).not.toHaveProperty('series');
    expect(buildAbsPayload(meta, null, cfg).metadata).not.toHaveProperty('series');
  });

  it('never replaces a curated series with a placeholder', () => {
    for (const ph of ['N/A', 'None', 'Standalone', 'Unknown', 'null']) {
      const meta = syncAllSeries(base, { ...base, series: ph, sequence: null });
      expect(buildAbsPayload(meta, orig(), cfg).metadata).not.toHaveProperty('series');
      expect(buildAbsPayload({ ...base, series: ph, all_series: [] }, null, cfg).metadata).not.toHaveProperty('series');
    }
  });

  it('a real series edit is still sent', () => {
    const meta = syncAllSeries(base, { ...base, series: 'Dune Saga', sequence: '1' });
    expect(buildAbsPayload(meta, orig(), cfg).metadata.series).toEqual([{ name: 'Dune Saga', sequence: '1' }]);
  });
});
