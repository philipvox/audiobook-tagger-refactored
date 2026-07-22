import { describe, it, expect } from 'vitest';
import { parseAIJson } from './proxy';

describe('parseAIJson - robust extraction (item 8)', () => {
  it('parses plain JSON with no wrapping', () => {
    expect(parseAIJson('{"title":"Dune"}')).toEqual({ title: 'Dune' });
  });

  it('parses JSON wrapped in ```json fences', () => {
    const text = '```json\n{"title":"Dune"}\n```';
    expect(parseAIJson(text)).toEqual({ title: 'Dune' });
  });

  it('parses JSON wrapped in bare ``` fences', () => {
    const text = '```\n{"title":"Dune"}\n```';
    expect(parseAIJson(text)).toEqual({ title: 'Dune' });
  });

  it('extracts a JSON object from prose wrapped around it', () => {
    const text = 'Sure, here is the metadata you asked for:\n{"title":"Dune","author":"Frank Herbert"}\nLet me know if you need anything else.';
    expect(parseAIJson(text)).toEqual({ title: 'Dune', author: 'Frank Herbert' });
  });

  it('extracts a JSON object followed by trailing commentary', () => {
    const text = '{"title":"Dune"}\n\nThis is my best guess based on the title alone.';
    expect(parseAIJson(text)).toEqual({ title: 'Dune' });
  });

  it('extracts a JSON array wrapped in prose', () => {
    const text = 'Here are the results: [{"id":"b1"},{"id":"b2"}] Hope that helps!';
    expect(parseAIJson(text)).toEqual([{ id: 'b1' }, { id: 'b2' }]);
  });

  it('extracts JSON from fences AND surrounding prose together', () => {
    const text = 'Here you go:\n```json\n{"title":"Dune"}\n```\nEnjoy!';
    expect(parseAIJson(text)).toEqual({ title: 'Dune' });
  });

  it('respects braces inside string values when scanning for the balanced block', () => {
    const text = 'Notes: {"description":"A story about a {lost} kingdom","title":"Foo"} - done';
    expect(parseAIJson(text)).toEqual({ description: 'A story about a {lost} kingdom', title: 'Foo' });
  });

  it('respects escaped quotes inside string values', () => {
    const text = 'result -> {"title":"The \\"Great\\" Escape"} <- end';
    expect(parseAIJson(text)).toEqual({ title: 'The "Great" Escape' });
  });

  it('respects a string value ending in an escaped backslash right before the closing quote', () => {
    const text = 'blah {"path":"C:\\\\"} blah';
    expect(parseAIJson(text)).toEqual({ path: 'C:\\' });
  });

  it('handles a nested object inside an array', () => {
    const text = 'array output: [{"id":"b1","meta":{"a":1,"b":[1,2,3]}},{"id":"b2"}] thanks';
    expect(parseAIJson(text)).toEqual([{ id: 'b1', meta: { a: 1, b: [1, 2, 3] } }, { id: 'b2' }]);
  });

  it('preserves a literal ``` fence sequence inside a JSON string value, even when the whole response is also fence-wrapped and surrounded by prose', () => {
    // Regression for a real corruption bug: a global `.replace(/```/g, '')`
    // over the entire raw text would delete this ``` sequence too, since it
    // can't distinguish "fence markers wrapping the payload" from "a literal
    // backtick sequence inside a JSON string value". The fix must never
    // mutate characters inside the JSON payload itself.
    const text = 'Here you go:\n```json\n{"description":"use ```json blocks for code samples"}\n```\nHope that helps!';
    expect(parseAIJson(text)).toEqual({ description: 'use ```json blocks for code samples' });
  });

  it('skips an unparseable earlier balanced block and parses valid JSON later in the text', () => {
    // Small local models often emit a <thinking> block first; a stray brace
    // pair in that prose balances but is not valid JSON, and the real JSON
    // comes after it. The first balanced block must not be the final word.
    const text = '<thinking>maybe {fantasy}</thinking>{"genres":["Fantasy"]}';
    expect(parseAIJson(text)).toEqual({ genres: ['Fantasy'] });
  });

  it('throws a JSON-mentioning error for pure garbage with no parseable block', () => {
    expect(() => parseAIJson('sorry, I cannot help with that request.')).toThrow(/JSON/i);
  });

  it('throws for an unbalanced/truncated block with no valid extraction', () => {
    expect(() => parseAIJson('{"title": "Dune", "author": "Frank Herbert"')).toThrow(/JSON/i);
  });
});
