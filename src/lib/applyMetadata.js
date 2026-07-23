// applyMetadata — the pure write-path bridge for enrichment + inline edits.
//
// The core product gap this fixes: enrichment results and inline edits only ever
// updated `group.metadata`, never `file.changes`. Write Tags builds its payload
// from `file.changes`, so AI fixes were silently dropped and never written to the
// local files. `applyMetadataToGroup` merges the new metadata AND stamps the
// corresponding `file.changes` entries on every file of the group, so a later
// Write Tags actually embeds the enrichment output.
//
// Two vocabularies are in play and MUST stay distinct:
//   - `file.changes` keys use the TAG vocabulary the Rust write path embeds
//     (see commands/tags.rs build_metadata_from_changes): title, author,
//     narrator ("Narrated by X"), genre (comma-joined), series, sequence,
//     subtitle, year, publisher, description, isbn, language.
//   - `group.changedFields` uses the METADATA vocabulary the UI highlights and
//     ABS push keys off (MetadataPanel isChanged / BookList pills): genres (not
//     genre), tags, narrator (bare), etc.
// Only `genre`/`genres` actually differ between the two; FILE_TO_META_FIELD maps
// it. Fields the write path can't embed (tags, and ABS-only themes/tropes/dna)
// are still safe to stamp — the backend simply ignores change keys it doesn't
// read.

// file.changes field name -> group.changedFields (metadata) field name.
const FILE_TO_META_FIELD = { genre: 'genres' };

const str = (v) => (v == null ? '' : String(v));

// Derive a file-facing (tag-compatible) STRING value from a metadata object.
// Used for both the `old` (prior metadata) and `new` (merged metadata) sides of
// a stamped change so the two are always compared in the same vocabulary.
const READERS = {
  title: (m) => str(m.title),
  subtitle: (m) => str(m.subtitle),
  author: (m) => str(m.author),
  narrator: (m) => {
    const n = str(m.narrator);
    if (!n) return '';
    return n.startsWith('Narrated by ') ? n : `Narrated by ${n}`;
  },
  genre: (m) => (Array.isArray(m.genres) ? m.genres.join(', ') : str(m.genres)),
  tags: (m) => (Array.isArray(m.tags) ? m.tags.join(', ') : str(m.tags)),
  series: (m) => str(m.series),
  sequence: (m) => str(m.sequence),
  // Fix Authors reads published_year||year; mirror that here so old/new agree.
  year: (m) => str(m.year != null && m.year !== '' ? m.year : m.published_year),
  publisher: (m) => str(m.publisher),
  description: (m) => str(m.description),
  isbn: (m) => str(m.isbn),
  asin: (m) => str(m.asin),
  language: (m) => str(m.language),
  age_rating: (m) => str(m.age_rating),
  abridged: (m) => str(m.abridged),
  runtime: (m) => str(m.runtime),
};

export function readFileField(metadata, field) {
  const reader = READERS[field];
  return reader ? reader(metadata || {}) : str((metadata || {})[field]);
}

// applyMetadataToGroup(group, updates, changedFileFields)
//
//   group             a BookGroup ({ metadata, files, changedFields, ... }).
//   updates           partial metadata to shallow-merge into group.metadata.
//   changedFileFields array of file.changes (tag-vocabulary) field names to
//                     stamp on every file of the group.
//
// Returns a NEW group with:
//   (a) metadata = { ...metadata, ...updates }
//   (b) for each changed field, file.changes[field] = { old, new } stamped on
//       EVERY file. `old` is the group.metadata value BEFORE this merge; an
//       already-staged `old` for the same field is preserved (keep the ORIGINAL
//       old, only refresh `new`) so repeated enrichment never loses the true
//       starting value.
//   (c) changedFields (metadata vocabulary, union with prior) and total_changes
//       (per-book changed-field count) refreshed.
//
// Block-specific concerns (lastError, all_series, pub_tag filtering,
// mergeClassifyTags, force-reset) are the CALLER's job: compute them, build
// `updates`, then spread the extras onto the returned group after the call.
export function applyMetadataToGroup(group, updates = {}, changedFileFields = []) {
  const prevMetadata = group.metadata || {};
  const newMetadata = { ...prevMetadata, ...updates };

  // Precompute the old/new pair once per field (same for every file in group).
  const stamps = {};
  for (const field of changedFileFields) {
    stamps[field] = {
      old: readFileField(prevMetadata, field),
      new: readFileField(newMetadata, field),
    };
  }

  const files = (group.files || []).map((file) => {
    const changes = { ...(file.changes || {}) };
    for (const field of changedFileFields) {
      const existing = changes[field];
      changes[field] = {
        // Never clobber an original staged `old`: keep the earliest one.
        old: existing && 'old' in existing ? existing.old : stamps[field].old,
        new: stamps[field].new,
      };
    }
    return {
      ...file,
      changes,
      status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged',
    };
  });

  const changedFields = new Set(group.changedFields || []);
  for (const field of changedFileFields) {
    changedFields.add(FILE_TO_META_FIELD[field] || field);
  }

  // total_changes = number of changed fields on a representative file (files in a
  // group share the same staged changes). ABS imports have no files, so fall back
  // to the changed-field count so the "edited" badge still lights up.
  const representative = files.find((f) => Object.keys(f.changes || {}).length > 0);
  const total_changes = representative
    ? Object.keys(representative.changes).length
    : (files.length > 0 ? 0 : changedFields.size);

  return {
    ...group,
    metadata: newMetadata,
    files,
    changedFields: [...changedFields],
    total_changes,
  };
}
