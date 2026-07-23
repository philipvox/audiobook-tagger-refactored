import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ValidationIssueModal } from './ValidationIssueModal';

// CR-5: ScannerPage's selection is file-id based; the modal must resolve target
// groups by whether any of a group's file ids is selected, not by group id.
const groups = [
  {
    id: 'g1',
    metadata: { title: 'Selected Book', author: 'A' },
    files: [{ id: 'g1-f0' }, { id: 'g1-f1' }],
  },
  {
    id: 'g2',
    metadata: { title: 'Other Book', author: 'B' },
    files: [{ id: 'g2-f0' }],
  },
];

const validationResults = {
  g1: { issues: [{ issue_type: 'SuspiciousTitle', severity: 'Warning', field: 'title', message: 'hm' }] },
  g2: { issues: [{ issue_type: 'SuspiciousTitle', severity: 'Warning', field: 'title', message: 'hm' }] },
};

describe('ValidationIssueModal (CR-5 file-id selection)', () => {
  it('shows only the group whose file id is in the selection', () => {
    render(
      <ValidationIssueModal
        isOpen
        onClose={() => {}}
        validationResults={validationResults}
        selectedBooks={new Set(['g1-f0'])}
        groups={groups}
        onApplyFixes={() => {}}
      />
    );
    expect(screen.getByText('Selected Book')).toBeTruthy();
    expect(screen.queryByText('Other Book')).toBeNull();
  });

  it('falls back to all groups when the selection is empty', () => {
    render(
      <ValidationIssueModal
        isOpen
        onClose={() => {}}
        validationResults={validationResults}
        selectedBooks={new Set()}
        groups={groups}
        onApplyFixes={() => {}}
      />
    );
    expect(screen.getByText('Selected Book')).toBeTruthy();
    expect(screen.getByText('Other Book')).toBeTruthy();
  });
});
