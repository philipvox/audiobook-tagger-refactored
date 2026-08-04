// Tests for the session snapshot helpers (#58).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SESSION_VERSION,
  SESSION_STORAGE_KEY,
  PREV_SESSION_STORAGE_KEY,
  AUTOSAVE_FAILURE_WARN_THRESHOLD,
  nextAutosaveFailureState,
  preserveSession,
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  autosaveDelay,
  makeSessionSnapshot,
  shouldAutosave,
  parseSession,
  formatRelativeTime,
  describeSession,
  saveSession,
  loadSession,
  clearSession,
} from './session.js';

const groupsFixture = [
  { id: 'g1', metadata: { title: 'One' }, files: [{ id: 'g1-f0', path: '/a.m4b', changes: {} }] },
  { id: 'g2', metadata: { title: 'Two' }, files: [{ id: 'g2-f0', path: '/b.m4b', changes: {} }] },
];

describe('makeSessionSnapshot', () => {
  it('captures groups, library id, book count and a timestamp', () => {
    const snap = makeSessionSnapshot({ groups: groupsFixture, libraryId: 'lib-7', now: 1000 });
    expect(snap).toEqual({
      version: SESSION_VERSION,
      savedAt: 1000,
      libraryId: 'lib-7',
      bookCount: 2,
      groups: groupsFixture,
    });
  });

  it('normalizes a missing library id to null and a non-array groups to empty', () => {
    const snap = makeSessionSnapshot({ groups: undefined, now: 5 });
    expect(snap.libraryId).toBeNull();
    expect(snap.groups).toEqual([]);
    expect(snap.bookCount).toBe(0);
  });

  it('round-trips through parseSession', () => {
    const snap = makeSessionSnapshot({ groups: groupsFixture, libraryId: 'lib-7', now: 1000 });
    const parsed = parseSession(JSON.stringify(snap));
    expect(parsed.groups).toEqual(groupsFixture);
    expect(parsed.savedAt).toBe(1000);
    expect(parsed.libraryId).toBe('lib-7');
    expect(parsed.bookCount).toBe(2);
  });
});

describe('shouldAutosave', () => {
  it('saves only when there is work to lose', () => {
    expect(shouldAutosave(groupsFixture)).toBe(true);
    expect(shouldAutosave([])).toBe(false);
    expect(shouldAutosave(null)).toBe(false);
    expect(shouldAutosave(undefined)).toBe(false);
    expect(shouldAutosave('nope')).toBe(false);
  });
});

describe('parseSession', () => {
  it('returns null for anything that is not restorable', () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession('')).toBeNull();
    expect(parseSession('   ')).toBeNull();
    expect(parseSession('not json')).toBeNull();
    expect(parseSession('{"groups":[]}')).toBeNull();      // nothing to restore
    expect(parseSession('{"groups":"x"}')).toBeNull();     // wrong shape
    expect(parseSession('[1,2,3]')).toBeNull();            // top-level array
    expect(parseSession('null')).toBeNull();
    expect(parseSession({ groups: groupsFixture })).toBeNull(); // object, not JSON text
  });

  it('tolerates a snapshot missing optional fields', () => {
    const parsed = parseSession(JSON.stringify({ groups: groupsFixture }));
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.savedAt).toBeNull();
    expect(parsed.libraryId).toBeNull();
    expect(parsed.version).toBe(0);
  });
});

describe('formatRelativeTime', () => {
  const now = 1_000_000_000_000;

  it('describes recent saves as just now', () => {
    expect(formatRelativeTime(now, now)).toBe('just now');
    expect(formatRelativeTime(now - 20_000, now)).toBe('just now');
  });

  it('scales through minutes, hours, days and months', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('1 minute ago');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(formatRelativeTime(now - 26 * 3_600_000, now)).toBe('1 day ago');
    expect(formatRelativeTime(now - 5 * 86_400_000, now)).toBe('5 days ago');
    expect(formatRelativeTime(now - 70 * 86_400_000, now)).toBe('2 months ago');
  });

  it('never invents a time when the timestamp is missing or unusable', () => {
    expect(formatRelativeTime(null, now)).toBe('recently');
    expect(formatRelativeTime(undefined, now)).toBe('recently');
    expect(formatRelativeTime(0, now)).toBe('recently');
    expect(formatRelativeTime(NaN, now)).toBe('recently');
  });

  it('handles a clock that went backwards without producing a negative age', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now');
  });
});

describe('describeSession', () => {
  const now = 1_000_000_000_000;

  it('summarizes book count and age for the restore prompt', () => {
    const snap = makeSessionSnapshot({ groups: groupsFixture, now: now - 5 * 60_000 });
    expect(describeSession(snap, now)).toBe('2 books, saved 5 minutes ago');
  });

  it('singularizes a one-book session', () => {
    const snap = makeSessionSnapshot({ groups: [groupsFixture[0]], now });
    expect(describeSession(snap, now)).toBe('1 book, saved just now');
  });

  it('returns an empty string for no session', () => {
    expect(describeSession(null)).toBe('');
  });
});

describe('AUTOSAVE_DEBOUNCE_MS', () => {
  it('sits in the 2-3 second window the design calls for', () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(2000);
    expect(AUTOSAVE_DEBOUNCE_MS).toBeLessThanOrEqual(3000);
  });
});

describe('autosaveDelay', () => {
  const now = 1_000_000_000_000;

  it('uses the full debounce when nothing has been saved yet', () => {
    expect(autosaveDelay(0, now)).toBe(AUTOSAVE_DEBOUNCE_MS);
    expect(autosaveDelay(null, now)).toBe(AUTOSAVE_DEBOUNCE_MS);
    expect(autosaveDelay(NaN, now)).toBe(AUTOSAVE_DEBOUNCE_MS);
  });

  it('uses the full debounce shortly after a save', () => {
    expect(autosaveDelay(now - 1000, now)).toBe(AUTOSAVE_DEBOUNCE_MS);
  });

  it('shortens the wait as the max-wait deadline approaches', () => {
    // 1s of headroom left, so do not wait the full debounce past it.
    expect(autosaveDelay(now - (AUTOSAVE_MAX_WAIT_MS - 1000), now)).toBe(1000);
  });

  it('saves immediately once the max wait has elapsed', () => {
    // The starvation case: a batch run committing chunks faster than the
    // debounce window would otherwise reset the timer forever.
    expect(autosaveDelay(now - AUTOSAVE_MAX_WAIT_MS, now)).toBe(0);
    expect(autosaveDelay(now - 10 * AUTOSAVE_MAX_WAIT_MS, now)).toBe(0);
  });

  it('falls back to the debounce if the clock went backwards', () => {
    expect(autosaveDelay(now + 5000, now)).toBe(AUTOSAVE_DEBOUNCE_MS);
  });
});

describe('nextAutosaveFailureState', () => {
  const fail = (error = 'quota exceeded') => ({ saved: false, error });
  const ok = { saved: true };

  // Drive a sequence of outcomes through the fold and collect every warning.
  function run(outcomes) {
    let state = { consecutiveFailures: 0, warned: false };
    const warnings = [];
    for (const outcome of outcomes) {
      const next = nextAutosaveFailureState(state, outcome);
      if (next.warn) warnings.push(next.reason);
      state = { consecutiveFailures: next.consecutiveFailures, warned: next.warned };
    }
    return { warnings, state };
  }

  it('stays quiet for transient failures below the threshold', () => {
    const { warnings } = run([fail(), fail()]);
    expect(warnings).toEqual([]);
    expect(AUTOSAVE_FAILURE_WARN_THRESHOLD).toBe(3);
  });

  it('warns once the failures become consecutive', () => {
    const { warnings } = run([fail(), fail(), fail('disk full')]);
    expect(warnings).toEqual(['disk full']);
  });

  it('warns exactly once per streak, however long the streak runs', () => {
    // The browser-quota case: a snapshot over 5MB fails on every single
    // debounce tick, so an unguarded warning would spam the user forever.
    const { warnings } = run(Array.from({ length: 50 }, () => fail()));
    expect(warnings).toHaveLength(1);
  });

  it('a success resets the streak so a near miss does not carry over', () => {
    const { warnings, state } = run([fail(), fail(), ok, fail(), fail()]);
    expect(warnings).toEqual([]);
    expect(state.consecutiveFailures).toBe(2);
  });

  it('re-arms after a success so a later streak warns again', () => {
    const { warnings } = run([fail(), fail(), fail('first'), ok, fail(), fail(), fail('second')]);
    expect(warnings).toEqual(['first', 'second']);
  });

  it('clears the counter and the warned flag on success', () => {
    const next = nextAutosaveFailureState({ consecutiveFailures: 9, warned: true }, ok);
    expect(next).toEqual({ consecutiveFailures: 0, warned: false, warn: false, reason: null });
  });

  it('tolerates a missing state and a missing error message', () => {
    const next = nextAutosaveFailureState(undefined, { saved: false });
    expect(next.consecutiveFailures).toBe(1);
    expect(next.reason).toBe('unknown error');
  });
});

describe('browser persistence (no Tauri)', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('round-trips a snapshot through localStorage', async () => {
    const snap = makeSessionSnapshot({ groups: groupsFixture, libraryId: 'lib-1', now: 42 });
    expect(await saveSession(snap)).toEqual({ saved: true });

    const { session, unreadable } = await loadSession();
    expect(unreadable).toBe(false);
    expect(session.groups).toEqual(groupsFixture);
    expect(session.savedAt).toBe(42);
    expect(session.libraryId).toBe('lib-1');
  });

  it('reports an absence, not an error, when nothing is stored', async () => {
    expect(await loadSession()).toEqual({ session: null, unreadable: false });
  });

  it('reports a corrupt stored value as unreadable, not as an absence', async () => {
    // Present-but-unparseable must NOT look like "nothing saved": the caller
    // pauses autosave on unreadable so it cannot overwrite real work.
    localStorage.setItem(SESSION_STORAGE_KEY, '{ this is not json');
    const outcome = await loadSession();
    expect(outcome.session).toBeNull();
    expect(outcome.unreadable).toBe(true);
    expect(outcome.error).toMatch(/parse/i);
  });

  it('treats a stored empty string as an absence', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '   ');
    expect(await loadSession()).toEqual({ session: null, unreadable: false });
  });

  it('reports a storage read failure as unreadable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = await loadSession();
    expect(outcome).toMatchObject({ session: null, unreadable: true });
    expect(outcome.error).toContain('SecurityError');
  });

  it('clears only on an explicit call', async () => {
    await saveSession(makeSessionSnapshot({ groups: groupsFixture, now: 1 }));
    expect((await loadSession()).session).not.toBeNull();

    await clearSession();
    expect((await loadSession()).session).toBeNull();
  });

  it('reports a quota error instead of throwing it at the UI', async () => {
    const err = new Error('QuotaExceededError');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw err; });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await saveSession(makeSessionSnapshot({ groups: groupsFixture, now: 1 }));
    expect(result.saved).toBe(false);
    expect(result.error).toContain('QuotaExceededError');
  });

  it('preserves a declined snapshot into the second slot instead of deleting it', async () => {
    await saveSession(makeSessionSnapshot({ groups: groupsFixture, now: 1 }));

    expect(await preserveSession()).toBe(true);

    // Primary slot is free, so autosave can resume without destroying anything.
    expect((await loadSession()).session).toBeNull();
    const prev = JSON.parse(localStorage.getItem(PREV_SESSION_STORAGE_KEY));
    expect(prev.groups).toEqual(groupsFixture);
  });

  it('leaves the second slot alone when autosave resumes', async () => {
    await saveSession(makeSessionSnapshot({ groups: groupsFixture, now: 1 }));
    await preserveSession();
    await saveSession(makeSessionSnapshot({ groups: [groupsFixture[0]], now: 2 }));

    expect((await loadSession()).session.groups).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(PREV_SESSION_STORAGE_KEY)).groups).toHaveLength(2);
  });

  it('never auto-loads the second slot', async () => {
    localStorage.setItem(
      PREV_SESSION_STORAGE_KEY,
      JSON.stringify(makeSessionSnapshot({ groups: groupsFixture, now: 1 }))
    );
    expect(await loadSession()).toEqual({ session: null, unreadable: false });
  });

  it('preserving with nothing saved is a no-op success', async () => {
    expect(await preserveSession()).toBe(true);
    expect(localStorage.getItem(PREV_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('reports a serialization failure instead of throwing it at the UI', async () => {
    const circular = {};
    circular.self = circular;
    const result = await saveSession({ groups: [circular] });
    expect(result.saved).toBe(false);
    expect(result.error).toMatch(/serialize/i);
  });
});
