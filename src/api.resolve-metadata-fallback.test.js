// Regression tests for the 2026-07-21 audit: resolve_metadata_batch write-path
// integrity (task 1, items CR-4b and F).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAI: vi.fn(),
    parseAIJson: vi.fn((s) => JSON.parse(s)),
  };
});

const { callBackend } = await import('./api.js');
const { callAI, parseAIJson } = await import('./lib/proxy');

beforeEach(() => {
  localStorage.clear();
  // Force cloud-AI path (individual processing) for single-book assertions.
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    openai_api_key: 'sk-fake',
    ai_model: 'gpt-5-nano',
  }));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

const bookWithSeries = {
  id: 'b1',
  current_title: 'Dune',
  current_author: 'Frank Herbert',
  current_subtitle: null,
  current_series: 'Dune Chronicles',
  current_sequence: '1',
  current_narrator: 'Simon Vance',
};

describe('CR-4b: resolve_metadata_batch series/sequence fall back, never to null', () => {
  it('falls back to current_series/current_sequence when the AI omits both keys', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ title: 'Dune', author: 'Frank Herbert' }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] });
    const r = result.results[0];

    expect(r.series).toBe('Dune Chronicles');
    expect(r.sequence).toBe('1');
  });

  it('falls back to current_series/current_sequence when the AI returns explicit null', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: null, sequence: null,
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] });
    const r = result.results[0];

    expect(r.series).toBe('Dune Chronicles');
    expect(r.sequence).toBe('1');
  });

  it('still uses an AI-provided series/sequence when present', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune Saga', sequence: '2',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] });
    const r = result.results[0];

    expect(r.series).toBe('Dune Saga');
    expect(r.sequence).toBe('2');
  });

  it('preserves an explicit sequence of 0 from the AI instead of falling back', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Prequel', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: 0,
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] });
    expect(result.results[0].sequence).toBe(0);
  });

  it('does not report changed:true when the AI merely echoes back the current series/sequence', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '1',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] });
    expect(result.results[0].changed).toBe(false);
  });
});

describe('F: resolve_metadata_batch changed computation includes narrator', () => {
  it('flags changed:true when narrator differs from current_narrator', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '1',
      narrator: 'Scott Brick',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] });
    const r = result.results[0];
    expect(r.narrator).toBe('Scott Brick');
    expect(r.changed).toBe(true);
  });

  it('does not clear a curated narrator when the AI omits it, and does not flag changed', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '1',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] });
    const r = result.results[0];
    expect(r.narrator).toBe('Simon Vance');
    expect(r.changed).toBe(false);
  });
});

describe('F: sequence/subtitle compared with String() normalization', () => {
  it('does not flag changed:true when sequence is numeric 3 vs current_sequence string "3"', async () => {
    const book = { ...bookWithSeries, current_sequence: 3 };
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '3',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [book] });
    expect(result.results[0].changed).toBe(false);
  });

  it('does not flag changed:true when subtitle matches current_subtitle after String() normalization', async () => {
    const book = { ...bookWithSeries, current_subtitle: 'A Novel' };
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', subtitle: 'A Novel',
      series: 'Dune Chronicles', sequence: '1',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [book] });
    expect(result.results[0].changed).toBe(false);
  });

  it('still flags changed:true when sequence genuinely differs', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '2',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] });
    expect(result.results[0].changed).toBe(true);
  });
});

describe('item 12: resolve_metadata_batch subtitle falls back to current, never to null', () => {
  const bookWithSubtitle = { ...bookWithSeries, current_subtitle: 'A Novel' };

  it('falls back to current_subtitle when the AI omits the key entirely', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '1',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSubtitle] });
    expect(result.results[0].subtitle).toBe('A Novel');
    expect(result.results[0].changed).toBe(false);
  });

  it('falls back to current_subtitle when the AI returns explicit null', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', subtitle: null,
      series: 'Dune Chronicles', sequence: '1',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSubtitle] });
    expect(result.results[0].subtitle).toBe('A Novel');
    expect(result.results[0].changed).toBe(false);
  });

  it('still uses an AI-provided subtitle when present', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', subtitle: 'A New Subtitle',
      series: 'Dune Chronicles', sequence: '1',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSubtitle] });
    expect(result.results[0].subtitle).toBe('A New Subtitle');
    expect(result.results[0].changed).toBe(true);
  });

  it('falls back to null (not clearing anything) when there is no current_subtitle either', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '1',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [bookWithSeries] }); // current_subtitle: null
    expect(result.results[0].subtitle).toBeNull();
  });
});
