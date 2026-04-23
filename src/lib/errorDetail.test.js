import { describe, it, expect } from 'vitest';
import {
  ERROR_STAGES,
  ERROR_KINDS,
  makeErrorDetail,
  errorDetailFromException,
  severityForKind,
} from './errorDetail.js';

describe('makeErrorDetail', () => {
  it('returns a normalized detail when all required fields are valid', () => {
    const d = makeErrorDetail({
      stage: 'dna',
      kind: 'parse',
      message: '  JSON parse error at position 42 ',
    });
    expect(d).toEqual({ stage: 'dna', kind: 'parse', message: 'JSON parse error at position 42' });
  });

  it('includes optional fields when provided', () => {
    const d = makeErrorDetail({
      stage: 'lookup-asin',
      kind: 'http',
      message: 'Audible returned HTML',
      responsePreview: '<!DOCTYPE html>',
      statusCode: 502,
      url: 'https://api.audible.com/1.0/catalog/products?title=Foo',
    });
    expect(d).toMatchObject({
      stage: 'lookup-asin',
      kind: 'http',
      statusCode: 502,
      url: 'https://api.audible.com/1.0/catalog/products?title=Foo',
      responsePreview: '<!DOCTYPE html>',
    });
  });

  it('truncates responsePreview beyond 500 chars and marks it', () => {
    const big = 'x'.repeat(1200);
    const d = makeErrorDetail({ stage: 'dna', kind: 'parse', message: 'fail', responsePreview: big });
    expect(d.responsePreview.length).toBe(500 + '...[truncated]'.length);
    expect(d.responsePreview.endsWith('...[truncated]')).toBe(true);
  });

  it('omits responsePreview if not provided', () => {
    const d = makeErrorDetail({ stage: 'dna', kind: 'parse', message: 'fail' });
    expect(d.responsePreview).toBeUndefined();
  });

  it('rejects unknown stage', () => {
    expect(() => makeErrorDetail({ stage: 'bogus', kind: 'parse', message: 'x' })).toThrow(/unknown stage/);
  });

  it('rejects unknown kind', () => {
    expect(() => makeErrorDetail({ stage: 'dna', kind: 'bogus', message: 'x' })).toThrow(/unknown kind/);
  });

  it('rejects empty message', () => {
    expect(() => makeErrorDetail({ stage: 'dna', kind: 'parse', message: '   ' })).toThrow(/message is required/);
  });

  it('omits statusCode unless a real integer', () => {
    const d = makeErrorDetail({ stage: 'dna', kind: 'parse', message: 'x', statusCode: '200' });
    expect(d.statusCode).toBeUndefined();
  });

  it('exposes the 10 stages and 6 kinds frozen', () => {
    expect(ERROR_STAGES).toHaveLength(10);
    expect(ERROR_KINDS).toHaveLength(6);
    expect(Object.isFrozen(ERROR_STAGES)).toBe(true);
    expect(Object.isFrozen(ERROR_KINDS)).toBe(true);
  });
});

describe('severityForKind', () => {
  it('maps empty-response and empty-content to warn', () => {
    expect(severityForKind('empty-response')).toBe('warn');
    expect(severityForKind('empty-content')).toBe('warn');
  });

  it('maps network/http/parse/schema to error', () => {
    expect(severityForKind('network')).toBe('error');
    expect(severityForKind('http')).toBe('error');
    expect(severityForKind('parse')).toBe('error');
    expect(severityForKind('schema')).toBe('error');
  });

  it('falls back to error for unknown kinds so they stay visible', () => {
    expect(severityForKind('bogus')).toBe('error');
    expect(severityForKind(undefined)).toBe('error');
    expect(severityForKind(null)).toBe('error');
  });
});

describe('errorDetailFromException', () => {
  it('infers kind=parse from a JSON.parse-style message', () => {
    const err = new Error("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
    const d = errorDetailFromException(err, { stage: 'lookup-asin' });
    expect(d.kind).toBe('parse');
    expect(d.message).toContain('Unexpected token');
  });

  it('infers kind=http from an "error 429" style message', () => {
    const err = new Error('Ollama error 429: rate limited');
    const d = errorDetailFromException(err, { stage: 'dna' });
    expect(d.kind).toBe('http');
  });

  it('falls back to kind=network for ambiguous errors', () => {
    const err = new Error('connect ECONNREFUSED');
    const d = errorDetailFromException(err, { stage: 'gather-audnexus' });
    expect(d.kind).toBe('network');
  });

  it('accepts an explicit kind override', () => {
    const err = new Error('whatever');
    const d = errorDetailFromException(err, { stage: 'dna', kind: 'schema' });
    expect(d.kind).toBe('schema');
  });

  it('passes through url and responsePreview', () => {
    const err = new Error('boom');
    const d = errorDetailFromException(err, {
      stage: 'lookup-asin',
      url: 'https://api.audible.com/',
      responsePreview: '<!DOCTYPE html>',
    });
    expect(d.url).toBe('https://api.audible.com/');
    expect(d.responsePreview).toBe('<!DOCTYPE html>');
  });
});
