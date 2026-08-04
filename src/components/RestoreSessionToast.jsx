import { AlertTriangle, History, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { describeSession } from '../lib/session.js';

/**
 * Non-blocking prompt offering the previous session back (#58).
 *
 * Deliberately different from UndoToast in two ways, both about not losing
 * data: there is no auto-dismiss timer and no X. The prompt stays until the
 * user answers, because autosave is suppressed while it is open, and an
 * ambiguous third exit would leave the app unsure whether it may start writing
 * over the saved snapshot again.
 *
 * Pass `unreadableReason` instead of `session` for the degraded case: a
 * snapshot is on disk but could not be read or parsed. There is nothing to
 * restore, so the only action is Discard, which is also what un-pauses
 * autosave.
 */
export function RestoreSessionToast({ session, unreadableReason, onRestore, onDiscard, busy = false }) {
  if (!session && !unreadableReason) return null;

  if (unreadableReason) {
    return (
      <div
        className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300"
        role="dialog"
        aria-live="polite"
        aria-label="Saved session could not be read"
      >
        <div className="bg-neutral-950 text-white rounded-xl shadow-2xl px-5 py-4 flex items-center gap-4 min-w-[380px] max-w-[560px] border border-amber-700/60">
          <div className="p-2 bg-amber-500/20 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">A saved session could not be read</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {unreadableReason}. Autosave is paused so the file is not overwritten. Discard it to resume.
            </div>
          </div>

          <button
            onClick={onDiscard}
            disabled={busy}
            title="Delete the unreadable session file and resume autosave."
            className="px-3 py-2 text-gray-300 bg-neutral-900 border border-neutral-700 rounded-lg hover:bg-neutral-800 disabled:opacity-50 transition-colors text-sm font-medium flex items-center gap-2 flex-shrink-0"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Discard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300"
      role="dialog"
      aria-live="polite"
      aria-label="Restore previous session"
    >
      <div className="bg-neutral-950 text-white rounded-xl shadow-2xl px-5 py-4 flex items-center gap-4 min-w-[380px] border border-neutral-800">
        <div className="p-2 bg-blue-500/20 rounded-lg">
          <History className="w-5 h-5 text-blue-400" />
        </div>

        <div className="flex-1">
          <div className="font-medium text-sm">Restore previous session?</div>
          <div className="text-xs text-gray-400 mt-0.5">
            {describeSession(session)}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onRestore}
            disabled={busy}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            Restore
          </button>

          <button
            onClick={onDiscard}
            disabled={busy}
            title="Delete the saved session. This cannot be undone."
            className="px-3 py-2 text-gray-300 bg-neutral-900 border border-neutral-700 rounded-lg hover:bg-neutral-800 disabled:opacity-50 transition-colors text-sm font-medium flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
