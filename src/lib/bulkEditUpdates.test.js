import { describe, it, expect } from 'vitest';
import { computeBulkUpdates } from './bulkEditUpdates';

describe('computeBulkUpdates (H1/M10 bulk-edit precedence)', () => {
  it('does not manufacture a change for a checked field left at its prefilled common value', () => {
    const updates = computeBulkUpdates({
      fieldsToEdit: { author: true },
      clearFields: {},
      values: { author: 'A. Author' },
      commonValues: { author: 'A. Author' },
    });
    expect(updates).toEqual({});
  });

  it('emits a field only when its value is non-empty AND changed from the common value', () => {
    const updates = computeBulkUpdates({
      fieldsToEdit: { author: true, publisher: true },
      clearFields: {},
      values: { author: 'New Author', publisher: '' }, // publisher blank => skip
      commonValues: { author: 'Old Author' },
    });
    expect(updates).toEqual({ author: 'New Author' });
  });

  it('series with a name but a blank number updates the name only', () => {
    const updates = computeBulkUpdates({
      fieldsToEdit: { series: true },
      clearFields: {},
      values: { series: 'Wheel of Time', sequence: '' },
      commonValues: {},
    });
    expect(updates).toEqual({ series: 'Wheel of Time' });
    expect('sequence' in updates).toBe(false);
  });

  it('series with a number but a blank name updates the number only', () => {
    const updates = computeBulkUpdates({
      fieldsToEdit: { series: true },
      clearFields: {},
      values: { series: '', sequence: '3' },
      commonValues: {},
    });
    expect(updates).toEqual({ sequence: '3' });
  });

  it('an explicit clear emits an intentional empty value (null / [])', () => {
    const updates = computeBulkUpdates({
      fieldsToEdit: { author: true, genres: true, series: true },
      clearFields: { author: true, genres: true, series: true },
      values: { author: 'ignored', genres: 'ignored', series: 'ignored', sequence: 'ignored' },
      commonValues: {},
    });
    expect(updates.author).toBeNull();
    expect(updates.genres).toEqual([]);
    expect(updates.series).toBeNull();
    expect(updates.sequence).toBeNull();
  });

  it('caps genres at 3 and skips when equal to the common value', () => {
    const capped = computeBulkUpdates({
      fieldsToEdit: { genres: true },
      clearFields: {},
      values: { genres: 'A, B, C, D, E' },
      commonValues: {},
    });
    expect(capped.genres).toEqual(['A', 'B', 'C']);

    const noop = computeBulkUpdates({
      fieldsToEdit: { genres: true },
      clearFields: {},
      values: { genres: 'Fantasy, Fiction' },
      commonValues: { genres: 'Fantasy, Fiction' },
    });
    expect(noop).toEqual({});
  });

  it('ignores fields that are not checked', () => {
    const updates = computeBulkUpdates({
      fieldsToEdit: { author: false },
      clearFields: {},
      values: { author: 'Someone' },
      commonValues: {},
    });
    expect(updates).toEqual({});
  });
});
