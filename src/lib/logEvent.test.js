// Tests for the persistent operation log helpers (#58).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatLogLine, logEvent, logBatchStart, logBatchEnd } from './logEvent.js';

// logEvent is fire-and-forget: each call awaits a dynamic import plus the
// backend call, so drain a few macrotasks before asserting on what landed.
async function flushLogs() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('formatLogLine', () => {
  it('renders category and message', () => {
    expect(formatLogLine('batch', 'resolve start')).toBe('[batch] resolve start');
  });

  it('appends a compact JSON detail', () => {
    expect(formatLogLine('batch', 'resolve complete', { succeeded: 12, failed: 2 }))
      .toBe('[batch] resolve complete | {"succeeded":12,"failed":2}');
  });

  it('omits an empty detail rather than logging noise', () => {
    expect(formatLogLine('batch', 'x', {})).toBe('[batch] x');
    expect(formatLogLine('batch', 'x', [])).toBe('[batch] x');
    expect(formatLogLine('batch', 'x', undefined)).toBe('[batch] x');
    expect(formatLogLine('batch', 'x', null)).toBe('[batch] x');
  });

  it('keeps one event on exactly one line', () => {
    const line = formatLogLine('book-error', 'failed\nfor book 3', { message: 'a\r\nb' });
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('failed for book 3');
  });

  it('falls back to a placeholder for an unserializable detail', () => {
    const circular = {};
    circular.self = circular;
    expect(formatLogLine('x', 'y', circular)).toBe('[x] y | "<unserializable detail>"');
  });

  it('truncates a runaway detail', () => {
    const line = formatLogLine('x', 'y', { blob: 'z'.repeat(5000) });
    expect(line.length).toBeLessThan(1100);
    expect(line).toContain('...[truncated]');
  });

  it('defaults a missing category and tolerates a missing message', () => {
    expect(formatLogLine('', 'msg')).toBe('[app] msg');
    expect(formatLogLine(null, undefined)).toBe('[app] ');
  });

  it('serializes a real errorDetail shape', () => {
    const detail = { stage: 'classify', kind: 'http', message: 'OpenAI error 500' };
    expect(formatLogLine('book-error', 'classify failed for book g1', detail))
      .toBe('[book-error] classify failed for book g1 | {"stage":"classify","kind":"http","message":"OpenAI error 500"}');
  });
});

describe('logEvent', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('is a silent no-op in the browser build', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logEvent('batch', 'start', { books: 3 })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('never throws when the backend call rejects', async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.doMock('../api', () => ({
      callBackend: vi.fn(async () => { throw new Error('disk full'); }),
    }));
    const { logEvent: freshLogEvent } = await import('./logEvent.js');

    expect(() => freshLogEvent('batch', 'start', { books: 3 })).not.toThrow();
    // Let the fire-and-forget promise settle; an unhandled rejection here
    // would fail the run.
    await flushLogs();
    vi.doUnmock('../api');
  });

  it('sends the formatted line to append_log in Tauri', async () => {
    window.__TAURI_INTERNALS__ = {};
    const callBackend = vi.fn(async () => undefined);
    vi.doMock('../api', () => ({ callBackend }));
    const { logEvent: freshLogEvent } = await import('./logEvent.js');

    freshLogEvent('batch', 'resolve start', { books: 3 });
    await flushLogs();

    expect(callBackend).toHaveBeenCalledWith('append_log', {
      line: '[batch] resolve start | {"books":3}',
    });
    vi.doUnmock('../api');
  });
});

describe('logBatchStart / logBatchEnd', () => {
  let lines;

  beforeEach(async () => {
    vi.resetModules();
    window.__TAURI_INTERNALS__ = {};
    lines = [];
    vi.doMock('../api', () => ({
      callBackend: vi.fn(async (cmd, args) => { if (cmd === 'append_log') lines.push(args.line); }),
    }));
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.doUnmock('../api');
  });

  it('logs a start line with the book count', async () => {
    const mod = await import('./logEvent.js');
    mod.logBatchStart('resolve', 42);
    await flushLogs();
    expect(lines).toEqual(['[batch] resolve start | {"books":42}']);
  });

  it('logs the end counts plus one line per failed book', async () => {
    const mod = await import('./logEvent.js');
    mod.logBatchEnd(
      'classify',
      { succeeded: 2, failed: 2 },
      [
        { id: 'g1' },
        { id: 'g2', errorDetail: { stage: 'classify', kind: 'http', message: 'HTTP 500' } },
        { id: 'g3', errorDetail: { stage: 'classify', kind: 'network', message: 'offline' } },
      ]
    );
    await flushLogs();

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[batch] classify complete | {"succeeded":2,"failed":2}');
    expect(lines[1]).toContain('classify failed for book g2');
    expect(lines[1]).toContain('"kind":"http"');
    expect(lines[2]).toContain('classify failed for book g3');
  });

  it('tolerates a missing results array', async () => {
    const mod = await import('./logEvent.js');
    expect(() => mod.logBatchEnd('years', { succeeded: 1 }, undefined)).not.toThrow();
    await flushLogs();
    expect(lines).toEqual(['[batch] years complete | {"succeeded":1}']);
  });

  it('names an id-less failed book instead of dropping it', async () => {
    const mod = await import('./logEvent.js');
    mod.logBatchEnd('resolve', { failed: 1 }, [{ errorDetail: { kind: 'parse', message: 'bad' } }]);
    await flushLogs();
    expect(lines[1]).toContain('resolve failed for book unknown');
  });
});
