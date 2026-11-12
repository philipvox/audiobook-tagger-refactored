import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('RenamePreviewModal (#62)', () => {
  it('shows only the filename of a Windows path and says the rename cannot be undone', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_rename_templates') return [{ id: 't', name: 'T', file_template: '{title}' }];
      return { old_path: 'C:\\Books\\Old\\old.m4b', new_path: 'C:\\Books\\Old\\Book.m4b', changed: true };
    });
    const onConfirm = vi.fn();
    render(
      <RenamePreviewModal
        files={[{ fileId: 'f1', path: 'C:\\Books\\Old\\old.m4b', metadata: { title: 'Book' } }]}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    expect(await screen.findByText('old.m4b', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByText('Book.m4b')).toBeTruthy();
    expect(screen.getByText('Rename 1 file. This cannot be undone from the app.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename 1 file' }));
    expect(onConfirm).toHaveBeenCalledWith(
      [{ fileId: 'f1', oldPath: 'C:\\Books\\Old\\old.m4b', newPath: 'C:\\Books\\Old\\Book.m4b' }],
      '{title}'
    );
  });

  it('a file that cannot be previewed is listed with the reason, not dropped', async () => {
    mockCallBackend.mockImplementation(async (cmd) => {
      if (cmd === 'get_rename_templates') return [{ id: 't', name: 'T', file_template: '{title}' }];
      throw new Error('bad metadata');
    });
    render(
      <RenamePreviewModal
        files={[{ fileId: 'f1', path: '/b/old.m4b', metadata: {} }]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(await screen.findByText(/old\.m4b: could not preview \(bad metadata\)/, {}, { timeout: 2000 })).toBeTruthy();
  });
});
