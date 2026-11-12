import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditMetadataModal } from './EditMetadataModal';

// H-2: the Year input must move `year` and `published_year` together, or the
// ABS push keeps sending the stale one.
describe('EditMetadataModal year (H-2)', () => {
  it('saves both year and published_year after the year is edited', () => {
    const onSave = vi.fn();
    render(
      <EditMetadataModal
        isOpen
        onClose={() => {}}
        onSave={onSave}
        metadata={{ title: 'Dune', author: 'A', genres: [], year: '1999', published_year: '1999' }}
        groupName="Dune"
        folderPath="/x"
      />
    );
    fireEvent.change(screen.getByPlaceholderText('YYYY'), { target: { value: '2005' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ year: '2005', published_year: '2005' });
  });
});
