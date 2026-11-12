import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// M-3: lookups must not take the first hit unchecked, and must not swallow errors.
const { callBackend } = await import('./api.js');

const ok = (data) => new Response(JSON.stringify(data), { status: 200 });

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

describe('gather_external_data: OpenLibrary hit must match the book', () => {
  it('treats a hit with a different title as no result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ docs: [
      { title: 'A Completely Different Book', author_name: ['Louise Erdrich'], isbn: ['9780000000001'] },
    ] }));
    const r = (await callBackend('gather_external_data', {
      books: [{ id: 'b1', title: 'The Sentence', author: 'Louise Erdrich' }],
    })).results[0];
    expect(r.gathered).toBe(false);
    expect(r.abs_title).toBeUndefined();
  });

  it('skips a title match by another author and takes the matching hit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ docs: [
      { title: 'The Sentence', author_name: ['Someone Else'], isbn: ['9780000000001'] },
      { title: 'The Sentence: A Novel', author_name: ['Louise Erdrich'], isbn: ['9780062671127'] },
    ] }));
    const r = (await callBackend('gather_external_data', {
      books: [{ id: 'b1', title: 'The Sentence', author: 'Louise Erdrich' }],
    })).results[0];
    expect(r.gathered).toBe(true);
    expect(r.abs_author).toBe('Louise Erdrich');
    expect(r.abs_isbn).toBe('9780062671127');
  });

  it('with a placeholder author, needs only a title match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ docs: [
      { title: 'Other', author_name: ['X Y'] },
      { title: 'The Sentence', author_name: ['Louise Erdrich'], isbn: ['9780062671127'] },
    ] }));
    const r = (await callBackend('gather_external_data', {
      books: [{ id: 'b1', title: 'The Sentence (Unabridged)', author: 'Unknown' }],
    })).results[0];
    expect(r.gathered).toBe(true);
    expect(r.abs_author).toBe('Louise Erdrich');
  });

  it('retries an OpenLibrary 429 before giving up', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('slow', { status: 429 }))
      .mockResolvedValueOnce(ok({ docs: [{ title: 'Dune', author_name: ['Frank Herbert'] }] }));
    const p = callBackend('gather_external_data', { books: [{ id: 'b1', title: 'Dune', author: 'Frank Herbert' }] });
    await vi.advanceTimersByTimeAsync(1000);
    const r = (await p).results[0];
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.gathered).toBe(true);
  });
});

describe('lookup_book_isbn: checked hits, visible errors', () => {
  it('ignores unrelated Audible and OpenLibrary hits', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audible.com')) {
        return ok({ products: [{ asin: 'B0WRONG', title: 'Unrelated', authors: [{ name: 'Louise Erdrich' }] }] });
      }
      return ok({ docs: [{ title: 'Unrelated', author_name: ['Louise Erdrich'], isbn: ['9780000000001'] }] });
    });
    const r = await callBackend('lookup_book_isbn', { request: { title: 'The Sentence', author: 'Louise Erdrich' } });
    expect(r.success).toBe(false);
    expect(r.isbn ?? null).toBeNull();
    expect(r.asin ?? null).toBeNull();
  });

  it('takes the first hit that matches title and author surname', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audible.com')) {
        return ok({ products: [
          { asin: 'B0OTHER', title: 'The Sentence', authors: [{ name: 'Someone Else' }] },
          { asin: 'B08RIGHT', title: 'The Sentence', authors: [{ name: 'Louise Erdrich' }] },
        ] });
      }
      return ok({ docs: [
        { title: 'The Sentence', author_name: ['Someone Else'], isbn: ['9780000000001'] },
        { title: 'The Sentence', author_name: ['Louise Erdrich'], isbn: ['0062671129', '9780062671127'] },
      ] });
    });
    const r = await callBackend('lookup_book_isbn', { request: { title: 'The Sentence', author: 'Louise Erdrich' } });
    expect(r).toMatchObject({ success: true, asin: 'B08RIGHT', isbn: '9780062671127' });
  });

  it('returns the lookup errors instead of "Not found" when both sources fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audible.com')) throw new TypeError('Failed to fetch');
      return new Response('down', { status: 503 });
    });
    const r = await callBackend('lookup_book_isbn', { request: { title: 'The Sentence', author: 'Louise Erdrich' } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Failed to fetch/);
    expect(r.error).toMatch(/503/);
    expect(r.errorDetail).toMatchObject({ stage: 'lookup-isbn' });
  });

  it('still says Not found when the sources answered but nothing matched', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
      String(url).includes('audible.com') ? ok({ products: [] }) : ok({ docs: [] })
    ));
    const r = await callBackend('lookup_book_isbn', { request: { title: 'The Sentence', author: 'Louise Erdrich' } });
    expect(r).toEqual({ success: false, error: 'Not found' });
  });
});
