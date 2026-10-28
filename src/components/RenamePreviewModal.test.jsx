import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RenamePreviewModal } from './RenamePreviewModal';

const mockCallBackend = vi.fn();
vi.mock('../api', () => ({
  callBackend: (...args) => mockCallBackend(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RenamePreviewModal (L9 empty-templates state)', () => {
  it('stops the spinner and shows a no-templates message when the backend returns []', async () => {
    mockCallBackend.mockResolvedValue([]); // get_rename_templates -> none

    render(
      <RenamePreviewModal
        files={[{ fileId: 'f1', path: '/a/1.m4b', metadata: { title: 'Book' } }]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(await screen.findByText(/No rename templates available/)).toBeTruthy();
    // The spinner text must be gone (loading resolved to false).
    expect(screen.queryByText(/Generating previews/)).toBeNull();
    // preview_rename must not have been called with no template.
    expect(mockCallBackend).not.toHaveBeenCalledWith('preview_rename', expect.anything());
  });
});

describe('RenamePreviewModal (v2.2.3 multi-file books)', () => {
  it('passes each file part number and the group file count to preview_rename', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_rename_templates') return [{ id: 't', name: 'T', file_template: '{title}' }];
      return { old_path: '/a/1.mp3', new_path: '/a/Book.mp3', changed: true };
    });
    render(
      <RenamePreviewModal
        files={[
          { fileId: 'f1', path: '/a/1.mp3', metadata: { title: 'Book' }, part: 1, totalParts: 2 },
          { fileId: 'f2', path: '/a/2.mp3', metadata: { title: 'Book' }, part: 2, totalParts: 2 },
        ]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    await vi.waitFor(() => {
      expect(mockCallBackend).toHaveBeenCalledWith('preview_rename', expect.objectContaining({ filePath: '/a/2.mp3', part: 2, totalParts: 2 }));
    }, { timeout: 2000 });
  });
});
