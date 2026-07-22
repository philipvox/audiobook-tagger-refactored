// Regression tests for the 2026-07-22 audit (task 4, items 2/7):
// abs-client.js absItemToBookGroup, CR-3 (stable file ids + changes) and
// M-4/L-14 (year field + defensive tagDate parsing).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    absApi: vi.fn(),
  };
});

const { importLibrary, parseYearFromTagDate } = await import('./abs-client.js');
const { absApi } = await import('./proxy');

const config = { abs_base_url: 'http://abs.local', abs_api_token: 'token', abs_library_id: 'lib-1' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('parseYearFromTagDate (M-4/L-14)', () => {
  it('takes the first 4 digits when tagDate is a plain year', () => {
    expect(parseYearFromTagDate('2019')).toBe('2019');
  });

  it('takes the first 4 digits when tagDate is a full ISO date', () => {
    expect(parseYearFromTagDate('2019-05-12')).toBe('2019');
  });

  it('falls back to Date parsing when the first 4 chars are not digits', () => {
    // "May 2019", first 4 chars are "May " which is not a 4-digit year
    expect(parseYearFromTagDate('May 12 2019')).toBe('2019');
  });

  it('returns null for unparseable garbage instead of a bogus year', () => {
    expect(parseYearFromTagDate('not a date at all')).toBeNull();
  });

  it('returns null for empty/missing input', () => {
    expect(parseYearFromTagDate(null)).toBeNull();
    expect(parseYearFromTagDate(undefined)).toBeNull();
    expect(parseYearFromTagDate('')).toBeNull();
  });
});

describe('absItemToBookGroup via importLibrary (CR-3 + M-4/L-14)', () => {
  it('gives every file a stable id and an empty changes object', async () => {
    absApi.mockResolvedValueOnce({
      results: [{
        id: 'item-1',
        media: {
          metadata: { title: 'Book One' },
          audioFiles: [
            { metadata: { path: '/a/1.m4b', filename: '1.m4b' }, duration: 100 },
            { metadata: { path: '/a/2.m4b', filename: '2.m4b' }, duration: 200 },
          ],
        },
      }],
      total: 1,
    });

    const [group] = await importLibrary(config);

    expect(group.files).toHaveLength(2);
    expect(group.files[0].id).toBe('item-1-f0');
    expect(group.files[1].id).toBe('item-1-f1');
    expect(group.files[0].changes).toEqual({});
    expect(group.files[1].changes).toEqual({});
  });

  it('sets both published_year and year from a 4-digit tagDate', async () => {
    absApi.mockResolvedValueOnce({
      results: [{
        id: 'item-2',
        media: {
          metadata: { title: 'Book Two' },
          audioFiles: [{ metaTags: { tagDate: '2015-03-01' } }],
        },
      }],
      total: 1,
    });

    const [group] = await importLibrary(config);
    expect(group.metadata.published_year).toBe('2015');
    expect(group.metadata.year).toBe('2015');
  });

  it('does not fabricate a year when tagDate is unparseable', async () => {
    absApi.mockResolvedValueOnce({
      results: [{
        id: 'item-3',
        media: {
          metadata: { title: 'Book Three' },
          audioFiles: [{ metaTags: { tagDate: 'garbage-not-a-date' } }],
        },
      }],
      total: 1,
    });

    const [group] = await importLibrary(config);
    expect(group.metadata.published_year).toBeNull();
    expect(group.metadata.year).toBeNull();
  });
});
