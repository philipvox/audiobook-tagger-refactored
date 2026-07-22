// src/lib/proxy.js
// Smart fetch — tries direct first, falls back to CORS proxy if blocked.
// This way it works both locally (direct) and on GitHub Pages (via proxy).

import { isTauri, getTauriFetch } from './platform.js';

const PROXY_URL = import.meta.env.VITE_PROXY_URL || 'https://audiobook-tagger-proxy.workers.dev';

/**
 * Fetch with an AbortController timeout.
 * @param {string} url
 * @param {object} options - standard fetch options
 * @param {number} timeoutMs - timeout in milliseconds
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

/**
 * Fetch a URL, trying direct first, then falling back to the CORS proxy.
 * @param {string} targetUrl - The actual API URL to call
 * @param {object} options - { method, headers, body }
 * @param {number} timeoutMs - timeout in milliseconds (default 30000)
 * @returns {Promise<Response>} - The response
 */
export async function proxyFetch(targetUrl, options = {}, timeoutMs = 30000) {
  const { method = 'GET', headers = {}, body = null } = options;

  // In Tauri, always use direct fetch (HTTP plugin bypasses CORS)
  if (isTauri()) {
    const tauriFetch = await getTauriFetch();
    const directOpts = { method, headers: { ...headers } };
    if (body && method !== 'GET' && method !== 'HEAD') {
      directOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return tauriFetch(targetUrl, directOpts);
  }

  // Browser: try direct fetch first, fall back to CORS proxy
  // Try direct fetch first (works same-origin or if server allows CORS)
  try {
    const directOpts = { method, headers: { ...headers }, credentials: 'omit' };
    if (body && method !== 'GET' && method !== 'HEAD') {
      directOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetchWithTimeout(targetUrl, directOpts, timeoutMs);
    return res;
  } catch (directError) {
    // Direct failed (likely CORS) — try proxy
  }

  // Fall back to CORS proxy
  const res = await fetchWithTimeout(`${PROXY_URL}/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      method,
      headers,
      body,
    }),
  }, timeoutMs);

  return res;
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
  const url = `${absBaseUrl.replace(/\/$/, '')}${path}`;

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
    throw new Error(`ABS API error ${res.status}: ${text}`);
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

  // Route through Caddy proxy if on same origin, otherwise use proxyFetch
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

  const fetchFn = isTauri() ? await getTauriFetch() : (useLocalProxy ? fetchWithTimeout : proxyFetch);
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, 90000);

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) throw new Error('Invalid API key. Check your OpenAI key in Settings.');
    if (res.status === 404) throw new Error(`Model "${model}" not found. Your OpenAI account may not have access to this model. Try a different model in Settings.`);
    if (res.status === 429) throw new Error('OpenAI rate limit exceeded. Wait a moment and try again, or reduce concurrency in Settings.');
    if (res.status === 403) throw new Error('OpenAI access denied. Your API key may lack permissions for this model or endpoint.');
    throw new Error(`OpenAI error ${res.status}: ${text.substring(0, 300)}`);
  }

  const data = await res.json();

  // Parse response based on API type
  if (useResponsesApi) {
    if (data.output_text) return data.output_text.trim();
    const text = data.output
      ?.find(item => item.type === 'message')
      ?.content?.find(c => c.type === 'output_text' || c.type === 'text')
      ?.text;
    if (text) return text.trim();
    throw new Error('No text in OpenAI Responses API response');
  } else {
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
  // Route through Caddy proxy to avoid CORS
  const useLocalProxy = !isTauri() && typeof window !== 'undefined';
  const endpoint = useLocalProxy ? '/api/anthropic/v1/messages' : 'https://api.anthropic.com/v1/messages';
  const fetchFn = isTauri() ? await getTauriFetch() : (useLocalProxy ? fetchWithTimeout : proxyFetch);

  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  }, 90000);

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 401) throw new Error('Invalid API key. Check your Anthropic key in Settings.');
    if (res.status === 404) throw new Error(`Model "${model}" not found. Try a different Claude model in Settings.`);
    if (res.status === 429) throw new Error('Anthropic rate limit exceeded. Wait a moment and try again.');
    throw new Error(`Anthropic error ${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
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
export async function callAI(config, systemPrompt, userPrompt, maxTokens = 2000) {
  // Local AI takes priority
  if (config.use_local_ai && config.ollama_model) {
    return callOllama(systemPrompt, userPrompt, {
      model: config.ollama_model,
      maxTokens,
    });
  }

  const model = config.ai_model || 'gpt-5-nano';
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

// Sentinel distinguishing "no parseable block found" from a block that
// legitimately parses to JSON `undefined` (which cannot happen: JSON has no
// undefined literal, but a dedicated sentinel keeps the intent explicit).
const NO_BLOCK_FOUND = Symbol('no-parseable-block');

/**
 * Scan `text` for balanced `{...}` / `[...]` blocks (in order of where they
 * open) and return the parsed value of the first one that is actually valid
 * JSON. A block can balance its brackets without being valid JSON (e.g. a
 * stray `{fantasy}` in prose before the real payload) - those are skipped
 * rather than treated as the final answer, so JSON appearing after
 * non-JSON bracket noise (a `<thinking>` block, for example) still gets
 * found. Returns NO_BLOCK_FOUND if nothing in the text parses.
 */
function findFirstParseableBlock(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const block = extractBalancedBlock(text, i);
      if (block) {
        try {
          return JSON.parse(block);
        } catch {
          // Balanced but not valid JSON - keep scanning for a later block.
        }
      }
    }
  }
  return NO_BLOCK_FOUND;
}

/**
 * Parse a JSON response from AI, handling markdown code blocks, prose the
 * model wrapped around the JSON, and trailing commentary. Strategy:
 *   1. Strip ``` fences wherever they appear (not just at the very start/end).
 *   2. Try JSON.parse on the cleaned text directly (fast path, no prose).
 *   3. Fall back to scanning for balanced {...} / [...] blocks (respecting
 *      strings/escapes) and parsing each in turn, returning the first one
 *      that is actually valid JSON: a balanced-but-non-JSON block earlier
 *      in the text (e.g. a stray brace pair inside a <thinking> block) does
 *      not stop the scan.
 *   4. Throw only if nothing in the text was parseable.
 */
export function parseAIJson(text) {
  const cleaned = String(text)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const result = findFirstParseableBlock(cleaned);
    if (result !== NO_BLOCK_FOUND) return result;
    throw new Error(`Failed to parse AI response as JSON: ${e.message}\nResponse was: ${cleaned.substring(0, 200)}`);
  }
}
