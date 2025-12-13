import { useState, useMemo } from 'react';
import { X, UploadCloud, AlertTriangle, CheckCircle, BookOpen, User, Mic2, Tag, Image } from 'lucide-react';

export function ABSPushModal({ isOpen, onClose, onConfirm, groups, pushing }) {
  const [confirmText, setConfirmText] = useState('');

  // Calculate summary of changes
  const summary = useMemo(() => {
    if (!groups || groups.length === 0) return null;

    let titleChanges = 0;
    let authorChanges = 0;
    let narratorChanges = 0;
    let genreChanges = 0;
    let coverChanges = 0;
    let lowConfidenceCount = 0;
    const lowConfidenceBooks = [];

    groups.forEach(group => {
      const metadata = group.metadata;

      // Count changes from files
      group.files?.forEach(file => {
        if (file.changes) {
          if (file.changes.title) titleChanges++;
          if (file.changes.author || file.changes.artist) authorChanges++;
          if (file.changes.narrator) narratorChanges++;
          if (file.changes.genre) genreChanges++;
        }
      });

      // Check for cover
      if (metadata.cover_url) coverChanges++;

      // Check confidence
      if (metadata.confidence && metadata.confidence.overall < 60) {
        lowConfidenceCount++;
        if (lowConfidenceBooks.length < 5) {
          lowConfidenceBooks.push({
            title: metadata.title,
            confidence: metadata.confidence.overall
          });
        }
      }
    });

    return {
      totalBooks: groups.length,
      titleChanges,
      authorChanges,
      narratorChanges,
      genreChanges,
      coverChanges,
      lowConfidenceCount,
      lowConfidenceBooks
    };
  }, [groups]);

  if (!isOpen || !summary) return null;

  const needsTypedConfirmation = summary.totalBooks >= 100;
  const confirmationValid = !needsTypedConfirmation || confirmText === `push ${summary.totalBooks}`;

  const handleConfirm = () => {
    if (confirmationValid) {
      onConfirm();
      setConfirmText('');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-green-50 to-emerald-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <UploadCloud className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">Push to AudiobookShelf</h2>
                <p className="text-sm text-gray-600">Review changes before pushing</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-green-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Summary */}
          <div className="bg-gray-50 rounded-xl p-4">
            <div className="text-center mb-4">
              <span className="text-4xl font-bold text-gray-900">{summary.totalBooks}</span>
              <span className="text-gray-600 ml-2">books will be pushed</span>
            </div>

            {/* Change breakdown */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              {summary.titleChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-700">
                  <BookOpen className="w-4 h-4 text-blue-500" />
                  <span>{summary.titleChanges} title updates</span>
                </div>
              )}
              {summary.authorChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-700">
                  <User className="w-4 h-4 text-purple-500" />
                  <span>{summary.authorChanges} author updates</span>
                </div>
              )}
              {summary.narratorChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-700">
                  <Mic2 className="w-4 h-4 text-green-500" />
                  <span>{summary.narratorChanges} narrator updates</span>
                </div>
              )}
              {summary.genreChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-700">
                  <Tag className="w-4 h-4 text-orange-500" />
                  <span>{summary.genreChanges} genre updates</span>
                </div>
              )}
              {summary.coverChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-700">
                  <Image className="w-4 h-4 text-pink-500" />
                  <span>{summary.coverChanges} covers</span>
                </div>
              )}
            </div>
          </div>

          {/* Low confidence warning */}
          {summary.lowConfidenceCount > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-semibold text-red-800">
                    {summary.lowConfidenceCount} book{summary.lowConfidenceCount > 1 ? 's have' : ' has'} low confidence
                  </h4>
                  <p className="text-sm text-red-700 mt-1">
                    Consider reviewing these before pushing:
                  </p>
                  <ul className="mt-2 text-sm text-red-700 space-y-1">
                    {summary.lowConfidenceBooks.map((book, idx) => (
                      <li key={idx} className="flex items-center gap-2">
                        <span className="text-red-500">🔴</span>
                        <span className="truncate">{book.title}</span>
                        <span className="text-red-500 font-medium">({book.confidence}%)</span>
                      </li>
                    ))}
                    {summary.lowConfidenceCount > 5 && (
                      <li className="text-red-600 font-medium">
                        ...and {summary.lowConfidenceCount - 5} more
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Info note */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
            <p>
              <strong>Note:</strong> This will update metadata on your AudiobookShelf server.
              {summary.coverChanges > 0 && ' Covers will be uploaded if cached locally.'}
            </p>
          </div>

          {/* Typed confirmation for large batches */}
          {needsTypedConfirmation && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">
                Type <code className="bg-gray-100 px-1.5 py-0.5 rounded">push {summary.totalBooks}</code> to confirm:
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={`push ${summary.totalBooks}`}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={pushing}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={pushing || !confirmationValid}
            className={`px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-all ${
              confirmationValid && !pushing
                ? 'bg-green-600 hover:bg-green-700 text-white'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            {pushing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Pushing...
              </>
            ) : (
              <>
                <UploadCloud className="w-4 h-4" />
                Push to ABS
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
