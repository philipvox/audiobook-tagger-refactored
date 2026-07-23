import { severityForKind } from './errorDetail';

// batchToast — pure helper that maps batch-operation counts to a toast
// payload (type, title, message). The caller supplies an optional action
// (for "Show details" scroll-to-first) since that closure needs ScannerPage
// state.

// Verb matches the operation's own UI language. V1 (all-success) keeps
// "Complete" suffix; V2/V3 (mixed) drop it — "Classification: 5 classified,
// 2 failed" reads cleaner than "Classification Complete: 5 classified, 2
// failed".
const OPS = Object.freeze({
  resolve:     { v1Title: 'Metadata Resolution Complete', v2v3Title: 'Metadata Resolution', verb: 'resolved' },
  classify:    { v1Title: 'Classification Complete',      v2v3Title: 'Classification',      verb: 'classified' },
  description: { v1Title: 'Description Processing Complete', v2v3Title: 'Description Processing', verb: 'processed' },
  authors:     { v1Title: 'Fix Authors Complete',         v2v3Title: 'Fix Authors',         verb: 'fixed' },
  years:       { v1Title: 'Fix Years Complete',           v2v3Title: 'Fix Years',           verb: 'fixed' },
});

// Returns null if nothing to report (zero succeeded AND zero skipped AND no
// errors). Returns { type: 'success'|'warning'|'error', title, message,
// hasWarnings, hasFailures } — caller adds the action for Show details.
export function summarizeBatch({ op, succeeded = 0, skipped = 0, warnings = 0, failed = 0 }) {
  const meta = OPS[op];
  if (!meta) throw new Error(`summarizeBatch: unknown op "${op}"`);

  if (succeeded === 0 && skipped === 0 && warnings === 0 && failed === 0) return null;

  // V1 — all clean.
  if (warnings === 0 && failed === 0) {
    const parts = [];
    if (succeeded > 0) parts.push(`${succeeded} ${meta.verb}`);
    if (skipped > 0) parts.push(`${skipped} already ok`);
    return {
      type: 'success',
      title: meta.v1Title,
      message: parts.join(', '),
      hasWarnings: false,
      hasFailures: false,
    };
  }

  // V2/V3 — mixed. Type is 'error' if any failed (red priority), else 'warning'.
  const type = failed > 0 ? 'error' : 'warning';
  const titleParts = [];
  if (succeeded > 0) titleParts.push(`${succeeded} ${meta.verb}`);
  if (failed > 0) titleParts.push(`${failed} failed`);
  if (warnings > 0) titleParts.push(`${warnings} warnings`);
  const title = `${meta.v2v3Title}: ${titleParts.join(', ')}`;
  const message = skipped > 0 ? `${skipped} already ok` : undefined;

  return {
    type,
    title,
    message,
    hasWarnings: warnings > 0,
    hasFailures: failed > 0,
  };
}

// Derive the render severity of a single per-book result. A hard failure
// (r.error set or r.success === false) is always 'error'; otherwise fall back
// to the errorDetail kind mapping. Returns null when the book carries no error
// signal at all.
function resultSeverity(r) {
  if (!r) return null;
  if (r.error || r.success === false) return 'error';
  if (r.errorDetail) return severityForKind(r.errorDetail.kind);
  return null;
}

// Scroll the first errored book into view, using the data-book-id attribute
// that BookList rows carry. Takes the handler's OWN fresh results array (the
// one it just received from the backend), not the component's `groups` state:
// the toast is created synchronously after an async setGroups that has not yet
// committed, so `groups` would be stale and miss the just-set lastError.
// `results` is an array of per-book objects shaped
// { id, errorDetail?, error?, success? }.
export function scrollToFirstErrorGroup(results, severity = 'any') {
  if (!Array.isArray(results)) return false;
  const match = results.find((r) => {
    const sev = resultSeverity(r);
    if (!sev) return false;
    if (severity === 'any') return true;
    return sev === severity;
  });
  if (!match || match.id == null) return false;
  if (typeof document === 'undefined') return false;
  const el = document.querySelector(`[data-book-id="${match.id}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
