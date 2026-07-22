// Regression tests for item G (2026-07-22 task 2): classify_books_batch's
// per-book fallback (entered when the local-AI batch response fails to
// parse) must run DNA when dnaEnabled, and attach errorDetail on failures
// instead of a bare { success:false, error } with no diagnosable detail.
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
    use_local_ai: true,
    ollama_model: 'qwen3:1.7b',
  }));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

describe('G: classify_books_batch per-book fallback (batch parse failure)', () => {
  it('runs DNA per book in the fallback when dnaEnabled, merging dna_tags into the result', async () => {
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve('not valid json, batch parse will fail');
      if (call === 2) return Promise.resolve(JSON.stringify({ genres: ['Fantasy'], tags: ['epic-fantasy'] })); // single classify
      return Promise.resolve(JSON.stringify({ pacing: 'slow', shelves: ['epic-fantasy'] })); // DNA
    });

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea' }],
      dnaEnabled: true,
    });

    const r = result.results[0];
    expect(r.success).toBe(true);
    expect(r.genres).toEqual(['Fantasy']);
    // DNA ran and its tags were merged in (convertDnaToTags produces dna:pacing:slow etc.)
    expect(r.dna_tags.some(t => t.includes('pacing'))).toBe(true);
    expect(callAI).toHaveBeenCalledTimes(3); // batch attempt + classify + dna
  });

  it('does NOT run DNA in the fallback when dnaEnabled is false', async () => {
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve('not valid json');
      return Promise.resolve(JSON.stringify({ genres: ['Fantasy'], tags: [] }));
    });

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea' }],
      dnaEnabled: false,
    });

    expect(result.results[0].dna_tags).toEqual([]);
    expect(callAI).toHaveBeenCalledTimes(2); // batch attempt + classify only
  });

  it('attaches errorDetail (stage=classify) when the per-book classify call fails in the fallback', async () => {
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve('not valid json');
      return Promise.reject(new Error('OpenAI error 500: internal'));
    });

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea' }],
      dnaEnabled: true,
    });

    const r = result.results[0];
    expect(r.success).toBe(false);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('classify');
    expect(r.errorDetail.kind).toBe('http');
  });

  it('attaches errorDetail (stage=dna) on the result when the fallback classify succeeds but DNA fails, without demoting success', async () => {
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve('not valid json');
      if (call === 2) return Promise.resolve(JSON.stringify({ genres: ['Fantasy'], tags: [] }));
      return Promise.reject(new Error('Anthropic error 529: Overloaded'));
    });

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea' }],
      dnaEnabled: true,
    });

    const r = result.results[0];
    expect(r.success).toBe(true);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('dna');
  });
});
