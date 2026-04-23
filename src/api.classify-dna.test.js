import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock proxy.js — the api.js handler delegates all AI work through these.
vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAI: vi.fn(),
    parseAIJson: vi.fn((s) => JSON.parse(s)),
    // absApi/proxyFetch not exercised in this test but must remain importable.
  };
});

// Force local-AI code path in classify_books_batch.
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    use_local_ai: true,
    ollama_model: 'qwen3:1.7b',
  }));
  vi.clearAllMocks();
});

const { callBackend } = await import('./api.js');
const { callAI } = await import('./lib/proxy');

describe('classify_books_batch — local DNA swallow adopts errorDetail (commit 2)', () => {
  it('attaches errorDetail when DNA parseAIJson throws on a small-model malformed response', async () => {
    // 1st call (classification batch): valid JSON array, one book.
    // 2nd call (DNA for book 0): valid response string, but parseAIJson will throw.
    // qwen3:1.7b frequently emits <thinking> blocks or truncated JSON.
    callAI
      .mockResolvedValueOnce(JSON.stringify([{ genres: ['Fantasy'], tags: ['magic'] }]))
      .mockResolvedValueOnce('<thinking>probably fantasy</thinking>{"tags":[oops');

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea', author: 'Le Guin' }],
      dnaEnabled: true,
      forceFresh: false,
      includeDescription: false,
    });

    expect(result.results).toHaveLength(1);
    const r = result.results[0];
    // Classification succeeded, book is still usable…
    expect(r.id).toBe('b1');
    expect(r.success).toBe(true);
    expect(r.genres).toEqual(['Fantasy']);
    // …but the DNA sub-step failed and is surfaced as errorDetail.
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('dna');
    expect(r.errorDetail.kind).toBe('parse');
    expect(r.errorDetail.message).toMatch(/JSON/i);
    // responsePreview is the raw AI output the UI needs to diagnose the model.
    expect(r.errorDetail.responsePreview).toContain('<thinking>');
    expect(r.errorDetail.responsePreview).toContain('oops');
  });

  it('does NOT attach errorDetail when DNA succeeds cleanly', async () => {
    callAI
      .mockResolvedValueOnce(JSON.stringify([{ genres: ['Fantasy'], tags: [] }]))
      .mockResolvedValueOnce(JSON.stringify({ pacing: 'slow-burn', mood: 'melancholic' }));

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea' }],
      dnaEnabled: true,
      forceFresh: false,
      includeDescription: false,
    });

    expect(result.results[0].errorDetail).toBeUndefined();
    expect(result.results[0].success).toBe(true);
  });

  it('cloud path: attaches errorDetail when DNA fetch throws, preserves classification', async () => {
    // Switch to cloud config (no use_local_ai / no ollama_model).
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      openai_api_key: 'sk-fake',
      ai_model: 'gpt-5-nano',
    }));
    // Cloud path fires classify + DNA in Promise.all. Classify resolves, DNA rejects.
    callAI.mockImplementation((config, sys /* system prompt */, user, maxTokens) => {
      // DNA system prompt differs from classification — discriminate by maxTokens
      // (1500 for DNA, 2000 for classification in the cloud processBook).
      if (maxTokens === 1500) return Promise.reject(new Error('Anthropic error 529: Overloaded'));
      return Promise.resolve(JSON.stringify({ genres: ['Fantasy'], tags: ['magic'] }));
    });

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea' }],
      dnaEnabled: true,
      forceFresh: false,
      includeDescription: false,
    });

    const r = result.results[0];
    expect(r.success).toBe(true);
    expect(r.genres).toEqual(['Fantasy']);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('dna');
    expect(r.errorDetail.kind).toBe('http'); // "error 529" → http
    expect(r.errorDetail.message).toMatch(/529|Overloaded/);
  });

  it('cloud path: attaches errorDetail on hard classify failure with stage=classify', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      openai_api_key: 'sk-fake',
      ai_model: 'gpt-5-nano',
    }));
    callAI.mockRejectedValue(new Error('OpenAI error 401: invalid key'));

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea' }],
      dnaEnabled: false,
      forceFresh: false,
      includeDescription: false,
    });

    const r = result.results[0];
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/401/);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('classify');
    expect(r.errorDetail.kind).toBe('http');
  });

  it('does NOT attach errorDetail when DNA is disabled', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify([{ genres: ['Fantasy'], tags: [] }]));

    const result = await callBackend('classify_books_batch', {
      books: [{ id: 'b1', title: 'A Wizard of Earthsea' }],
      dnaEnabled: false,
      forceFresh: false,
      includeDescription: false,
    });

    expect(result.results[0].errorDetail).toBeUndefined();
    expect(callAI).toHaveBeenCalledTimes(1); // no DNA call
  });
});
