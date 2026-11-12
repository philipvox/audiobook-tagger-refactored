// Final review fix D-4 / I-3: Check by Audio sends a locally scanned book as
// local (never toward ABS), and the per-book message and the summary name the
// real cause, counting cancelled and timed-out books separately.
//
// Contract (src-tauri/src/whisper.rs AudioIntroResult): each result has
// `status` "ok" | "failed" | "cancelled" | "timed_out" and `error` when it
// stopped early. batch_extract_audio_intros stops at a cancel and returns no
// result for the books it never reached.

import { describe, it, expect, vi } from 'vitest';
import { ENRICH_ACTIONS, runEnrichAction } from './enrichActions.js';
import { applyAudioResult, tallyOutcomes } from './applyAiResults.js';
import { summarizeBatch } from './batchToast.js';

const local = (id = 'uuid-1') => ({ id, files: [{ id: `${id}-f0`, path: `/books/${id}.m4b`, ino: null }], metadata: { title: 'L' } });
const abs = (id = 'li_1') => ({ id, abs_id: id, source: 'abs', files: [{ id: `${id}-f0`, path: '/srv/a.m4b', ino: '42' }], metadata: { title: 'A' } });
const cfg = { abs_base_url: 'http://abs', abs_api_token: 'tok', openai_api_key: 'sk' };

describe('audio_check request items', () => {
  it('a scanned book (uuid id, no source, no abs_id) is sent as local with its file and no ABS credentials', async () => {
    const callBackend = vi.fn(async () => []);
    await ENRICH_ACTIONS.audio_check.callChunk([local()], { config: cfg }, callBackend);
    const item = callBackend.mock.calls[0][1].items[0];
    expect(item).toMatchObject({ item_id: 'uuid-1', source: 'local', file_path: '/books/uuid-1.m4b' });
    expect(item.abs_base_url).toBeNull();
    expect(item.abs_api_token).toBeNull();
  });

  it('an ABS book is sent as abs with its item id and the ABS connection', async () => {
    const callBackend = vi.fn(async () => []);
    await ENRICH_ACTIONS.audio_check.callChunk([abs()], { config: cfg }, callBackend);
    expect(callBackend.mock.calls[0][1].items[0]).toMatchObject({ item_id: 'li_1', source: 'abs', abs_base_url: 'http://abs', abs_api_token: 'tok' });
  });
});

describe('applyAudioResult names the cause', () => {
  it('a rejected call shows its error', () => {
    const out = applyAudioResult(local(), { success: false, error: 'No OpenAI API key configured' });
    expect(out.outcome).toBe('failed');
    expect(out.group.lastError.message).toContain('No OpenAI API key configured');
  });

  it('a failed item shows the Rust error', () => {
    const out = applyAudioResult(local(), { item_id: 'uuid-1', transcript: null, narrators: [], authors: [], status: 'failed', error: 'FFmpeg failed: boom' });
    expect(out.outcome).toBe('failed');
    expect(out.group.lastError.message).toContain('FFmpeg failed: boom');
  });

  it('a cancelled item is not a failure and puts no error on the book', () => {
    const out = applyAudioResult(local(), { item_id: 'uuid-1', transcript: null, narrators: [], authors: [], status: 'cancelled', error: 'Cancelled' });
    expect(out.outcome).toBe('cancelled');
    expect(out.group.lastError).toBeUndefined();
  });

  it('a timed-out item is its own outcome with its message', () => {
    const out = applyAudioResult(local(), { item_id: 'uuid-1', transcript: null, narrators: [], authors: [], status: 'timed_out', error: 'Timed out after 5 minutes' });
    expect(out.outcome).toBe('timedout');
    expect(out.group.lastError.message).toContain('Timed out after 5 minutes');
  });

  it('a transcript with no status (cached before the field existed) is still ok', () => {
    const out = applyAudioResult(local(), { item_id: 'uuid-1', transcript: 'x', narrators: ['Jim Dale'], authors: [] }, 'narrator');
    expect(out.outcome).toBe('changed');
  });
});

describe('the summary counts cancelled and timed-out books separately', () => {
  it('tallies and words them', () => {
    const { counts } = tallyOutcomes([
      { id: 'a', outcome: 'changed' }, { id: 'b', outcome: 'cancelled' }, { id: 'c', outcome: 'timedout' }, { id: 'd', outcome: 'failed' },
    ]);
    expect(counts).toMatchObject({ succeeded: 1, cancelled: 1, timedOut: 1, failed: 1 });
    const s = summarizeBatch({ op: 'audio_check', ...counts });
    expect(s.type).toBe('error');
    expect(s.message).toMatch(/1 timed out/);
    expect(s.message).toMatch(/1 was cancelled/);
  });

  it('a run stopped by Cancel counts the books it never reached as cancelled', async () => {
    const groups = [local('a'), local('b'), local('c')];
    const callBackend = vi.fn(async () => [
      { item_id: 'a', transcript: 'x', narrators: ['N'], authors: [], status: 'ok' },
      { item_id: 'b', transcript: null, narrators: [], authors: [], status: 'cancelled', error: 'Cancelled' },
      // 'c' was never reached: Rust returns no result for it.
    ]);
    const toast = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() };
    let state = groups;
    const setGroups = (fn) => { state = fn(state); };
    const { counts } = await runEnrichAction('audio_check', groups, { callBackend, setGroups, toast, ctx: { config: {}, field: 'narrator' } });
    expect(counts).toMatchObject({ succeeded: 1, cancelled: 2, failed: 0 });
    const [title, message] = toast.warning.mock.calls[0];
    expect(title).toBe('Audio Check cancelled');
    expect(message).toMatch(/1 of 3 processed/);
  });
});
