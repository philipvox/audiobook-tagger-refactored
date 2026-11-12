// cancel.js - the one cancel token for long-running operations (audit H-7, M-6).
//
// The progress bar's Cancel calls requestCancel(). Import and push loops check
// isCancelled() between items; the chunked Enrich actions check it between
// chunks. Work already done stays done: a cancel only stops what has not
// started. Every operation calls resetCancel() when it starts, so a stale
// cancel from an earlier run never stops the next one.

export const cancelToken = { cancelled: false };

export function requestCancel() {
  cancelToken.cancelled = true;
}

export function resetCancel() {
  cancelToken.cancelled = false;
}

export function isCancelled() {
  return cancelToken.cancelled === true;
}
