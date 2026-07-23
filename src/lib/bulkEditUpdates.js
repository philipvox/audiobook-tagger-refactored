// bulkEditUpdates — pure computation of the `updates` object BulkEditModal emits.
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
