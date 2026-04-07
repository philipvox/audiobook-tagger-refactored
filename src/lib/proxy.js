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
    throw new Error(`OpenAI error ${res.status}: ${text}`);
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
    const text = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${text}`);
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
export async function callOllama(systemPrompt, userPrompt, { model = 'qwen3:4b', maxTokens = 1000 } = {}) {
  const url = 'http://127.0.0.1:11434/api/chat';

  const fetchFn = isTauri() ? await getTauriFetch() : globalThis.fetch.bind(globalThis);

  const resp = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      think: false,
      format: 'json',
      options: {
        num_predict: maxTokens,
        temperature: 0.3,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ollama error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
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
 * Parse a JSON response from AI, handling markdown code blocks.
 */
export function parseAIJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse AI response as JSON: ${e.message}\nResponse was: ${cleaned.substring(0, 200)}`);
  }
}
