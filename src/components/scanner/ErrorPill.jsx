import React, { useState } from 'react';
import { AlertTriangle, AlertCircle, Copy, X } from 'lucide-react';

// Inline pill that surfaces a per-book errorDetail attached to an AI-call
// handler result. Red for hard failures (success:false), amber for sub-step
// warnings (success:true + errorDetail, e.g. classification OK, DNA failed).
// Click to expand. Dismissable via X. Copy pastes the full detail as JSON.

export function ErrorPill({ detail, severity = 'warn', onDismiss }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!detail) return null;

  const isError = severity === 'error';
  const palette = isError
    ? 'bg-red-500/15 text-red-300 border-red-500/40 hover:bg-red-500/25'
    : 'bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/25';
  const Icon = isError ? AlertCircle : AlertTriangle;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(detail, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard API unavailable */ }
  };

  const shortMsg = detail.message.length > 60 ? detail.message.slice(0, 57) + '...' : detail.message;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="error-pill"
      className={`inline-flex flex-col text-[10px] rounded border ${palette} leading-none transition-colors`}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="flex items-center gap-1 px-1.5 py-0.5 font-semibold uppercase"
        aria-expanded={open}
        aria-label={`${isError ? 'Error' : 'Warning'} at ${detail.stage}: ${detail.message}. Click to ${open ? 'collapse' : 'expand'} details.`}
        title={detail.message}
      >
        <Icon className="w-3 h-3" aria-hidden="true" />
        <span>{detail.stage}</span>
        <span className="opacity-70 normal-case font-normal">
          {open ? detail.message : shortMsg}
        </span>
      </button>
      {open && (
        <div className="px-2 py-1.5 border-t border-current/20 text-[10px] font-mono text-white/80 normal-case max-w-md">
          <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 mb-1.5">
            <span className="opacity-60">stage:</span><span>{detail.stage}</span>
            <span className="opacity-60">kind:</span><span>{detail.kind}</span>
            {detail.statusCode !== undefined && (<><span className="opacity-60">status:</span><span>{detail.statusCode}</span></>)}
            {detail.url && (<><span className="opacity-60">url:</span><span className="truncate">{detail.url}</span></>)}
          </div>
          {detail.responsePreview && (
            <div className="mt-1">
              <div className="opacity-60 mb-0.5">response preview:</div>
              <pre className="whitespace-pre-wrap break-all text-[9px] bg-black/30 p-1 rounded max-h-32 overflow-auto">{detail.responsePreview}</pre>
            </div>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); copy(); }}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20"
              aria-label="Copy error detail as JSON"
            >
              <Copy className="w-2.5 h-2.5" aria-hidden="true" />
              {copied ? 'copied' : 'copy'}
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDismiss(); }}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20"
                aria-label="Dismiss this error"
              >
                <X className="w-2.5 h-2.5" aria-hidden="true" />
                dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
