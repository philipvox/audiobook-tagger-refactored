// applyValidationFixes - one pure applier for the fixes the validation scan,
// author analysis, Batch Fix and the per-book "Fix" button apply (W-8).
//
// These used to edit group.metadata only and bump total_changes, so a later
// Write Tags never saw them. They now stamp file.changes through
// applyMetadataToGroup like every other applier.

import { applyMetadataToGroup, readFileField, setYear } from './applyMetadata.js';

// Validation field name -> file.changes (tag vocabulary) field name.
const FILE_FIELD = { genres: 'genre', published_year: 'year' };

/** Metadata after one validation fix of `field` to `value`. */
export function fixedMetadata(metadata, field, value) {
  const m = { ...(metadata || {}) };
  switch (field) {
    case 'author':
      m.author = value;
      m.authors = [value, ...(m.authors || []).slice(1)];
      break;
    case 'series':
      m.series = value;
      m.all_series = m.all_series?.length > 0
        ? [{ ...m.all_series[0], name: value }, ...m.all_series.slice(1)]
        : [{ name: value, sequence: m.sequence }];
      break;
    case 'sequence':
      m.sequence = value;
      if (m.all_series?.length > 0) {
        m.all_series = [{ ...m.all_series[0], sequence: value }, ...m.all_series.slice(1)];
      }
      break;
    case 'narrator':
      m.narrator = value;
      m.narrators = [value, ...(m.narrators || []).slice(1)];
      break;
    case 'genres':
      if (typeof value === 'string') m.genres = value.split(',').map((g) => g.trim()).filter(Boolean);
      else if (Array.isArray(value)) m.genres = value;
      break;
    case 'year':
    case 'published_year':
      return setYear(m, value);
    case 'title':
    case 'description':
      m[field] = value;
      break;
    default:
      // Any other field the book already has is assigned directly.
      if (field in m) m[field] = value;
  }
  return m;
}

/**
 * Apply `fixes` ([{ field, value }]) to a group, in order. `extra` is merged
 * into the metadata afterwards and is not stamped (e.g. `sources`). Only
 * fields whose file-facing value actually changed are stamped.
 */
export function applyFieldFixes(group, fixes, extra = {}) {
  const prev = group.metadata || {};
  let next = prev;
  for (const fix of fixes || []) next = fixedMetadata(next, fix.field, fix.value);
  next = { ...next, ...extra };
  const fields = [...new Set((fixes || []).map((f) => FILE_FIELD[f.field] || f.field))]
    .filter((f) => readFileField(next, f) !== readFileField(prev, f));
  return applyMetadataToGroup(group, next, fields);
}
