import { describe, it, expect } from 'vitest';
import { groupDurationSeconds, bookDurationSeconds, dnaLengthFromSeconds, withLengthTags } from './bookLength';

const H = 3600;

describe('groupDurationSeconds', () => {
  it('uses the ABS duration in seconds', () => {
    expect(groupDurationSeconds({ metadata: { duration: 7.5 * H }, files: [] })).toBe(7.5 * H);
  });
  it('falls back to runtime_minutes, then to the sum of the files', () => {
    expect(groupDurationSeconds({ metadata: { runtime_minutes: 90 }, files: [] })).toBe(90 * 60);
    expect(groupDurationSeconds({ metadata: {}, files: [{ duration: 100 }, { duration: 200 }] })).toBe(300);
  });
  it('is null when nothing is known', () => {
    expect(groupDurationSeconds({ metadata: {}, files: [{ duration: 0 }] })).toBeNull();
    expect(groupDurationSeconds(null)).toBeNull();
  });
});

describe('bookDurationSeconds', () => {
  it('reads seconds or minutes from a request book', () => {
    expect(bookDurationSeconds({ duration: 600 })).toBe(600);
    expect(bookDurationSeconds({ duration_minutes: 10 })).toBe(600);
    expect(bookDurationSeconds({})).toBeNull();
  });
});

describe('dnaLengthFromSeconds (matches the DNA prompt: <5h short, 5-12h medium, 12-20h long, 20h+ epic)', () => {
  it('maps the boundaries', () => {
    expect(dnaLengthFromSeconds(4.99 * H)).toBe('short');
    expect(dnaLengthFromSeconds(5 * H)).toBe('medium');
    expect(dnaLengthFromSeconds(11.99 * H)).toBe('medium');
    expect(dnaLengthFromSeconds(12 * H)).toBe('long');
    expect(dnaLengthFromSeconds(20 * H)).toBe('epic');
  });
});

describe('withLengthTags', () => {
  it('replaces a guessed length tag with the real one', () => {
    expect(withLengthTags(['dark', '5-10-hours', 'standalone'], 3 * H))
      .toEqual(['dark', 'standalone', 'under-5-hours']);
  });
  it('adds the length tag when the AI gave none', () => {
    expect(withLengthTags(['dark'], 16 * H)).toEqual(['dark', '15-20-hours']);
  });
  it('replaces dna:length only in a list that has DNA tags', () => {
    expect(withLengthTags(['dna:pacing:fast', 'dna:length:short'], 25 * H, { dna: true }))
      .toEqual(['dna:pacing:fast', 'dna:length:epic']);
    expect(withLengthTags([], 25 * H, { dna: true })).toEqual([]);
  });
  it('leaves tags alone when the duration is unknown', () => {
    expect(withLengthTags(['5-10-hours'], null)).toEqual(['5-10-hours']);
    expect(withLengthTags(['dna:length:short'], 0, { dna: true })).toEqual(['dna:length:short']);
  });
});
