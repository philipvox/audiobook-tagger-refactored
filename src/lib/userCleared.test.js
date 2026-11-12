import { describe, it, expect } from 'vitest';
import { userClearedPatch } from './userCleared';

describe('userClearedPatch', () => {
  it('adds the field when the edit leaves the list empty', () => {
    expect(userClearedPatch({}, { tags: [] })).toEqual({ user_cleared: ['tags'] });
  });
  it('removes it again when the list becomes non-empty', () => {
    expect(userClearedPatch({ user_cleared: ['tags', 'genres'] }, { tags: ['a'] })).toEqual({ user_cleared: ['genres'] });
  });
  it('ignores edits that do not touch genres or tags', () => {
    expect(userClearedPatch({ user_cleared: ['tags'] }, { title: 'x' })).toEqual({});
  });
  it('does not flag a null value as a clear', () => {
    expect(userClearedPatch({}, { genres: null })).toEqual({ user_cleared: [] });
  });
});
