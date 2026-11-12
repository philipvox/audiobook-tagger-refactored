// src/lib/proxy.js
// Network helpers for ABS, the cloud AI providers and the public lookups.
// Every request carries a real timeout (an AbortController signal in `init`,
// the only form the Tauri HTTP plugin honours). In the browser build a failed
// ABS/lookup request may be retried through a CORS proxy, but only when
// VITE_PROXY_URL is configured and only for a genuine CORS/network failure.

import { isTauri, getTauriFetch } from './platform.js';
import { DEFAULT_OPENAI_MODEL } from './configSave.js';

/** Default timeout for ABS and lookup requests. */
export const DEFAULT_TIMEOUT_MS = 30000;
/** Timeout for the cloud AI calls (OpenAI / Anthropic). */
export const AI_TIMEOUT_MS = 90000;

// 429 retry policy: two retries, 1 s then 3 s unless Retry-After says
// otherwise, never waiting longer than 30 s.
const RETRY_DELAYS_MS = [1000, 3000];
const MAX_RETRY_AFTER_MS = 30000;

// Read at call time so the configured value (or its absence) is what counts.
// There is deliberately no default: an unset VITE_PROXY_URL means no proxy.
function configuredProxyUrl() {
  return String(import.meta.env.VITE_PROXY_URL || '').trim().replace(/\/+$/, '');
}

function hostOf(url) {
  try { return new URL(url, 'http://localhost').host; } catch { return String(url); }
}

function timeoutError(url, timeoutMs) {
  // Deliberately a plain Error, never a TypeError: a timeout must not trigger
  // the proxy fallback.
  const err = new Error(`Request to ${hostOf(url)} timed out after ${Math.round(timeoutMs / 1000)}s`);
  err.name = 'TimeoutError';
  err.code = 'ETIMEDOUT';
  return err;
}

const BODY_READERS = ['json', 'text', 'arrayBuffer', 'blob'];

/**
 * Run `fetchFn(url, init)` with a timeout that covers the whole request,
 * body included. The AbortController signal is passed in `init` (so the
 * Tauri plugin and the browser can cancel the request). The returned promise,
 * and any later `json()` / `text()` / `arrayBuffer()` / `blob()` read on the
 * response, reject at the same deadline even if the fetch implementation
 * ignores the signal. The timer stops once the body has been read.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = null) {
  const doFetch = fetchFn || globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the caller sees the timeout, not the AbortError the
      // abort below causes.
      reject(timeoutError(url, timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  // The deadline may fire after the caller stopped listening (a response
  // whose body is never read); that is not an unhandled rejection.
  deadline.catch(() => {});

  let res;
  try {
    res = await Promise.race([doFetch(url, { ...options, signal: controller.signal }), deadline]);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  for (const name of BODY_READERS) {
    const read = res?.[name];
    if (typeof read !== 'function') continue;
    res[name] = (...args) => Promise.race([read.apply(res, args), deadline])
      .finally(() => clearTimeout(timer));
  }
  return res;
}

function retryDelayMs(res, attempt) {
  const header = res.headers?.get?.('Retry-After');
  if (header != null && String(header).trim() !== '') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return RETRY_DELAYS_MS[attempt];
}

/**
 * Call `doRequest()` and retry it while it answers 429, up to 2 times. For the
 * cloud AI calls and the public lookups only; ABS requests are never retried.
 * Returns the last response (still a 429 if every attempt was rate limited).
 */
export async function retryOn429(doRequest) {
  for (let attempt = 0; ; attempt++) {
    const res = await doRequest();
    if (res.status !== 429 || attempt >= RETRY_DELAYS_MS.length) return res;
    // This response is discarded: release its body before waiting.
    try { await res.body?.cancel?.(); } catch { /* already consumed or not cancellable */ }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(res, attempt)));
  }
}

/** Fetch directly (Tauri plugin or browser fetch) with a timeout. Never proxied. */
async function directFetch(url, options, timeoutMs) {
  const fetchFn = isTauri() ? await getTauriFetch() : globalThis.fetch.bind(globalThis);
  return fetchWithTimeout(url, options, timeoutMs, fetchFn);
}

/**
 * Fetch an ABS or lookup URL. Desktop: direct through the Tauri HTTP plugin.
 * Browser: direct first; when VITE_PROXY_URL is set and the direct request
 * failed with a TypeError (the browser's CORS/network failure), retry it
 * through that proxy. A timeout or any other error is thrown as-is.
 * @param {string} targetUrl - The actual API URL to call
 * @param {object} options - { method, headers, body }
 * @param {number} timeoutMs - timeout in milliseconds (default 30000)
 * @returns {Promise<Response>}
 */
export async function proxyFetch(targetUrl, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { method = 'GET', headers = {}, body = null } = options;
  const directOpts = { method, headers: { ...headers } };
  if (body && method !== 'GET' && method !== 'HEAD') {
    directOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  // In Tauri, always go direct (the HTTP plugin bypasses CORS).
  if (isTauri()) {
    return fetchWithTimeout(targetUrl, directOpts, timeoutMs, await getTauriFetch());
  }

  let proxyUrl;
  try {
    return await fetchWithTimeout(targetUrl, { ...directOpts, credentials: 'omit' }, timeoutMs);
  } catch (directError) {
    proxyUrl = configuredProxyUrl();
    if (!proxyUrl || !(directError instanceof TypeError)) throw directError;
  }

  return fetchWithTimeout(`${proxyUrl}/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      method,
      headers,
      body,
    }),
  }, timeoutMs);
}

/**
 * Call an ABS API endpoint through the proxy.
 * @param {string} absBaseUrl - e.g., 'https://my-abs.com'
 * @param {string} absToken - ABS API token
 * @param {string} path - e.g., '/api/libraries'
 * @param {object} options - { method, body }
 */
export async function absApi(absBaseUrl, absToken, path, options = {}) {
  const { method = 'GET', body = null } = options;
  const url = `${String(absBaseUrl || '').trim().replace(/\/+$/, '')}${path}`;

  const res = await proxyFetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${absToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    // Bounded like the AI errors: the text ends up in toasts and pills.
    throw new Error(`ABS API error ${res.status}: ${String(text).substring(0, 300)}`);
  }

  return res.json();
}

/**
 * Call OpenAI API through the proxy.
 * @param {string} apiKey - OpenAI API key
 * @param {string} model - e.g., 'gpt-5.4-nano'
 * @param {string} systemPrompt - System message
 * @param {string} userPrompt - User message
 * @param {number} maxTokens - Max output tokens
 * @param {string} baseUrl - API base URL (default: https://api.openai.com)
 */
export async function callOpenAI(apiKey, model, systemPrompt, userPrompt, maxTokens = 2000, baseUrl = 'https://api.openai.com') {
  const isGpt5 = model.startsWith('gpt-5');
  const useResponsesApi = isGpt5;

  // Browser + official API: the same-origin /api/openai reverse proxy. Any
  // other case goes direct; AI calls never use the CORS proxy.
  const useLocalProxy = !isTauri() && typeof window !== 'undefined' && baseUrl === 'https://api.openai.com';
  const apiBase = useLocalProxy ? '/api/openai' : baseUrl;

  let endpoint, body;

  if (useResponsesApi) {
    endpoint = `${apiBase}/v1/responses`;
    body = {
      model,
      input: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_output_tokens: maxTokens,
      text: { format: { type: 'json_object' } },
      reasoning: { effort: 'minimal' },
    };
  } else {
    endpoint = `${apiBase}/v1/chat/completions`;
    body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    };
  }

  const res = await retryOn429(() => directFetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, AI_TIMEOUT_MS));

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) throw new Error('Invalid API key. Check your OpenAI key in Settings.');
    if (res.status === 404) throw new Error(`Model "${model}" not found. Your OpenAI account may not have access to this model. Try a different model in Settings.`);
    if (res.status === 429) throw new Error('OpenAI rate limit exceeded. Wait a moment and try again, or reduce concurrency in Settings.');
    if (res.status === 403) throw new Error('OpenAI access denied. Your API key may lack permissions for this model or endpoint.');
    throw new Error(`OpenAI error ${res.status}: ${text.substring(0, 300)}`);
  }

  const data = await res.json();

  // M-1: a cut-off answer is never usable, however much of it parses.
  if (useResponsesApi) {
    if (data.status === 'incomplete') {
      const reason = data.incomplete_details?.reason || 'incomplete';
      throw new Error(`OpenAI response was truncated (${reason}); nothing was applied.`);
    }
    if (data.output_text) return data.output_text.trim();
    const text = data.output
      ?.find(item => item.type === 'message')
      ?.content?.find(c => c.type === 'output_text' || c.type === 'text')
      ?.text;
    if (text) return text.trim();
    throw new Error('No text in OpenAI Responses API response');
  } else {
    if (data.choices?.[0]?.finish_reason === 'length') {
      throw new Error('OpenAI response was truncated (max_tokens); nothing was applied.');
    }
    const content = data.choices?.[0]?.message?.content;
    if (content) return content.trim();
    throw new Error('No content in OpenAI Chat response');
  }
}

/**
 * Call Anthropic Claude API through the proxy.
 * @param {string} apiKey - Anthropic API key
 * @param {string} model - e.g., 'claude-haiku-4-5-20251001'
 * @param {string} systemPrompt - System message
 * @param {string} userPrompt - User message
 * @param {number} maxTokens - Max output tokens
 */
export async function callAnthropic(apiKey, model, systemPrompt, userPrompt, maxTokens = 2000) {
  // Browser: the same-origin /api/anthropic reverse proxy. Desktop: direct.
  // AI calls never use the CORS proxy.
  const useLocalProxy = !isTauri() && typeof window !== 'undefined';
  const endpoint = useLocalProxy ? '/api/anthropic/v1/messages' : 'https://api.anthropic.com/v1/messages';

  const res = await retryOn429(() => directFetch(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // Required whenever the request carries an Origin header, which is every
      // request we make: tauri-plugin-http unconditionally appends
      // Origin: tauri://localhost (http://tauri.localhost on Windows), and the
      // browser adds one on the /api/anthropic proxy path. Without this header
      // Anthropic rejects the call with 401 "CORS requests must set
      // 'anthropic-dangerous-direct-browser-access' header", which we used to
      // report to the user as an invalid API key.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  }, AI_TIMEOUT_MS));

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 401) {
      // Surface Anthropic's own message: a 401 here is not always a bad key
      // (CORS/header rejections use the same status), and assuming it was cost
      // users a lot of time chasing keys that were fine.
      let apiMessage = '';
      try { apiMessage = JSON.parse(errText)?.error?.message || ''; } catch { /* non-JSON body */ }
      throw new Error(
        apiMessage
          ? `Anthropic rejected the request (401): ${apiMessage}`
          : 'Invalid API key. Check your Anthropic key in Settings.'
      );
    }
    if (res.status === 404) throw new Error(`Model "${model}" not found. Try a different Claude model in Settings.`);
    if (res.status === 429) throw new Error('Anthropic rate limit exceeded. Wait a moment and try again.');
    throw new Error(`Anthropic error ${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Anthropic response was truncated (max_tokens); nothing was applied.');
  }
  const text = data.content?.find(c => c.type === 'text')?.text;
  if (text) return text.trim();
  throw new Error('No text in Anthropic response');
}

/**
 * Call local Ollama server for chat completions.
 * Uses Ollama's native /api/chat endpoint (not OpenAI-compat).
 */
export async function callOllama(systemPrompt, userPrompt, { model = 'qwen3:4b', maxTokens = 1000, baseUrl } = {}) {
  // baseUrl falls back to getLocalConfig().ollama_base_url (or localhost default).
  // Lazy import avoids circular dep with api.js; keep in sync with getOllamaBaseUrl() there.
  let resolvedBase = (baseUrl || '').trim();
  if (!resolvedBase) {
    try {
      const mod = await import('../api.js');
      resolvedBase = mod.getOllamaBaseUrl();
    } catch { resolvedBase = 'http://127.0.0.1:11434'; }
  }
  const url = `${resolvedBase.replace(/\/+$/, '')}/api/chat`;
  const t0 = performance.now();

  const promptChars = systemPrompt.length + userPrompt.length;
  console.log(`[Ollama] Starting request — model=${model}, prompt=${(promptChars/1024).toFixed(1)}KB, maxTokens=${maxTokens}`);

  const fetchFn = isTauri() ? await getTauriFetch() : globalThis.fetch.bind(globalThis);

  // Build request body — adapt parameters for different model families
  const isQwen = model.startsWith('qwen');
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    format: 'json',
    options: {
      num_predict: maxTokens,
      temperature: 0.3,
    },
  };
  // Qwen 3 models support 'think' parameter to disable extended reasoning
  if (isQwen) body.think = false;

  // Use AbortController for timeout — larger models can take 2+ minutes on first load
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minute timeout

  let resp;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    if (err.name === 'AbortError') {
      console.error(`[Ollama] TIMEOUT after ${elapsed}s — model=${model}`);
      throw new Error(`Ollama timed out after 3 minutes. The model "${model}" may be too large for your hardware, or still loading into memory. Try a smaller model.`);
    }
    console.error(`[Ollama] FETCH ERROR after ${elapsed}s — ${err.message}`);
    throw err;
  }
  clearTimeout(timeoutId);

  if (!resp.ok) {
    const text = await resp.text();
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.error(`[Ollama] HTTP ${resp.status} after ${elapsed}s — ${text.substring(0, 200)}`);
    if (resp.status === 403) {
      throw new Error('Ollama rejected the request (403 Forbidden). If you are running Ollama separately, set OLLAMA_ORIGINS=* in your environment and restart Ollama. If using the built-in Ollama, try stopping and restarting it from Settings.');
    }
    if (resp.status === 404) {
      throw new Error(`Model "${model}" not found in Ollama. Go to Settings and pull the model first.`);
    }
    throw new Error(`Ollama error ${resp.status}: ${text.substring(0, 300)}`);
  }

  const data = await resp.json();
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const loadTime = data.load_duration ? (data.load_duration / 1e9).toFixed(1) : '?';
  const evalTime = data.eval_duration ? (data.eval_duration / 1e9).toFixed(1) : '?';
  const promptEvalTime = data.prompt_eval_duration ? (data.prompt_eval_duration / 1e9).toFixed(1) : '?';
  const tokens = data.eval_count || '?';
  const promptTokens = data.prompt_eval_count || '?';
  const speed = (data.eval_count && data.eval_duration) ? (data.eval_count / (data.eval_duration / 1e9)).toFixed(0) : '?';

  console.log(`[Ollama] DONE in ${elapsed}s — load=${loadTime}s, prompt_eval=${promptEvalTime}s (${promptTokens} tokens), gen=${evalTime}s (${tokens} tokens, ${speed} tok/s)`);

  if (data?.done_reason === 'length') {
    throw new Error(`Ollama response was truncated (num_predict ${maxTokens}); nothing was applied.`);
  }
  const content = data?.message?.content;
  if (!content) throw new Error('Empty response from Ollama');
  return content.trim();
}

/**
 * Call the configured AI provider (OpenAI or Anthropic).
 * Auto-detects based on model name.
 * @param {object} config - App config with api keys and model settings
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 */
/** True when AI calls go to the local Ollama model: the switch and a model. */
export function usesLocalAi(config) {
  return !!(config?.use_local_ai && config?.ollama_model);
}

/**
 * The one definition of "an AI provider is configured", matching what callAI
 * needs: local AI with a model, or an OpenAI or Anthropic key.
 */
export function isAiConfigured(config) {
  return usesLocalAi(config) || !!(config?.openai_api_key || config?.anthropic_api_key);
}

export async function callAI(config, systemPrompt, userPrompt, maxTokens = 2000) {
  // Local AI takes priority
  if (usesLocalAi(config)) {
    return callOllama(systemPrompt, userPrompt, {
      model: config.ollama_model,
      maxTokens,
    });
  }

  const model = config.ai_model || DEFAULT_OPENAI_MODEL;
  const isAnthropic = model.startsWith('claude');

  if (isAnthropic) {
    const key = config.anthropic_api_key;
    if (!key) throw new Error('No Anthropic API key configured. Add one in Settings.');
    return callAnthropic(key, model, systemPrompt, userPrompt, maxTokens);
  } else {
    const key = config.openai_api_key;
    if (!key) throw new Error('No OpenAI API key configured. Add one in Settings.');
    const baseUrl = config.ai_base_url || 'https://api.openai.com';
    return callOpenAI(key, model, systemPrompt, userPrompt, maxTokens, baseUrl);
  }
}

/**
 * Scan `text` starting at `startIndex` (which must point at a `{` or `[`) and
 * return the substring of the first balanced bracket block, respecting
 * strings and escape sequences so braces/brackets inside string values don't
 * throw off the depth count. Returns null if the block never balances.
 */
function extractBalancedBlock(text, startIndex) {
  const open = text[startIndex];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null; // never balanced - truncated/garbage input
}

// Small local models sometimes open with a reasoning block. It is prose, not
// the answer, so it is dropped before looking for the JSON.
const LEADING_REASONING_BLOCK = /^\s*<(think|thinking)>[\s\S]*?<\/\1>/i;

/**
 * Parse a JSON answer from an AI model (M-1). The rule is strict on purpose:
 * a truncated answer must fail, never be salvaged as a fragment.
 *   1. JSON.parse the trimmed text as-is (clean JSON, the common case).
 *   2. Otherwise find the FIRST `{` or `[` in the text and take the balanced
 *      block that starts there (string- and escape-aware). Prose, ```json
 *      fences and trailing commentary around that block are ignored.
 *   3. If that block never closes, or is not valid JSON, throw. There is no
 *      fallback to a later or nested block: a DNA answer cut mid-array used
 *      to come back as just its first complete inner array.
 * A leading <think>...</think> reasoning block is skipped first.
 */
export function parseAIJson(text) {
  const raw = String(text);
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const body = raw.replace(LEADING_REASONING_BLOCK, '');
    const start = body.search(/[{[]/);
    const block = start >= 0 ? extractBalancedBlock(body, start) : null;
    if (block === null) {
      const why = start >= 0 ? 'the JSON never closes (truncated answer)' : 'no JSON found';
      throw new Error(`Failed to parse AI response as JSON: ${why}\nResponse was: ${trimmed.substring(0, 200)}`);
    }
    try {
      return JSON.parse(block);
    } catch (blockError) {
      throw new Error(`Failed to parse AI response as JSON: ${blockError.message}\nResponse was: ${trimmed.substring(0, 200)}`);
    }
  }
}
