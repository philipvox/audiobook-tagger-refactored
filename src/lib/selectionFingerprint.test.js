import { describe, it, expect } from 'vitest';
import { listFingerprint } from './selectionFingerprint';

describe('listFingerprint (M13 shift-click anchor validity)', () => {
  it('is stable for the same list', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(listFingerprint(list)).toBe(listFingerprint(list));
  });

  it('changes when length changes', () => {
    const a = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const b = [{ id: 'a' }, { id: 'b' }];
    expect(listFingerprint(a)).not.toBe(listFingerprint(b));
  });

  it('changes when the first or last id changes (reorder / filter swap)', () => {
    const a = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const reordered = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
    const swapped = [{ id: 'x' }, { id: 'b' }, { id: 'c' }];
    expect(listFingerprint(a)).not.toBe(listFingerprint(reordered));
    expect(listFingerprint(a)).not.toBe(listFingerprint(swapped));
  });

  it('handles empty and non-array input', () => {
    expect(listFingerprint([])).toBe('0::');
    expect(listFingerprint(null)).toBe('0::');
    expect(listFingerprint(undefined)).toBe('0::');
  });
});
