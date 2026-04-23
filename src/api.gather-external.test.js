import { describe, it, expect, beforeEach, vi } from 'vitest';

const { callBackend } = await import('./api.js');

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('gather_external_data — OpenLibrary (cluster 1)', () => {
  it('surfaces errorDetail when OpenLibrary returns 503 and there is no ASIN fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('openlibrary.org')) {
        return new Response('maintenance', { status: 503 });
      }
      return new Response('', { status: 404 });
    });

    const result = await callBackend('gather_external_data', {
      books: [{ id: 'b1', title: 'The Sentence', author: 'Louise Erdrich' }],
    });

    const r = result.results[0];
    expect(r.gathered).toBe(false);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('gather-openlibrary');
    expect(r.errorDetail.kind).toBe('http');
    expect(r.errorDetail.statusCode).toBe(503);
    expect(r.errorDetail.url).toContain('openlibrary.org/search.json');
  });

  it('surfaces errorDetail when OpenLibrary fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('openlibrary.org')) throw new TypeError('Failed to fetch');
      return new Response('', { status: 404 });
    });

    const result = await callBackend('gather_external_data', {
      books: [{ id: 'b1', title: 'The Sentence', author: 'Louise Erdrich' }],
    });

    expect(result.results[0].errorDetail.stage).toBe('gather-openlibrary');
    expect(result.results[0].errorDetail.kind).toBe('network');
  });

  it('does not attach errorDetail on a clean OpenLibrary hit', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ docs: [{ title: 'T', author_name: ['A'], isbn: ['9781234567897'] }] }), { status: 200 }));

    const result = await callBackend('gather_external_data', {
      books: [{ id: 'b1', title: 'T', author: 'A' }],
    });

    expect(result.results[0].gathered).toBe(true);
    expect(result.results[0].errorDetail).toBeUndefined();
  });
});

describe('gather_external_data — Audnexus (cluster 1)', () => {
  it('surfaces errorDetail when Audnexus returns a 429', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audnex.us')) {
        return new Response('rate limited', { status: 429, statusText: 'Too Many' });
      }
      // OpenLibrary fallback also 4xx so we see the Audnexus error, not the fallback
      return new Response(JSON.stringify({ docs: [] }), { status: 200 });
    });

    const result = await callBackend('gather_external_data', {
      books: [{ id: 'b1', asin: 'B01234567X', title: 'Dune', author: 'Herbert' }],
    });

    const r = result.results[0];
    expect(r.gathered).toBe(false);
    expect(r.errorDetail).toBeDefined();
    expect(r.errorDetail.stage).toBe('gather-audnexus');
    expect(r.errorDetail.kind).toBe('http');
    expect(r.errorDetail.statusCode).toBe(429);
    expect(r.errorDetail.url).toContain('audnex.us/books/');
    fetchSpy.mockRestore();
  });

  it('surfaces errorDetail when Audnexus fetch throws (network error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audnex.us')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ docs: [] }), { status: 200 });
    });

    const result = await callBackend('gather_external_data', {
      books: [{ id: 'b1', asin: 'B01234567X', title: 'Dune', author: 'Herbert' }],
    });

    const r = result.results[0];
    expect(r.gathered).toBe(false);
    expect(r.errorDetail.stage).toBe('gather-audnexus');
    expect(r.errorDetail.kind).toBe('network');
    expect(r.errorDetail.url).toContain('audnex.us');
  });

  it('clears errorDetail when Audnexus fails but OpenLibrary rescues the lookup', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audnex.us')) return new Response('', { status: 502 });
      if (String(url).includes('openlibrary.org')) {
        return new Response(JSON.stringify({ docs: [{
          title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441013593'],
        }] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const result = await callBackend('gather_external_data', {
      books: [{ id: 'b1', asin: 'B0FAIL', title: 'Dune', author: 'Frank Herbert' }],
    });

    const r = result.results[0];
    expect(r.gathered).toBe(true);
    expect(r.errorDetail).toBeUndefined();
    expect(r.abs_author).toBe('Frank Herbert');
  });

  it('does not attach errorDetail on a clean Audnexus hit', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audnex.us')) {
        return new Response(JSON.stringify({
          title: 'Dune', authors: [{ name: 'Frank Herbert' }],
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const result = await callBackend('gather_external_data', {
      books: [{ id: 'b1', asin: 'B0OK', title: 'Dune', author: 'Herbert' }],
    });

    expect(result.results[0].gathered).toBe(true);
    expect(result.results[0].errorDetail).toBeUndefined();
  });
});
