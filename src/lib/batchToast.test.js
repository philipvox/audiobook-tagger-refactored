import { describe, it, expect, vi } from 'vitest';
import { summarizeBatch, scrollToFirstErrorGroup } from './batchToast';

describe('summarizeBatch (V1/V2/V3 copy)', () => {
  it('V1: all success → success toast with "Complete" title', () => {
    const s = summarizeBatch({ op: 'classify', succeeded: 5 });
    expect(s).toEqual({
      type: 'success',
      title: 'Classification Complete',
      message: '5 classified',
      hasWarnings: false,
      hasFailures: false,
    });
  });

  it('V1: success + skipped, zero-count rule drops nothing non-zero', () => {
    const s = summarizeBatch({ op: 'resolve', succeeded: 3, skipped: 2 });
    expect(s.type).toBe('success');
    expect(s.title).toBe('Metadata Resolution Complete');
    expect(s.message).toBe('3 resolved, 2 already ok');
  });

  it('V2: warnings only (no failures) → warning toast, title drops "Complete"', () => {
    const s = summarizeBatch({ op: 'classify', succeeded: 5, warnings: 3 });
    expect(s).toMatchObject({
      type: 'warning',
      title: 'Classification: 5 classified, 3 warnings',
      hasWarnings: true,
      hasFailures: false,
    });
    expect(s.message).toBeUndefined();
  });

  it('V3: failures force error toast, warnings appear after failures', () => {
    const s = summarizeBatch({ op: 'resolve', succeeded: 3, failed: 2, warnings: 1 });
    expect(s.type).toBe('error');
    expect(s.title).toBe('Metadata Resolution: 3 resolved, 2 failed, 1 warnings');
    expect(s.hasFailures).toBe(true);
  });

  it('V3: zero succeeded is dropped from title per the zero-count rule', () => {
    const s = summarizeBatch({ op: 'authors', failed: 4 });
    expect(s.title).toBe('Fix Authors: 4 failed');
  });

  it('skipped only appears in the message, never the title (V2/V3)', () => {
    const s = summarizeBatch({ op: 'years', succeeded: 2, warnings: 1, skipped: 5 });
    expect(s.title).toBe('Fix Years: 2 fixed, 1 warnings');
    expect(s.message).toBe('5 already ok');
  });

  it('nothing to report → null', () => {
    expect(summarizeBatch({ op: 'classify' })).toBeNull();
  });

  it('throws on unknown op', () => {
    expect(() => summarizeBatch({ op: 'bogus', succeeded: 1 })).toThrow(/unknown op/);
  });
});

describe('scrollToFirstErrorGroup (fresh results array)', () => {
  it('returns false for non-arrays and empty/clean results', () => {
    expect(scrollToFirstErrorGroup(null)).toBe(false);
    expect(scrollToFirstErrorGroup([{ id: 'a' }, { id: 'b' }])).toBe(false);
  });

  it('scrolls the first errored book into view (hard failure via error field)', () => {
    document.body.innerHTML = `
      <div data-book-id="a">A</div>
      <div data-book-id="b">B</div>
    `;
    const bEl = document.querySelector('[data-book-id="b"]');
    bEl.scrollIntoView = vi.fn();

    const results = [
      { id: 'a' },
      { id: 'b', error: 'boom' },
    ];
    expect(scrollToFirstErrorGroup(results)).toBe(true);
    expect(bEl.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('derives severity from errorDetail.kind and filters by severity', () => {
    document.body.innerHTML = `
      <div data-book-id="a">A</div>
      <div data-book-id="b">B</div>
    `;
    const aEl = document.querySelector('[data-book-id="a"]');
    aEl.scrollIntoView = vi.fn();
    const bEl = document.querySelector('[data-book-id="b"]');
    bEl.scrollIntoView = vi.fn();

    // 'a' is a warn (empty-content maps to warn), 'b' is a hard http error.
    const results = [
      { id: 'a', errorDetail: { stage: 'dna', kind: 'empty-content', message: 'x' } },
      { id: 'b', errorDetail: { stage: 'classify', kind: 'http', message: 'x' } },
    ];
    expect(scrollToFirstErrorGroup(results, 'error')).toBe(true);
    expect(bEl.scrollIntoView).toHaveBeenCalled();
    expect(aEl.scrollIntoView).not.toHaveBeenCalled();
  });

  it('finds a warn book when severity is warn', () => {
    document.body.innerHTML = `<div data-book-id="a">A</div>`;
    const aEl = document.querySelector('[data-book-id="a"]');
    aEl.scrollIntoView = vi.fn();
    const results = [
      { id: 'a', errorDetail: { stage: 'dna', kind: 'empty-response', message: 'x' } },
    ];
    expect(scrollToFirstErrorGroup(results, 'warn')).toBe(true);
    expect(aEl.scrollIntoView).toHaveBeenCalled();
  });
});

describe('summarizeBatch cancelled runs (M-6)', () => {
  it('says how many were processed and that the rest were cancelled', () => {
    const s = summarizeBatch({ op: 'classify', succeeded: 20, skipped: 3, failed: 2, cancelled: 35 });
    expect(s.type).toBe('error');
    expect(s.title).toBe('Classification cancelled');
    expect(s.message).toBe('25 of 60 processed (20 classified, 2 failed, 3 already ok); the remaining 35 were cancelled.');
  });

  it('a cancel before anything ran still reports', () => {
    const s = summarizeBatch({ op: 'resolve', cancelled: 10 });
    expect(s.type).toBe('warning');
    expect(s.message).toBe('0 of 10 processed; the remaining 10 were cancelled.');
  });
});

describe('summarizeBatch with a batch error or an early stop (Task 9 fix round 1)', () => {
  it('names the first error when every chunk failed', () => {
    const s = summarizeBatch({ op: 'classify', failed: 60, errorMessage: 'Invalid API key' });
    expect(s.type).toBe('error');
    expect(s.title).toBe('Classification: 60 failed');
    expect(s.message).toBe('First error: Invalid API key');
  });

  it('says how many were not processed after an early stop', () => {
    const s = summarizeBatch({ op: 'resolve', failed: 50, notProcessed: 50, errorMessage: 'Invalid API key' });
    expect(s.message).toBe('Stopped after repeated errors; 50 not processed. First error: Invalid API key');
  });

  it('keeps the existing message ahead of the extras', () => {
    const s = summarizeBatch({ op: 'description', succeeded: 5, skipped: 2, failed: 25, errorMessage: 'HTTP 500' });
    expect(s.message).toBe('2 already ok. First error: HTTP 500');
  });
});
