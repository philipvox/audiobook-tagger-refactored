import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UndoToast } from './UndoToast';

describe('UndoToast (L4)', () => {
  it('renders with a defaulted ageSeconds and a valid (non-NaN) undo countdown', () => {
    // ageSeconds omitted -> defaults to 0, so the 1h availability text is exact.
    render(<UndoToast booksCount={3} onUndo={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/Wrote 3 books/)).toBeTruthy();
    // 3600s -> "1h 0m" (formatTime), proving timeRemaining isn't NaN.
    expect(screen.getByText(/Undo available for 1h 0m/)).toBeTruthy();
  });

  it('renders a single book without the plural', () => {
    render(<UndoToast booksCount={1} onUndo={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/Wrote 1 book(?!s)/)).toBeTruthy();
  });
});
