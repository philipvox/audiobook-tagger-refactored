import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// M-2 (timeouts, 429 retry) and H-6 (no default third-party proxy).
const tauriFetch = vi.fn();
vi.mock('./platform.js', () => ({
  isTauri: vi.fn(() => false),
  getTauriFetch: vi.fn(async () => tauriFetch),
}));

const platform = await import('./platform.js');
const { proxyFetch, absApi, callOpenAI, callAnthropic } = await import('./proxy.js');

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json' }, ...init,
});
const status = (code, headers = {}) => new Response('slow down', { status: code, headers });

// A fetch that never settles unless its signal aborts it (the way the Tauri
// plugin behaves), so we can tell the timeout really fires.
const hangingFetch = vi.fn((url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
}));
// A fetch that ignores the signal entirely: the call must still reject.
const deafFetch = vi.fn(() => new Promise(() => {}));

beforeEach(() => {
  vi.restoreAllMocks();
  tauriFetch.mockReset();
  hangingFetch.mockClear();
  deafFetch.mockClear();
  platform.isTauri.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Tauri branch honours timeouts (M-2)', () => {
  beforeEach(() => { platform.isTauri.mockReturnValue(true); });

  it('proxyFetch rejects after timeoutMs and passes an AbortSignal in init', async () => {
    vi.useFakeTimers();
    tauriFetch.mockImplementation(hangingFetch);
    const p = proxyFetch('https://abs.example/api/items/1', { method: 'GET' }, 5000);
    const assertion = expect(p).rejects.toThrow(/timed out after 5s/);
    await vi.advanceTimersByTimeAsync(4999);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    const init = tauriFetch.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(init.signal.aborted).toBe(true);
  });

  it('rejects even when the fetch implementation ignores the signal', async () => {
    vi.useFakeTimers();
    tauriFetch.mockImplementation(deafFetch);
    const p = proxyFetch('https://abs.example/api/me', {}, 1000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('absApi uses the 30 s default timeout', async () => {
    vi.useFakeTimers();
    tauriFetch.mockImplementation(hangingFetch);
    const p = absApi('https://abs.example', 'tok', '/api/libraries');
    const assertion = expect(p).rejects.toThrow(/timed out after 30s/);
    await vi.advanceTimersByTimeAsync(29999);
    expect(tauriFetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('OpenAI and Anthropic calls time out after 90 s', async () => {
    vi.useFakeTimers();
    tauriFetch.mockImplementation(hangingFetch);
    const a = callOpenAI('sk', 'gpt-5-nano', 's', 'u', 100);
    const b = callAnthropic('key', 'claude-haiku-4-5', 's', 'u', 100);
    const ea = expect(a).rejects.toThrow(/timed out after 90s/);
    const eb = expect(b).rejects.toThrow(/timed out after 90s/);
    await vi.advanceTimersByTimeAsync(89999);
    for (const call of tauriFetch.mock.calls) expect(call[1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await ea;
    await eb;
  });

  it('does not retry an ABS 429', async () => {
    tauriFetch.mockResolvedValue(status(429));
    await expect(absApi('https://abs.example', 'tok', '/api/me')).rejects.toThrow(/429/);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
  });
});

describe('429 retry for cloud AI calls (M-2)', () => {
  beforeEach(() => { platform.isTauri.mockReturnValue(true); });

  it('retries a 429 up to 2 times with 1 s then 3 s backoff', async () => {
    vi.useFakeTimers();
    tauriFetch
      .mockResolvedValueOnce(status(429))
      .mockResolvedValueOnce(status(429))
      .mockResolvedValueOnce(json({ output_text: '{"ok":true}' }));
    const p = callOpenAI('sk', 'gpt-5-nano', 's', 'u', 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tauriFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(tauriFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tauriFetch).toHaveBeenCalledTimes(3);
    await expect(p).resolves.toBe('{"ok":true}');
  });

  it('gives up after 2 retries and reports the rate limit', async () => {
    vi.useFakeTimers();
    // A fresh response per attempt: discarded 429 bodies are cancelled.
    tauriFetch.mockImplementation(async () => status(429));
    const p = callAnthropic('key', 'claude-haiku-4-5', 's', 'u', 100);
    const assertion = expect(p).rejects.toThrow(/rate limit/i);
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
    expect(tauriFetch).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After (seconds) and caps it at 30 s', async () => {
    vi.useFakeTimers();
    tauriFetch
      .mockResolvedValueOnce(status(429, { 'Retry-After': '5' }))
      .mockResolvedValueOnce(status(429, { 'Retry-After': '120' }))
      .mockResolvedValueOnce(json({ output_text: '{"ok":true}' }));
    const p = callOpenAI('sk', 'gpt-5-nano', 's', 'u', 100);
    await vi.advanceTimersByTimeAsync(4999);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tauriFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29999);
    expect(tauriFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tauriFetch).toHaveBeenCalledTimes(3);
    await expect(p).resolves.toBe('{"ok":true}');
  });
});

describe('browser proxy fallback (H-6)', () => {
  it('with no VITE_PROXY_URL, a failed direct fetch rejects and nothing else is contacted', async () => {
    vi.stubEnv('VITE_PROXY_URL', '');
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(absApi('https://abs.example', 'secret-token', '/api/me')).rejects.toThrow(TypeError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe('https://abs.example/api/me');
  });

  it('with VITE_PROXY_URL set, falls back for a TypeError', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'https://my-proxy.example');
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ id: 'me' }));
    await expect(absApi('https://abs.example', 'tok', '/api/me')).resolves.toEqual({ id: 'me' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toBe('https://my-proxy.example/proxy');
  });

  it('with VITE_PROXY_URL set, does not fall back for a timeout', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'https://my-proxy.example');
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(hangingFetch);
    const p = proxyFetch('https://abs.example/api/me', {}, 1000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('with VITE_PROXY_URL set, does not fall back for a non-TypeError failure', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'https://my-proxy.example');
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    await expect(proxyFetch('https://abs.example/api/me')).rejects.toThrow('boom');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never routes an AI provider call through the proxy', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'https://my-proxy.example');
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(callOpenAI('sk', 'gpt-4o-mini', 's', 'u', 100, 'https://custom-llm.example')).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe('https://custom-llm.example/v1/chat/completions');
  });
});

// A 200 whose body never finishes arriving.
const stalledBody = () => new Response(new ReadableStream({ start() {} }), { status: 200 });

describe('the deadline covers reading the body (fix round 1)', () => {
  beforeEach(() => { platform.isTauri.mockReturnValue(true); });

  it('absApi rejects at 30 s when the body read never resolves', async () => {
    vi.useFakeTimers();
    tauriFetch.mockImplementation(async () => stalledBody());
    const p = absApi('https://abs.example', 'tok', '/api/libraries');
    const assertion = expect(p).rejects.toThrow(/timed out after 30s/);
    await vi.advanceTimersByTimeAsync(29999);
    expect(tauriFetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(tauriFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('a lookup body read through proxyFetch rejects at the deadline', async () => {
    vi.useFakeTimers();
    tauriFetch.mockImplementation(async () => stalledBody());
    const res = await proxyFetch('https://openlibrary.org/search.json?q=x', {}, 2000);
    const assertion = expect(res.text()).rejects.toThrow(/timed out after 2s/);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('OpenAI and Anthropic reject at 90 s when the body read never resolves', async () => {
    vi.useFakeTimers();
    tauriFetch.mockImplementation(async () => stalledBody());
    const ea = expect(callOpenAI('sk', 'gpt-5-nano', 's', 'u', 100)).rejects.toThrow(/timed out after 90s/);
    const eb = expect(callAnthropic('key', 'claude-haiku-4-5', 's', 'u', 100)).rejects.toThrow(/timed out after 90s/);
    await vi.advanceTimersByTimeAsync(90000);
    await ea;
    await eb;
  });

  it('a body that arrives in time is returned normally', async () => {
    tauriFetch.mockResolvedValue(json({ id: 'me' }));
    await expect(absApi('https://abs.example', 'tok', '/api/me')).resolves.toEqual({ id: 'me' });
  });
});

describe('a discarded 429 releases its body (fix round 1)', () => {
  beforeEach(() => { platform.isTauri.mockReturnValue(true); });

  it('cancels the 429 body before sleeping', async () => {
    vi.useFakeTimers();
    const limited = status(429);
    const cancel = vi.spyOn(limited.body, 'cancel');
    tauriFetch
      .mockResolvedValueOnce(limited)
      .mockResolvedValueOnce(json({ output_text: '{"ok":true}' }));
    const p = callOpenAI('sk', 'gpt-5-nano', 's', 'u', 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('{"ok":true}');
  });
});
