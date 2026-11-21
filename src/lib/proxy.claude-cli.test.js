import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

import { callAI, isAiConfigured, usesClaudeCli } from './proxy.js';
import { matchAiModelToKeys } from './configSave.js';
import { shouldAutoEnableLocalAI } from '../context/AppContext.jsx';

describe('Claude Code (CLI) provider', () => {
  beforeEach(() => { window.__TAURI_INTERNALS__ = {}; invoke.mockReset(); });
  afterEach(() => { delete window.__TAURI_INTERNALS__; });

  it('routes cli: models to claude_cli_call with the alias and path', async () => {
    invoke.mockResolvedValue('{"ok":true}');
    const out = await callAI({ ai_model: 'cli:sonnet', claude_cli_path: '/x/claude' }, 'sys', 'user');
    expect(out).toBe('{"ok":true}');
    expect(invoke).toHaveBeenCalledWith('claude_cli_call', {
      systemPrompt: 'sys', userPrompt: 'user', model: 'sonnet', path: '/x/claude',
    });
  });

  it('needs no API key to count as configured', () => {
    expect(isAiConfigured({ ai_model: 'cli:haiku' })).toBe(true);
  });

  it('is desktop-only', () => {
    delete window.__TAURI_INTERNALS__;
    expect(usesClaudeCli({ ai_model: 'cli:haiku' })).toBe(false);
    expect(isAiConfigured({ ai_model: 'cli:haiku' })).toBe(false);
  });

  it('a save never swaps Claude Code for a keyed provider', () => {
    const cfg = { ai_model: 'cli:haiku', openai_api_key: 'sk-x' };
    expect(matchAiModelToKeys(cfg)).toBe(cfg);
  });

  it('Ollama auto-enable leaves a Claude Code choice alone', () => {
    expect(shouldAutoEnableLocalAI({ ai_model: 'cli:haiku' }, { running: true, models: [{ name: 'm' }] })).toBe(false);
  });

  it('rejects an unknown cli model before invoking', async () => {
    await expect(callAI({ ai_model: 'cli:bogus' }, 's', 'u')).rejects.toThrow(/Unknown Claude Code model/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
