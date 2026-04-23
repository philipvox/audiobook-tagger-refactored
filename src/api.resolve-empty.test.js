import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock proxy so we control what callAI returns.
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
  // Force cloud-AI path (individual processing) for easier single-book assertions.
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    openai_api_key: 'sk-fake',
    ai_model: 'gpt-5-nano',
  }));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

const emptyBook = {
  id: 'b1',
  current_title: 'Unknown',
  current_author: 'Unknown',
};

describe('resolve_metadata_batch — buildMetaResult silent-success predicate (cluster 2)', () => {
  it('attaches errorDetail kind=empty-content when AI returns {}', async () => {
    callAI.mockResolvedValueOnce('{}');

    const result = await callBackend('resolve_metadata_batch', { books: [emptyBook] });
    const r = result.results[0];

    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('resolve');
    expect(r.errorDetail.kind).toBe('empty-content');
    expect(r.errorDetail.message).toMatch(/no usable metadata/i);
    expect(r.errorDetail.responsePreview).toBe('{}');
    expect(r.changed).toBe(false);
  });

  it('attaches errorDetail when all expected fields come back null', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: null, author: null, subtitle: null, series: null, sequence: null, narrator: null,
      confidence: 20,
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [emptyBook] });
    const r = result.results[0];

    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.kind).toBe('empty-content');
  });

  it('attaches errorDetail when fields are empty strings or whitespace', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: '', author: '   ', subtitle: null, series: null, sequence: null, narrator: null,
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [emptyBook] });
    expect(result.results[0].errorDetail?.kind).toBe('empty-content');
  });

  it('does NOT attach errorDetail when AI returns at least one non-null field (partial result)', async () => {
    // Partial-result detection is deliberately out of scope for this predicate.
    // Commit 7 treats any non-null field as useful; the changedFields diff
    // handles the "AI returned data but nothing actually changed" signal.
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'A Wizard of Earthsea', author: null, series: null,
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [emptyBook] });
    expect(result.results[0].errorDetail).toBeUndefined();
    expect(result.results[0].title).toBe('A Wizard of Earthsea');
  });

  it('does NOT attach errorDetail on a complete AI response', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({
      title: 'Dune', author: 'Frank Herbert', series: 'Dune', sequence: '1',
    }));

    const result = await callBackend('resolve_metadata_batch', { books: [emptyBook] });
    expect(result.results[0].errorDetail).toBeUndefined();
  });

  it('populates errorDetail on a hard resolve failure (exception from callAI)', async () => {
    callAI.mockRejectedValueOnce(new Error('OpenAI error 503: service unavailable'));

    const result = await callBackend('resolve_metadata_batch', { books: [emptyBook] });
    const r = result.results[0];
    expect(r.error).toMatch(/503/);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('resolve');
    expect(r.errorDetail.kind).toBe('http');
  });
});
