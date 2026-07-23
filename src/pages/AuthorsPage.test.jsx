// src/pages/AuthorsPage.test.jsx
// Regression tests for the 2026-07-22 audit (task 4, items 9/12):
// - CR-7: onEditDescription used to call an undefined `setDetail`, throwing
//   a ReferenceError. It must now use the exported updateDetail mutator.
// - Item 12: suggested_value truthy-check bugs at the rename-modal default
//   (line ~477) and the issues list (line ~719) must not drop 0/''.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AuthorsPage } from './AuthorsPage';
import { ToastProvider } from '../components/Toast';

function renderPage() {
  return render(<ToastProvider><AuthorsPage /></ToastProvider>);
}

vi.mock('../api', () => ({
  callBackend: vi.fn(async () => ({})),
}));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    startGlobalProgress: vi.fn(),
    updateGlobalProgress: vi.fn(),
    endGlobalProgress: vi.fn(),
  }),
}));

const stageChange = vi.fn();
const updateDetail = vi.fn();
const loadAuthors = vi.fn();

const baseDetail = {
  id: 'a1',
  name: 'Author One',
  num_books: 2,
  has_image: false,
  description: 'Old bio',
  books: [],
};

let mockHook;

vi.mock('../hooks/useAuthors', () => ({
  useAuthors: () => mockHook,
}));

function makeHook(overrides = {}) {
  return {
    authors: [{ id: 'a1', name: 'Author One', num_books: 2 }],
    selectedAuthorId: 'a1',
    detail: baseDetail,
    analysis: null,
    loading: false, loadingDetail: false, analyzing: false,
    fixingDescriptions: false, pushing: false,
    progressMessage: null, error: null,
    pendingChanges: {}, pendingMerges: {}, pendingCount: 0, mergedAwayIds: new Set(),
    selectedIds: new Set(), allSelected: false,
    loadAuthors, loadDetail: vi.fn(), runAnalysis: vi.fn(),
    renameAuthor: vi.fn(), stageMerge: vi.fn(), unstageMerge: vi.fn(),
    autoMergeDuplicates: vi.fn(), fixDescriptions: vi.fn(),
    applyNormalizationFixes: vi.fn(), pushToAbs: vi.fn(async () => ({ updated: 0, failed: 0, errors: [] })),
    stageChange, updateDetail, discardAllChanges: vi.fn(), setSelectedAuthorId: vi.fn(),
    handleAuthorClick: vi.fn(), handleSelectAll: vi.fn(), handleClearSelection: vi.fn(),
    getSelectedAuthors: (list) => list || [], getSelectedCount: () => 0,
    getIssuesForAuthor: () => [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHook = makeHook();
});

describe('AuthorsPage description editing (CR-7)', () => {
  it('saves an edited description via updateDetail without throwing (no more undefined setDetail)', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    const textarea = screen.getByDisplayValue('Old bio');
    fireEvent.change(textarea, { target: { value: 'New bio' } });

    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    }).not.toThrow();

    expect(stageChange).toHaveBeenCalledWith('a1', 'description', 'New bio');
    expect(updateDetail).toHaveBeenCalledWith('description', 'New bio');
  });
});

describe('AuthorsPage push-to-ABS failure feedback (H5/M-8 critical fix)', () => {
  it('shows an error toast with the specific message when pushToAbs reports the whole batch failed (untrustworthy backend result)', async () => {
    const pushToAbs = vi.fn(async () => ({
      updated: 0,
      failed: 2,
      errors: ['Author push failed: backend returned no result'],
    }));
    mockHook = makeHook({ pendingCount: 2, pushToAbs });
    renderPage();

    fireEvent.click(screen.getByTitle(/Push 2 changes to ABS/i));
    fireEvent.click(screen.getByRole('button', { name: 'Push' }));

    expect(await screen.findByText('Author push failed: backend returned no result')).toBeInTheDocument();
    expect(pushToAbs).toHaveBeenCalled();
  });
});

describe('AuthorsPage suggested_value truthy-check bugs (item 12)', () => {
  // Note: AuthorsPage derives per-author issues from `analysis.issues` via
  // its own issuesByAuthor memo, not from the hook's getIssuesForAuthor
  // helper (that helper isn't called anywhere in this component), so these
  // tests drive it through `analysis`, matching what the component actually
  // reads.
  it('shows the "Suggested:" line for a numeric 0 suggested_value in the issues list', () => {
    mockHook = makeHook({
      analysis: { issues: [{ author_id: 'a1', issue_type: 'sequence_mismatch', message: 'Sequence looks off', suggested_value: 0 }], summary: {} },
    });
    renderPage();
    expect(screen.getByText('Suggested:')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('does not show the "Suggested:" line when suggested_value is absent', () => {
    mockHook = makeHook({
      analysis: { issues: [{ author_id: 'a1', issue_type: 'suspicious', message: 'Looks off' }], summary: {} },
    });
    renderPage();
    expect(screen.queryByText('Suggested:')).not.toBeInTheDocument();
  });

  it('defaults the rename modal value to a suggested_value of 0 instead of falling back to the author name', () => {
    mockHook = makeHook({
      analysis: { issues: [{ author_id: 'a1', issue_type: 'needs_normalization', suggested_value: 0, message: 'Needs normalization' }], summary: {} },
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Rename/i }));
    const input = screen.getByDisplayValue('0');
    expect(input).toBeInTheDocument();
  });

  it('falls back to the author name when suggested_value is an empty string', () => {
    mockHook = makeHook({
      analysis: { issues: [{ author_id: 'a1', issue_type: 'needs_normalization', suggested_value: '', message: 'Needs normalization' }], summary: {} },
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Rename/i }));
    const input = screen.getByDisplayValue('Author One');
    expect(input).toBeInTheDocument();
  });
});
