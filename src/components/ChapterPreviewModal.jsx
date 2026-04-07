import { X, Clock, List, CheckCircle } from 'lucide-react';

export function ChapterPreviewModal({ chapters, totalDuration, onClose }) {
  const formatDuration = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatTimestamp = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatTotalDuration = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    return `${minutes}m ${seconds}s`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="p-6 border-b border-neutral-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <List className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-100">Chapter Preview</h2>
                <p className="text-sm text-gray-400">
                  {chapters.length} chapters detected
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Chapter List */}
        <div className="overflow-y-auto max-h-[50vh]">
          <table className="w-full">
            <thead className="bg-neutral-950 sticky top-0">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider w-12">
                  #
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Chapter Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider w-28">
                  Start
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-400 uppercase tracking-wider w-24">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {chapters.map((chapter, index) => {
                const duration = chapter.end_ms - chapter.start_ms;
                return (
                  <tr
                    key={index}
                    className="hover:bg-neutral-950 transition-colors"
                  >
                    <td className="px-4 py-3 text-sm text-gray-400 font-mono">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-gray-100">
                        {chapter.title}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400 font-mono">
                      {formatTimestamp(chapter.start_ms)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400 text-right font-mono">
                      {formatDuration(duration)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-neutral-800 bg-neutral-950">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-sm text-gray-400">
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4" />
                Total: {formatTotalDuration(totalDuration)}
              </div>
              <div className="flex items-center gap-1.5">
                <List className="w-4 h-4" />
                {chapters.length} chapters
              </div>
            </div>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2"
            >
              <CheckCircle className="w-4 h-4" />
              Looks Good
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
