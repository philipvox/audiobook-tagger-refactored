// Regression tests for item H (2026-07-22 task 2): process_with_pipeline must
// capture DNA/description sub-step failures as errorDetail on the per-book
// result (same shape the classify handler uses), not just a console.warn.
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
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    openai_api_key: 'sk-fake',
    ai_model: 'gpt-5-nano',
  }));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

const book = { abs_id: 'abs1', title: 'A Wizard of Earthsea', description: 'An old description.' };

describe('H: process_with_pipeline errorDetail capture', () => {
  it('attaches errorDetail (stage=dna) when DNA generation fails, keeping the book successful', async () => {
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(JSON.stringify({ genres: ['Fantasy'], tags: ['epic-fantasy'] })); // classify
      if (call === 2) return Promise.reject(new Error('OpenAI error 500: internal')); // dna
      return Promise.resolve(JSON.stringify({ description: 'A description.', action: 'kept' })); // description
    });

    const result = await callBackend('process_with_pipeline', { request: { books: [book] } });
    const r = result.books[0];

    expect(r.success).toBe(true);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('dna');
    expect(r.errorDetail.kind).toBe('http');
  });

  it('attaches errorDetail (stage=description) when description processing fails, keeping the book successful', async () => {
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(JSON.stringify({ genres: ['Fantasy'], tags: [] })); // classify
      if (call === 2) return Promise.resolve(JSON.stringify({ pacing: 'slow' })); // dna
      return Promise.reject(new Error('OpenAI error 503: unavailable')); // description
    });

    const result = await callBackend('process_with_pipeline', { request: { books: [book] } });
    const r = result.books[0];

    expect(r.success).toBe(true);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('description');
    expect(r.errorDetail.kind).toBe('http');
  });

  it('does not attach errorDetail when everything succeeds', async () => {
    callAI.mockImplementation(() =>
      Promise.resolve(JSON.stringify({ genres: ['Fantasy'], tags: [] })));

    const result = await callBackend('process_with_pipeline', { request: { books: [book] } });
    expect(result.books[0].errorDetail).toBeUndefined();
    expect(result.books[0].success).toBe(true);
  });
});
