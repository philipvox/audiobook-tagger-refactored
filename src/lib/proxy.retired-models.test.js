import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// OpenAI retires gpt-5-nano on 2026-12-11 (and GPT-4o, 4o mini, 4.1, 4.1 mini,
// gpt-5.4-nano later), naming gpt-6-luna as the replacement.
vi.mock('./platform.js', () => ({
  isTauri: vi.fn(() => false),
  getTauriFetch: vi.fn(async () => globalThis.fetch.bind(globalThis)),
}));

const { callOpenAI, resolveOpenAIModel, usesResponsesApi, lowestReasoningEffort } = await import('./proxy.js');

const responsesOk = () => new Response(JSON.stringify({ status: 'completed', output_text: '{"ok":true}' }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

let fetchMock;
beforeEach(() => { fetchMock = vi.fn(async () => responsesOk()); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);
const sentUrl = () => String(fetchMock.mock.calls[0][0]);

describe('retired OpenAI models', () => {
  it('maps every retired model to gpt-6-luna on the official API', () => {
    for (const m of ['gpt-5-nano', 'gpt-5-nano-2025-08-07', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5.4-nano']) {
      expect(resolveOpenAIModel(m)).toBe('gpt-6-luna');
      expect(resolveOpenAIModel(m, 'https://api.openai.com')).toBe('gpt-6-luna');
    }
  });

  it('leaves current and non-OpenAI models alone', () => {
    for (const m of ['gpt-6-luna', 'gpt-5.4-mini', 'claude-haiku-4-5-20251001', 'qwen3:4b']) {
      expect(resolveOpenAIModel(m)).toBe(m);
    }
  });

  it('never remaps on a custom base URL, which may serve its own model under the name', () => {
    expect(resolveOpenAIModel('gpt-4o-mini', 'https://llm.example')).toBe('gpt-4o-mini');
    expect(resolveOpenAIModel('gpt-5-nano', 'http://localhost:1234')).toBe('gpt-5-nano');
  });

  it('sends gpt-6-luna for a saved gpt-5-nano, via the Responses API with effort none', async () => {
    await callOpenAI('sk', 'gpt-5-nano', 's', 'u', 100);
    expect(sentUrl()).toMatch(/\/v1\/responses$/);
    expect(sentBody().model).toBe('gpt-6-luna');
    expect(sentBody().reasoning).toEqual({ effort: 'none' });
    expect(sentBody()).not.toHaveProperty('temperature');
  });

  it('gpt-5.4-mini keeps effort minimal', async () => {
    await callOpenAI('sk', 'gpt-5.4-mini', 's', 'u', 100);
    expect(sentBody().model).toBe('gpt-5.4-mini');
    expect(sentBody().reasoning).toEqual({ effort: 'minimal' });
  });

  it('routes gpt-5 and later to the Responses API, older models to Chat Completions', () => {
    expect(usesResponsesApi('gpt-6-luna')).toBe(true);
    expect(usesResponsesApi('gpt-5.4-mini')).toBe(true);
    expect(usesResponsesApi('gpt-4o-mini')).toBe(false);
    expect(lowestReasoningEffort('gpt-6-luna')).toBe('none');
    expect(lowestReasoningEffort('gpt-5.4-mini')).toBe('minimal');
  });
});
