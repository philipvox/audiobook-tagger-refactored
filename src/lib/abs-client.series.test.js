// C-3: the onboarding wizard's importLibrary (abs-client.js) must build the
// same groups as the workspace import (api.js import_from_abs): one shared
// group builder, including seriesName parsing, the multi-series item GET,
// series_unresolved and the import lastError.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    absApi: vi.fn(),
    callAI: vi.fn(),
    parseAIJson: vi.fn((s) => JSON.parse(s)),
  };
});

const { importLibrary } = await import('./abs-client.js');
const { callBackend } = await import('../api.js');
const { absApi } = await import('./proxy');

const config = { abs_base_url: 'http://abs.local', abs_api_token: 'token', abs_library_id: 'lib-1' };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify(config));
  vi.resetAllMocks();
});

const items = [
  {
    id: 'multi',
    addedAt: 1700000000000,
    media: {
      duration: 3600,
      tags: ['keep-me'],
      metadata: {
        title: 'The Queen\'s Fool',
        authorName: 'Philippa Gregory',
        narratorName: 'Bianca Amato',
        seriesName: 'The Plantagenet and Tudor #6, Tudor Court #1',
        genres: ['Historical Fiction'],
        publishedDate: '2003-01-01',
      },
      audioFiles: [{ ino: '123', metadata: { path: '/a/1.m4b', filename: '1.m4b', size: 10 }, duration: 3600 }],
    },
  },
  {
    id: 'single',
    media: {
      metadata: { title: 'Winter Tide', authorName: 'Ben Aaronovitch', seriesName: 'Rivers of London #8.1' },
      audioFiles: [],
    },
  },
];

const itemResponse = {
  id: 'multi',
  media: { metadata: { series: [
    { id: 's1', name: 'The Plantagenet and Tudor', sequence: '6' },
    { id: 's2', name: 'Tudor Court', sequence: '1' },
  ] } },
};

function mockAbs({ failItem = false } = {}) {
  absApi.mockImplementation(async (_b, _t, path) => {
    if (path.startsWith('/api/libraries/')) return { results: items, total: items.length };
    if (path === '/api/items/multi?expanded=1') {
      if (failItem) throw new Error('HTTP 500');
      return itemResponse;
    }
    throw new Error(`unexpected ABS call ${path}`);
  });
}

describe('importLibrary uses the same group builder as import_from_abs', () => {
  it('builds identical groups, including all_series, for multi- and single-series items', async () => {
    mockAbs();
    const wizard = await importLibrary(config);
    const itemGets = absApi.mock.calls.filter(([, , p]) => p.startsWith('/api/items/'));
    expect(itemGets).toEqual([['http://abs.local', 'token', '/api/items/multi?expanded=1']]);
    const { groups: workspace } = await callBackend('import_from_abs', {});
    expect(wizard).toEqual(workspace);

    const multi = wizard.find((g) => g.abs_id === 'multi');
    expect(multi.metadata.all_series).toEqual([
      { name: 'The Plantagenet and Tudor', sequence: '6', source: 'abs' },
      { name: 'Tudor Court', sequence: '1', source: 'abs' },
    ]);
    expect(multi.files[0].ino).toBe('123');
    const single = wizard.find((g) => g.abs_id === 'single');
    expect(single.metadata.series).toBe('Rivers of London');
    expect(single.metadata.sequence).toBe('8.1');
    expect(single.metadata.all_series).toEqual([{ name: 'Rivers of London', sequence: '8.1', source: 'abs' }]);
  });

  it('marks a failed multi-series fetch unresolved with the import lastError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAbs({ failItem: true });
    const wizard = await importLibrary(config);
    const multi = wizard.find((g) => g.abs_id === 'multi');
    expect(multi.metadata.series_unresolved).toBe(true);
    expect(multi.lastError).toMatchObject({ stage: 'import', kind: 'series', severity: 'warn' });
    warn.mockRestore();
  });
});
