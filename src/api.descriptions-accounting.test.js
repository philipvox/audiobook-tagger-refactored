// Regression test for item N (2026-07-22 task 2): process_descriptions_batch
// previously counted total_processed as "changed" books only, undercounting
// books the AI successfully validated and kept as-is. total_processed must
// count ALL successful results (changed or kept); total_unchanged tracks the
// kept ones separately.
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
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    openai_api_key: 'sk-fake', ai_model: 'gpt-5-nano',
  }));
  vi.resetAllMocks();
  parseAIJson.mockImplementation((s) => JSON.parse(s));
});

describe('N: process_descriptions_batch accounting', () => {
  it('counts total_processed as all successful results (changed AND kept), and adds total_unchanged for kept ones', async () => {
    let call = 0;
    callAI.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(JSON.stringify({ description: 'New desc.', action: 'rewritten', reason: 'was garbage' }));
      if (call === 2) return Promise.resolve(JSON.stringify({ description: 'Same desc.', action: 'kept', reason: 'already good' }));
      return Promise.reject(new Error('OpenAI error 500: internal'));
    });

    const result = await callBackend('process_descriptions_batch', {
      books: [
        { id: 'b1', title: 'Rewritten Book' },
        { id: 'b2', title: 'Kept Book' },
        { id: 'b3', title: 'Failed Book' },
      ],
    });

    expect(result.total_processed).toBe(2); // b1 (changed) + b2 (kept), both success:true
    expect(result.total_unchanged).toBe(1); // b2 only
    expect(result.total_failed).toBe(1); // b3
  });
});
