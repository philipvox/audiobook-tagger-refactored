// Coverage guard for the persistent operation log (#58).
//
// ScannerPage is 3,700 lines of stateful async handlers, so mounting it to
// assert that every batch operation logs is not practical. This scans the
// source instead: it cannot prove the calls fire, but it does catch the
// regression that actually happens, which is a new batch operation being added
// (or an existing one refactored) without log wiring, leaving a silent hole
// after a crash.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ScannerPage.jsx'),
  'utf8'
);

// Every batch operation the page runs, by the op name used in the log. Three
// differ from their batch.start progress key because the log uses the same
// vocabulary as summarizeBatch: metadata -> resolve, descriptionProcessing ->
// description, and classify keeps its name.
const LOGGED_OPS = [
  'genres',
  'titles',
  'subtitles',
  'authors',
  'years',
  'audio_check',
  'series',
  'age',
  'isbn',
  'resolve',
  'description',
  'enrichment',
  'tags',
  'dna',
  'classify',
  'descriptions',
];

// batch.start progress keys, which is the ground truth for "this page runs a
// batch operation". Kept separate so adding a batch.start without adding a log
// op fails the count assertion below.
const BATCH_START_KEYS = [
  'genres',
  'titles',
  'subtitles',
  'authors',
  'years',
  'audio_check',
  'series',
  'age',
  'isbn',
  'metadata',
  'descriptionProcessing',
  'enrichment',
  'tags',
  'dna',
  'classify',
  'descriptions',
];

describe('ScannerPage batch operation logging (#58)', () => {
  it('logs a start line for every batch operation', () => {
    const missing = LOGGED_OPS.filter(op => !source.includes(`logBatchStart('${op}'`));
    expect(missing).toEqual([]);
  });

  it('logs an end line for every batch operation', () => {
    // Whitespace-normalized so a call broken across lines by the formatter
    // still matches.
    const flat = source.replace(/\s+/g, ' ');
    const missing = LOGGED_OPS.filter(op => !flat.includes(`logBatchEnd( '${op}'`)
      && !flat.includes(`logBatchEnd('${op}'`));
    expect(missing).toEqual([]);
  });

  it('has a logged op for every batch.start on the page', () => {
    const found = [...source.matchAll(/batch\.start\('([^']+)'/g)].map(m => m[1]);
    const unique = [...new Set(found)].sort();
    expect(unique).toEqual([...BATCH_START_KEYS].sort());
    // One log op per batch operation. If a batch.start is added without a log
    // op, the assertion above fails first; this pins the two lists together.
    expect(LOGGED_OPS).toHaveLength(BATCH_START_KEYS.length);
  });

  it('feeds gather-stage per-book failures into the resolve end log', () => {
    // resolve_metadata_batch results carry only resolve-stage errorDetails, so
    // a book that failed during the earlier gather phase would never be logged
    // if the log iterated result.results directly.
    expect(source).toContain('loggedResolveResults');
    expect(source).toMatch(/errorDetail = r\?\.errorDetail \|\| gatheredDataRef\.current\?\.get\(g\.id\)\?\.errorDetail/);
  });
});
