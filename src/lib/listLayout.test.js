import { describe, it, expect } from 'vitest';
import { computeListMetrics } from './listLayout';

const opts = { rowHeight: 80, fileRowHeight: 37 };

describe('computeListMetrics (L7 expanded-row virtualization geometry)', () => {
  it('is a plain grid of rowHeight when nothing is expanded', () => {
    const groups = [{ id: 'a', files: [] }, { id: 'b', files: [] }, { id: 'c', files: [] }];
    const m = computeListMetrics(groups, new Set(), 0, opts);
    expect(m.totalHeight).toBe(3 * 80);
    expect(m.offsetY).toBe(0);
  });

  it('adds the expanded row files height to totalHeight', () => {
    const groups = [{ id: 'a', files: [{}, {}] }, { id: 'b', files: [] }];
    const m = computeListMetrics(groups, new Set(['a']), 0, opts);
    expect(m.totalHeight).toBe(2 * 80 + 2 * 37);
  });

  it('offsetY includes expanded rows above the visible window', () => {
    const groups = [{ id: 'a', files: [{}, {}] }, { id: 'b', files: [] }, { id: 'c', files: [] }];
    // 'a' (expanded, index 0) is above visibleStart=1, so its extra pushes the block.
    const m = computeListMetrics(groups, new Set(['a']), 1, opts);
    expect(m.offsetY).toBe(1 * 80 + 2 * 37);
  });

  it('does not add offset for an expanded row at/after the visible window', () => {
    const groups = [{ id: 'a', files: [] }, { id: 'b', files: [{}, {}] }];
    const m = computeListMetrics(groups, new Set(['b']), 1, opts);
    // 'b' is at visibleStart, not above it -> no offset contribution.
    expect(m.offsetY).toBe(1 * 80);
    expect(m.totalHeight).toBe(2 * 80 + 2 * 37);
  });
});
