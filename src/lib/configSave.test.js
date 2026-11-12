import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  matchAiModelToKeys,
  normalizeAbsConnection,
  prepareConfigForSave,
} from './configSave.js';

describe('matchAiModelToKeys (M-11)', () => {
  it('only an Anthropic key: an OpenAI model becomes the default Anthropic model', () => {
    const out = matchAiModelToKeys({ anthropic_api_key: 'sk-ant', openai_api_key: null, ai_model: 'gpt-5-nano', ai_base_url: 'https://api.openai.com' });
    expect(out.ai_model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(out.ai_base_url).toBe('https://api.anthropic.com');
  });

  it('only an Anthropic key and no model set: the default Anthropic model', () => {
    expect(matchAiModelToKeys({ anthropic_api_key: 'sk-ant' }).ai_model).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('only an OpenAI key: a Claude model becomes the default OpenAI model', () => {
    const out = matchAiModelToKeys({ openai_api_key: 'sk-x', anthropic_api_key: '', ai_model: 'claude-sonnet-4-6', ai_base_url: 'https://api.anthropic.com' });
    expect(out.ai_model).toBe(DEFAULT_OPENAI_MODEL);
    expect(out.ai_base_url).toBe('https://api.openai.com');
  });

  it('a model that matches the only key is kept as it is', () => {
    const cfg = { anthropic_api_key: 'sk-ant', ai_model: 'claude-sonnet-4-6', ai_base_url: 'https://api.anthropic.com' };
    expect(matchAiModelToKeys(cfg)).toBe(cfg);
    const oa = { openai_api_key: 'sk-x', ai_model: 'gpt-4o', ai_base_url: 'https://example.test' };
    expect(matchAiModelToKeys(oa)).toBe(oa);
  });

  it('both keys or no key: the model is the user choice and is left alone', () => {
    const both = { openai_api_key: 'a', anthropic_api_key: 'b', ai_model: 'gpt-5-nano' };
    expect(matchAiModelToKeys(both)).toBe(both);
    const none = { ai_model: 'claude-sonnet-4-6' };
    expect(matchAiModelToKeys(none)).toBe(none);
  });

  it('a whitespace-only key counts as no key', () => {
    expect(matchAiModelToKeys({ anthropic_api_key: 'sk-ant', openai_api_key: '   ', ai_model: 'gpt-5-nano' }).ai_model)
      .toBe(DEFAULT_ANTHROPIC_MODEL);
  });
});

describe('normalizeAbsConnection', () => {
  it('trims the URL and token and strips trailing slashes from the URL', () => {
    const out = normalizeAbsConnection({ abs_base_url: '  http://abs.local:13378///  ', abs_api_token: '\ttok \n', other: 1 });
    expect(out).toEqual({ abs_base_url: 'http://abs.local:13378', abs_api_token: 'tok', other: 1 });
  });

  it('leaves missing values alone', () => {
    expect(normalizeAbsConnection({ abs_base_url: null })).toEqual({ abs_base_url: null });
  });
});

describe('prepareConfigForSave', () => {
  it('applies both the connection clean-up and the model fix-up, keeping every other key', () => {
    const out = prepareConfigForSave({
      abs_base_url: 'https://abs.example/ ', abs_api_token: ' t ', anthropic_api_key: 'k',
      ai_model: 'gpt-5-nano', local_concurrency: 2, custom_approved_genres: 'A, B',
    });
    expect(out).toMatchObject({
      abs_base_url: 'https://abs.example', abs_api_token: 't', ai_model: DEFAULT_ANTHROPIC_MODEL,
      local_concurrency: 2, custom_approved_genres: 'A, B',
    });
  });
});
