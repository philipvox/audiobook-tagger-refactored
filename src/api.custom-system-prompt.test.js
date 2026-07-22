// Regression tests for item I (2026-07-22 task 2): every handler that calls
// the AI with the bare SYSTEM_PROMPT constant must use getSystemPrompt(config)
// instead, so a user's custom_system_prompt override actually takes effect.
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

const CUSTOM = 'CUSTOM SYSTEM PROMPT OVERRIDE';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    openai_api_key: 'sk-fake',
    ai_model: 'gpt-5-nano',
    custom_system_prompt: CUSTOM,
  }));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

function systemPromptArgOf(mockCall) {
  return mockCall[1]; // callAI(config, systemPrompt, userPrompt, maxTokens)
}

describe('I: custom_system_prompt honored at every AI call site', () => {
  it('resolve_metadata_batch (cloud individual path)', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ title: 'Dune', author: 'Frank Herbert' }));
    await callBackend('resolve_metadata_batch', {
      books: [{ id: 'b1', current_title: 'Dune', current_author: 'Frank Herbert' }],
    });
    expect(systemPromptArgOf(callAI.mock.calls[0])).toBe(CUSTOM);
  });

  it('resolve_title', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ title: 'Dune', author: 'Frank Herbert' }));
    await callBackend('resolve_title', { request: { current_title: 'Dune', current_author: 'Frank Herbert' } });
    expect(systemPromptArgOf(callAI.mock.calls[0])).toBe(CUSTOM);
  });

  it('resolve_series', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ series: null, sequence: null, confidence: 0 }));
    await callBackend('resolve_series', { request: { title: 'Dune', author: 'Frank Herbert' } });
    expect(systemPromptArgOf(callAI.mock.calls[0])).toBe(CUSTOM);
  });

  it('cleanup_genres_with_gpt', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ genres: ['Fantasy'] }));
    await callBackend('cleanup_genres_with_gpt', { books: [{ id: 'b1', title: 'Dune', author: 'Frank Herbert' }] });
    expect(systemPromptArgOf(callAI.mock.calls[0])).toBe(CUSTOM);
  });

  it('fix_subtitles_batch', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ subtitle: null }));
    await callBackend('fix_subtitles_batch', { books: [{ id: 'b1', title: 'Dune', author: 'Frank Herbert' }] });
    expect(systemPromptArgOf(callAI.mock.calls[0])).toBe(CUSTOM);
  });

  it('fix_years_batch', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ year: '1965' }));
    await callBackend('fix_years_batch', { books: [{ id: 'b1', title: 'Dune', author: 'Frank Herbert' }], force: true });
    expect(systemPromptArgOf(callAI.mock.calls[0])).toBe(CUSTOM);
  });

  it('resolve_book_age_rating', async () => {
    callAI.mockResolvedValueOnce(JSON.stringify({ age_rating: { intended_for_kids: false }, age_rating_reason: 'x' }));
    await callBackend('resolve_book_age_rating', { request: { title: 'Dune', author: 'Frank Herbert' } });
    expect(systemPromptArgOf(callAI.mock.calls[0])).toBe(CUSTOM);
  });

  it('resolve_metadata_batch local-AI batch path', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      use_local_ai: true, ollama_model: 'qwen3:1.7b', custom_system_prompt: CUSTOM,
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
    expect(systemPromptArgOf(callAI.mock.calls[0])).toBe(CUSTOM);
  });

  it('resolve_metadata_batch local-AI batch-failure fallback path', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      use_local_ai: true, ollama_model: 'qwen3:1.7b', custom_system_prompt: CUSTOM,
    }));
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve('not json, batch parse fails');
      return Promise.resolve(JSON.stringify({ title: 'Dune', author: 'Frank Herbert' }));
    });
    // Needs >1 book to take the local-AI BATCH path (isLocalAI && books.length > 1);
    // a single book takes the individual-processing path instead.
    await callBackend('resolve_metadata_batch', {
      books: [
        { id: 'b1', current_title: 'Dune', current_author: 'Frank Herbert' },
        { id: 'b2', current_title: 'Foundation', current_author: 'Isaac Asimov' },
      ],
    });
    // 2nd call is the per-book fallback resolve call.
    expect(systemPromptArgOf(callAI.mock.calls[1])).toBe(CUSTOM);
  });
});
