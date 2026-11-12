import { describe, it, expect, beforeEach, vi } from 'vitest';

// M-3: AI resolve results are gated on confidence and placeholder values.
vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAI: vi.fn() };
});

const { callBackend } = await import('./api.js');
const { callAI } = await import('./lib/proxy');
const { applyMetadataToGroup } = await import('./lib/applyMetadata.js');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    openai_api_key: 'sk-fake',
    ai_model: 'gpt-5-nano',
  }));
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const seriesBook = {
  id: 'b1',
  current_title: 'Guards! Guards!',
  current_author: 'Terry Pratchett',
  current_subtitle: 'A Discworld Novel',
  current_series: 'Discworld',
  current_sequence: '8',
  current_narrator: 'Nigel Planer',
};

const resolve = async (aiAnswer, book = seriesBook) => {
  callAI.mockResolvedValueOnce(JSON.stringify(aiAnswer));
  const result = await callBackend('resolve_metadata_batch', { books: [book] });
  return result.results[0];
};

describe('resolve_metadata_batch confidence gate', () => {
  it('ignores a result with confidence below 60', async () => {
    const r = await resolve({ title: 'Wrong Book', author: 'Someone Else', series: 'Other', sequence: '1', confidence: 55 });
    expect(r.changed).toBe(false);
    expect(r.title).toBe('Guards! Guards!');
    expect(r.author).toBe('Terry Pratchett');
    expect(r.series).toBe('Discworld');
    expect(r.sequence).toBe('8');
    expect(r.errorDetail?.message).toMatch(/confidence 55/);
  });

  it('accepts a result at confidence 60', async () => {
    const r = await resolve({ title: 'Guards! Guards!', author: 'Terry Pratchett', series: 'Discworld', sequence: '8', narrator: 'Tony Robinson', confidence: 60 });
    expect(r.changed).toBe(true);
    expect(r.narrator).toBe('Tony Robinson');
  });
});

describe('resolve_metadata_batch never stages placeholders', () => {
  it('AI "series":"N/A" keeps the series, sequence and all_series', async () => {
    const r = await resolve({ title: 'Guards! Guards!', author: 'Terry Pratchett', series: 'N/A', sequence: null, confidence: 90 });
    expect(r.series).toBe('Discworld');
    expect(r.sequence).toBe('8');
    expect(r.changed).toBe(false);

    // The ScannerPage merge, as it applies a resolve result.
    const allSeries = [{ name: 'Discworld', sequence: '8' }, { name: 'City Watch', sequence: '1' }];
    const group = {
      id: 'b1',
      metadata: { title: 'Guards! Guards!', author: 'Terry Pratchett', series: 'Discworld', sequence: '8', all_series: allSeries },
      files: [],
      changedFields: [],
    };
    const next = applyMetadataToGroup(group, { series: r.series, sequence: r.sequence }, []);
    expect(next.metadata.series).toBe('Discworld');
    expect(next.metadata.all_series).toEqual(allSeries);
  });

  it.each(['None', 'standalone', 'Unknown', 'null'])('series %s keeps the current series', async (value) => {
    const r = await resolve({ series: value, sequence: '3', confidence: 90 });
    expect(r.series).toBe('Discworld');
    expect(r.sequence).toBe('8');
  });

  it('placeholder subtitle, title, author and narrator keep the current values', async () => {
    const r = await resolve({ title: 'Unknown', author: 'Unknown Author', subtitle: 'N/A', narrator: 'N/A', series: 'Discworld', sequence: '8', confidence: 90 });
    expect(r.title).toBe('Guards! Guards!');
    expect(r.author).toBe('Terry Pratchett');
    expect(r.subtitle).toBe('A Discworld Novel');
    expect(r.narrator).toBe('Nigel Planer');
    expect(r.changed).toBe(false);
  });

  it('a book with no series stays without one when the AI says "N/A"', async () => {
    const r = await resolve({ series: 'N/A', confidence: 90 }, { ...seriesBook, current_series: null, current_sequence: null });
    expect(r.series).toBeNull();
    expect(r.sequence).toBeNull();
  });
});

describe('resolve_title / resolve_series drop placeholder answers', () => {
  it('resolve_series turns "N/A" into null so callers keep their value', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ series: 'N/A', sequence: '2', confidence: 80 }));
    const r = await callBackend('resolve_series', { request: { title: 'X', author: 'Y', current_series: 'Discworld' } });
    expect(r.series).toBeNull();
    expect(r.sequence).toBeNull();
  });

  it('resolve_title turns a placeholder series and subtitle into null', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ title: 'X', author: 'Y', subtitle: 'None', series: 'N/A', sequence: '1', confidence: 80 }));
    const r = await callBackend('resolve_title', { request: { current_title: 'X', current_author: 'Y' } });
    expect(r.subtitle).toBeNull();
    expect(r.series).toBeNull();
    expect(r.sequence).toBeNull();
  });
});

describe('external source labelling in the resolve prompt', () => {
  it('labels OpenLibrary data as OpenLibrary, not Audible', async () => {
    await resolve({ title: 'Guards! Guards!', confidence: 90 }, {
      ...seriesBook,
      external_source: 'openlibrary',
      audible_title: 'Guards! Guards!',
      audible_author: 'Terry Pratchett',
    });
    const prompt = callAI.mock.calls[0][2];
    expect(prompt).toContain('OpenLibrary title: "Guards! Guards!"');
    expect(prompt).toContain('OpenLibrary author: "Terry Pratchett"');
    expect(prompt).not.toMatch(/Audible title/);
  });

  it('keeps the Audible label for Audnexus data', async () => {
    await resolve({ title: 'Guards! Guards!', confidence: 90 }, {
      ...seriesBook,
      external_source: 'audnexus',
      audible_title: 'Guards! Guards!',
    });
    expect(callAI.mock.calls[0][2]).toContain('Audible title: "Guards! Guards!"');
  });
});
