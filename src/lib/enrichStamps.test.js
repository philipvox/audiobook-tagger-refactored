// #62: Write Tags builds its payload from file.changes, so an Enrich result
// that only updates group.metadata would silently never reach the files. Run
// every applier against a locally scanned book and check what Write Tags
// would do with the result.
import { describe, it, expect } from 'vitest';
import { applyMetadataToGroup } from './applyMetadata';
import { applyClassifyResult } from './applyClassifyResult';
import { applyTagsResultToGroup, applyDnaResultToGroup } from './applyTagResults';
import {
  applyAgeResult, applyIsbnResult, applyAudioResult, applyTitleResult,
  applySeriesResult, applySubtitleResult, applyGenreCleanupResult, applyResolveResult,
} from './applyAiResults';
import { applyFieldFixes } from './applyValidationFixes';
import { buildWritePayload, splitFileChanges } from './writePayload';

const localBook = () => ({
  id: 'g1',
  group_name: 'Book',
  metadata: { title: 'Old Title', author: 'Old Author', genres: ['Fiction'], tags: ['cozy'], series: null, sequence: null },
  files: [
    { id: 'f1', path: '/books/Book/part1.m4b', filename: 'part1.m4b', changes: {} },
    { id: 'f2', path: '/books/Book/part2.m4b', filename: 'part2.m4b', changes: {} },
  ],
});

const payloadOf = (group) => buildWritePayload([group], new Set(group.files.map((f) => f.id)));
const stampedFields = (group) => Object.keys(group.files[0].changes).sort();

// Appliers whose output has a home in the audio tags: Write Tags must send it.
const writableAppliers = {
  'classify (genres)': (g) => {
    const r = applyClassifyResult(g.metadata, { genres: ['Fantasy'], tags: [] });
    // ScannerPage's classify handler stamps the applier's changedFields.
    return applyMetadataToGroup(g, r.metadata, r.changedFields);
  },
  'age (adds the category as a genre)': (g) => applyAgeResult(g, { success: true, age_category: 'Teen', age_tags: ['age:teen'] }).group,
  isbn: (g) => applyIsbnResult(g, { success: true, isbn: '9780000000001', asin: 'B000000001' }).group,
  'audio check': (g) => applyAudioResult(g, { transcript: 'Read by Jane Reader', narrators: ['Jane Reader'] }, 'narrator', false).group,
  'batch fix (validation and author fixes)': (g) => applyFieldFixes(g, [{ field: 'author', value: 'New Author' }, { field: 'genres', value: 'Fantasy, Adventure' }]),
  'fix titles': (g) => applyTitleResult(g, { success: true, result: { title: 'New Title' } }).group,
  'fix series': (g) => applySeriesResult(g, { success: true, result: { series: 'Saga', sequence: '2' } }).group,
  'fix subtitles': (g) => applySubtitleResult(g, { success: true, fixed: true, subtitle: 'A Novel' }).group,
  'genre cleanup': (g) => applyGenreCleanupResult(g, { success: true, cleaned_genres: ['Fantasy'] }).group,
  'resolve metadata': (g) => applyResolveResult(g, { success: true, changed: true, title: 'Resolved Title' }),
};

// Tags and DNA live in the app (and ABS) only: the writer has no tag for them.
const appOnlyAppliers = {
  'AI tags': (g) => applyTagsResultToGroup(g, { success: true, tags: ['dark'] }).group,
  'generate DNA': (g) => applyDnaResultToGroup(g, { success: true, dna_tags: ['dna:pace:fast'] }).group,
};

describe('every Enrich applier stamps file.changes (#62)', () => {
  for (const [name, apply] of Object.entries(writableAppliers)) {
    it(`${name}: stamped on every file, and Write Tags sends it`, () => {
      const next = apply(localBook());
      expect(stampedFields(next).length).toBeGreaterThan(0);
      expect(next.files[1].changes).toEqual(next.files[0].changes);
      const { fileIds } = payloadOf(next);
      expect(fileIds).toEqual(['f1', 'f2']);
    });
  }

  for (const [name, apply] of Object.entries(appOnlyAppliers)) {
    it(`${name}: stamped, and the write preview lists it as app-only`, () => {
      const next = apply(localBook());
      expect(stampedFields(next)).toEqual(['tags']);
      expect(splitFileChanges(next.files[0]).notWritten.map((r) => r.field)).toEqual(['tags']);
      expect(payloadOf(next).fileIds).toEqual([]);
    });
  }
});

describe('applyFieldFixes (validation, author and single-issue fixes)', () => {
  it('stamps only fields whose value changed, maps genres to genre and keeps series lists in step', () => {
    const g = { ...localBook(), metadata: { ...localBook().metadata, series: 'Old', sequence: '1', all_series: [{ name: 'Old', sequence: '1' }] } };
    const next = applyFieldFixes(g, [
      { field: 'title', value: 'Old Title' }, // unchanged: not stamped
      { field: 'genres', value: ['Fantasy'] },
      { field: 'series', value: 'New' },
    ]);
    expect(stampedFields(next)).toEqual(['genre', 'series']);
    expect(next.files[0].changes.genre).toEqual({ old: 'Fiction', new: 'Fantasy' });
    expect(next.metadata.all_series[0]).toMatchObject({ name: 'New', sequence: '1' });
  });

  it('a year fix moves year and published_year together', () => {
    const next = applyFieldFixes(localBook(), [{ field: 'year', value: '2001' }]);
    expect(next.metadata.year).toBe('2001');
    expect(next.metadata.published_year).toBe('2001');
    expect(next.files[0].changes.year).toEqual({ old: '', new: '2001' });
  });

  it('extra updates (e.g. the author source) are merged without being stamped', () => {
    const next = applyFieldFixes(localBook(), [{ field: 'author', value: 'Canon' }], { sources: { author: 'normalized' } });
    expect(next.metadata.sources).toEqual({ author: 'normalized' });
    expect(next.metadata.authors[0]).toBe('Canon');
    expect(stampedFields(next)).toEqual(['author']);
  });

  it('a book with no files still records the change', () => {
    const next = applyFieldFixes({ id: 'a', metadata: { title: 'A' }, files: [] }, [{ field: 'title', value: 'B' }]);
    expect(next.metadata.title).toBe('B');
    expect(next.changedFields).toContain('title');
    expect(next.total_changes).toBe(1);
  });
});
