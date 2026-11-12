// Final review fixes I-6 and M-m: an import that would replace older-session
// books with unpushed edits asks first; the restore says so; closing the
// wizard mid-import cancels the import.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  callBackend: vi.fn(async () => ({ groups: [], total: 0 })),
  askToConfirm: vi.fn(async () => false),
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callBackend: api.callBackend, askToConfirm: api.askToConfirm, subscribe: vi.fn(() => () => {}) };
});
const app = vi.hoisted(() => ({ groups: [], setGroups: vi.fn(), config: {}, saveConfig: vi.fn() }));
vi.mock('../context/AppContext', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useApp: () => app };
});
vi.mock('../lib/abs-client', () => ({ importLibrary: vi.fn() }));

const { useScan, reimportDiscardCount, REIMPORT_DISCARD_PROMPT } = await import('./useScan');
const { parseSession, restoreToast } = await import('../lib/session.js');
const { standingWarnings } = await import('../lib/groupWarnings.js');
const { ToastProvider } = await import('../components/Toast');
const { SetupWizard } = await import('../components/OnboardingWizard');
const { importLibrary } = await import('../lib/abs-client');

const stale = (id, staged) => ({
  id, abs_id: id, source: 'abs', needs_reimport: true, metadata: { title: id }, files: [],
  total_changes: staged ? 1 : 0, changedFields: staged ? ['title'] : [],
});

beforeEach(() => {
  vi.clearAllMocks();
  app.groups = [];
  app.config = { abs_base_url: 'http://abs.local', abs_api_token: 'tok', abs_library_id: 'lib1' };
  app.saveConfig.mockResolvedValue({ success: true });
  api.callBackend.mockImplementation(async () => ({ groups: [], total: 0 }));
  api.askToConfirm.mockResolvedValue(false);
});

describe('I-6: Library import', () => {
  it('counts older-session books with unpushed edits', () => {
    expect(reimportDiscardCount([stale('a', true), stale('b', false), { id: 'c', total_changes: 2, files: [] }])).toBe(1);
    expect(REIMPORT_DISCARD_PROMPT(2)).toMatch(/2 books from an older session have unpushed edits that will be discarded\. Continue\?/);
  });

  it('asks first; declining makes no backend call and changes nothing', async () => {
    app.groups = [stale('a', true)];
    const { result } = renderHook(() => useScan());
    let out;
    await act(async () => { out = await result.current.handleImportFromAbs(); });
    expect(api.askToConfirm).toHaveBeenCalledTimes(1);
    expect(api.askToConfirm.mock.calls[0][0]).toMatch(/1 book from an older session has unpushed edits/);
    expect(api.callBackend).not.toHaveBeenCalledWith('import_from_abs', expect.anything());
    expect(app.setGroups).not.toHaveBeenCalled();
    expect(out).toMatchObject({ success: false, declined: true });
  });

  it('flagged books without staged edits: no prompt', async () => {
    app.groups = [stale('a', false)];
    const { result } = renderHook(() => useScan());
    await act(async () => { await result.current.handleImportFromAbs(); });
    expect(api.askToConfirm).not.toHaveBeenCalled();
    expect(api.callBackend).toHaveBeenCalledWith('import_from_abs', expect.anything());
  });
});

describe('I-6: restore wording', () => {
  it('the pill says re-importing discards the edits, and stays visible beside another error', () => {
    const g = parseSession(JSON.stringify({ version: 1, savedAt: 1, groups: [{ id: 'x', source: 'abs', metadata: { title: 'T' }, files: [] }] })).groups[0];
    expect(g.lastError.message).toMatch(/re-importing discards the edits shown here/);
    const hidden = { ...g, lastError: { stage: 'tags', kind: 'ai', message: 'boom', severity: 'error' } };
    expect(standingWarnings(hidden).map((w) => w.message)).toEqual([g.lastError.message]);
  });

  it('the restore toast warns and says re-import discards those edits', () => {
    const t = restoreToast([stale('a', true), stale('b', false), { id: 'c', files: [] }]);
    expect(t.type).toBe('warning');
    expect(t.message).toMatch(/2 books came from an older session/);
    expect(t.message).toMatch(/re-importing discards their unpushed edits/i);
    expect(restoreToast([{ id: 'c', files: [] }]).type).toBe('success');
  });
});

describe('I-6 and M-m: the wizard import', () => {
  const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
  const openImportStep = async () => {
    const onClose = vi.fn();
    render(<ToastProvider><SetupWizard onClose={onClose} /></ToastProvider>);
    await act(async () => { next(); });
    await act(async () => { next(); });
    return onClose;
  };

  it('asks before replacing older-session books with edits; declining does not import', async () => {
    app.groups = [stale('a', true)];
    await openImportStep();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Import Library/ })); });
    expect(api.askToConfirm).toHaveBeenCalledTimes(1);
    expect(importLibrary).not.toHaveBeenCalled();
    expect(app.setGroups).not.toHaveBeenCalled();
  });

  it('closing the wizard during an import cancels it: the workspace is not changed', async () => {
    let finish;
    let options;
    importLibrary.mockImplementation((_cfg, _onProgress, opts) => new Promise((resolve) => {
      options = opts;
      finish = () => resolve([{ id: 'li-1', metadata: { title: 'A' }, files: [] }]);
    }));
    await openImportStep();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Import Library/ })); });
    await waitFor(() => expect(importLibrary).toHaveBeenCalled());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })); });
    expect(options?.shouldStop?.()).toBe(true);
    await act(async () => { finish(); });
    expect(app.setGroups).not.toHaveBeenCalled();
  });
});
