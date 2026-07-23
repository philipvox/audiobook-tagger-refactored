import { describe, it, expect } from 'vitest';
import { applyMetadataToGroup, readFileField } from './applyMetadata';

const mkGroup = (metadata, fileCount = 1, extra = {}) => ({
  id: 'g1',
  metadata,
  files: Array.from({ length: fileCount }, (_, i) => ({
    id: `f${i}`,
    filename: `file${i}.m4b`,
    path: `/books/file${i}.m4b`,
    changes: {},
  })),
  ...extra,
});

describe('applyMetadataToGroup (write-path bridge)', () => {
  it('merges updates into metadata and returns a new group (no mutation)', () => {
    const group = mkGroup({ title: 'Old', author: 'A' });
    const next = applyMetadataToGroup(group, { author: 'B' }, ['author']);
    expect(next.metadata.author).toBe('B');
    expect(next.metadata.title).toBe('Old');
    // original untouched
    expect(group.metadata.author).toBe('A');
    expect(group.files[0].changes).toEqual({});
  });

  it('first stamp uses old = prior metadata value on every file', () => {
    const group = mkGroup({ author: 'Old Author' }, 3);
    const next = applyMetadataToGroup(group, { author: 'New Author' }, ['author']);
    for (const f of next.files) {
      expect(f.changes.author).toEqual({ old: 'Old Author', new: 'New Author' });
      expect(f.status).toBe('changed');
    }
  });

  it('second stamp keeps the ORIGINAL old and only updates new', () => {
    const group = mkGroup({ author: 'Original' });
    const once = applyMetadataToGroup(group, { author: 'Second' }, ['author']);
    // metadata is now 'Second'; a further enrichment must not lose 'Original'.
    const twice = applyMetadataToGroup(once, { author: 'Third' }, ['author']);
    expect(twice.files[0].changes.author).toEqual({ old: 'Original', new: 'Third' });
  });

  it('joins genres array into a comma-separated genre file change', () => {
    const group = mkGroup({ genres: ['Fantasy', 'Adventure'] });
    const next = applyMetadataToGroup(
      group,
      { genres: ['Sci-Fi', 'Space Opera'] },
      ['genre']
    );
    expect(next.files[0].changes.genre).toEqual({
      old: 'Fantasy, Adventure',
      new: 'Sci-Fi, Space Opera',
    });
    // group.changedFields uses metadata vocabulary: genres, not genre.
    expect(next.changedFields).toContain('genres');
    expect(next.changedFields).not.toContain('genre');
  });

  it('stamps a cleared field with old set and new empty', () => {
    const group = mkGroup({ subtitle: 'A Novel' });
    const next = applyMetadataToGroup(group, { subtitle: '' }, ['subtitle']);
    expect(next.files[0].changes.subtitle).toEqual({ old: 'A Novel', new: '' });
  });

  it('formats narrator with the "Narrated by" prefix and avoids double-prefixing', () => {
    const group = mkGroup({ narrator: 'Old Reader' });
    const next = applyMetadataToGroup(group, { narrator: 'Jim Dale' }, ['narrator']);
    expect(next.files[0].changes.narrator).toEqual({
      old: 'Narrated by Old Reader',
      new: 'Narrated by Jim Dale',
    });
    const already = mkGroup({ narrator: 'Narrated by X' });
    const n2 = applyMetadataToGroup(already, { narrator: 'Narrated by Y' }, ['narrator']);
    expect(n2.files[0].changes.narrator.new).toBe('Narrated by Y');
  });

  it('preserves unrelated staged changes and unions changedFields', () => {
    const group = mkGroup({ title: 'T', author: 'A' });
    const first = applyMetadataToGroup(group, { title: 'T2' }, ['title']);
    const second = applyMetadataToGroup(first, { author: 'A2' }, ['author']);
    expect(second.files[0].changes.title).toEqual({ old: 'T', new: 'T2' });
    expect(second.files[0].changes.author).toEqual({ old: 'A', new: 'A2' });
    expect(second.changedFields).toEqual(expect.arrayContaining(['title', 'author']));
  });

  it('total_changes reflects the per-book changed-field count, not passes', () => {
    const group = mkGroup({ title: 'T', author: 'A' }, 5);
    const first = applyMetadataToGroup(group, { title: 'T2' }, ['title']);
    expect(first.total_changes).toBe(1);
    const second = applyMetadataToGroup(first, { author: 'A2' }, ['author']);
    expect(second.total_changes).toBe(2);
  });

  it('reads year from published_year when year is absent', () => {
    const group = mkGroup({ published_year: '1999' });
    const next = applyMetadataToGroup(group, { year: '2001' }, ['year']);
    expect(next.files[0].changes.year).toEqual({ old: '1999', new: '2001' });
  });

  it('ABS import (no files) still lights up via changedFields fallback', () => {
    const group = { id: 'abs1', metadata: { author: 'A' }, files: [] };
    const next = applyMetadataToGroup(group, { author: 'B' }, ['author']);
    expect(next.files).toEqual([]);
    expect(next.changedFields).toContain('author');
    expect(next.total_changes).toBe(1);
  });

  it('guards files that have no changes object', () => {
    const group = { id: 'g', metadata: { title: 'X' }, files: [{ id: 'f0', path: '/x' }] };
    const next = applyMetadataToGroup(group, { title: 'Y' }, ['title']);
    expect(next.files[0].changes.title).toEqual({ old: 'X', new: 'Y' });
  });
});

describe('readFileField', () => {
  it('falls back to raw string for unmapped fields', () => {
    expect(readFileField({ custom: 42 }, 'custom')).toBe('42');
    expect(readFileField({}, 'title')).toBe('');
  });
});
