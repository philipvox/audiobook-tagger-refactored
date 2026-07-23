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
