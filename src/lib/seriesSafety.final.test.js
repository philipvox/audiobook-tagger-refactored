// Final review fixes D-1, D-2, D-6: a series in ABS at import is never
// dropped by an AI answer, a v2.2.3 session's unparsed multi-series string is
// never pushed, and the unresolved-series warning cannot be hidden.

import { describe, it, expect } from 'vitest';
import { buildAbsPayload, snapshotAbsMetadata, UNRESOLVED_SERIES_IMPORT_MESSAGE } from './absPayload.js';
import { applyMetadataToGroup } from './applyMetadata.js';
import { applySeriesResult, applyResolveResult } from './applyAiResults.js';
import { parseSession } from './session.js';
import { absItemToBookGroup } from './absGroup.js';
import { standingWarnings } from './groupWarnings.js';
import { mergeAbsPull } from '../hooks/useScan.js';

const mk = (meta) => {
  const metadata = { title: 'T', author: 'A B', narrator: null, genres: [], tags: [], all_series: [], ...meta };
  return { id: 'g1', abs_id: 'g1', source: 'abs', metadata, abs_original: snapshotAbsMetadata(metadata), files: [] };
};

const restoreV223 = (meta) => {
  const g = { id: 'g1', abs_id: 'g1', source: 'abs', metadata: meta, abs_original: snapshotAbsMetadata(meta), files: [] };
  return parseSession(JSON.stringify({ version: 1, savedAt: 1, groups: [g] })).groups[0];
};

describe('D-1: a v2.2.3 session with an unparsed multi-series string', () => {
  const meta = {
    title: 'T', author: 'A B',
    series: 'The Plantagenet and Tudor #6, Tudor Court #1', sequence: null, all_series: [],
    genres: ['x'], tags: ['t'],
  };

  it('is flagged series_unresolved with the import warning on restore', () => {
    const r = restoreV223(meta);
    expect(r.metadata.series_unresolved).toBe(true);
    expect(r.lastError?.message).toBe(UNRESOLVED_SERIES_IMPORT_MESSAGE);
  });

  it('never pushes a series after a sequence edit', () => {
    const r = restoreV223(meta);
    const edited = applyMetadataToGroup(r, { sequence: '7' }, ['sequence']);
    expect(buildAbsPayload(edited.metadata, edited.abs_original, {})).toEqual({ metadata: {} });
  });

  it('Fix Series skips it and nothing is pushed', () => {
    const r = restoreV223(meta);
    const ai = applySeriesResult(r, { success: true, result: { series: 'Tudor Court', sequence: '1' } });
    expect(ai.outcome).toBe('skipped');
    expect(buildAbsPayload(ai.group.metadata, ai.group.abs_original, {})).toEqual({ metadata: {} });
  });

  it('keeps another error already on the book (the badge shows the series warning)', () => {
    const g = { id: 'g1', abs_id: 'g1', source: 'abs', metadata: meta, abs_original: snapshotAbsMetadata(meta), files: [],
      lastError: { stage: 'tags', kind: 'ai', message: 'AI Tags failed.', severity: 'error' } };
    const r = parseSession(JSON.stringify({ version: 1, savedAt: 1, groups: [g] })).groups[0];
    expect(r.metadata.series_unresolved).toBe(true);
    expect(r.lastError.message).toBe('AI Tags failed.');
    expect(standingWarnings(r).map((w) => w.message)).toContain(UNRESOLVED_SERIES_IMPORT_MESSAGE);
  });

  it('leaves alone a single series, a resolved list, an explicit flag and a local book', () => {
    expect(restoreV223({ ...meta, series: 'Discworld', all_series: [{ name: 'Discworld', sequence: '1' }] }).metadata.series_unresolved).toBeUndefined();
    const two = [{ name: 'A', sequence: '6' }, { name: 'B', sequence: '1' }];
    expect(restoreV223({ ...meta, series: 'A', all_series: two }).metadata.series_unresolved).toBeUndefined();
    expect(restoreV223({ ...meta, series_unresolved: false }).metadata.series_unresolved).toBe(false);
    const local = { id: 'l1', metadata: { ...meta }, files: [{ id: 'f', path: '/a.m4b', changes: {} }] };
    const r = parseSession(JSON.stringify({ version: 1, savedAt: 1, groups: [local] })).groups[0];
    expect(r.metadata.series_unresolved).toBeUndefined();
  });
});

describe('D-1: re-import heals the series of a staged series_unresolved group', () => {
  const stale = () => {
    const meta = { title: 'T', author: 'A B', series: 'A #6, B #1', sequence: null, all_series: [], genres: [], tags: [] };
    const r = restoreV223(meta);
    return applyMetadataToGroup(r, { title: 'Edited', sequence: '9' }, ['title', 'sequence']);
  };
  const fresh = () => {
    const g = mk({ series: 'A', sequence: '6', all_series: [{ name: 'A', sequence: '6' }, { name: 'B', sequence: '1' }] });
    return { ...g, metadata: { ...g.metadata, series_unresolved: false } };
  };

  it('takes series, sequence, all_series and the series snapshot from the fresh group and keeps other edits', () => {
    const { groups } = mergeAbsPull([stale()], [fresh()]);
    const g = groups[0];
    expect(g.metadata.title).toBe('Edited');
    expect(g.metadata.series).toBe('A');
    expect(g.metadata.sequence).toBe('6');
    expect(g.metadata.all_series).toHaveLength(2);
    expect(g.metadata.series_unresolved).toBe(false);
    expect(g.abs_original.all_series).toHaveLength(2);
    expect(g.abs_original.series).toBe('A');
    expect(g.abs_original.title).toBe('T');
    expect(g.changedFields).toEqual(['title']);
    expect(g.lastError).toBeUndefined();
    // The title edit is still pushed; the series is not.
    expect(buildAbsPayload(g.metadata, g.abs_original, {})).toEqual({ metadata: { title: 'Edited' } });
  });

  it('keeps a flagged (needs_reimport) group that is absent from the result, as documented', () => {
    const flagged = { id: 'old', source: 'abs', abs_id: 'old', needs_reimport: true, metadata: { title: 'Old' }, files: [] };
    const { groups } = mergeAbsPull([flagged], [fresh()]);
    expect(groups.map((g) => g.id).sort()).toEqual(['g1', 'old']);
  });
});

describe('D-2: an AI series answer never drops a series that was in ABS', () => {
  const two = () => mk({
    series: 'The Plantagenet and Tudor', sequence: '6',
    all_series: [{ name: 'The Plantagenet and Tudor', sequence: '6' }, { name: 'Tudor Court', sequence: '1' }],
  });
  const names = (payload) => (payload.metadata.series || []).map((x) => x.name);

  it('Fix Series naming the secondary series reorders, keeping both', () => {
    const a = applySeriesResult(two(), { success: true, result: { series: 'Tudor Court', sequence: '1' } });
    const p = buildAbsPayload(a.group.metadata, a.group.abs_original, {});
    expect(names(p).sort()).toEqual(['The Plantagenet and Tudor', 'Tudor Court']);
  });

  it('Resolve naming the secondary series reorders, keeping both', () => {
    const b = applyResolveResult(two(), { id: 'g1', changed: true, title: 'T', author: 'A B', series: 'Tudor Court', sequence: '1' });
    const p = buildAbsPayload(b.metadata, b.abs_original, {});
    expect(names(p).sort()).toEqual(['The Plantagenet and Tudor', 'Tudor Court']);
  });

  it('Resolve renaming the primary keeps the secondary series (same rule as Fix Series, M-5)', () => {
    const b = applyResolveResult(two(), { id: 'g1', changed: true, title: 'T', author: 'A B', series: 'Plantagenet and Tudor Novels', sequence: '6' });
    expect(names(buildAbsPayload(b.metadata, b.abs_original, {}))).toEqual(['Plantagenet and Tudor Novels', 'Tudor Court']);
  });

  it('the reorder keeps each series sequence', () => {
    const a = applySeriesResult(two(), { success: true, result: { series: 'Tudor Court', sequence: '1' } });
    expect(a.group.metadata.all_series.map((x) => [x.name, x.sequence])).toEqual([
      ['Tudor Court', '1'], ['The Plantagenet and Tudor', '6'],
    ]);
  });

  it('Resolve answering no series never clears the series', () => {
    for (const series of [null, '', 'N/A']) {
      const b = applyResolveResult(two(), { id: 'g1', changed: true, title: 'T', author: 'A B', series, sequence: null });
      expect(b.metadata.series).toBe('The Plantagenet and Tudor');
      expect(buildAbsPayload(b.metadata, b.abs_original, {})).toEqual({ metadata: {} });
    }
  });

  it('a single-series book still takes the Fix Series answer (M-5)', () => {
    const one = mk({ series: 'Old', sequence: '1', all_series: [{ name: 'Old', sequence: '1' }] });
    const a = applySeriesResult(one, { success: true, result: { series: 'New', sequence: '1' } });
    expect(a.outcome).toBe('changed');
    expect(buildAbsPayload(a.group.metadata, a.group.abs_original, {}).metadata.series).toEqual([{ name: 'New', sequence: '1' }]);
  });
});

describe('D-6: Resolve on a series_unresolved book', () => {
  const unresolved = () => absItemToBookGroup(
    { id: 'i1', media: { metadata: { title: 'T', authorName: 'A B', seriesName: 'A #6, B #1', genres: [], publishedYear: 1999 }, tags: [] } },
    'http://x', null,
  );

  it('does not stage series or sequence and the warning stays visible', () => {
    const r = applyResolveResult(unresolved(), { id: 'i1', changed: true, title: 'T', author: 'A B', series: 'A', sequence: '6' });
    expect(r.metadata.series).toBe('A #6, B #1');
    expect(r.changedFields || []).not.toContain('series');
    expect(r.changedFields || []).not.toContain('sequence');
    expect(buildAbsPayload(r.metadata, r.abs_original, {})).toEqual({ metadata: {} });
    const shown = [r.lastError?.message, ...standingWarnings(r).map((w) => w.message)];
    expect(shown).toContain(UNRESOLVED_SERIES_IMPORT_MESSAGE);
  });

  it('a later stage error cannot hide the series warning', () => {
    const g = { ...unresolved(), lastError: { stage: 'resolve', kind: 'low-confidence', message: 'kept current values', severity: 'warn' } };
    expect(standingWarnings(g).map((w) => w.message)).toEqual([UNRESOLVED_SERIES_IMPORT_MESSAGE]);
  });

  it('no duplicate badge while the import warning itself is the pill', () => {
    expect(standingWarnings(unresolved())).toEqual([]);
  });
});

describe('D-1: a v2.2.3 session whose series was already edited before the upgrade', () => {
  // The snapshot still holds the old builder's unparsed string, but the book's
  // current series was changed to a single name (Resolve, or a hand edit) and
  // the session was saved. The current metadata looks clean; the snapshot does not.
  const combined = 'The Plantagenet and Tudor #6, Tudor Court #1';
  const imported = { title: 'T', author: 'A B', series: combined, sequence: null, all_series: [], genres: [], tags: [] };
  const savedGroup = () => ({
    id: 'g1', abs_id: 'g1', source: 'abs', files: [],
    metadata: { ...imported, series: 'Tudor Court', sequence: '1', all_series: [{ name: 'Tudor Court', sequence: '1' }] },
    abs_original: snapshotAbsMetadata(imported),
    changedFields: ['series', 'sequence'], total_changes: 2,
  });
  const restore = (g) => parseSession(JSON.stringify({ version: 1, savedAt: 1, groups: [g] })).groups[0];

  it('is flagged series_unresolved on restore, from the snapshot', () => {
    const r = restore(savedGroup());
    expect(r.metadata.series_unresolved).toBe(true);
    // Shown on the book itself; the standing badge does not repeat it.
    expect(r.lastError?.message).toBe(UNRESOLVED_SERIES_IMPORT_MESSAGE);
    expect(standingWarnings({ ...r, lastError: undefined }).map((w) => w.message)).toContain(UNRESOLVED_SERIES_IMPORT_MESSAGE);
  });

  it('pushes no series, so the series ABS holds is not dropped', () => {
    const r = restore(savedGroup());
    const payload = buildAbsPayload(r.metadata, r.abs_original, {});
    expect(payload.metadata.series).toBeUndefined();
    expect(payload).toEqual({ metadata: {} });
  });

  it('still pushes its other staged edits', () => {
    const g = savedGroup();
    g.metadata.title = 'New T';
    const r = restore(g);
    expect(buildAbsPayload(r.metadata, r.abs_original, {})).toEqual({ metadata: { title: 'New T' } });
  });

  it('a snapshot with a real series list is not flagged', () => {
    const good = { ...imported, series: 'The Plantagenet and Tudor', sequence: '6',
      all_series: [{ name: 'The Plantagenet and Tudor', sequence: '6' }, { name: 'Tudor Court', sequence: '1' }] };
    const g = { id: 'g1', abs_id: 'g1', source: 'abs', files: [], abs_original: snapshotAbsMetadata(good),
      metadata: { ...good, series: 'Tudor Court', sequence: '1', all_series: [{ name: 'Tudor Court', sequence: '1' }, { name: 'The Plantagenet and Tudor', sequence: '6' }] } };
    expect(restore(g).metadata.series_unresolved).toBeUndefined();
  });
});
