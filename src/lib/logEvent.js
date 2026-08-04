// logEvent.js — one-line writes to the persistent operation log (#58).
//
// The point of the log is post-mortem: after a crash or a forced close during
// a long run, the user (or a bug report) needs to see which batch operations
// ran, how they ended, and which books failed. Every call is fire-and-forget:
// a logging failure must never break, delay, or fail the operation being
// logged, so nothing here awaits or rethrows.
//
// Tauri-only. The browser build has no writable log file, so logEvent is a
// silent no-op there rather than filling the console.

import { isTauri } from './platform.js';

const MAX_DETAIL_CHARS = 1000;

// api.js is imported lazily, and the import promise is cached so a burst of
// log calls shares one module resolution instead of racing several.
let backendPromise = null;

function backend() {
  if (!backendPromise) {
    backendPromise = import('../api').then((m) => m.callBackend);
  }
  return backendPromise;
}

/**
 * Render one log line: `[category] message | {"compact":"detail"}`.
 * Pure, so the format is testable without touching the backend.
 */
export function formatLogLine(category, message, detail) {
  const cat = String(category ?? '').trim() || 'app';
  const msg = String(message ?? '').trim();
  let line = `[${cat}] ${msg}`;

  if (detail !== undefined && detail !== null) {
    let json;
    try {
      json = JSON.stringify(detail);
    } catch {
      json = '"<unserializable detail>"';
    }
    if (json !== undefined && json !== '{}' && json !== '[]') {
      if (json.length > MAX_DETAIL_CHARS) {
        json = `${json.slice(0, MAX_DETAIL_CHARS)}...[truncated]`;
      }
      line += ` | ${json}`;
    }
  }

  // The Rust side flattens newlines too, but doing it here keeps the pure
  // helper's output identical to what lands on disk.
  return line.replace(/[\r\n]+/g, ' ');
}

/**
 * Append one line to the persistent log. Fire-and-forget.
 */
export function logEvent(category, message, detail) {
  if (!isTauri()) return;
  const line = formatLogLine(category, message, detail);
  backend()
    .then((callBackend) => callBackend('append_log', { line }))
    .catch(() => {
      // Deliberately silent: a failed log write must not surface as an app error.
    });
}

/**
 * Log the start of a batch operation.
 */
export function logBatchStart(op, books) {
  logEvent('batch', `${op} start`, { books });
}

/**
 * Log the end of a batch operation plus one line per book that came back with
 * an errorDetail, so the per-book failures survive the toast that summarized
 * them. `results` is the handler's own fresh per-book array
 * ({ id, errorDetail?, error? }), the same one batchToast scrolls through.
 */
export function logBatchEnd(op, counts, results) {
  logEvent('batch', `${op} complete`, counts);
  if (!Array.isArray(results)) return;
  for (const r of results) {
    if (!r?.errorDetail) continue;
    logEvent('book-error', `${op} failed for book ${r.id ?? 'unknown'}`, r.errorDetail);
  }
}
