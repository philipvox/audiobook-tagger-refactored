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

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    abs_base_url: 'http://abs.local',
    abs_api_token: 'token',
  }));
  vi.resetAllMocks();
  absApi.mockResolvedValue({});
});

// Push one book and return the series array from the PATCH payload
async function pushAndGetSeries(meta) {
  const result = await callBackend('push_abs_updates', {
    items: [{ abs_id: 'item-1', metadata: meta }],
  });
  expect(result.success).toBe(1);
  expect(result.failed).toBe(0);
  const options = absApi.mock.calls.at(-1)[3];
  return options.body.metadata.series;
}

describe('stripEmbeddedSequence via buildAbsPayload (ports v1 #55)', () => {
  it('strips trailing #N', async () => {
    const series = await pushAndGetSeries({ all_series: [{ name: 'Harry Potter #3' }] });
    expect(series).toEqual([{ name: 'Harry Potter', sequence: '3' }]);
  });

  it('strips ", Book N"', async () => {
    const series = await pushAndGetSeries({ all_series: [{ name: 'Jack Reacher, Book 12' }] });
    expect(series).toEqual([{ name: 'Jack Reacher', sequence: '12' }]);
  });

  it('strips "Vol. N"', async () => {
    const series = await pushAndGetSeries({ all_series: [{ name: 'Discworld Vol. 5' }] });
    expect(series).toEqual([{ name: 'Discworld', sequence: '5' }]);
  });

  it('strips ": Volume N"', async () => {
    const series = await pushAndGetSeries({ all_series: [{ name: 'The Expanse: Volume 3' }] });
    expect(series).toEqual([{ name: 'The Expanse', sequence: '3' }]);
  });

  it('strips "Part N"', async () => {
    const series = await pushAndGetSeries({ all_series: [{ name: 'Lord of the Rings Part 2' }] });
    expect(series).toEqual([{ name: 'Lord of the Rings', sequence: '2' }]);
  });

  it('strips decimal sequences (#2.5)', async () => {
    const series = await pushAndGetSeries({ all_series: [{ name: 'Dresden Files #2.5' }] });
    expect(series).toEqual([{ name: 'Dresden Files', sequence: '2.5' }]);
  });

  it('strips ": Book N"', async () => {
    const series = await pushAndGetSeries({ all_series: [{ name: 'Kingkiller Chronicle: Book 2' }] });
    expect(series).toEqual([{ name: 'Kingkiller Chronicle', sequence: '2' }]);
  });

  it('does NOT strip numbers that are part of the name', async () => {
    for (const name of ['1984', 'The 100', 'Catch-22', 'Station Eleven']) {
      const series = await pushAndGetSeries({ all_series: [{ name }] });
      expect(series).toEqual([{ name }]);
    }
  });

  it('explicit sequence wins over embedded one, name still stripped', async () => {
    const series = await pushAndGetSeries({ all_series: [{ name: 'Harry Potter #3', sequence: 7 }] });
    expect(series).toEqual([{ name: 'Harry Potter', sequence: '7' }]);
  });

  it('applies to the series/sequence fallback path too', async () => {
    const series = await pushAndGetSeries({ series: 'Harry Potter #3' });
    expect(series).toEqual([{ name: 'Harry Potter', sequence: '3' }]);
  });

  it('fallback path: explicit meta.sequence wins, name still stripped', async () => {
    const series = await pushAndGetSeries({ series: 'Harry Potter #3', sequence: 7 });
    expect(series).toEqual([{ name: 'Harry Potter', sequence: '7' }]);
  });
});
