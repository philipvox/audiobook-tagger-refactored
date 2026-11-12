import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../api', () => ({ callBackend: vi.fn().mockResolvedValue(null) }));
vi.mock('../../lib/proxy', () => ({ proxyFetch: vi.fn().mockResolvedValue(null) }));
vi.mock('../Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }));

const { MetadataPanel } = await import('./MetadataPanel');

// LOW: "Save Local" did nothing (inline edits already update the group), so
// it is gone. An inline edit must not bring up a save button.
describe('MetadataPanel has no "Save Local" button', () => {
  it('an inline edit applies straight away and no Save Local button appears', () => {
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
    expect(screen.queryByRole('button', { name: /Save Local/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });
});
