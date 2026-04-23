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

describe('fix_years_batch — invalid-year adopts errorDetail (cluster 3)', () => {
  it('attaches errorDetail.kind=schema when AI returns a year outside the valid range', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ year: '3025' })); // too far in the future

    const result = await callBackend('fix_years_batch', {
      books: [{ id: 'b1', title: 'Foo', author: 'Bar' }],
      force: true,
    });
    const r = result.results[0];
    expect(r.fixed).toBe(false);
    expect(r.error).toBe('Invalid year from AI');
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('fix-year');
    expect(r.errorDetail.kind).toBe('schema');
    expect(r.errorDetail.message).toMatch(/3025/);
    expect(r.errorDetail.responsePreview).toContain('3025');
    expect(result.total_failed).toBe(1);
  });

  it('attaches errorDetail when AI returns no year', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ year: null }));

    const result = await callBackend('fix_years_batch', {
      books: [{ id: 'b1', title: 'Foo', author: 'Bar' }],
      force: true,
    });
    expect(result.results[0].errorDetail.message).toMatch(/no year/i);
  });

  it('attaches errorDetail with kind=http when AI call throws', async () => {
    callAI.mockRejectedValueOnce(new Error('OpenAI error 500: internal'));

    const result = await callBackend('fix_years_batch', {
      books: [{ id: 'b1', title: 'Foo', author: 'Bar' }],
      force: true,
    });
    expect(result.results[0].errorDetail.stage).toBe('fix-year');
    expect(result.results[0].errorDetail.kind).toBe('http');
  });

  it('does not attach errorDetail on a valid year', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ year: '2021' }));

    const result = await callBackend('fix_years_batch', {
      books: [{ id: 'b1', title: 'Foo', author: 'Bar' }],
      force: true,
    });
    expect(result.results[0].fixed).toBe(true);
    expect(result.results[0].errorDetail).toBeUndefined();
  });
});
