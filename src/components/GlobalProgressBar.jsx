// src/components/GlobalProgressBar.jsx
import { RefreshCw, X, Clock } from 'lucide-react';
import { useApp } from '../context/AppContext';

export function GlobalProgressBar() {
  const { globalProgress, cancelGlobalProgress } = useApp();

  // Don't show if no active progress
  if (!globalProgress.active) return null;

  const { current, total, message, startTime, canCancel, type } = globalProgress;

  // Calculate ETA
  const calculateETA = () => {
    if (!startTime || current === 0) {
      return 'Calculating...';
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = current / elapsed;

    if (rate === 0) return 'Calculating...';

    const remaining = total - current;
    const secondsLeft = remaining / rate;

    if (secondsLeft < 60) {
      return `~${Math.round(secondsLeft)}s remaining`;
    } else if (secondsLeft < 3600) {
      const mins = Math.floor(secondsLeft / 60);
      const secs = Math.round(secondsLeft % 60);
      return `~${mins}m ${secs}s remaining`;
    } else {
      const hours = Math.floor(secondsLeft / 3600);
      const mins = Math.floor((secondsLeft % 3600) / 60);
      return `~${hours}h ${mins}m remaining`;
    }
  };

  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

  // Color based on type
  const getColors = () => {
    switch (type) {
      case 'danger':
        return {
          bg: 'from-red-500 to-red-600',
          icon: 'text-red-600',
          bar: 'bg-gradient-to-r from-red-500 to-red-600'
        };
      case 'success':
        return {
          bg: 'from-green-500 to-green-600',
          icon: 'text-green-600',
          bar: 'bg-gradient-to-r from-green-500 to-green-600'
        };
      case 'warning':
        return {
          bg: 'from-yellow-500 to-yellow-600',
          icon: 'text-yellow-600',
          bar: 'bg-gradient-to-r from-yellow-500 to-yellow-600'
        };
      default:
        return {
          bg: 'from-blue-500 to-blue-600',
          icon: 'text-blue-600',
          bar: 'bg-gradient-to-r from-blue-500 to-blue-600'
        };
    }
  };

  const colors = getColors();

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <RefreshCw className={`w-5 h-5 ${colors.icon} animate-spin`} />
              <span className="font-semibold text-gray-900">
                {message || 'Processing...'}
              </span>
            </div>
            {canCancel && cancelGlobalProgress && (
              <button
                onClick={cancelGlobalProgress}
                className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-sm font-medium rounded-lg transition-colors flex items-center gap-1"
              >
                <X className="w-4 h-4" />
                Cancel
              </button>
            )}
          </div>

          <div className="text-right flex items-center gap-4">
            {total > 0 && (
              <div className="flex items-center gap-2 text-gray-600">
                <Clock className="w-4 h-4" />
                <span className="text-sm font-medium">{calculateETA()}</span>
              </div>
            )}
            <div>
              {total > 0 && (
                <div className="font-semibold text-gray-900">
                  {current} of {total}
                </div>
              )}
              <div className="text-sm text-gray-600">
                {percentage}% complete
              </div>
            </div>
          </div>
        </div>

        <div className="mb-2">
          <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
            <div
              className={`${colors.bar} h-3 rounded-full transition-all duration-300`}
              style={{
                width: `${total > 0 ? Math.max(2, percentage) : 0}%`
              }}
            ></div>
          </div>
        </div>

        {globalProgress.detail && (
          <div className="text-sm text-gray-600 truncate">
            <span className="font-medium">Current:</span> {globalProgress.detail}
          </div>
        )}
      </div>
    </div>
  );
}
