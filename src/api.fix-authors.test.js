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

describe('fix_authors_batch — ai-empty normalization + errorDetail (cluster 2)', () => {
  it('normalizes "AI returned null author" to success:false with empty-response errorDetail', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ author: null, confidence: 10 }));

    const result = await callBackend('fix_authors_batch', {
      books: [{ id: 'b1', title: 'The Sentence', current_author: 'Unknown' }],
    });
    const r = result.results[0];

    expect(r.success).toBe(false);
    expect(r.fixed).toBe(false);
    expect(r.source).toBe('ai-empty');
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('fix-author');
    expect(r.errorDetail.kind).toBe('empty-response');
    expect(r.errorDetail.responsePreview).toContain('"author":null');
    // Counts are now consistent: total_failed++ matches success:false
    expect(result.total_failed).toBe(1);
    expect(result.total_fixed).toBe(0);
  });

  it('normalizes "AI returned Unknown" to same empty-response case', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ author: 'Unknown' }));

    const result = await callBackend('fix_authors_batch', {
      books: [{ id: 'b1', title: 'Foo', current_author: '' }],
    });
    expect(result.results[0].errorDetail?.kind).toBe('empty-response');
    expect(result.results[0].success).toBe(false);
  });

  it('populates errorDetail on a hard failure (AI call threw)', async () => {
    callAI.mockRejectedValueOnce(new Error('OpenAI error 429: rate limited'));

    const result = await callBackend('fix_authors_batch', {
      books: [{ id: 'b1', title: 'Foo', current_author: 'Unknown' }],
    });
    const r = result.results[0];
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/429/);
    expect(r.errorDetail.stage).toBe('fix-author');
    expect(r.errorDetail.kind).toBe('http');
  });

  it('does not attach errorDetail when AI successfully identifies an author', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ author: 'Frank Herbert', confidence: 90 }));

    const result = await callBackend('fix_authors_batch', {
      books: [{ id: 'b1', title: 'Dune', current_author: 'Unknown' }],
    });
    const r = result.results[0];
    expect(r.success).toBe(true);
    expect(r.fixed).toBe(true);
    expect(r.author).toBe('Frank Herbert');
    expect(r.errorDetail).toBeUndefined();
  });

  it('does not hit the AI (or attach errorDetail) when existing author is valid', async () => {
    const result = await callBackend('fix_authors_batch', {
      books: [{ id: 'b1', title: 'Dune', current_author: 'Frank Herbert' }],
      force: false,
    });
    expect(callAI).not.toHaveBeenCalled();
    expect(result.results[0].errorDetail).toBeUndefined();
    expect(result.results[0].success).toBe(true);
  });
});
