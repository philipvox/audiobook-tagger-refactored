// cancel.js - cancel tokens for long-running operations (audit H-7, M-6).
//
// Each operation takes its own token when it starts (startCancellable) and
// checks `token.cancelled` between items or chunks. A Cancel button calls
// requestCancel(token) for the operation it belongs to. Work already done
// stays done: a cancel only stops what has not started.
//
// Per-operation tokens mean starting a new operation can never clear a Cancel
// the user asked for on one that is still running, and a Cancel left over
// from an earlier run can never stop the next one (it gets a fresh token).

const active = new Set();

/** A fresh, not-cancelled token for one operation. */
export function startCancellable() {
  const token = { cancelled: false };
  active.add(token);
  return token;
}

/** The operation has settled; its token no longer needs tracking. */
export function finishCancellable(token) {
  if (token) active.delete(token);
}

/**
 * Cancel one operation. Without a token this does nothing: a missing token
 * must never turn one Cancel into "cancel everything" (that is cancelAll).
 */
export function requestCancel(token) {
  if (!token) return;
  token.cancelled = true;
  active.delete(token);
}

/** Cancel every operation still running. */
export function cancelAll() {
  for (const t of active) t.cancelled = true;
  active.clear();
}

/** How many operations hold a token that has not been finished (for tests). */
export function activeCancellableCount() {
  return active.size;
}

/** True once `token` was cancelled. A missing token is never cancelled. */
export function isCancelled(token) {
  return token?.cancelled === true;
}

/**
 * Wrap an operation so the token it took is finished when it ends, however
 * it ends (resolve or throw). `takeToken()` runs in the finally and returns
 * the token to finish, or null to keep it (e.g. a token shared with an
 * enclosing operation that is still running).
 */
export function finishAfter(fn, takeToken) {
  return async (...args) => {
    try {
      return await fn(...args);
    } finally {
      const token = takeToken();
      if (token) finishCancellable(token);
    }
  };
}
