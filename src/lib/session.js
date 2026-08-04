// session.js: crash-resilient working-state snapshots (#58).
//
// The scanner holds hours of enrichment work in memory. Before this, a crash
// or an accidental window close threw all of it away. The pure helpers here
// build and read back a snapshot; the IO functions persist it through the Rust
// session commands in Tauri, or best-effort localStorage in the browser build.
//
// Data-preservation rules:
//   * nothing here ever discards a snapshot on its own. clearSession() runs
//     only from an explicit user action (Discard) or an explicit workspace
//     reset that left the workspace empty.
//   * a save failure (quota, disk, oversized payload) is reported to the
//     caller as { saved: false, error } and never thrown at the UI.

import { isTauri } from './platform.js';

export const SESSION_VERSION = 1;

// Debounce window for autosave. Long enough that a burst of per-book updates
// during a batch run collapses into one write, short enough that a crash
// loses at most a couple of seconds of edits. A 2,700-book snapshot measures
// about 8MB and serializes in ~15ms, so the write itself is not the cost.
export const AUTOSAVE_DEBOUNCE_MS = 2500;

// Upper bound on how long the working state can go unsaved while it is still
// changing. A pure debounce can starve: a long batch run commits a chunk of
// results every couple of seconds, which would reset the timer over and over
// and never write, which is exactly the crash this feature exists to survive.
export const AUTOSAVE_MAX_WAIT_MS = 30000;

export const SESSION_STORAGE_KEY = 'audiobook-tagger.session';

// Second slot, mirroring the Rust session.prev.json. Holds a snapshot the user
// declined to restore, so autosave can resume into the primary slot without
// destroying it. Never auto-loaded: it is a manual-recovery artifact.
export const PREV_SESSION_STORAGE_KEY = 'audiobook-tagger.session.prev';

// How many autosaves must fail in a row before the user is told. One failure
// is usually transient (a locked file, a momentary permission issue) and not
// worth interrupting for; three in a row means the workspace is genuinely not
// being protected and the user needs to know before a crash proves it.
export const AUTOSAVE_FAILURE_WARN_THRESHOLD = 3;

/**
 * Fold one autosave outcome into the failure-tracking state.
 *
 * `state` is { consecutiveFailures, warned }. Returns the next state plus
 * `warn: true` exactly once per failure streak, so a browser build whose
 * snapshot exceeds the localStorage quota (and therefore fails on every single
 * save) warns once rather than on every debounce tick. A successful save
 * resets both, which re-arms the warning for a later streak.
 */
export function nextAutosaveFailureState(state, result) {
  const prev = { consecutiveFailures: 0, warned: false, ...(state || {}) };

  if (result?.saved) {
    return { consecutiveFailures: 0, warned: false, warn: false, reason: null };
  }

  const consecutiveFailures = prev.consecutiveFailures + 1;
  const warn = consecutiveFailures >= AUTOSAVE_FAILURE_WARN_THRESHOLD && !prev.warned;
  return {
    consecutiveFailures,
    warned: prev.warned || warn,
    warn,
    reason: result?.error || 'unknown error',
  };
}

/**
 * How long to wait before writing, given when the last write happened.
 * Normally the debounce window; shortened (to zero at the limit) so that a
 * continuously changing workspace is still written at least every
 * AUTOSAVE_MAX_WAIT_MS.
 */
export function autosaveDelay(lastSavedAt, now = Date.now()) {
  if (!Number.isFinite(lastSavedAt) || lastSavedAt <= 0) return AUTOSAVE_DEBOUNCE_MS;
  const since = now - lastSavedAt;
  if (since <= 0) return AUTOSAVE_DEBOUNCE_MS;
  if (since >= AUTOSAVE_MAX_WAIT_MS) return 0;
  return Math.min(AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS - since);
}

/**
 * Build the snapshot object that gets persisted. `groups` is the whole working
 * state; `libraryId` records which AudiobookShelf library it came from so the
 * restore prompt can be honest about what it is offering.
 */
export function makeSessionSnapshot({ groups, libraryId = null, now = Date.now() }) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  return {
    version: SESSION_VERSION,
    savedAt: now,
    libraryId: libraryId || null,
    bookCount: safeGroups.length,
    groups: safeGroups,
  };
}

/**
 * Autosave only when there is actually something to lose. An empty workspace
 * is never written over a saved session.
 */
export function shouldAutosave(groups) {
  return Array.isArray(groups) && groups.length > 0;
}

/**
 * Parse a stored snapshot back into a usable object. Returns null for anything
 * we cannot safely restore (bad JSON, wrong shape, no books) so the caller can
 * treat "nothing to restore" and "corrupt file" the same way rather than
 * showing the user a prompt that would restore garbage.
 */
export function parseSession(json) {
  if (typeof json !== 'string' || !json.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) return null;

  return {
    version: Number.isFinite(parsed.version) ? parsed.version : 0,
    savedAt: Number.isFinite(parsed.savedAt) ? parsed.savedAt : null,
    libraryId: typeof parsed.libraryId === 'string' ? parsed.libraryId : null,
    bookCount: parsed.groups.length,
    groups: parsed.groups,
  };
}

/**
 * Human phrasing for the restore prompt ("saved 5 minutes ago"). Returns
 * 'recently' when the timestamp is missing or unusable rather than inventing
 * a time.
 */
export function formatRelativeTime(savedAt, now = Date.now()) {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return 'recently';
  const seconds = Math.round((now - savedAt) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/**
 * The one-line summary the restore prompt shows.
 */
export function describeSession(session, now = Date.now()) {
  if (!session) return '';
  const n = session.bookCount ?? (session.groups?.length || 0);
  return `${n} book${n === 1 ? '' : 's'}, saved ${formatRelativeTime(session.savedAt, now)}`;
}

// ============================================================================
// Persistence
// ============================================================================

// api.js is imported lazily so the pure helpers above stay cheap to test and
// so this module never drags the whole backend surface into a browser bundle
// path that does not need it. The import promise is cached so overlapping
// calls share one module resolution instead of racing several.
let backendPromise = null;

function backend() {
  if (!backendPromise) {
    backendPromise = import('../api').then((m) => m.callBackend);
  }
  return backendPromise;
}

/**
 * Persist a snapshot. Never throws: returns { saved, error? } so the caller can
 * decide whether the failure is worth surfacing.
 */
export async function saveSession(snapshot) {
  let json;
  try {
    json = JSON.stringify(snapshot);
  } catch (e) {
    return { saved: false, error: `Could not serialize the session: ${e?.message || e}` };
  }

  if (isTauri()) {
    try {
      const callBackend = await backend();
      await callBackend('save_session', { json });
      return { saved: true };
    } catch (e) {
      console.warn('Session autosave failed:', e);
      return { saved: false, error: String(e?.message || e) };
    }
  }

  // Browser build: best effort. localStorage caps out around 5MB, so a large
  // library will hit a quota error. That is logged and reported, never thrown.
  try {
    if (typeof localStorage === 'undefined') return { saved: false, error: 'no storage' };
    localStorage.setItem(SESSION_STORAGE_KEY, json);
    return { saved: true };
  } catch (e) {
    console.warn('Session autosave skipped (browser storage):', e);
    return { saved: false, error: String(e?.message || e) };
  }
}

/**
 * Read the saved snapshot back.
 *
 * Returns { session, unreadable, error? }. `unreadable` distinguishes "a
 * snapshot is there but we could not read it" from "there is nothing saved":
 * the first must pause autosave (real work may be sitting in that file), the
 * second must not.
 */
export async function loadSession() {
  let json = null;

  if (isTauri()) {
    try {
      const callBackend = await backend();
      json = await callBackend('load_session');
    } catch (e) {
      console.warn('Could not read the saved session:', e);
      return { session: null, unreadable: true, error: String(e?.message || e) };
    }
  } else {
    try {
      if (typeof localStorage === 'undefined') return { session: null, unreadable: false };
      json = localStorage.getItem(SESSION_STORAGE_KEY);
    } catch (e) {
      console.warn('Could not read the saved session:', e);
      return { session: null, unreadable: true, error: String(e?.message || e) };
    }
  }

  // callBackend returns a { _stub: true } object for commands that are not
  // wired in the browser build; parseSession rejects anything that is not a
  // string, so that path lands on null.
  const session = parseSession(typeof json === 'string' ? json : null);

  // Content that is present but unparseable is corrupt, not absent. Same rule:
  // do not autosave over it until the user explicitly discards it.
  const corrupt = !session && typeof json === 'string' && json.trim().length > 0;

  return {
    session,
    unreadable: corrupt,
    ...(corrupt ? { error: 'the saved session file could not be parsed' } : {}),
  };
}

/**
 * Move the saved snapshot to the second slot instead of deleting it, freeing
 * the primary slot so autosave can resume. Used when the user answers the
 * restore prompt with "keep current books": their new work needs protecting,
 * and the declined session must not be destroyed to get it. Never throws.
 */
export async function preserveSession() {
  if (isTauri()) {
    try {
      const callBackend = await backend();
      await callBackend('preserve_session');
      return true;
    } catch (e) {
      console.warn('Could not preserve the saved session:', e);
      return false;
    }
  }
  try {
    if (typeof localStorage === 'undefined') return false;
    const current = localStorage.getItem(SESSION_STORAGE_KEY);
    if (current === null) return true; // nothing to preserve
    localStorage.setItem(PREV_SESSION_STORAGE_KEY, current);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return true;
  } catch (e) {
    console.warn('Could not preserve the saved session:', e);
    return false;
  }
}

/**
 * Delete the saved snapshot. Only ever called from an explicit user decision
 * or an explicit workspace reset. Never throws.
 */
export async function clearSession() {
  if (isTauri()) {
    try {
      const callBackend = await backend();
      await callBackend('clear_session');
      return true;
    } catch (e) {
      console.warn('Could not clear the saved session:', e);
      return false;
    }
  }
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return true;
  } catch (e) {
    console.warn('Could not clear the saved session:', e);
    return false;
  }
}
