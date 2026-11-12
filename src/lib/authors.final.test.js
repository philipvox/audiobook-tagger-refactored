// Final review fix D-5: a comma in an author value that came from ABS is ABS's
// author separator, so "Homer, Virgil" is two authors. "Last, First" is
// inverted only for a locally scanned book's tag.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanAuthorName, splitAuthors } from './normalize.js';
import { buildAbsPayload, snapshotAbsMetadata } from './absPayload.js';
import { applyMetadataToGroup } from './applyMetadata.js';

vi.mock('./proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAI: vi.fn(), parseAIJson: vi.fn((s) => JSON.parse(s)) };
});

const { callBackend } = await import('../api.js');
const { callAI, parseAIJson } = await import('./proxy');

const mk = (meta) => {
  const metadata = { title: 'T', author: 'A B', narrator: null, genres: [], tags: [], all_series: [], ...meta };
  return { id: 'g1', abs_id: 'g1', source: 'abs', metadata, abs_original: snapshotAbsMetadata(metadata), files: [] };
};

describe('cleanAuthorName / splitAuthors with ABS values', () => {
  const abs = { commaSeparatesAuthors: true };

  it('never inverts or merges two single-name co-authors', () => {
    expect(cleanAuthorName('Homer, Virgil', abs)).toBe('Homer, Virgil');
    expect(splitAuthors('Homer, Virgil', abs)).toEqual(['Homer', 'Virgil']);
    expect(cleanAuthorName('Plato, Aristotle', abs)).toBe('Plato, Aristotle');
    expect(splitAuthors('Madonna, Cher', abs)).toEqual(['Madonna', 'Cher']);
  });

  it('still keeps a name suffix with its name', () => {
    expect(splitAuthors('Martin Luther King, Jr.', abs)).toEqual(['Martin Luther King, Jr.']);
    expect(cleanAuthorName('Martin Luther King, Jr.', abs)).toBe('Martin Luther King Jr.');
  });

  it('a locally scanned tag still inverts "Last, First"', () => {
    expect(cleanAuthorName('King, Stephen')).toBe('Stephen King');
    expect(splitAuthors('King, Stephen')).toEqual(['Stephen King']);
  });
});

describe('push of an ABS author edit', () => {
  it('"Homer, Virgil" is sent as two authors', () => {
    const g = mk({ author: 'Homer' });
    const e = applyMetadataToGroup(g, { author: 'Homer, Virgil' }, ['author']);
    expect(buildAbsPayload(e.metadata, e.abs_original, {})).toEqual({
      metadata: { authors: [{ id: 'new-1', name: 'Homer' }, { id: 'new-2', name: 'Virgil' }] },
    });
  });

  it('ABS narrators are split on the comma too', () => {
    const e = applyMetadataToGroup(mk({ author: 'X' }), { narrator: 'Kate Reading, Michael Kramer' }, ['narrator']);
    expect(buildAbsPayload(e.metadata, e.abs_original, {}).metadata.narrators).toEqual(['Kate Reading', 'Michael Kramer']);
  });
});

describe('fix_authors_batch takes the source from the book', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({ openai_api_key: 'sk-fake', ai_model: 'gpt-5-nano' }));
    vi.resetAllMocks();
    parseAIJson.mockImplementation((s) => JSON.parse(s));
  });

  it('leaves an ABS "Homer, Virgil" alone', async () => {
    const res = await callBackend('fix_authors_batch', { books: [{ id: 'b1', title: 'T', current_author: 'Homer, Virgil', source: 'abs' }] });
    expect(res.results[0]).toMatchObject({ author: 'Homer, Virgil', fixed: false });
  });

  it('a book with no source is not inverted either (unknown source changes nothing)', async () => {
    const res = await callBackend('fix_authors_batch', { books: [{ id: 'b1', title: 'T', current_author: 'Homer, Virgil' }] });
    expect(res.results[0]).toMatchObject({ author: 'Homer, Virgil', fixed: false });
  });

  it('inverts a local "King, Stephen"', async () => {
    const res = await callBackend('fix_authors_batch', { books: [{ id: 'b1', title: 'T', current_author: 'King, Stephen', source: 'local' }] });
    expect(res.results[0]).toMatchObject({ author: 'Stephen King', fixed: true });
  });

  it('an AI answer "Homer, Virgil" (comma-separated co-authors, as the prompt asks) is two authors', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ author: 'Homer, Virgil', confidence: 90 }));
    const res = await callBackend('fix_authors_batch', { books: [{ id: 'b1', title: 'T', current_author: 'Unknown', source: 'local' }] });
    expect(res.results[0]).toMatchObject({ author: 'Homer, Virgil', fixed: true });
  });
});
