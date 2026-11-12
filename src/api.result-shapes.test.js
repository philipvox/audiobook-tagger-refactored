import { describe, it, expect, beforeEach, vi } from 'vitest';

// H-3: every single-book AI handler returns the shape its caller reads.
// Before this, the handlers returned flat or differently named fields and the
// callers in ScannerPage applied nothing.
vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAI: vi.fn() };
});

const { callBackend } = await import('./api.js');
const { callAI } = await import('./lib/proxy');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    openai_api_key: 'sk-fake',
    ai_model: 'gpt-5-nano',
  }));
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const answer = (obj) => callAI.mockResolvedValueOnce(JSON.stringify(obj));

describe('resolve_title', () => {
  const request = { current_title: 'Guards Guards', current_author: 'Pratchett' };

  it('returns { success, result: { title, author, subtitle, series, sequence, narrator, confidence } }', async () => {
    answer({ title: 'Guards! Guards!', author: 'Terry Pratchett', subtitle: null, series: 'Discworld', sequence: '8', narrator: 'Nigel Planer', confidence: 90 });
    const r = await callBackend('resolve_title', { request });
    expect(r.success).toBe(true);
    expect(r.result).toEqual({
      title: 'Guards! Guards!',
      author: 'Terry Pratchett',
      subtitle: null,
      series: 'Discworld',
      sequence: '8',
      narrator: 'Nigel Planer',
      confidence: 90,
    });
  });

  it('keeps the current values below confidence 60, like the batch handler', async () => {
    answer({ title: 'Wrong Book', author: 'Someone Else', confidence: 40 });
    const r = await callBackend('resolve_title', { request });
    expect(r.success).toBe(true);
    expect(r.result.title).toBe('Guards Guards');
    expect(r.result.author).toBe('Pratchett');
    expect(r.errorDetail?.message).toMatch(/confidence 40/);
  });

  it('reports a failed AI call as { success: false, error }', async () => {
    callAI.mockRejectedValueOnce(new Error('HTTP 500'));
    const r = await callBackend('resolve_title', { request });
    expect(r.success).toBe(false);
    expect(r.error).toBe('HTTP 500');
    expect(r.result).toBeUndefined();
  });
});

describe('resolve_series', () => {
  it('returns { success, result: { series, sequence } }', async () => {
    answer({ series: 'The Stormlight Archive', sequence: '1', confidence: 90 });
    const r = await callBackend('resolve_series', { request: { title: 'The Way of Kings', author: 'Brandon Sanderson', current_series: 'Stormlight' } });
    expect(r.success).toBe(true);
    expect(r.result).toMatchObject({ series: 'The Stormlight Archive', sequence: '1' });
  });

  it('gives no series below confidence 60', async () => {
    answer({ series: 'Other', sequence: '4', confidence: 30 });
    const r = await callBackend('resolve_series', { request: { title: 'X', author: 'Y', current_series: 'Discworld' } });
    expect(r.success).toBe(true);
    expect(r.result.series).toBeNull();
    expect(r.errorDetail?.message).toMatch(/confidence 30/);
  });

  it('reports a failed AI call as { success: false, error }', async () => {
    callAI.mockRejectedValueOnce(new Error('timeout'));
    const r = await callBackend('resolve_series', { request: { title: 'X', author: 'Y' } });
    expect(r).toMatchObject({ success: false, error: 'timeout' });
  });
});

describe('fix_subtitles_batch', () => {
  it('items carry fixed and subtitle, with totals', async () => {
    answer({ subtitle: 'The Desert Planet' });
    answer({ subtitle: 'N/A' });
    callAI.mockRejectedValueOnce(new Error('HTTP 429'));
    const r = await callBackend('fix_subtitles_batch', {
      books: [
        { id: 'a', title: 'Dune', author: 'Frank Herbert', current_subtitle: null },
        { id: 'b', title: 'Emma', author: 'Jane Austen', current_subtitle: 'A Novel' },
        { id: 'c', title: 'Z', author: 'Q' },
      ],
    });
    expect(r.results[0]).toMatchObject({ id: 'a', success: true, fixed: true, subtitle: 'The Desert Planet' });
    expect(r.results[1]).toMatchObject({ id: 'b', success: true, fixed: false, subtitle: null });
    expect(r.results[2]).toMatchObject({ id: 'c', success: false, fixed: false, error: 'HTTP 429' });
    expect(r).toMatchObject({ total_fixed: 1, total_skipped: 1, total_failed: 1 });
  });

  it('the same subtitle the book already has is not a fix', async () => {
    answer({ subtitle: 'A Novel' });
    const r = await callBackend('fix_subtitles_batch', { books: [{ id: 'b', title: 'Emma', author: 'Jane Austen', current_subtitle: 'A Novel' }] });
    expect(r.results[0].fixed).toBe(false);
  });
});

describe('cleanup_genres_with_gpt', () => {
  it('items carry changed and cleaned_genres, with totals', async () => {
    answer({ genres: ['Fantasy', 'Humor'] });
    answer({ genres: ['Fantasy'] });
    answer({ genres: [] });
    const r = await callBackend('cleanup_genres_with_gpt', {
      books: [
        { id: 'a', title: 'Mort', author: 'Terry Pratchett', genres: ['Sci Fi & Fantasy'] },
        { id: 'b', title: 'Eragon', author: 'Christopher Paolini', genres: ['Fantasy'] },
        { id: 'c', title: 'Z', author: 'Q', genres: ['Fantasy'] },
      ],
    });
    expect(r.results[0]).toMatchObject({ id: 'a', success: true, changed: true });
    expect(r.results[0].cleaned_genres).toEqual(expect.arrayContaining(['Fantasy', 'Humor']));
    expect(r.results[1]).toMatchObject({ id: 'b', success: true, changed: false, cleaned_genres: ['Fantasy'] });
    // An empty answer is a failure, not "clear the genres".
    expect(r.results[2]).toMatchObject({ id: 'c', success: false });
    expect(r).toMatchObject({ total_cleaned: 1, total_unchanged: 1, total_failed: 1 });
  });
});

describe('resolve_book_age_rating (Lookup Age)', () => {
  it('returns { age_category, age_tags, age_rating }', async () => {
    answer({ age_rating: { intended_for_kids: false, age_category: 'Teen 13-17', content_rating: 'PG-13' }, age_rating_reason: 'Teen protagonist' });
    const r = await callBackend('resolve_book_age_rating', { request: { title: 'X', author: 'Y' } });
    expect(r.success).toBe(true);
    expect(r.age_category).toBe('Teen 13-17');
    expect(r.age_tags).toEqual(expect.arrayContaining(['not-for-kids', 'age-teens', 'rated-pg13']));
    expect(r.age_rating).toBe('Teens');
    expect(r.content_rating).toBe('PG-13');
    expect(r.reasoning).toBe('Teen protagonist');
  });

  it('an answer without an age rating is a failure', async () => {
    answer({ genres: ['Fantasy'] });
    const r = await callBackend('resolve_book_age_rating', { request: { title: 'X', author: 'Y' } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no age rating/i);
  });

  it('reports a failed AI call as { success: false, error }', async () => {
    callAI.mockRejectedValueOnce(new Error('HTTP 401'));
    const r = await callBackend('resolve_book_age_rating', { request: { title: 'X', author: 'Y' } });
    expect(r).toMatchObject({ success: false, error: 'HTTP 401' });
  });
});
