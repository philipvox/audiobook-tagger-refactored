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

// Scroll the first group whose lastError matches the requested severity into
// view. Exported for reuse; uses the data-book-id attribute that BookList
// rows now carry.
export function scrollToFirstErrorGroup(groups, severity = 'any') {
  const match = groups.find((g) => {
    if (!g.lastError) return false;
    if (severity === 'any') return true;
    return g.lastError.severity === severity;
  });
  if (!match) return false;
  if (typeof document === 'undefined') return false;
  const el = document.querySelector(`[data-book-id="${match.id}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
