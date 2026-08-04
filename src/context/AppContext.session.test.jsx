// Session persistence invariants in AppContext (#58).
//
// These run against the browser (non-Tauri) persistence path, so localStorage
// is the durable store and the assertions can read it directly. The behavior
// under test is the gating logic, which is identical on both platforms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppProvider, useApp } from './AppContext';
import {
  SESSION_STORAGE_KEY,
  PREV_SESSION_STORAGE_KEY,
  AUTOSAVE_DEBOUNCE_MS,
  makeSessionSnapshot,
} from '../lib/session.js';

const mockCallBackend = vi.fn();

vi.mock('../api', () => ({
  callBackend: (...args) => mockCallBackend(...args),
  ollamaCall: vi.fn(async () => ({ running: false, models: [] })),
  subscribe: () => () => {},
}));

const savedGroups = [
  { id: 's1', metadata: { title: 'Saved One' }, files: [{ id: 's1-f0', path: '/one.m4b', changes: {} }] },
  { id: 's2', metadata: { title: 'Saved Two' }, files: [{ id: 's2-f0', path: '/two.m4b', changes: {} }] },
];

const freshGroups = [
  { id: 'n1', metadata: { title: 'Newly Scanned' }, files: [{ id: 'n1-f0', path: '/new.m4b', changes: {} }] },
];

const wrapper = ({ children }) => <AppProvider>{children}</AppProvider>;

function storedSession() {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function seedSavedSession(groups = savedGroups) {
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify(makeSessionSnapshot({ groups, libraryId: 'lib-1', now: Date.now() - 60_000 }))
  );
}

// Let the startup read (and any pending promise chain) settle. Works under
// fake timers because these are microtasks, not scheduled callbacks.
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

async function advancePastDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 100);
    await Promise.resolve();
  });
  await settle();
}

describe('AppContext session persistence (#58)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    mockCallBackend.mockReset();
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_config') return { abs_library_id: 'lib-1' };
      return {};
    });
    delete window.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('never auto-restores: a saved session is offered, not applied', async () => {
    seedSavedSession();
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    expect(result.current.sessionRestorePending).toBe(true);
    expect(result.current.savedSession.bookCount).toBe(2);
    expect(result.current.groups).toEqual([]);
  });

  it('does not overwrite the saved session while the restore prompt is unanswered', async () => {
    seedSavedSession();
    const before = storedSession();

    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();
    expect(result.current.sessionRestorePending).toBe(true);

    // The user starts a new scan without answering the prompt. This is the
    // exact #58 failure mode: if autosave ran here, the unrestored work would
    // be gone for good.
    act(() => { result.current.setGroups(freshGroups); });
    await advancePastDebounce();

    expect(storedSession()).toEqual(before);
    expect(storedSession().groups.map(g => g.id)).toEqual(['s1', 's2']);
  });

  it('restores the saved groups on an explicit Restore', async () => {
    seedSavedSession();
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    let outcome;
    act(() => { outcome = result.current.restoreSession(); });

    expect(outcome).toEqual({ restored: true, count: 2 });
    expect(result.current.groups.map(g => g.id)).toEqual(['s1', 's2']);
    expect(result.current.sessionRestorePending).toBe(false);
    expect(result.current.savedSession).toBeNull();
  });

  it('refuses to restore over books already loaded, instead of destroying them', async () => {
    seedSavedSession();
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    // The prompt has no dismiss, so the user can scan while it is open. That
    // fresh scan is not on disk (autosave is suppressed), so an unguarded
    // restore would destroy it unrecoverably.
    act(() => { result.current.setGroups(freshGroups); });
    await settle();

    let outcome;
    act(() => { outcome = result.current.restoreSession(); });

    expect(outcome.restored).toBe(false);
    expect(outcome.reason).toBe('workspace-not-empty');
    expect(outcome.currentCount).toBe(1);
    expect(outcome.count).toBe(2);
    // The scan survives, and the prompt is still open so the caller can confirm.
    expect(result.current.groups.map(g => g.id)).toEqual(['n1']);
    expect(result.current.sessionRestorePending).toBe(true);
    expect(result.current.savedSession).not.toBeNull();
  });

  it('replaces the loaded books once the restore is explicitly forced', async () => {
    seedSavedSession();
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    act(() => { result.current.setGroups(freshGroups); });
    await settle();

    let outcome;
    act(() => { outcome = result.current.restoreSession({ force: true }); });

    expect(outcome).toEqual({ restored: true, count: 2 });
    expect(result.current.groups.map(g => g.id)).toEqual(['s1', 's2']);
    expect(result.current.sessionRestorePending).toBe(false);
  });

  it('reports no-session rather than throwing when there is nothing to restore', async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    let outcome;
    act(() => { outcome = result.current.restoreSession(); });
    expect(outcome).toEqual({ restored: false, count: 0, reason: 'no-session' });
  });

  it('deletes the snapshot only on an explicit Discard', async () => {
    seedSavedSession();
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    expect(storedSession()).not.toBeNull();

    await act(async () => { await result.current.discardSession(); });

    expect(storedSession()).toBeNull();
    expect(result.current.sessionRestorePending).toBe(false);
    expect(result.current.groups).toEqual([]);
  });

  it('autosaves the working state on a debounce once no decision is pending', async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();
    expect(result.current.sessionRestorePending).toBe(false);

    act(() => { result.current.setGroups(freshGroups); });

    // Nothing written yet: the debounce is still open.
    expect(storedSession()).toBeNull();

    await advancePastDebounce();

    const stored = storedSession();
    expect(stored.groups.map(g => g.id)).toEqual(['n1']);
    expect(stored.bookCount).toBe(1);
    expect(stored.libraryId).toBe('lib-1');
    expect(stored.savedAt).toBeGreaterThan(0);
  });

  it('collapses a burst of edits into a single write', async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    act(() => { result.current.setGroups([{ id: 'a', files: [] }]); });
    act(() => { result.current.setGroups([{ id: 'a', files: [] }, { id: 'b', files: [] }]); });
    act(() => { result.current.setGroups([{ id: 'a', files: [] }, { id: 'b', files: [] }, { id: 'c', files: [] }]); });

    await advancePastDebounce();

    const sessionWrites = setItem.mock.calls.filter(([key]) => key === SESSION_STORAGE_KEY);
    expect(sessionWrites).toHaveLength(1);
    expect(storedSession().groups.map(g => g.id)).toEqual(['a', 'b', 'c']);
    setItem.mockRestore();
  });

  it('leaves an untouched saved session alone when the workspace stays empty', async () => {
    seedSavedSession();
    const before = storedSession();

    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();
    // The user ignores the prompt entirely and never touches the workspace.
    await advancePastDebounce();
    await advancePastDebounce();

    expect(storedSession()).toEqual(before);
    expect(result.current.sessionRestorePending).toBe(true);
  });

  it('clears the snapshot when the workspace is explicitly emptied after a save', async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    act(() => { result.current.setGroups(freshGroups); });
    await advancePastDebounce();
    expect(storedSession()).not.toBeNull();

    // An explicit reset that leaves nothing loaded. Only now is the snapshot
    // stale, and only after the new (empty) state settled.
    act(() => { result.current.setGroups([]); });
    expect(storedSession()).not.toBeNull(); // not until the debounce elapses

    await advancePastDebounce();
    expect(storedSession()).toBeNull();
  });

  it('replaces rather than clears when a reset loads different books', async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    act(() => { result.current.setGroups(savedGroups); });
    await advancePastDebounce();
    expect(storedSession().groups.map(g => g.id)).toEqual(['s1', 's2']);

    // Full import replace: the new state's own autosave is what supersedes the
    // old snapshot, so there is never a window with nothing on disk.
    act(() => { result.current.setGroups(freshGroups); });
    await advancePastDebounce();
    expect(storedSession().groups.map(g => g.id)).toEqual(['n1']);
  });

  it('still writes during a run that keeps changing the workspace', async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    // First write establishes the max-wait clock.
    act(() => { result.current.setGroups([{ id: 'b0', files: [] }]); });
    await advancePastDebounce();
    expect(storedSession().groups).toHaveLength(1);

    // Now simulate a long batch run committing a chunk of results every second,
    // which is faster than the debounce window. A pure debounce would never
    // fire; the max wait guarantees a write anyway.
    for (let i = 1; i <= 40; i++) {
      const next = Array.from({ length: i + 1 }, (_, k) => ({ id: `b${k}`, files: [] }));
      act(() => { result.current.setGroups(next); });
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }
    await settle();

    expect(storedSession().groups.length).toBeGreaterThan(1);
  });

  it('survives a corrupt snapshot without offering a restore', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '{ not json at all');
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    expect(result.current.sessionRestorePending).toBe(false);
    expect(result.current.savedSession).toBeNull();
  });

  it('pauses autosave over a snapshot that is present but unreadable', async () => {
    const corrupt = '{ not json at all';
    localStorage.setItem(SESSION_STORAGE_KEY, corrupt);

    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    expect(result.current.sessionUnreadable).not.toBeNull();

    // The file may hold real work that a future version can read, so the app
    // must not write over it on the strength of a parse failure.
    act(() => { result.current.setGroups(freshGroups); });
    await advancePastDebounce();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(corrupt);
  });

  it('resumes autosave once the unreadable snapshot is explicitly discarded', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '{ not json at all');
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    act(() => { result.current.setGroups(freshGroups); });
    await act(async () => { await result.current.discardSession(); });
    expect(result.current.sessionUnreadable).toBeNull();

    await advancePastDebounce();
    expect(storedSession().groups.map(g => g.id)).toEqual(['n1']);
  });

  it('keeps the declined session in a second slot and resumes autosave', async () => {
    seedSavedSession();
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    // The user scans before answering, then chooses to keep the new books.
    act(() => { result.current.setGroups(freshGroups); });
    await settle();
    await act(async () => { await result.current.keepCurrentWorkspace(); });

    // Nothing was destroyed: the declined session moved to the second slot.
    const prev = JSON.parse(localStorage.getItem(PREV_SESSION_STORAGE_KEY));
    expect(prev.groups.map(g => g.id)).toEqual(['s1', 's2']);

    // And the user is no longer stranded unprotected.
    expect(result.current.sessionRestorePending).toBe(false);
    await advancePastDebounce();
    expect(storedSession().groups.map(g => g.id)).toEqual(['n1']);
    // The resumed autosave did not clobber the second slot.
    expect(JSON.parse(localStorage.getItem(PREV_SESSION_STORAGE_KEY)).groups).toHaveLength(2);
  });

  it('warns once after three consecutive autosave failures', async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const warnings = [];
    for (let i = 1; i <= 6; i++) {
      act(() => {
        result.current.setGroups(Array.from({ length: i }, (_, k) => ({ id: `q${k}`, files: [] })));
      });
      await advancePastDebounce();
      if (result.current.autosaveWarning) {
        warnings.push(result.current.autosaveWarning.reason);
        act(() => { result.current.acknowledgeAutosaveWarning(); });
      }
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('QuotaExceededError');
  });
});
