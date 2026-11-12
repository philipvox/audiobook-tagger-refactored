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

describe('exact title beats containment (fix round 1)', () => {
  it('lookup_book_isbn takes "Dune" over "Dune Messiah" listed first', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audible.com')) {
        return ok({ products: [
          { asin: 'B0MESSIAH', title: 'Dune Messiah', authors: [{ name: 'Frank Herbert' }] },
          { asin: 'B0DUNE', title: 'Dune', authors: [{ name: 'Frank Herbert' }] },
        ] });
      }
      return ok({ docs: [
        { title: 'Dune Messiah', author_name: ['Frank Herbert'], isbn: ['9780593098233'] },
        { title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441013593'] },
      ] });
    });
    const r = await callBackend('lookup_book_isbn', { request: { title: 'Dune', author: 'Frank Herbert' } });
    expect(r).toMatchObject({ success: true, asin: 'B0DUNE', isbn: '9780441013593' });
  });

  it('gather takes "Dune" over "Dune Messiah" listed first', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ docs: [
      { title: 'Dune Messiah', author_name: ['Frank Herbert'], isbn: ['9780593098233'] },
      { title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441013593'] },
    ] }));
    const r = (await callBackend('gather_external_data', {
      books: [{ id: 'b1', title: 'Dune', author: 'Frank Herbert' }],
    })).results[0];
    expect(r.abs_title).toBe('Dune');
    expect(r.abs_isbn).toBe('9780441013593');
  });

  it('gather rejects a sequel-only hit when the author is a placeholder', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ docs: [
      { title: 'Dune Messiah', author_name: ['Frank Herbert'], isbn: ['9780593098233'] },
    ] }));
    const r = (await callBackend('gather_external_data', {
      books: [{ id: 'b1', title: 'Dune', author: 'Unknown' }],
    })).results[0];
    expect(r.gathered).toBe(false);
  });
});

describe('gather_external_data: Audnexus record must match the book', () => {
  it('ignores an ASIN record for another book and falls back to OpenLibrary', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audnex.us')) {
        return ok({ title: 'The Dosadi Experiment', authors: [{ name: 'Frank Herbert' }] });
      }
      return ok({ docs: [{ title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441013593'] }] });
    });
    const r = (await callBackend('gather_external_data', {
      books: [{ id: 'b1', asin: 'B0WRONG', title: 'Dune', author: 'Frank Herbert' }],
    })).results[0];
    expect(r.gathered).toBe(true);
    expect(r.source).toBe('openlibrary');
    expect(r.abs_title).toBe('Dune');
  });

  it('accepts a matching Audnexus record', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
      String(url).includes('audnex.us')
        ? ok({ title: 'Dune', authors: [{ name: 'Frank Herbert' }] })
        : ok({ docs: [] })
    ));
    const r = (await callBackend('gather_external_data', {
      books: [{ id: 'b1', asin: 'B0DUNE', title: 'Dune', author: 'Frank Herbert' }],
    })).results[0];
    expect(r.source).toBe('audnexus');
  });
});
