// errorDetail.js — structured per-book error shape surfaced to the UI.
// Attach an `errorDetail` field to any AI-call handler result so the scanner
// can render an inline pill (red for success:false, amber for success:true).

export const ERROR_STAGES = Object.freeze([
  'resolve',            // resolve_metadata_batch / resolve_title
  'classify',           // classify_batch (classification step)
  'dna',                // classify_batch DNA sub-step, generate_book_dna_batch
  'description',        // process_descriptions_batch / fix_descriptions_with_gpt
  'fix-author',         // fix_authors_batch
  'fix-year',           // fix_years_batch
  'gather-audnexus',    // gather_external_data lookupByAsin
  'gather-openlibrary', // gather_external_data lookupByTitle
  'lookup-asin',        // MetadataPanel Audible lookup
  'lookup-isbn',        // MetadataPanel OpenLibrary lookup
]);

export const ERROR_KINDS = Object.freeze([
  'network',        // fetch threw (CORS, DNS, offline, abort/timeout)
  'http',           // response.ok === false
  'parse',          // JSON.parse / parseAIJson failed on a non-empty body
  'empty-response', // AI returned 200 + empty/nullish content
  'empty-content',  // AI returned structured JSON but all expected fields null/missing
  'schema',         // AI returned content that doesn't match the expected schema
]);

// Suggested render severity per kind. Callers pass severity to ErrorPill
// explicitly — this is the convention so the batch-summary toast (commit 11)
// and the scanner pill agree on red vs amber without needing to re-infer.
//   WARNING (amber): empty-response, empty-content
//     The call succeeded at the transport + parse level; the model just
//     didn't produce usable data. Book is still usable; user may want a
//     different model or more signal.
//   FAILURE (red):   network, http, parse, schema
//     Something broke in the pipeline. The book's data may be stale or
//     missing. User action (retry, fix config, switch provider) likely
//     required.

const MAX_PREVIEW_CHARS = 500;

function truncate(s) {
  if (typeof s !== 'string') return undefined;
  if (s.length <= MAX_PREVIEW_CHARS) return s;
  return s.slice(0, MAX_PREVIEW_CHARS) + '...[truncated]';
}

export function makeErrorDetail({ stage, kind, message, responsePreview, statusCode, url }) {
  if (!ERROR_STAGES.includes(stage)) {
    throw new Error(`makeErrorDetail: unknown stage "${stage}". Known: ${ERROR_STAGES.join(', ')}`);
  }
  if (!ERROR_KINDS.includes(kind)) {
    throw new Error(`makeErrorDetail: unknown kind "${kind}". Known: ${ERROR_KINDS.join(', ')}`);
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('makeErrorDetail: message is required');
  }
  const detail = { stage, kind, message: message.trim() };
  const preview = truncate(responsePreview);
  if (preview) detail.responsePreview = preview;
  if (Number.isInteger(statusCode)) detail.statusCode = statusCode;
  if (typeof url === 'string' && url) detail.url = url;
  return detail;
}

// Derive a short, one-line errorDetail from a caught exception. Falls back to
// kind='network' if we can't tell — caller can override by passing kind.
export function errorDetailFromException(err, { stage, kind, url, responsePreview } = {}) {
  const msg = err?.message || String(err);
  let resolvedKind = kind;
  if (!resolvedKind) {
    if (/HTTP \d|status \d|error \d{3}/i.test(msg)) resolvedKind = 'http';
    else if (/parse|JSON|unexpected token/i.test(msg)) resolvedKind = 'parse';
    else resolvedKind = 'network';
  }
  return makeErrorDetail({
    stage,
    kind: resolvedKind,
    message: msg,
    responsePreview,
    url,
  });
}
