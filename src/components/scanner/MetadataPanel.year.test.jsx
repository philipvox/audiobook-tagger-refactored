import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../api', () => ({ callBackend: vi.fn().mockResolvedValue(null) }));
vi.mock('../../lib/proxy', () => ({ proxyFetch: vi.fn().mockResolvedValue(null) }));
vi.mock('../Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }));

const { MetadataPanel } = await import('./MetadataPanel');

// H-2: the Details tab Year card edits `year` (not the ABS-only published_year).
describe('MetadataPanel inline Year edit (H-2)', () => {
  it('calls onInlineEdit with field "year"', () => {
    const onInlineEdit = vi.fn();
    const group = {
      id: 'g1',
      files: [],
      changedFields: [],
      metadata: { title: 'Dune', author: 'A', year: '1999', published_year: '1999' },
    };
    render(<MetadataPanel group={group} onEdit={() => {}} onInlineEdit={onInlineEdit} />);
    fireEvent.click(screen.getByText('Details'));
    fireEvent.click(screen.getAllByText('1999').at(-1));
    const input = screen.getByDisplayValue('1999');
    fireEvent.change(input, { target: { value: '2005' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onInlineEdit).toHaveBeenCalledWith('g1', 'year', '2005');
  });
});
