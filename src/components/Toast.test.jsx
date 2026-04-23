import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

function TestHarness({ onReady }) {
  const toast = useToast();
  onReady(toast);
  return null;
}

function renderWithToasts() {
  let api;
  render(
    <ToastProvider>
      <TestHarness onReady={(t) => { api = t; }} />
    </ToastProvider>
  );
  return api;
}

describe('Toast a11y + action extension (commit 11)', () => {
  it('warning toast has role=alert and aria-live=polite', () => {
    const toast = renderWithToasts();
    act(() => { toast.warning('Metadata Resolution: 3 resolved, 2 warnings'); });
    const el = screen.getByTestId('toast-warning');
    expect(el).toHaveAttribute('role', 'alert');
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('error toast uses aria-live=assertive (more urgent than warning)', () => {
    const toast = renderWithToasts();
    act(() => { toast.error('Classification: 5 classified, 3 failed'); });
    const el = screen.getByTestId('toast-error');
    expect(el).toHaveAttribute('aria-live', 'assertive');
  });

  it('renders action button when action={label,onClick} is provided', () => {
    const toast = renderWithToasts();
    const onClick = vi.fn();
    act(() => {
      toast.warning('Classification: 5 classified, 3 warnings', null, {
        duration: 0, action: { label: 'Show details', onClick },
      });
    });
    const btn = screen.getByRole('button', { name: 'Show details' });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('preserves legacy 3-arg signature (title, message, duration)', () => {
    const toast = renderWithToasts();
    act(() => { toast.success('Done', 'All good', 99999); });
    expect(screen.getByTestId('toast-success')).toBeInTheDocument();
    // No action button rendered
    expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument();
  });

  it('does not render action button when action is incomplete', () => {
    const toast = renderWithToasts();
    act(() => { toast.warning('T', null, { duration: 0, action: { label: 'Show details' } }); });
    expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument();
  });
});
