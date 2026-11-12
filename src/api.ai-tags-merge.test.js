import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAI: vi.fn(), parseAIJson: vi.fn((s) => JSON.parse(s)) };
});

const { callBackend } = await import('./api.js');
const { callAI, parseAIJson } = await import('./lib/proxy');
const { mergeClassifyTags } = await import('./lib/mergeClassifyTags');

const EXISTING = ['favorite', 'kids-bedtime', 'dna:pacing:fast'];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({ use_local_ai: true, ollama_model: 'qwen3:1.7b' }));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

describe('AI Tags merge (C-2)', () => {
  it('keeps curated and dna tags when AI Tags succeeds and the DNA call throws; reports dna_error', async () => {
    callAI
      .mockResolvedValueOnce(JSON.stringify({ tags: ['fast-paced'] }))
      .mockRejectedValueOnce(new Error('dna boom'));
    const out = await callBackend('assign_tags_with_gpt', {
      books: [{ id: 'b1', title: 'T', author: 'A' }],
      dnaEnabled: true,
    });
    const r = out.results[0];
    expect(r.dna_error).toBe('dna boom');
    const merged = mergeClassifyTags(EXISTING, { tags: r.tags, dna_tags: r.dna_tags }, EXISTING);
    expect(merged.tags).toEqual(expect.arrayContaining(['favorite', 'kids-bedtime', 'dna:pacing:fast', 'fast-paced']));
  });
});

describe('Generate DNA merge (C-2)', () => {
  it('an empty DNA answer fails the book and keeps every dna: tag', async () => {
    callAI.mockResolvedValueOnce('{}');
    const results = await callBackend('generate_book_dna_batch', {
      request: { items: [{ id: 'b1', title: 'T', tags: EXISTING }] },
    });
    expect(results.results[0].success).toBe(false);
    expect(results.results[0].error).toBeTruthy();
    expect(results.results[0].merged_tags).toEqual(EXISTING);
  });

  it('new dna tags replace old dna tags and keep non-dna tags', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ pacing: 'slow' }));
    const results = await callBackend('generate_book_dna_batch', {
      request: { items: [{ id: 'b1', title: 'T', tags: EXISTING }] },
    });
    const r = results.results[0];
    if (!r.success) throw new Error('expected success, dna_tags=' + JSON.stringify(r));
    const merged = mergeClassifyTags(EXISTING, { dna_tags: r.dna_tags }, EXISTING).tags;
    expect(merged).toEqual(expect.arrayContaining(['favorite', 'kids-bedtime']));
    expect(merged).not.toContain('dna:pacing:fast');
    expect(merged.some((t) => t.startsWith('dna:'))).toBe(true);
  });
});
