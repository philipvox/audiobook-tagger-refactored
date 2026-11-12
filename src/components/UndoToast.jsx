import { useState, useEffect } from 'react';
import { Undo2, X, Clock, Loader2 } from 'lucide-react';

const AUTO_DISMISS_SECONDS = 30;

// I-5: shown right after a write, so its Undo stays one click. `fileCount` is
// get_undo_status's count of files in the undo journal. The journal has no
// expiry: Undo stays available (from the action bar) until the next write.
export function UndoToast({ fileCount, onUndo, onDismiss, undoing }) {
  // L4: countdown driving the auto-dismiss progress bar (30s).
  const [dismissRemaining, setDismissRemaining] = useState(AUTO_DISMISS_SECONDS);

  // Auto-dismiss after 30 seconds, ticking every second so the progress bar
  // below actually tracks the countdown it claims.
  useEffect(() => {
    const interval = setInterval(() => {
      setDismissRemaining(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          onDismiss();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [onDismiss]);

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="bg-neutral-950 text-white rounded-xl shadow-2xl px-5 py-4 flex items-center gap-4 min-w-[320px]">
        {/* Icon */}
        <div className="p-2 bg-blue-500/20 rounded-lg">
          <Undo2 className="w-5 h-5 text-blue-400" />
        </div>

        {/* Content */}
        <div className="flex-1">
          <div className="font-medium text-sm">
            Wrote {fileCount} file{fileCount === 1 ? '' : 's'}
          </div>
          <div className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
            <Clock className="w-3 h-3" />
            Undo stays available until the next write
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={onUndo}
            disabled={undoing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            {undoing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Undoing...
              </>
            ) : (
              <>
                <Undo2 className="w-4 h-4" />
                Undo
              </>
            )}
          </button>

          <button
            onClick={onDismiss}
            className="p-2 hover:bg-neutral-900/10 rounded-lg transition-colors"
            title="Dismiss (keeps changes)"
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Progress bar showing the 30s auto-dismiss countdown */}
      <div className="h-1 bg-neutral-800 rounded-b-xl overflow-hidden -mt-1">
        <div
          className="h-full bg-blue-500 transition-all duration-1000 ease-linear"
          style={{ width: `${(dismissRemaining / AUTO_DISMISS_SECONDS) * 100}%` }}
        />
      </div>
    </div>
  );
}
