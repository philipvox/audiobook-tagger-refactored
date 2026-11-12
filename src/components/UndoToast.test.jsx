import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UndoToast } from './UndoToast';

// I-5: the count is the undo journal's file count, and the journal has no
// expiry. These tests used to expect "Wrote 3 books" and a one-hour
// "Undo available for 1h 0m" countdown that nothing enforced.
describe('UndoToast (L4, I-5)', () => {
  it('names the file count and that undo lasts until the next write', () => {
    render(<UndoToast fileCount={3} onUndo={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/Wrote 3 files/)).toBeTruthy();
    expect(screen.getByText(/Undo stays available until the next write/)).toBeTruthy();
  });

  it('renders a single file without the plural', () => {
    render(<UndoToast fileCount={1} onUndo={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/Wrote 1 file(?!s)/)).toBeTruthy();
  });
});
