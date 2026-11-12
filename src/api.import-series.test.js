// C-3: the ABS list endpoint (/api/libraries/:id/items?expanded=1) returns
// only `metadata.seriesName`, e.g. "Rivers of London #8.1" or
// "The Plantagenet and Tudor #6, Tudor Court #1". Import must parse the
// single-series form, fetch the item for the multi-series form, and mark the
// book unresolved (so push never sends series) when that fetch fails.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    absApi: vi.fn(),
    callAI: vi.fn(),
    parseAIJson: vi.fn((s) => JSON.parse(s)),
  };
});

const { callBackend } = await import('./api.js');
const { absApi } = await import('./lib/proxy');
const { buildAbsPayload, isEmptyPayload } = await import('./lib/absPayload.js');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    abs_base_url: 'http://abs.local',
    abs_api_token: 'token',
    abs_library_id: 'lib-1',
  }));
  vi.resetAllMocks();
});

// Minified list-endpoint shape, as the live server sends it.
const listItem = (id, seriesName) => ({
  id,
  media: {
    metadata: { title: `Book ${id}`, authorName: 'Some Author', seriesName, genres: ['Fantasy'] },
    tags: ['keep-me'],
    audioFiles: [],
  },
});

const isListCall = (path) => path.startsWith('/api/libraries/');

function mockAbs({ items, itemResponses = {} }) {
  absApi.mockImplementation(async (_base, _token, path) => {
    if (isListCall(path)) return { results: items, total: items.length };
    const m = path.match(/^\/api\/items\/([^/?]+)\?expanded=1$/);
    if (m && m[1] in itemResponses) {
      const r = itemResponses[m[1]];
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error(`unexpected ABS call ${path}`);
  });
}

const itemCalls = () => absApi.mock.calls.filter(([, , path]) => !isListCall(path));

describe('import_from_abs series parsing (C-3)', () => {
  it('a single-series seriesName sets series, sequence and a one-entry all_series', async () => {
    mockAbs({ items: [listItem('i1', 'Rivers of London #8.1')] });
    const { groups } = await callBackend('import_from_abs', {});
    const g = groups[0];
    expect(g.metadata.series).toBe('Rivers of London');
    expect(g.metadata.sequence).toBe('8.1');
    expect(g.metadata.all_series).toEqual([{ name: 'Rivers of London', sequence: '8.1', source: 'abs' }]);
    expect(g.metadata.series_unresolved).toBe(false);
    expect(g.abs_original.series).toBe('Rivers of London');
    expect(g.abs_original.all_series).toEqual([{ name: 'Rivers of London', sequence: '8.1' }]);
    expect(itemCalls()).toHaveLength(0);
    // An untouched book pushes nothing.
    expect(isEmptyPayload(buildAbsPayload(g.metadata, g.abs_original, {}))).toBe(true);
  });

  it('a series with no sequence imports with sequence null', async () => {
    mockAbs({ items: [listItem('i2', 'Discworld')] });
    const { groups } = await callBackend('import_from_abs', {});
    expect(groups[0].metadata.series).toBe('Discworld');
    expect(groups[0].metadata.sequence).toBeNull();
    expect(groups[0].metadata.all_series).toEqual([{ name: 'Discworld', sequence: null, source: 'abs' }]);
    expect(itemCalls()).toHaveLength(0);
  });

  it('a multi-series seriesName fetches the item once and uses its series array', async () => {
    mockAbs({
      items: [listItem('i3', 'The Plantagenet and Tudor #6, Tudor Court #1')],
      itemResponses: {
        i3: {
          id: 'i3',
          media: { metadata: { series: [
            { id: 's1', name: 'The Plantagenet and Tudor', sequence: '6' },
            { id: 's2', name: 'Tudor Court', sequence: '1' },
          ] } },
        },
      },
    });
    const { groups } = await callBackend('import_from_abs', {});
    const g = groups[0];
    expect(itemCalls()).toHaveLength(1);
    expect(itemCalls()[0][2]).toBe('/api/items/i3?expanded=1');
    expect(g.metadata.all_series).toEqual([
      { name: 'The Plantagenet and Tudor', sequence: '6', source: 'abs' },
      { name: 'Tudor Court', sequence: '1', source: 'abs' },
    ]);
    expect(g.metadata.series).toBe('The Plantagenet and Tudor');
    expect(g.metadata.sequence).toBe('6');
    expect(g.metadata.series_unresolved).toBe(false);
    expect(g.lastError).toBeUndefined();
    expect(g.abs_original.all_series).toHaveLength(2);
    expect(isEmptyPayload(buildAbsPayload(g.metadata, g.abs_original, {}))).toBe(true);
    // The rest of the book still comes from the list item.
    expect(g.metadata.title).toBe('Book i3');
    expect(g.metadata.tags).toEqual(['keep-me']);
  });

  it('"Discworld, Tiffany Aching #2" is two series: one item GET, two-entry all_series', async () => {
    mockAbs({
      items: [listItem('d1', 'Discworld, Tiffany Aching #2')],
      itemResponses: {
        d1: { id: 'd1', media: { metadata: { series: [
          { id: 'a', name: 'Discworld', sequence: null },
          { id: 'b', name: 'Tiffany Aching', sequence: '2' },
        ] } } },
      },
    });
    const { groups } = await callBackend('import_from_abs', {});
    expect(itemCalls()).toHaveLength(1);
    expect(itemCalls()[0][2]).toBe('/api/items/d1?expanded=1');
    expect(groups[0].metadata.all_series).toEqual([
      { name: 'Discworld', sequence: null, source: 'abs' },
      { name: 'Tiffany Aching', sequence: '2', source: 'abs' },
    ]);
    expect(groups[0].metadata.series_unresolved).toBe(false);
    expect(isEmptyPayload(buildAbsPayload(groups[0].metadata, groups[0].abs_original, {}))).toBe(true);
  });

  it('a single series whose name has a comma costs one GET and imports as one entry', async () => {
    mockAbs({
      items: [listItem('w1', 'Wallace, Gromit #2'), listItem('t1', 'Tales of Earth, Sea and Sky')],
      itemResponses: {
        w1: { id: 'w1', media: { metadata: { series: [{ id: 'w', name: 'Wallace, Gromit', sequence: '2' }] } } },
        t1: { id: 't1', media: { metadata: { series: [{ id: 't', name: 'Tales of Earth, Sea and Sky', sequence: null }] } } },
      },
    });
    const { groups } = await callBackend('import_from_abs', {});
    expect(itemCalls()).toHaveLength(2);
    const w = groups.find((g) => g.abs_id === 'w1');
    expect(w.metadata.all_series).toEqual([{ name: 'Wallace, Gromit', sequence: '2', source: 'abs' }]);
    expect(w.metadata.series).toBe('Wallace, Gromit');
    expect(w.metadata.sequence).toBe('2');
    const tl = groups.find((g) => g.abs_id === 't1');
    expect(tl.metadata.all_series).toEqual([{ name: 'Tales of Earth, Sea and Sky', sequence: null, source: 'abs' }]);
  });

  it('a fetched series entry with no name leaves the book unresolved', async () => {
    mockAbs({
      items: [listItem('n1', 'A, B')],
      itemResponses: { n1: { id: 'n1', media: { metadata: { series: [{ id: 'a', name: 'A' }, { id: 'b', sequence: '1' }] } } } },
    });
    const { groups } = await callBackend('import_from_abs', {});
    expect(groups[0].metadata.series_unresolved).toBe(true);
    expect(groups[0].metadata.all_series).toEqual([]);
    expect(groups[0].lastError).toMatchObject({ stage: 'import', kind: 'series', severity: 'warn' });
  });

  it('marks the book series_unresolved when the item fetch fails, and push never sends series', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAbs({
      items: [listItem('i4', 'A #6, B #1'), listItem('i5', 'Solo #2')],
      itemResponses: { i4: new Error('HTTP 500') },
    });
    const { groups } = await callBackend('import_from_abs', {});
    expect(groups).toHaveLength(2);
    const g = groups.find((x) => x.abs_id === 'i4');
    expect(itemCalls()).toHaveLength(1);
    expect(g.metadata.series_unresolved).toBe(true);
    expect(g.metadata.all_series).toEqual([]);
    const edited = { ...g.metadata, title: 'Edited', series: 'A', sequence: '6' };
    expect(buildAbsPayload(edited, g.abs_original, {}).metadata).not.toHaveProperty('series');
    expect(g.lastError).toEqual({
      stage: 'import',
      kind: 'series',
      severity: 'warn',
      message: "Could not read this book's series from AudiobookShelf. Series will not be pushed until you re-import.",
    });
    expect(groups.find((x) => x.abs_id === 'i5').metadata.series_unresolved).toBe(false);
    expect(groups.find((x) => x.abs_id === 'i5').lastError).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('an item response without a series array also leaves the book unresolved', async () => {
    mockAbs({
      items: [listItem('i6', 'A #6, B #1')],
      itemResponses: { i6: { id: 'i6', media: { metadata: { series: [] } } } },
    });
    const { groups } = await callBackend('import_from_abs', {});
    expect(groups[0].metadata.series_unresolved).toBe(true);
    expect(groups[0].lastError).toMatchObject({ stage: 'import', kind: 'series', severity: 'warn' });
  });

  it('keeps using a metadata.series array when the list item carries one', async () => {
    const item = listItem('i7', 'X #1, Y #2');
    item.media.metadata.series = [{ id: 'a', name: 'X', sequence: '1' }, { id: 'b', name: 'Y', sequence: '2' }];
    mockAbs({ items: [item] });
    const { groups } = await callBackend('import_from_abs', {});
    expect(itemCalls()).toHaveLength(0);
    expect(groups[0].metadata.all_series.map((x) => x.name)).toEqual(['X', 'Y']);
    expect(groups[0].metadata.series).toBe('X');
    expect(groups[0].metadata.series_unresolved).toBe(false);
  });
});
