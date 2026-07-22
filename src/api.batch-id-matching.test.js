// Regression tests for items C and D (2026-07-22 task 2): local-AI batch paths
// must match AI results to books by id first, falling back to position only
// when no id-matched entry exists AND the response length equals the batch
// length. A book that gets no entry at all must never silently succeed.
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

describe('C: classify_books_batch local-batch matches results by id, not position', () => {
  it('matches out-of-order results by id instead of index', async () => {
    // AI returned book b2's classification first, then b1's - out of order.
    callAI.mockResolvedValueOnce(JSON.stringify([
      { id: 'b2', genres: ['Romance'], tags: ['cozy'] },
      { id: 'b1', genres: ['Fantasy'], tags: ['epic-fantasy'] },
    ]));

    const result = await callBackend('classify_books_batch', {
      books: [
        { id: 'b1', title: 'A Wizard of Earthsea' },
        { id: 'b2', title: 'Pride and Prejudice' },
      ],
      dnaEnabled: false,
    });

    const b1 = result.results.find(r => r.id === 'b1');
    const b2 = result.results.find(r => r.id === 'b2');
    expect(b1.genres).toEqual(['Fantasy']);
    expect(b2.genres).toEqual(['Romance']);
  });

  it('falls back to position when the AI response omits ids but lengths match', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify([
      { genres: ['Fantasy'], tags: ['epic-fantasy'] },
      { genres: ['Romance'], tags: ['cozy'] },
    ]));

    const result = await callBackend('classify_books_batch', {
      books: [
        { id: 'b1', title: 'A Wizard of Earthsea' },
        { id: 'b2', title: 'Pride and Prejudice' },
      ],
      dnaEnabled: false,
    });

    const b1 = result.results.find(r => r.id === 'b1');
    const b2 = result.results.find(r => r.id === 'b2');
    expect(b1.genres).toEqual(['Fantasy']);
    expect(b2.genres).toEqual(['Romance']);
  });

  it('produces a per-book failure with errorDetail when a book has no id match and lengths differ (no positional fallback)', async () => {
    // Only ONE result for TWO books, and its id doesn't match either book.
    callAI.mockResolvedValueOnce(JSON.stringify([
      { id: 'unrelated', genres: ['Fantasy'], tags: ['epic-fantasy'] },
    ]));

    const result = await callBackend('classify_books_batch', {
      books: [
        { id: 'b1', title: 'A Wizard of Earthsea' },
        { id: 'b2', title: 'Pride and Prejudice' },
      ],
      dnaEnabled: false,
    });

    expect(result.results).toHaveLength(2);
    const b2 = result.results.find(r => r.id === 'b2');
    // b2 got no entry at all - must be a real failure, not a silent success.
    expect(b2.success).toBe(false);
    expect(b2.errorDetail).toBeDefined();
    expect(b2.errorDetail.kind).toBe('empty-response');
  });

  it('String()-normalizes id comparison (numeric id vs string id)', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify([
      { id: 2, genres: ['Romance'], tags: ['cozy'] },
      { id: 1, genres: ['Fantasy'], tags: ['epic-fantasy'] },
    ]));

    const result = await callBackend('classify_books_batch', {
      books: [
        { id: '1', title: 'A Wizard of Earthsea' },
        { id: '2', title: 'Pride and Prejudice' },
      ],
      dnaEnabled: false,
    });

    const b1 = result.results.find(r => r.id === '1');
    expect(b1.genres).toEqual(['Fantasy']);
  });
});

describe('D: resolve_metadata_batch local-batch matches results by id, not position', () => {
  const books = [
    { id: 'b1', current_title: 'Dune', current_author: 'Frank Herbert' },
    { id: 'b2', current_title: 'Foundation', current_author: 'Isaac Asimov' },
  ];

  it('matches out-of-order results by id instead of index', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify([
      { id: 'b2', title: 'Foundation', author: 'Isaac Asimov', series: 'Foundation', sequence: '1' },
      { id: 'b1', title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '1' },
    ]));

    const result = await callBackend('resolve_metadata_batch', { books });

    const b1 = result.results.find(r => r.id === 'b1');
    const b2 = result.results.find(r => r.id === 'b2');
    expect(b1.series).toBe('Dune Chronicles');
    expect(b2.series).toBe('Foundation');
  });

  it('falls back to position when ids are absent but lengths match', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify([
      { title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', sequence: '1' },
      { title: 'Foundation', author: 'Isaac Asimov', series: 'Foundation', sequence: '1' },
    ]));

    const result = await callBackend('resolve_metadata_batch', { books });

    expect(result.results[0].series).toBe('Dune Chronicles');
    expect(result.results[1].series).toBe('Foundation');
  });
});
