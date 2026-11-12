// groupWarnings - warnings that come from a book's state, not from the last
// action run on it.
//
// `group.lastError` holds one message and every Enrich stage may replace it,
// so a warning that must stay visible for as long as the state lasts (D-6: a
// series that could not be read, which push will never send) is derived from
// the state when the list renders. A standing warning is not repeated while
// lastError already says the same thing.

import { UNRESOLVED_SERIES_IMPORT_MESSAGE } from './absPayload.js';

/** The standing warnings to show beside `group.lastError`, as errorDetails. */
export function standingWarnings(group) {
  if (!group || typeof group !== 'object') return [];
  const out = [];
  const last = group.lastError;
  if (group.metadata?.series_unresolved === true && last?.kind !== 'series') {
    out.push({ stage: 'import', kind: 'series', severity: 'warn', message: UNRESOLVED_SERIES_IMPORT_MESSAGE });
  }
  return out;
}
