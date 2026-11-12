import { describe, it, expect } from 'vitest';
import {
  applyTitleResult,
  applySeriesResult,
  applySubtitleResult,
  applyGenreCleanupResult,
  applyAgeResult,
  applyAgeTagsResult,
  applyIsbnResult,
  applyAudioResult,
  tallyOutcomes,
} from './applyAiResults';
import { summarizeBatch } from './batchToast';

const book = (metadata = {}, extra = {}) => ({
  id: 'b1',
  metadata: { title: 'Mort', author: 'Terry Pratchett', ...metadata },
  files: [],
  changedFields: [],
  ...extra,
});

const ok = (result) => ({ success: true, result });
const rejected = { success: false, error: 'HTTP 500' };

describe('applyTitleResult', () => {
  it('applies title, author and subtitle and stamps the changes', () => {
    const { group, outcome } = applyTitleResult(book({ title: 'mort', subtitle: null }), ok({ title: 'Mort', author: 'Terry Pratchett', subtitle: 'A Discworld Novel', confidence: 90 }));
    expect(outcome).toBe('changed');
    expect(group.metadata.title).toBe('Mort');
    expect(group.metadata.subtitle).toBe('A Discworld Novel');
    expect(group.changedFields).toEqual(expect.arrayContaining(['title', 'subtitle']));
    expect(group.changedFields).not.toContain('author');
  });

  it('never applies series from Fix Titles', () => {
    const { group } = applyTitleResult(book({ series: 'Discworld', sequence: '4' }), ok({ title: 'Mort', series: 'Other', sequence: '1', confidence: 90 }));
    expect(group.metadata.series).toBe('Discworld');
    expect(group.metadata.sequence).toBe('4');
  });

  it('null, empty and placeholder values keep the current values', () => {
    const start = book({ subtitle: 'A Discworld Novel' });
    const { group, outcome } = applyTitleResult(start, ok({ title: 'Unknown', author: 'N/A', subtitle: '', confidence: 90 }));
    expect(outcome).toBe('unchanged');
    expect(group.metadata).toEqual(start.metadata);
  });

  it('a low-confidence answer changes nothing and shows a warning', () => {
    const entry = { ...ok({ title: 'Mort', author: 'Terry Pratchett', confidence: 40 }), errorDetail: { stage: 'resolve', kind: 'empty-content', message: 'AI confidence 40 is below 60; kept the current metadata.' } };
    const { group, outcome } = applyTitleResult(book({ title: 'mort' }), entry);
    expect(outcome).toBe('warning');
    expect(group.metadata.title).toBe('mort');
    expect(group.lastError).toMatchObject({ severity: 'warn', message: expect.stringMatching(/confidence 40/) });
  });

  it('a failed call sets lastError and changes nothing', () => {
    const start = book();
    const { group, outcome } = applyTitleResult(start, rejected);
    expect(outcome).toBe('failed');
    expect(group.metadata).toEqual(start.metadata);
    expect(group.lastError).toMatchObject({ severity: 'error', message: 'HTTP 500' });
  });
});

describe('applySeriesResult (M-5)', () => {
  it('Stormlight -> The Stormlight Archive replaces the primary series, it does not prepend', () => {
    const start = book({ series: 'Stormlight', sequence: '1', all_series: [{ name: 'Stormlight', sequence: '1' }] });
    const { group, outcome } = applySeriesResult(start, ok({ series: 'The Stormlight Archive', sequence: '1' }));
    expect(outcome).toBe('changed');
    expect(group.metadata.series).toBe('The Stormlight Archive');
    expect(group.metadata.all_series).toHaveLength(1);
    expect(group.metadata.all_series[0]).toMatchObject({ name: 'The Stormlight Archive', sequence: '1' });
    expect(group.changedFields).toContain('series');
  });

  it('keeps secondary series', () => {
    const start = book({ series: 'Stormlight', sequence: '1', all_series: [{ name: 'Stormlight', sequence: '1' }, { name: 'Cosmere', sequence: null }] });
    const { group } = applySeriesResult(start, ok({ series: 'The Stormlight Archive', sequence: '1' }));
    expect(group.metadata.all_series.map((s) => s.name)).toEqual(['The Stormlight Archive', 'Cosmere']);
  });

  it('strips a sequence embedded in the series name', () => {
    const { group } = applySeriesResult(book({ series: null, sequence: null, all_series: [] }), ok({ series: 'Harry Potter #3', sequence: null }));
    expect(group.metadata.series).toBe('Harry Potter');
    expect(group.metadata.sequence).toBe('3');
  });

  it('a null or placeholder series keeps the current series and sequence', () => {
    for (const series of [null, '', 'N/A', 'Standalone']) {
      const start = book({ series: 'Discworld', sequence: '4', all_series: [{ name: 'Discworld', sequence: '4' }] });
      const { group, outcome } = applySeriesResult(start, ok({ series, sequence: '9' }));
      expect(outcome).toBe('unchanged');
      expect(group.metadata).toEqual(start.metadata);
    }
  });

  it('a missing sequence keeps the current sequence', () => {
    const { group } = applySeriesResult(book({ series: 'Stormlight', sequence: '2' }), ok({ series: 'The Stormlight Archive', sequence: null }));
    expect(group.metadata.sequence).toBe('2');
  });

  it('a book whose series list is unknown is skipped and its series untouched', () => {
    const start = book({ series: 'Discworld', sequence: '4', series_unresolved: true, all_series: [] });
    const { group, outcome } = applySeriesResult(start, ok({ series: 'Other', sequence: '1' }));
    expect(outcome).toBe('skipped');
    expect(group.metadata).toEqual(start.metadata);
    expect(group.lastError).toMatchObject({ severity: 'warn' });
  });

  it('a failed call sets lastError', () => {
    const { outcome, group } = applySeriesResult(book(), rejected);
    expect(outcome).toBe('failed');
    expect(group.lastError.severity).toBe('error');
  });
});

describe('applySubtitleResult', () => {
  it('applies a fixed subtitle', () => {
    const { group, outcome } = applySubtitleResult(book(), { id: 'b1', success: true, fixed: true, subtitle: 'A Discworld Novel' });
    expect(outcome).toBe('changed');
    expect(group.metadata.subtitle).toBe('A Discworld Novel');
    expect(group.changedFields).toContain('subtitle');
  });

  it('not fixed or empty keeps the subtitle', () => {
    const start = book({ subtitle: 'Old' });
    expect(applySubtitleResult(start, { success: true, fixed: false, subtitle: null })).toMatchObject({ outcome: 'unchanged', group: start });
    expect(applySubtitleResult(start, { success: true, fixed: true, subtitle: '' })).toMatchObject({ outcome: 'unchanged', group: start });
  });

  it('a failed book sets lastError', () => {
    const { outcome, group } = applySubtitleResult(book(), { id: 'b1', success: false, error: 'HTTP 500' });
    expect(outcome).toBe('failed');
    expect(group.lastError.message).toBe('HTTP 500');
  });
});

describe('applyGenreCleanupResult', () => {
  it('applies the cleaned genres', () => {
    const { group, outcome } = applyGenreCleanupResult(book({ genres: ['Sci Fi'] }), { success: true, changed: true, cleaned_genres: ['Science Fiction'] });
    expect(outcome).toBe('changed');
    expect(group.metadata.genres).toEqual(['Science Fiction']);
    expect(group.changedFields).toContain('genres');
  });

  it('never drops a genre that was in ABS at import unless it maps to a replacement', () => {
    const start = book(
      { genres: ['Cozy Witchy', 'Sci-Fi', 'Fantasy'] },
      { abs_original: { genres: ['Cozy Witchy', 'Sci-Fi', 'Fantasy'] } }
    );
    const { group } = applyGenreCleanupResult(start, { success: true, changed: true, cleaned_genres: ['Science Fiction', 'Humor'] });
    // "Sci-Fi" maps to "Science Fiction", so it is replaced. "Cozy Witchy" and
    // "Fantasy" have no replacement in the answer, so they stay.
    expect(group.metadata.genres).toEqual(expect.arrayContaining(['Science Fiction', 'Humor', 'Cozy Witchy', 'Fantasy']));
    expect(group.metadata.genres).not.toContain('Sci-Fi');
  });

  it('a genre added this session (not in the snapshot) can be dropped', () => {
    const start = book({ genres: ['Fantasy', 'Junk'] }, { abs_original: { genres: ['Fantasy'] } });
    const { group } = applyGenreCleanupResult(start, { success: true, changed: true, cleaned_genres: ['Fantasy'] });
    expect(group.metadata.genres).toEqual(['Fantasy']);
  });

  it('an empty answer keeps the genres', () => {
    const start = book({ genres: ['Fantasy'] });
    expect(applyGenreCleanupResult(start, { success: true, changed: true, cleaned_genres: [] })).toMatchObject({ outcome: 'unchanged', group: start });
  });

  it('the same set in another order is unchanged', () => {
    const start = book({ genres: ['Fantasy', 'Humor'] });
    expect(applyGenreCleanupResult(start, { success: true, changed: false, cleaned_genres: ['Humor', 'Fantasy'] }).outcome).toBe('unchanged');
  });
});

describe('applyAgeResult', () => {
  const ageEntry = { success: true, age_category: 'Teen 13-17', age_tags: ['not-for-kids', 'age-teens', 'rated-pg13'], age_rating: 'Teens', content_rating: 'PG-13' };

  it('adds age tags through mergeClassifyTags; an age tag added this session is replaced', () => {
    const start = book({ tags: ['cozy', 'age-adult'], genres: ['Fantasy'] }, { abs_original: { tags: ['cozy'] } });
    const { group, outcome } = applyAgeResult(start, ageEntry);
    expect(outcome).toBe('changed');
    expect(group.metadata.tags).toEqual(['cozy', 'not-for-kids', 'age-teens', 'rated-pg13']);
    expect(group.metadata.age_rating).toBe('Teens');
    expect(group.metadata.content_rating).toBe('PG-13');
    expect(group.changedFields).toEqual(expect.arrayContaining(['tags', 'age']));
  });

  it('an age tag that was in ABS at import is kept', () => {
    const start = book({ tags: ['cozy', 'age-adult', 'rated-r'] }, { abs_original: { tags: ['cozy', 'age-adult'] } });
    const { group } = applyAgeResult(start, ageEntry);
    // age-adult is in the snapshot: kept. rated-r was added this session: replaced.
    expect(group.metadata.tags).toEqual(['cozy', 'age-adult', 'not-for-kids', 'age-teens', 'rated-pg13']);
  });

  it('without a snapshot, existing age tags are kept too (nothing is known to be session-only)', () => {
    const start = book({ tags: ['age-adult'] });
    const { group } = applyAgeResult(start, ageEntry);
    expect(group.metadata.tags).toContain('age-adult');
  });

  it('adds the age genre without dropping existing genres', () => {
    const start = book({ genres: ['Fantasy', 'Young Adult'] });
    const { group } = applyAgeResult(start, ageEntry);
    expect(group.metadata.genres).toEqual(['Fantasy', 'Young Adult', 'Teen 13-17']);
  });

  it('can leave genres alone', () => {
    const start = book({ genres: ['Fantasy'] });
    const { group } = applyAgeResult(start, ageEntry, { addGenre: false });
    expect(group.metadata.genres).toEqual(['Fantasy']);
  });

  it('a failed call sets lastError', () => {
    const { outcome, group } = applyAgeResult(book(), { success: false, error: 'HTTP 401' });
    expect(outcome).toBe('failed');
    expect(group.lastError.message).toBe('HTTP 401');
  });
});

describe('applyAgeTagsResult (AI Tags age step)', () => {
  const tagsError = { stage: 'tags', kind: 'dna', message: 'DNA tags were not updated', severity: 'error' };

  it('an empty (warning) age answer keeps the tags-step error', () => {
    const start = book({ tags: ['cozy'] }, { lastError: tagsError });
    const { group, outcome } = applyAgeTagsResult(start, { success: true, age_tags: [], age_category: null });
    expect(outcome).toBe('warning');
    expect(group.lastError).toEqual(tagsError);
  });

  it('a successful age answer adds tags, leaves genres and the tags-step error alone', () => {
    const start = book({ tags: ['cozy'], genres: ['Fantasy'] }, { lastError: tagsError });
    const { group } = applyAgeTagsResult(start, { success: true, age_category: 'Teen 13-17', age_tags: ['age-teens'] });
    expect(group.metadata.tags).toEqual(['cozy', 'age-teens']);
    expect(group.metadata.genres).toEqual(['Fantasy']);
    expect(group.lastError).toEqual(tagsError);
  });
});

describe('applyIsbnResult', () => {
  it('applies a found ISBN', () => {
    const { group, outcome } = applyIsbnResult(book(), { success: true, isbn: '9780552131063', asin: null });
    expect(outcome).toBe('changed');
    expect(group.metadata.isbn).toBe('9780552131063');
    expect(group.changedFields).toContain('isbn');
  });

  it('not found is not an error', () => {
    const start = book();
    expect(applyIsbnResult(start, { success: false, error: 'Not found' })).toEqual({ group: start, outcome: 'notfound' });
  });

  it('a lookup error is surfaced as lastError', () => {
    const { group, outcome } = applyIsbnResult(book(), {
      success: false,
      error: 'Audible lookup failed: HTTP 503',
      errorDetail: { stage: 'lookup-isbn', kind: 'http', message: 'Audible lookup failed: HTTP 503' },
    });
    expect(outcome).toBe('failed');
    expect(group.lastError).toMatchObject({ severity: 'error', message: 'Audible lookup failed: HTTP 503' });
  });
});

describe('applyAudioResult', () => {
  const intro = { item_id: 'b1', transcript: 'Read by Nigel Planer', narrators: ['Nigel Planer'], authors: ['Terry Pratchett'], title: null, publisher: 'Corgi', language: 'en' };

  it('fills missing fields and stamps them', () => {
    const { group, outcome } = applyAudioResult(book({ narrator: null, publisher: null, language: null }), intro, 'all', false);
    expect(outcome).toBe('changed');
    expect(group.metadata.narrator).toBe('Nigel Planer');
    expect(group.metadata.publisher).toBe('Corgi');
    expect(group.changedFields).toEqual(expect.arrayContaining(['narrator', 'publisher', 'language']));
  });

  it('a placeholder author counts as missing', () => {
    const { group } = applyAudioResult(book({ author: 'Unknown' }), intro, 'author', false);
    expect(group.metadata.author).toBe('Terry Pratchett');
  });

  it('never replaces a present value without force', () => {
    const start = book({ narrator: 'Tony Robinson', publisher: 'X', language: 'en' });
    expect(applyAudioResult(start, intro, 'all', false).outcome).toBe('unchanged');
  });

  it('no transcript is a per-book failure', () => {
    const { outcome, group } = applyAudioResult(book(), { ...intro, transcript: null, narrators: [], authors: [] }, 'all', false);
    expect(outcome).toBe('failed');
    expect(group.lastError.severity).toBe('error');
  });
});

describe('M-7: total failure reads as failure', () => {
  const groups = ['a', 'b', 'c'].map((id) => book({}, { id }));
  const allFail = (apply, entry, ...rest) => tallyOutcomes(groups.map((g) => ({ id: g.id, outcome: apply(g, entry, ...rest).outcome })));

  it.each([
    ['titles', 'Fix Titles', () => allFail(applyTitleResult, rejected)],
    ['series', 'Fix Series', () => allFail(applySeriesResult, rejected)],
    ['subtitles', 'Fix Subtitles', () => allFail(applySubtitleResult, rejected)],
    ['genres', 'Genre Cleanup', () => allFail(applyGenreCleanupResult, rejected)],
    ['age', 'Age Lookup', () => allFail(applyAgeResult, rejected)],
    ['isbn', 'ISBN Lookup', () => allFail(applyIsbnResult, { ...rejected, errorDetail: { stage: 'lookup-isbn', kind: 'network', message: 'offline' } })],
    ['audio_check', 'Audio Check', () => allFail(applyAudioResult, { item_id: 'x', transcript: null, narrators: [], authors: [] }, 'all', false)],
  ])('%s: every book failing gives an error toast naming the count', (op, title, run) => {
    const { counts, errorResults } = run();
    expect(counts.failed).toBe(3);
    const summary = summarizeBatch({ op, ...counts });
    expect(summary.type).toBe('error');
    expect(summary.title).toBe(`${title}: 3 failed`);
    expect(errorResults.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('ISBN not found is reported as not found, not as success or failure', () => {
    const { counts } = tallyOutcomes([{ id: 'a', outcome: 'notfound' }, { id: 'b', outcome: 'changed' }]);
    const summary = summarizeBatch({ op: 'isbn', ...counts });
    expect(summary.type).toBe('warning');
    expect(summary.title).toBe('ISBN Lookup: 1 found, 1 not found');
  });
});
