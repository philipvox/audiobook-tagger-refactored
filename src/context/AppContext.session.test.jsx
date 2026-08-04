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

    let count;
    act(() => { count = result.current.restoreSession(); });

    expect(count).toBe(2);
    expect(result.current.groups.map(g => g.id)).toEqual(['s1', 's2']);
    expect(result.current.sessionRestorePending).toBe(false);
    expect(result.current.savedSession).toBeNull();
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

  it('survives a corrupt snapshot without offering a restore', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '{ not json at all');
    const { result } = renderHook(() => useApp(), { wrapper });
    await settle();

    expect(result.current.sessionRestorePending).toBe(false);
    expect(result.current.savedSession).toBeNull();
  });
});
