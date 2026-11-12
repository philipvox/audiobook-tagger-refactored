// bulkEditUpdates - pure computation of the `updates` object BulkEditModal emits.
//
// H1: precedence per field is clear > non-empty-and-changed > skip. A checked
// field left at its prefilled common value (M10) is a no-op and must NOT
// manufacture a spurious change. An explicit "clear" emits an intentional
// empty value (null, or [] for genres) so downstream can wipe the tag.

const SIMPLE_FIELDS = ['author', 'narrator', 'publisher', 'year', 'language', 'age_rating', 'content_rating'];

export function computeBulkUpdates({ fieldsToEdit = {}, clearFields = {}, values = {}, commonValues = {} }) {
  const updates = {};

  const emit = (field) => {
    if (!fieldsToEdit[field]) return;
    if (clearFields[field]) { updates[field] = null; return; }
    const v = (values[field] ?? '').trim();
    if (!v) return;                            // blank + not clearing => skip
    if (v === (commonValues[field] ?? '')) return; // untouched prefill => no-op
    updates[field] = v;
  };
  SIMPLE_FIELDS.forEach(emit);

  if (fieldsToEdit.genres) {
    if (clearFields.genres) {
      updates.genres = [];
    } else {
      const parsed = (values.genres ?? '').split(',').map(g => g.trim()).filter(Boolean).slice(0, 3);
      if (parsed.length > 0 && parsed.join(', ') !== (commonValues.genres ?? '')) {
        updates.genres = parsed;
      }
    }
  }

  // Series name and sequence are independent: a name with a blank number updates
  // the name only (and vice versa).
  if (fieldsToEdit.series) {
    if (clearFields.series) {
      updates.series = null;
      updates.sequence = null;
    } else {
      const name = (values.series ?? '').trim();
      const seq = (values.sequence ?? '').trim();
      if (name && name !== (commonValues.series ?? '')) updates.series = name;
      if (seq && seq !== (commonValues.sequence ?? '')) updates.sequence = seq;
    }
  }

  return updates;
}

// The file.changes a bulk edit stages on one file (handleBulkSave). An update
// KEY being present drives the change (a present null is an intentional clear
// and stamps an empty new value); absent keys are left untouched, as are
// unrelated staged changes. W-8: a file with no `changes` object is fine.
export function bulkFileChanges(file, updates) {
  const staged = file?.changes || {};
  const changes = { ...staged };
  const stamp = (field, next) => {
    const old = staged[field]?.old || '';
    if (old !== next) changes[field] = { old, new: next };
  };
  if ('author' in updates) stamp('author', updates.author || '');
  if ('narrator' in updates) stamp('narrator', updates.narrator ? `Narrated by ${updates.narrator}` : '');
  if ('genres' in updates) stamp('genre', (updates.genres || []).join(', '));
  if ('series' in updates) changes.series = { old: '', new: updates.series || '' };
  if ('sequence' in updates) changes.sequence = { old: '', new: updates.sequence || '' };
  if ('year' in updates) changes.year = { old: staged.year?.old || '', new: updates.year || '' };
  if ('publisher' in updates) changes.publisher = { old: '', new: updates.publisher || '' };
  return changes;
}
