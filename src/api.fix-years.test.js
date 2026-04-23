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

  it('counts add up: fixed + skipped + failed === total books (Risk 1 smoke)', async () => {
    // Book with existing valid year → skipped. Book with force=true and AI
    // returning a valid year → fixed. Book with AI returning garbage → failed.
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(JSON.stringify({ year: '1965' }));
      return Promise.resolve(JSON.stringify({ year: '9999' })); // out of range
    });
    const result = await callBackend('fix_years_batch', {
      books: [
        { id: 'b1', title: 'Dune', author: 'Herbert', current_year: null }, // fixed
        { id: 'b2', title: 'LotR', author: 'Tolkien', current_year: 1954 }, // skipped
        { id: 'b3', title: 'X', author: 'Y', current_year: null },          // failed
      ],
      force: false,
    });
    const total = result.total_fixed + result.total_skipped + result.total_failed;
    expect(total).toBe(3);
    expect(result.total_fixed).toBe(1);
    expect(result.total_skipped).toBe(1);
    expect(result.total_failed).toBe(1);
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
