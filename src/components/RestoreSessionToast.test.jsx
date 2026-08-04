// Restore prompt behaviour (#58).
//
// The point of these is the absence of exits: this prompt gates autosave, so
// any way to dismiss it without answering leaves the app writing over a
// session the user never decided about.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RestoreSessionToast } from './RestoreSessionToast';
import { makeSessionSnapshot } from '../lib/session.js';

const session = {
  ...makeSessionSnapshot({
    groups: [{ id: 'a' }, { id: 'b' }],
    now: Date.now() - 5 * 60_000,
  }),
};

describe('RestoreSessionToast', () => {
  it('offers exactly two actions and no dismiss', () => {
    render(<RestoreSessionToast session={session} onRestore={() => {}} onDiscard={() => {}} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.map(b => b.textContent.trim())).toEqual(['Restore', 'Discard']);
  });

  it('describes what would be restored', () => {
    render(<RestoreSessionToast session={session} onRestore={() => {}} onDiscard={() => {}} />);
    expect(screen.getByText('Restore previous session?')).toBeInTheDocument();
    expect(screen.getByText('2 books, saved 5 minutes ago')).toBeInTheDocument();
  });

  it('wires each action to its own handler', async () => {
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    render(<RestoreSessionToast session={session} onRestore={onRestore} onDiscard={onDiscard} />);

    await userEvent.click(screen.getByRole('button', { name: /restore/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('disables both actions while a decision is in flight', () => {
    render(<RestoreSessionToast session={session} onRestore={() => {}} onDiscard={() => {}} busy />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
  });

  it('renders nothing without a session', () => {
    const { container } = render(<RestoreSessionToast onRestore={() => {}} onDiscard={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('unreadable snapshot variant', () => {
    it('offers only Discard, since there is nothing to restore', () => {
      render(<RestoreSessionToast unreadableReason="permission denied" onDiscard={() => {}} />);

      const buttons = screen.getAllByRole('button');
      expect(buttons.map(b => b.textContent.trim())).toEqual(['Discard']);
      expect(screen.getByText('A saved session could not be read')).toBeInTheDocument();
    });

    it('explains why autosave is paused and what un-pauses it', () => {
      render(<RestoreSessionToast unreadableReason="permission denied" onDiscard={() => {}} />);
      expect(screen.getByText(/permission denied/)).toBeInTheDocument();
      expect(screen.getByText(/autosave is paused/i)).toBeInTheDocument();
    });
  });
});

describe('restore prompt placement (#58)', () => {
  const scannerSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'ScannerPage.jsx'),
    'utf8'
  );

  it('is portaled out of the tab wrapper App.jsx hides', () => {
    // App.jsx renders ScannerPage inside a div that gets `hidden` on the
    // Settings tab. A hidden prompt would be invisible while still suppressing
    // autosave, so the prompt and its confirmation must escape that subtree.
    expect(scannerSource).toContain("import { createPortal } from 'react-dom'");
    const portalCall = scannerSource.slice(scannerSource.indexOf('createPortal('));
    expect(portalCall).toContain('RestoreSessionToast');
    expect(portalCall).toContain('document.body');
  });
});
