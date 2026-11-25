import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAI: vi.fn(), parseAIJson: vi.fn((s) => JSON.parse(s)) };
});

const { callBackend } = await import('./api.js');
const { callAI, parseAIJson } = await import('./lib/proxy');

const H = 3600;
const book = { id: 'b1', title: 'Short Book', author: 'A', duration: 3 * H };
const guess = JSON.stringify({ genres: ['Fantasy'], tags: ['dark', '10-15-hours'] });
const dnaGuess = JSON.stringify({ length: 'long', pacing: 'fast' });

function useConfig(cfg) {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify(cfg));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
}

describe('length tags come from the real duration, not the AI guess', () => {
  beforeEach(() => useConfig({ openai_api_key: 'test', ai_model: 'gpt-6-luna' }));

  it('classify (cloud): fixes the length tag and dna:length, and sends the duration', async () => {
    callAI.mockImplementation(async (_c, system) => (system.includes('DNA') ? dnaGuess : guess));
    const { results } = await callBackend('classify_books_batch', { books: [book], dnaEnabled: true });
    const r = results[0];
    expect(r.tags).toContain('under-5-hours');
    expect(r.tags).not.toContain('10-15-hours');
    expect(r.dna_tags).toContain('dna:length:short');
    expect(r.dna_tags).not.toContain('dna:length:long');
    for (const call of callAI.mock.calls) expect(call[2]).toContain('Duration: 3h 0m');
  });

  it('classify (local batch): fixes the length tag and sends the duration', async () => {
    useConfig({ use_local_ai: true, ollama_model: 'qwen3:4b' });
    callAI.mockResolvedValueOnce(JSON.stringify([{ id: 'b1', genres: ['Fantasy'], tags: ['5-10-hours'] }]));
    const { results } = await callBackend('classify_books_batch', { books: [book], dnaEnabled: false });
    expect(results[0].tags).toEqual(['under-5-hours']);
    expect(callAI.mock.calls[0][2]).toContain('Duration: 3h 0m');
  });

  it('assign tags: fixes the length tag and dna:length', async () => {
    callAI.mockImplementation(async (_c, system) => (system.includes('DNA') ? dnaGuess : JSON.stringify({ tags: ['dark', 'over-20-hours'] })));
    const { results } = await callBackend('assign_tags_with_gpt', { books: [book], dnaEnabled: true });
    expect(results[0].tags).toEqual(['dark', 'under-5-hours']);
    expect(results[0].dna_tags).toContain('dna:length:short');
    expect(results[0].suggested_tags).toContain('under-5-hours');
    expect(results[0].suggested_tags).not.toContain('over-20-hours');
  });

  it('DNA batch: fixes dna:length', async () => {
    callAI.mockResolvedValue(dnaGuess);
    const { results } = await callBackend('generate_book_dna_batch', { items: [{ ...book, tags: ['dark'] }] });
    expect(results[0].dna_tags).toContain('dna:length:short');
    expect(results[0].merged_tags).toContain('dna:length:short');
    expect(results[0].merged_tags).not.toContain('dna:length:long');
  });
});
