// Regression tests for items O/P (2026-07-22 task 2): token budgets were too
// tight for the Responses API, which counts reasoning tokens against the
// output budget - small budgets could get truncated before any visible JSON
// came out. resolve_metadata_batch's local-AI batch call goes to
// BATCH_SIZE*400 (was *200); fix_authors_batch / fix_years_batch go to 600
// (was 200).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAI: vi.fn(),
    parseAIJson: vi.fn((s) => JSON.parse(s)),
  };
});

const { callBackend } = await import('./api.js');
const { callAI, parseAIJson } = await import('./lib/proxy');

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

function maxTokensArgOf(mockCall) {
  return mockCall[3]; // callAI(config, systemPrompt, userPrompt, maxTokens)
}

describe('O/P: token budgets raised for reasoning-token-hungry endpoints', () => {
  it('resolve_metadata_batch local-AI batch call uses BATCH_SIZE * 400', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      use_local_ai: true, ollama_model: 'qwen3:1.7b',
    }));
    callAI.mockResolvedValueOnce(JSON.stringify([
      { id: 'b1', title: 'Dune', author: 'Frank Herbert' },
      { id: 'b2', title: 'Foundation', author: 'Isaac Asimov' },
    ]));
    await callBackend('resolve_metadata_batch', {
      books: [
        { id: 'b1', current_title: 'Dune', current_author: 'Frank Herbert' },
        { id: 'b2', current_title: 'Foundation', current_author: 'Isaac Asimov' },
      ],
    });
    // BATCH_SIZE for local AI is 3 (fixed constant in resolve_metadata_batch).
    expect(maxTokensArgOf(callAI.mock.calls[0])).toBe(3 * 400);
  });

  it('fix_authors_batch uses maxTokens 600', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      openai_api_key: 'sk-fake', ai_model: 'gpt-5-nano',
    }));
    callAI.mockResolvedValueOnce(JSON.stringify({ author: 'Frank Herbert', confidence: 90 }));
    await callBackend('fix_authors_batch', {
      books: [{ id: 'b1', title: 'Dune', current_author: 'Unknown' }],
    });
    expect(maxTokensArgOf(callAI.mock.calls[0])).toBe(600);
  });

  it('fix_years_batch uses maxTokens 600', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      openai_api_key: 'sk-fake', ai_model: 'gpt-5-nano',
    }));
    callAI.mockResolvedValueOnce(JSON.stringify({ year: '1965' }));
    await callBackend('fix_years_batch', {
      books: [{ id: 'b1', title: 'Dune', author: 'Frank Herbert' }],
      force: true,
    });
    expect(maxTokensArgOf(callAI.mock.calls[0])).toBe(600);
  });
});
