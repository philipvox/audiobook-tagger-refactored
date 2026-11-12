import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WritePreviewModal } from './WritePreviewModal';

const groups = [{
  id: 'g1',
  metadata: { title: 'Book' },
  files: [{
    id: 'f1', path: '/books/Book/book.mp3', filename: 'book.mp3',
    changes: {
      title: { old: 'Old', new: 'New' },
      description: { old: '', new: 'A story' },
      tags: { old: '', new: 'dna:pace:fast' },
    },
  }],
}];

describe('WritePreviewModal lists only what the writer writes (#62)', () => {
  it('counts writable changes only and names each app-only change with its reason', () => {
    render(<WritePreviewModal isOpen onClose={vi.fn()} onConfirm={vi.fn()} selectedFiles={new Set(['f1'])} groups={groups} backupEnabled />);
    expect(screen.getByRole('button', { name: /Write 1 Change$/ })).toBeInTheDocument();
    expect(screen.getByText(/2 staged changes stay in the app only/)).toBeInTheDocument();
    expect(screen.getByText('Not written to this file:')).toBeInTheDocument();
    expect(screen.getByText(/MP3 tags have no description field/)).toBeInTheDocument();
    expect(screen.getByText(/App only: audio files have no tag for this/)).toBeInTheDocument();
  });

  it('confirms with the backup flag and exclusions', () => {
    const onConfirm = vi.fn();
    render(<WritePreviewModal isOpen onClose={vi.fn()} onConfirm={onConfirm} selectedFiles={new Set(['f1'])} groups={groups} backupEnabled />);
    fireEvent.click(screen.getByRole('button', { name: /Write 1 Change$/ }));
    expect(onConfirm).toHaveBeenCalledWith(false, new Set());
  });
});
