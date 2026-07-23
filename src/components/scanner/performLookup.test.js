import { describe, it, expect, vi } from 'vitest';
import { performLookup } from './performLookup';

const htmlBody = '<!DOCTYPE html><html><body><h1>Bad Gateway</h1></body></html>';

function mockResponse({ status = 200, body = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

describe('performLookup — Lookup Failed toast detail includes URL + status + body (#53 @kyleviloria)', () => {
  it('returns error with URL + status + body preview when Audible fallback returns HTML', async () => {
    // The @kyleviloria bug: CORS-proxy fallback returned HTML, res.ok was true,
    // JSON.parse threw "Unexpected token '<', \"<!DOCTYPE ...\"". The toast
    // only showed the JS parser message — no URL, no body, no status.
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 200, body: htmlBody }));

    const out = await performLookup({
      field: 'asin', title: 'The Sentence', author: 'Louise Erdrich', fetcher,
    });

    expect(out.kind).toBe('error');
    expect(out.detail).toMatch(/Unexpected token|is not valid JSON|JSON/i);
    expect(out.detail).toContain('Status: 200');
    expect(out.detail).toContain('URL: https://api.audible.com/1.0/catalog/products');
    expect(out.detail).toContain('Body: <!DOCTYPE html>');
  });

  it('returns error with explicit HTTP status on a 4xx/5xx', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 503, body: 'maintenance' }));

    const out = await performLookup({
      field: 'isbn', title: 'Dune', author: 'Herbert', fetcher,
    });

    expect(out.kind).toBe('error');
    expect(out.detail).toContain('HTTP 503');
    expect(out.detail).toContain('Status: 503');
    expect(out.detail).toContain('URL: https://openlibrary.org/search.json');
    expect(out.detail).toContain('Body: maintenance');
  });

  it('returns error with URL captured when fetcher throws', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const out = await performLookup({
      field: 'asin', title: 'Dune', author: 'Herbert', fetcher,
    });

    expect(out.kind).toBe('error');
    expect(out.detail).toContain('Failed to fetch');
    expect(out.detail).toContain('URL: https://api.audible.com');
  });

  it('returns found on a clean Audible hit (exact title match)', async () => {
    const body = JSON.stringify({
      products: [
        { asin: 'B0OTHER', title: 'Dune Messiah' },
        { asin: 'B0DUNE', title: 'Dune' },
      ],
    });
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 200, body }));

    const out = await performLookup({
      field: 'asin', title: 'Dune', author: 'Herbert', fetcher,
    });

    expect(out.kind).toBe('found');
    expect(out.value).toBe('B0DUNE');
  });

  it('returns found on a clean OpenLibrary hit with ISBN-13 preference', async () => {
    const body = JSON.stringify({
      docs: [{ title: 'Dune', author_name: ['Frank Herbert'], isbn: ['1', '9780441013593'] }],
    });
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 200, body }));

    const out = await performLookup({
      field: 'isbn', title: 'Dune', author: 'Herbert', fetcher,
    });

    expect(out.kind).toBe('found');
    expect(out.value).toBe('9780441013593');
  });

  it('M5: rejects an OpenLibrary doc whose title does not match the book', async () => {
    // A doc with an ISBN but a wildly different title must NOT yield that ISBN.
    const body = JSON.stringify({
      docs: [{ title: 'Pride and Prejudice', author_name: ['Jane Austen'], isbn: ['9780000000001'] }],
    });
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 200, body }));

    const out = await performLookup({
      field: 'isbn', title: 'Dune', author: 'Frank Herbert', fetcher,
    });

    expect(out.kind).toBe('not-found');
  });

  it('M5: rejects an OpenLibrary doc whose author does not overlap', async () => {
    const body = JSON.stringify({
      docs: [{ title: 'Dune', author_name: ['Somebody Else'], isbn: ['9780000000002'] }],
    });
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 200, body }));

    const out = await performLookup({
      field: 'isbn', title: 'Dune', author: 'Frank Herbert', fetcher,
    });

    expect(out.kind).toBe('not-found');
  });

  it('M5: takes a matching doc even if an earlier non-matching doc has an ISBN', async () => {
    const body = JSON.stringify({
      docs: [
        { title: 'Some Other Book', author_name: ['Nobody'], isbn: ['9780000000003'] },
        { title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441013593'] },
      ],
    });
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 200, body }));

    const out = await performLookup({
      field: 'isbn', title: 'Dune', author: 'Frank Herbert', fetcher,
    });

    expect(out.kind).toBe('found');
    expect(out.value).toBe('9780441013593');
  });

  it('M5: rejects an Audible products[0] fallback whose title does not match', async () => {
    // No exact title hit; the only product is unrelated -> must not return its asin.
    const body = JSON.stringify({
      products: [{ asin: 'B0WRONG', title: 'A Completely Different Book', authors: [{ name: 'Nobody' }] }],
    });
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 200, body }));

    const out = await performLookup({
      field: 'asin', title: 'Dune', author: 'Frank Herbert', fetcher,
    });

    expect(out.kind).toBe('not-found');
  });

  it('returns not-found when the API is reachable but empty', async () => {
    const body = JSON.stringify({ docs: [] });
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ status: 200, body }));

    const out = await performLookup({
      field: 'isbn', title: 'Unknown Title', author: 'Nobody', fetcher,
    });

    expect(out.kind).toBe('not-found');
  });

  it('returns error immediately when title is missing', async () => {
    const fetcher = vi.fn();
    const out = await performLookup({ field: 'asin', title: '', author: '', fetcher });
    expect(out.kind).toBe('error');
    expect(out.detail).toMatch(/No title/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
