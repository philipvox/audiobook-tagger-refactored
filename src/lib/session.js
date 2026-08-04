// session.js — crash-resilient working-state snapshots (#58).
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

export const SESSION_STORAGE_KEY = 'audiobook-tagger.session';

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
 * Read the saved snapshot back, or null when there is nothing restorable.
 */
export async function loadSession() {
  let json = null;
  if (isTauri()) {
    try {
      const callBackend = await backend();
      json = await callBackend('load_session');
    } catch (e) {
      console.warn('Could not read the saved session:', e);
      return null;
    }
  } else {
    try {
      if (typeof localStorage === 'undefined') return null;
      json = localStorage.getItem(SESSION_STORAGE_KEY);
    } catch (e) {
      console.warn('Could not read the saved session:', e);
      return null;
    }
  }
  // callBackend returns a { _stub: true } object for commands that are not
  // wired in the browser build; parseSession rejects anything that is not a
  // string, so that path lands on null.
  return parseSession(typeof json === 'string' ? json : null);
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
