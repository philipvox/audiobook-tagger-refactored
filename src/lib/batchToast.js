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
  titles:      { v1Title: 'Fix Titles Complete',          v2v3Title: 'Fix Titles',          verb: 'fixed' },
  series:      { v1Title: 'Fix Series Complete',          v2v3Title: 'Fix Series',          verb: 'fixed', skippedLabel: 'unchanged or skipped' },
  subtitles:   { v1Title: 'Fix Subtitles Complete',       v2v3Title: 'Fix Subtitles',       verb: 'fixed' },
  fix_descriptions: { v1Title: 'Fix Descriptions Complete', v2v3Title: 'Fix Descriptions', verb: 'fixed' },
  dna:         { v1Title: 'BookDNA Generated',            v2v3Title: 'DNA Generation',      verb: 'generated' },
  genres:      { v1Title: 'Genre Cleanup Complete',       v2v3Title: 'Genre Cleanup',       verb: 'cleaned' },
  age:         { v1Title: 'Age Lookup Complete',          v2v3Title: 'Age Lookup',          verb: 'rated' },
  audio_check: { v1Title: 'Audio Check Complete',         v2v3Title: 'Audio Check',         verb: 'updated', skippedLabel: 'nothing new' },
  tags:        { v1Title: 'AI Tags Complete',             v2v3Title: 'AI Tags',             verb: 'tagged', warningLabel: 'partly tagged' },
  isbn:        { v1Title: 'ISBN Lookup Complete',         v2v3Title: 'ISBN Lookup',         verb: 'found', skippedLabel: 'already had ISBN', warningLabel: 'not found' },
});

// Per-op wording for the skipped and warning counts.
const skippedText = (meta, n) => `${n} ${meta.skippedLabel || 'already ok'}`;
const warningText = (meta, n) => `${n} ${meta.warningLabel || 'warnings'}`;

// Returns null if nothing to report (zero succeeded AND zero skipped AND no
// errors). Returns { type: 'success'|'warning'|'error', title, message,
// hasWarnings, hasFailures } — caller adds the action for Show details.
//
// M-6: `cancelled` is the number of books a cancelled run never reached. When
// it is set the toast says how many were processed and that the rest were
// cancelled (what was already applied stays applied).
//
// `notProcessed` is how many books a run stopped early (repeated errors) left
// untouched; `errorMessage` is the first batch error, shown so the cause (a
// bad key, no provider) is in the toast and not only on the book pills.
export function summarizeBatch({ op, succeeded = 0, skipped = 0, warnings = 0, failed = 0, cancelled = 0, notProcessed = 0, errorMessage = null }) {
  const summary = summarizeCounts({ op, succeeded, skipped, warnings, failed, cancelled });
  const extra = [];
  if (notProcessed > 0) extra.push(`Stopped after repeated errors; ${notProcessed} not processed.`);
  if (errorMessage) extra.push(`First error: ${errorMessage}`);
  if (extra.length === 0) return summary;
  const meta = OPS[op];
  const base = summary || {
    type: 'error', title: `${meta.v2v3Title} stopped`, message: undefined, hasWarnings: false, hasFailures: true,
  };
  const type = base.type === 'success' ? 'error' : base.type;
  const head = base.message ? (/[.!?]$/.test(base.message) ? base.message : `${base.message}.`) : '';
  return { ...base, type, message: [head, ...extra].filter(Boolean).join(' ') };
}

function summarizeCounts({ op, succeeded, skipped, warnings, failed, cancelled }) {
  const meta = OPS[op];
  if (!meta) throw new Error(`summarizeBatch: unknown op "${op}"`);

  if (cancelled > 0) {
    const processed = succeeded + skipped + warnings + failed;
    const parts = [];
    if (succeeded > 0) parts.push(`${succeeded} ${meta.verb}`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (warnings > 0) parts.push(warningText(meta, warnings));
    if (skipped > 0) parts.push(skippedText(meta, skipped));
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return {
      type: failed > 0 ? 'error' : 'warning',
      title: `${meta.v2v3Title} cancelled`,
      message: `${processed} of ${processed + cancelled} processed${detail}; the remaining ${cancelled} ${cancelled === 1 ? 'was' : 'were'} cancelled.`,
      hasWarnings: warnings > 0,
      hasFailures: failed > 0,
    };
  }

  if (succeeded === 0 && skipped === 0 && warnings === 0 && failed === 0) return null;

  // V1 — all clean.
  if (warnings === 0 && failed === 0) {
    const parts = [];
    if (succeeded > 0) parts.push(`${succeeded} ${meta.verb}`);
    if (skipped > 0) parts.push(skippedText(meta, skipped));
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
  if (warnings > 0) titleParts.push(warningText(meta, warnings));
  const title = `${meta.v2v3Title}: ${titleParts.join(', ')}`;
  const message = skipped > 0 ? skippedText(meta, skipped) : undefined;

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
