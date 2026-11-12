import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ABSPushModal } from './ABSPushModal';

const groups = [{ id: 'g1', metadata: { title: 'Dune' }, files: [] }];
const confirmButton = () => screen.getByRole('button', { name: /Push to ABS|Pushing/ });

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
});
