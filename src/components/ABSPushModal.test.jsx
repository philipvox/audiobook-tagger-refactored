import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, absApi: vi.fn() };
});

const { ABSPushModal } = await import('./ABSPushModal');
const { callBackend } = await import('../api');
const { absApi } = await import('../lib/proxy');
const { startCancellable, requestCancel } = await import('../lib/cancel');

const groups = [{ id: 'g1', metadata: { title: 'Dune' }, files: [] }];
const confirmButton = () => screen.getByRole('button', { name: /Push to ABS|Pushing/ });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});

describe('ABSPushModal busy state (H-7)', () => {
  it('Confirm is disabled while a push is running', () => {
    render(<ABSPushModal isOpen groups={groups} pushing onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(confirmButton()).toBeDisabled();
  });

  it('a second Confirm click before the parent reports busy does not start a second push', () => {
    const onConfirm = vi.fn(() => new Promise(() => {})); // push still running
    render(<ABSPushModal isOpen groups={groups} pushing={false} onClose={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmButton()).toBeDisabled();
  });

  it('while a push runs, "Cancel push" stops it: in-flight book finishes, the rest are skipped as cancelled', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      abs_base_url: 'http://abs.local', abs_api_token: 'token', concurrency_abs_push: 1,
    }));
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `g${i + 1}`, abs_id: `li-${i + 1}`, metadata: { title: `Book ${i + 1}` }, original: { title: 'old' },
    }));
    let releaseFirst;
    let gets = 0;
    absApi.mockImplementation(async (_b, _t, _p, opts) => {
      if (opts?.method === 'PATCH') return {};
      gets++;
      if (gets === 1) await new Promise((r) => { releaseFirst = r; });
      return { media: { tags: [], metadata: { genres: [] } } };
    });

    // Wired the way ScannerPage wires it: one token per push.
    const cancel = startCancellable();
    let result;
    const onConfirm = async () => {
      result = await callBackend('push_abs_imports', { request: { items }, cancel });
    };
    const onClose = vi.fn();
    render(<ABSPushModal isOpen groups={groups} pushing={false} onClose={onClose} onConfirm={onConfirm} onCancelPush={() => requestCancel(cancel)} />);

    fireEvent.click(confirmButton());
    await waitFor(() => expect(gets).toBe(1));
    expect(confirmButton()).toBeDisabled();
    const cancelPush = screen.getByRole('button', { name: 'Cancel push' });
    expect(cancelPush).not.toBeDisabled();

    fireEvent.click(cancelPush);
    expect(onClose).not.toHaveBeenCalled(); // the modal stays until the push settles
    expect(screen.getByRole('button', { name: 'Cancelling...' })).toBeDisabled();

    await act(async () => { releaseFirst(); });
    await waitFor(() => expect(result).toBeDefined());

    expect(result.updated.map((u) => u.id)).toEqual(['g1']);
    expect(result.skipped).toHaveLength(9);
    expect(result.skipped.every((s) => s.reason === 'cancelled')).toBe(true);
    expect(gets).toBe(1);
  });
});

describe('ABSPushModal copy and counts (M-10)', () => {
  it('describes the diff-only push, not an overwrite', () => {
    render(<ABSPushModal isOpen groups={groups} pushing={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('Only fields you changed since import are sent. Tags and genres are merged with what is on the server.')).toBeInTheDocument();
    expect(screen.queryByText(/will be replaced with what you see in the tagger/)).not.toBeInTheDocument();
    expect(screen.queryByText(/overwrites/i)).not.toBeInTheDocument();
  });

  it('counts per book: a 12-file book with a title change is 1 title update', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`, filename: `part${i}.mp3`, changes: { title: { old: 'a', new: 'b' } },
    }));
    const twelve = [{ id: 'b1', metadata: { title: 'Long Book' }, files }];
    render(<ABSPushModal isOpen groups={twelve} pushing={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('1 title update')).toBeInTheDocument();
    expect(screen.queryByText(/12 title/)).not.toBeInTheDocument();
  });
});
