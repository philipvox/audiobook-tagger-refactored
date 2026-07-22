// Regression tests for the 2026-07-21 audit: ABS write-path integrity (task 1).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    absApi: vi.fn(),
    callAI: vi.fn(),
    parseAIJson: vi.fn((s) => JSON.parse(s)),
  };
});

const { callBackend } = await import('./api.js');
const { absApi } = await import('./lib/proxy');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('audiobook_tagger_config', JSON.stringify({
    abs_base_url: 'http://abs.local',
    abs_api_token: 'token',
  }));
  vi.resetAllMocks();
  absApi.mockResolvedValue({});
});

async function pushUpdatesAndGetPayload(meta, idField = 'abs_id') {
  const item = { metadata: meta };
  item[idField] = 'item-1';
  const result = await callBackend('push_abs_updates', { items: [item] });
  expect(result.success).toBe(1);
  expect(result.failed).toBe(0);
  const options = absApi.mock.calls.at(-1)[3];
  return options.body;
}

describe('CR-4a: buildAbsPayload omits series key when there is no series info', () => {
  it('omits metadata.series entirely when meta has no series/all_series', async () => {
    const payload = await pushUpdatesAndGetPayload({ title: 'Some Book' });
    expect(payload.metadata).not.toHaveProperty('series');
  });

  it('omits metadata.series when all_series is an explicit empty array', async () => {
    const payload = await pushUpdatesAndGetPayload({ title: 'Some Book', all_series: [] });
    expect(payload.metadata).not.toHaveProperty('series');
  });

  it('omits metadata.series when meta.series is an empty string', async () => {
    const payload = await pushUpdatesAndGetPayload({ title: 'Some Book', series: '' });
    expect(payload.metadata).not.toHaveProperty('series');
  });

  it('still includes series when meta.series is a non-empty string', async () => {
    const payload = await pushUpdatesAndGetPayload({ series: 'Dune' });
    expect(payload.metadata.series).toEqual([{ name: 'Dune' }]);
  });

  it('still includes series when all_series is non-empty', async () => {
    const payload = await pushUpdatesAndGetPayload({ all_series: [{ name: 'Dune', sequence: '1' }] });
    expect(payload.metadata.series).toEqual([{ name: 'Dune', sequence: '1' }]);
  });
});

describe('J: push handlers unify on item.abs_id || item.id', () => {
  it('push_abs_updates uses abs_id when both abs_id and id are present', async () => {
    absApi.mockResolvedValue({});
    await callBackend('push_abs_updates', {
      items: [{ abs_id: 'correct-id', id: 'wrong-id', metadata: { title: 'X' } }],
    });
    const url = absApi.mock.calls.at(-1)[2];
    expect(url).toContain('correct-id');
    expect(url).not.toContain('wrong-id');
  });

  it('push_abs_imports uses abs_id when both abs_id and id are present', async () => {
    absApi.mockResolvedValue({});
    await callBackend('push_abs_imports', {
      items: [{ abs_id: 'correct-id', id: 'wrong-id', metadata: { title: 'X' } }],
    });
    const url = absApi.mock.calls.at(-1)[2];
    expect(url).toContain('correct-id');
    expect(url).not.toContain('wrong-id');
  });

  it('push_abs_imports falls back to id when abs_id is absent', async () => {
    absApi.mockResolvedValue({});
    await callBackend('push_abs_imports', {
      items: [{ id: 'only-id', metadata: { title: 'X' } }],
    });
    const url = absApi.mock.calls.at(-1)[2];
    expect(url).toContain('only-id');
  });
});

describe('L: sequence 0 is preserved, empty-string sequence is treated as absent', () => {
  it('buildAbsPayload (all_series branch) treats empty-string sequence as absent, keeps stripped fallback', async () => {
    const payload = await pushUpdatesAndGetPayload({ all_series: [{ name: 'Harry Potter #3', sequence: '' }] });
    expect(payload.metadata.series).toEqual([{ name: 'Harry Potter', sequence: '3' }]);
  });

  it('buildAbsPayload (series/sequence fallback branch) treats empty-string sequence as absent', async () => {
    const payload = await pushUpdatesAndGetPayload({ series: 'Harry Potter #3', sequence: '' });
    expect(payload.metadata.series).toEqual([{ name: 'Harry Potter', sequence: '3' }]);
  });

  it('buildAbsPayload preserves an explicit numeric 0 sequence', async () => {
    const payload = await pushUpdatesAndGetPayload({ all_series: [{ name: 'Prequel', sequence: 0 }] });
    expect(payload.metadata.series).toEqual([{ name: 'Prequel', sequence: '0' }]);
  });

  it('absItemToBookGroup preserves sequence 0 instead of falling back to null', async () => {
    absApi.mockResolvedValue({
      results: [{
        id: 'item-1',
        media: {
          metadata: {
            title: 'Prequel',
            series: [{ name: 'Some Series', sequence: 0 }],
          },
        },
      }],
      total: 1,
    });
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      abs_base_url: 'http://abs.local',
      abs_api_token: 'token',
      abs_library_id: 'lib-1',
    }));
    const result = await callBackend('import_from_abs', {});
    expect(result.groups[0].metadata.sequence).toBe(0);
    expect(result.groups[0].metadata.all_series[0].sequence).toBe(0);
  });
});

describe('Q: push handlers fast-fail when ABS is not configured', () => {
  it('push_abs_updates returns a single failure result without calling absApi', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({}));
    const result = await callBackend('push_abs_updates', {
      items: [{ abs_id: 'a' }, { abs_id: 'b' }, { abs_id: 'c' }],
    });
    expect(absApi).not.toHaveBeenCalled();
    expect(result.success).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('push_abs_imports returns a single failure result without calling absApi', async () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({ abs_base_url: 'http://abs.local' }));
    const result = await callBackend('push_abs_imports', {
      items: [{ abs_id: 'a' }, { abs_id: 'b' }],
    });
    expect(absApi).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});
