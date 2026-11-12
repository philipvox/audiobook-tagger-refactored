import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAI: vi.fn(), parseAIJson: vi.fn((s) => JSON.parse(s)) };
});

const { callBackend } = await import('./api.js');
const { callAI, parseAIJson } = await import('./lib/proxy');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    use_local_ai: true, ollama_model: 'qwen3:1.7b', genres_default_v2: true,
  }));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

const run = (dnaEnabled) => callBackend('classify_books_batch', {
  books: [{ id: 'b1', title: 'T' }], dnaEnabled, forceFresh: false, includeDescription: false,
});

describe('classify empty-answer detection', () => {
  it('fails with Empty AI answer when genres, tags, dna and age are all empty', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify([{ genres: [], tags: [] }]));
    const r = (await run(false)).results[0];
    expect(r.success).toBe(false);
    expect(r.error).toBe('Empty AI answer');
  });

  it('keeps a DNA-only result (no genres, no tags) as a success', async () => {
    callAI
      .mockResolvedValueOnce(JSON.stringify([{ genres: [], tags: [] }]))
      .mockResolvedValueOnce(JSON.stringify({ pacing: 'slow-burn', mood: 'melancholic' }));
    const r = (await run(true)).results[0];
    expect(r.success).toBe(true);
    expect(r.dna_tags.length).toBeGreaterThan(0);
  });

  it('keeps an age-only result as a success', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify([{ genres: [], tags: [], age_rating: 8 }]));
    const r = (await run(false)).results[0];
    expect(r.success).toBe(true);
    expect(r.age_tags.length).toBeGreaterThan(0);
  });
});
