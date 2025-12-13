import { useState, useEffect } from 'react';
import { Undo2, X, Clock, Loader2 } from 'lucide-react';

export function UndoToast({ booksCount, ageSeconds, onUndo, onDismiss, undoing }) {
  const [timeRemaining, setTimeRemaining] = useState(3600 - ageSeconds);

  // Countdown timer - undo expires after 1 hour
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeRemaining(prev => {
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

  // Auto-dismiss after 30 seconds
  useEffect(() => {
    const timeout = setTimeout(() => {
      onDismiss();
    }, 30000);

    return () => clearTimeout(timeout);
  }, [onDismiss]);

  const formatTime = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  };

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="bg-gray-900 text-white rounded-xl shadow-2xl px-5 py-4 flex items-center gap-4 min-w-[320px]">
        {/* Icon */}
        <div className="p-2 bg-blue-500/20 rounded-lg">
          <Undo2 className="w-5 h-5 text-blue-400" />
        </div>

        {/* Content */}
        <div className="flex-1">
          <div className="font-medium text-sm">
            Wrote {booksCount} book{booksCount === 1 ? '' : 's'}
          </div>
          <div className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
            <Clock className="w-3 h-3" />
            Undo available for {formatTime(timeRemaining)}
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
            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
            title="Dismiss (keeps changes)"
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Progress bar showing auto-dismiss */}
      <div className="h-1 bg-gray-700 rounded-b-xl overflow-hidden -mt-1">
        <div
          className="h-full bg-blue-500 transition-all duration-1000 ease-linear"
          style={{ width: `${(timeRemaining / 3600) * 100}%` }}
        />
      </div>
    </div>
  );
}
