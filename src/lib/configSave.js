// src/lib/configSave.js
// Clean-ups applied to a config when the user saves it (Settings "Save
// Settings" and each step of the setup wizard). Never run on load, so a
// stored config is only rewritten by an explicit save.

// The default model for each cloud provider. DEFAULT_OPENAI_MODEL is also the
// app-wide default (DEFAULT_CONFIG.ai_model in api.js and callAI's fallback).
export const DEFAULT_OPENAI_MODEL = 'gpt-5-nano';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const OPENAI_BASE_URL = 'https://api.openai.com';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

const hasKey = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * M-11: callAI picks the provider from the model name, so a model for a
 * provider the user has no key for fails every AI call. With exactly one
 * cloud key, switch a model of the other provider to that provider's default.
 * With both keys or none the model is the user's choice and is left alone.
 * Returns the same object when nothing changes.
 */
export function matchAiModelToKeys(config) {
  if (!config) return config;
  const openai = hasKey(config.openai_api_key);
  const anthropic = hasKey(config.anthropic_api_key);
  const model = config.ai_model || DEFAULT_OPENAI_MODEL;
  const isClaude = model.startsWith('claude');
  if (anthropic && !openai && !isClaude) {
    return { ...config, ai_model: DEFAULT_ANTHROPIC_MODEL, ai_base_url: ANTHROPIC_BASE_URL };
  }
  if (openai && !anthropic && isClaude) {
    return { ...config, ai_model: DEFAULT_OPENAI_MODEL, ai_base_url: OPENAI_BASE_URL };
  }
  return config;
}

/** Trim the ABS URL and token; strip trailing slashes from the URL. */
export function normalizeAbsConnection(config) {
  if (!config) return config;
  const out = { ...config };
  if (typeof out.abs_base_url === 'string') out.abs_base_url = out.abs_base_url.trim().replace(/\/+$/, '');
  if (typeof out.abs_api_token === 'string') out.abs_api_token = out.abs_api_token.trim();
  return out;
}

/** Everything a save applies. Every other key is passed through untouched. */
export function prepareConfigForSave(config) {
  return matchAiModelToKeys(normalizeAbsConnection(config));
}
