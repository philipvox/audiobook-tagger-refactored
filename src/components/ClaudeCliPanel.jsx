// Settings block for the "Claude Code" AI provider: shows whether the
// user's `claude` CLI was found and is logged in, lets them set its path,
// and runs a real test prompt.
import { useState, useEffect, useCallback } from 'react';
import { callBackend } from '../api';
import { callClaudeCli } from '../lib/proxy';
import { Check, AlertCircle } from 'lucide-react';

export function ClaudeCliPanel({ localConfig, setLocalConfig }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const path = localConfig.claude_cli_path || '';

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await callBackend('claude_cli_status', { path: path || null }));
    } catch (e) {
      setStatus({ found: false, error: String(e?.message || e) });
    } finally {
      setChecking(false);
    }
  }, [path]);

  useEffect(() => { check(); }, [check]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const started = Date.now();
    try {
      const text = await callClaudeCli(localConfig, 'Answer with JSON only.', 'Return {"ok": true}');
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      setTestResult({ ok: /"ok"\s*:\s*true/.test(text), msg: `Answered in ${secs}s` });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e?.message || e) });
    } finally {
      setTesting(false);
    }
  };

  const subscription = status?.auth_method === 'claude.ai';
  const ready = status?.found && status?.logged_in;

  return (
    <div className="space-y-3 rounded-lg border border-neutral-800 p-4">
      <p className="text-sm text-gray-400">
        Uses the Claude Code program on this computer, logged in with your Claude subscription. No API key and no
        per-book cost, but tagging counts toward your plan&apos;s usage limits. Each AI call takes a couple of seconds longer than an API key.
      </p>

      {localConfig.use_local_ai && localConfig.ollama_model && (
        <p className="text-sm text-amber-400">Local AI is switched on, and it takes priority. Turn it off to use Claude Code.</p>
      )}

      <div className="text-sm">
        {checking && !status ? (
          <span className="text-gray-500">Looking for Claude Code…</span>
        ) : ready ? (
          <span className="flex items-start gap-1.5 text-green-400">
            <Check className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>
              Found {status.version || 'Claude Code'} at <code className="text-xs">{status.path}</code>
              {subscription
                ? ` — logged in${status.subscription_type ? ` (${status.subscription_type} plan)` : ''}`
                : ` — logged in with ${status.auth_method || 'an API key'}, so calls are billed to that account, not a subscription`}
            </span>
          </span>
        ) : (
          <span className="flex items-start gap-1.5 text-amber-400">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{status?.error || 'Claude Code not found.'}</span>
          </span>
        )}
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1.5">Path to claude (optional)</label>
        <input
          type="text"
          value={path}
          onChange={(e) => setLocalConfig({ ...localConfig, claude_cli_path: e.target.value })}
          placeholder="Leave empty to find it automatically"
          className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={check}
          disabled={checking}
          className="px-3 py-2 text-sm rounded-lg bg-neutral-800 text-gray-300 hover:bg-neutral-700 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <button
          onClick={runTest}
          disabled={!ready || testing}
          className="px-3 py-2 text-sm rounded-lg bg-neutral-800 text-gray-300 hover:bg-neutral-700 disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Send a test prompt'}
        </button>
        {testResult && (
          <span className={`text-sm ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>{testResult.msg}</span>
        )}
      </div>
    </div>
  );
}
