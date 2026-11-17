import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// M-1: a truncated AI answer must never be salvaged as a fragment.
vi.mock('./platform.js', () => ({
  isTauri: vi.fn(() => false),
  getTauriFetch: vi.fn(async () => globalThis.fetch.bind(globalThis)),
}));

const { parseAIJson, callOpenAI, callAnthropic, callOllama } = await import('./proxy.js');

const json = (data) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

describe('parseAIJson: first bracket block only (M-1)', () => {
  it('throws for an answer cut off mid-array', () => {
    expect(() => parseAIJson('{"genres":["Fantasy","Adv')).toThrow(/JSON/i);
  });

  it('returns the block wrapped in prose', () => {
    expect(parseAIJson('Here you go: {"a":1} thanks')).toEqual({ a: 1 });
  });

  it('throws when the first bracket never closes, even if a later complete array exists', () => {
    const text = '{"dna":{"length":"2","pacing": ["slow"], "tags": ["dna:length:2"]';
    expect(() => parseAIJson(text)).toThrow(/JSON/i);
    expect(() => parseAIJson('{"tags": ["a", "b"] and then nothing')).toThrow(/JSON/i);
  });

  it('does not fall back to a nested block of a truncated DNA answer', () => {
    // The audited case: a DNA answer cut mid-array became ["dna:length:2"].
    expect(() => parseAIJson('{"tags":["dna:length:2"],"more":["dna:pac')).toThrow(/JSON/i);
  });

  it('throws when the first block balances but is not JSON, instead of trying a later block', () => {
    expect(() => parseAIJson('Note {fantasy} then {"genres":["Fantasy"]}')).toThrow(/JSON/i);
  });

  it('still accepts a ```json fenced block', () => {
    expect(parseAIJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseAIJson('Sure:\n```json\n[1,2]\n```\nDone')).toEqual([1, 2]);
  });
});

describe('AI provider truncation signals (M-1)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('rejects an OpenAI Responses answer with status incomplete', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '{"genres":["Fantasy"]}',
    }));
    await expect(callOpenAI('sk', 'gpt-5-nano', 's', 'u', 100)).rejects.toThrow(/truncated/);
  });

  it('rejects an OpenAI Chat answer with finish_reason length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      choices: [{ finish_reason: 'length', message: { content: '{"genres":["Fan' } }],
    }));
    // A custom OpenAI-compatible server: the official API no longer serves a Chat-only model.
    await expect(callOpenAI('sk', 'gpt-4o-mini', 's', 'u', 100, 'https://llm.example')).rejects.toThrow(/truncated/);
  });

  it('rejects an Anthropic answer with stop_reason max_tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"genres":["Fantasy"]}' }],
    }));
    await expect(callAnthropic('key', 'claude-haiku-4-5', 's', 'u', 100)).rejects.toThrow(/truncated/);
  });

  it('rejects an Ollama answer with done_reason length', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      done_reason: 'length',
      message: { content: '{"genres":["Fan' },
    }));
    await expect(callOllama('s', 'u', { model: 'qwen3:4b', baseUrl: 'http://127.0.0.1:11434' }))
      .rejects.toThrow(/truncated/);
  });

  it('still returns a complete OpenAI and Anthropic answer', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ status: 'completed', output_text: '{"a":1}' }))
      .mockResolvedValueOnce(json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"b":2}' }] }));
    await expect(callOpenAI('sk', 'gpt-5-nano', 's', 'u', 100)).resolves.toBe('{"a":1}');
    await expect(callAnthropic('key', 'claude-haiku-4-5', 's', 'u', 100)).resolves.toBe('{"b":2}');
  });
});

describe('error kinds (fix round 1)', async () => {
  const { errorDetailFromException, severityForKind } = await import('./errorDetail.js');

  it('a truncated answer is reported as a parse failure, not a network one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }));
    const err = await callAnthropic('key', 'claude-haiku-4-5', 's', 'u', 100).catch(e => e);
    const detail = errorDetailFromException(err, { stage: 'classify' });
    expect(detail.kind).toBe('parse');
    expect(severityForKind(detail.kind)).toBe('error');
    vi.restoreAllMocks();
  });

  it('low-confidence is a warning kind', () => {
    expect(severityForKind('low-confidence')).toBe('warn');
  });
});
