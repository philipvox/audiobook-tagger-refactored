import { useState, useMemo } from 'react';
import { X, UploadCloud, AlertTriangle, CheckCircle, BookOpen, User, Mic2, Tag, Image, Library, FileText, Calendar } from 'lucide-react';
import { isAbsBacked } from '../lib/absPush';

// H-7: while a push runs this modal covers the progress bar, so its own
// Cancel becomes "Cancel push" and calls onCancelPush (books in flight finish,
// the rest are skipped). The modal closes when the push settles.
// I-2: `progress` ({ current, total }) is the running push's count.
export function ABSPushModal({ isOpen, onClose, onConfirm, onCancelPush, groups, pushing, progress = null }) {
  const [confirmText, setConfirmText] = useState('');
  // H-7: disabled from the first click until the push settles, so a second
  // click before the parent reports `pushing` cannot start a second push.
  const [submitting, setSubmitting] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const busy = pushing || submitting;

  // Calculate summary of changes
  const summary = useMemo(() => {
    if (!groups || groups.length === 0) return null;

    let titleChanges = 0;
    let authorChanges = 0;
    let narratorChanges = 0;
    let genreChanges = 0;
    let tagChanges = 0;
    let seriesChanges = 0;
    let descriptionChanges = 0;
    let yearChanges = 0;
    let coverChanges = 0;
    let lowConfidenceCount = 0;
    const lowConfidenceBooks = [];

    // M-e: only ABS books are pushed; local books are skipped (Write Tags
    // updates their files).
    const absGroups = groups.filter(isAbsBacked);

    absGroups.forEach(group => {
      const metadata = group.metadata || {};

      // M-10: count books, not files. A multi-file book stages the same
      // change on every file but is one ABS item and one update.
      // M-e: changedFields (metadata names) first, so a book with no files
      // still counts; file.changes (tag names) as the fallback.
      const fields = new Set(group.changedFields || []);
      const changed = (...keys) => keys.some(k => fields.has(k))
        || (group.files || []).some(file => keys.some(k => file.changes?.[k]));
      if (changed('title')) titleChanges++;
      if (changed('author', 'artist')) authorChanges++;
      if (changed('narrator')) narratorChanges++;
      if (changed('genre', 'genres')) genreChanges++;
      if (changed('tags', 'dna', 'age')) tagChanges++;
      if (changed('series', 'sequence')) seriesChanges++;
      if (changed('description')) descriptionChanges++;
      if (changed('year', 'published_year')) yearChanges++;

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
      totalBooks: absGroups.length,
      localBooks: groups.length - absGroups.length,
      titleChanges,
      authorChanges,
      narratorChanges,
      genreChanges,
      tagChanges,
      seriesChanges,
      descriptionChanges,
      yearChanges,
      coverChanges,
      lowConfidenceCount,
      lowConfidenceBooks
    };
  }, [groups]);

  if (!isOpen || !summary) return null;

  const needsTypedConfirmation = summary.totalBooks >= 100;
  const confirmationValid = !needsTypedConfirmation || confirmText === `push ${summary.totalBooks}`;

  const handleConfirm = async () => {
    if (!confirmationValid || busy) return;
    setSubmitting(true);
    setCancelRequested(false);
    setConfirmText('');
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
      setCancelRequested(false);
    }
  };

  const handleCancelPush = () => {
    setCancelRequested(true);
    onCancelPush?.();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden border border-neutral-800">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800/50 bg-neutral-950">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-900/50 rounded-lg">
                <UploadCloud className="w-6 h-6 text-green-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-100">Push to AudiobookShelf</h2>
                <p className="text-sm text-gray-500">Review changes before pushing</p>
              </div>
            </div>
            <button
              // H-7: while a push runs the X asks for the cancel like the
              // footer button; the modal stays until the push settles.
              onClick={busy ? handleCancelPush : onClose}
              disabled={busy && (cancelRequested || !onCancelPush)}
              aria-label={busy ? 'Stop push' : 'Close'}
              className="p-2 hover:bg-neutral-800 rounded-lg transition-colors disabled:opacity-50"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Summary */}
          <div className="bg-black/50 rounded-xl p-4 border border-gray-800">
            <div className="text-center mb-4">
              <span className="text-4xl font-bold text-gray-100">{summary.totalBooks}</span>
              <span className="text-gray-400 ml-2">{summary.totalBooks === 1 ? 'book' : 'books'} will be pushed</span>
              {summary.localBooks > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  {summary.localBooks} local {summary.localBooks === 1 ? 'book' : 'books'} will be skipped (use Write Tags for local files).
                </p>
              )}
            </div>

            {/* Change breakdown */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              {summary.titleChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-300">
                  <BookOpen className="w-4 h-4 text-blue-500" />
                  <span>{summary.titleChanges} title {summary.titleChanges === 1 ? 'update' : 'updates'}</span>
                </div>
              )}
              {summary.authorChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-300">
                  <User className="w-4 h-4 text-purple-500" />
                  <span>{summary.authorChanges} author {summary.authorChanges === 1 ? 'update' : 'updates'}</span>
                </div>
              )}
              {summary.narratorChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-300">
                  <Mic2 className="w-4 h-4 text-green-500" />
                  <span>{summary.narratorChanges} narrator {summary.narratorChanges === 1 ? 'update' : 'updates'}</span>
                </div>
              )}
              {summary.genreChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-300">
                  <Tag className="w-4 h-4 text-orange-500" />
                  <span>{summary.genreChanges} genre {summary.genreChanges === 1 ? 'update' : 'updates'}</span>
                </div>
              )}
              {summary.tagChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-300">
                  <Tag className="w-4 h-4 text-amber-500" />
                  <span>{summary.tagChanges} tag {summary.tagChanges === 1 ? 'update' : 'updates'}</span>
                </div>
              )}
              {summary.seriesChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-300">
                  <Library className="w-4 h-4 text-indigo-400" />
                  <span>{summary.seriesChanges} series {summary.seriesChanges === 1 ? 'update' : 'updates'}</span>
                </div>
              )}
              {summary.descriptionChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-300">
                  <FileText className="w-4 h-4 text-cyan-400" />
                  <span>{summary.descriptionChanges} description {summary.descriptionChanges === 1 ? 'update' : 'updates'}</span>
                </div>
              )}
              {summary.yearChanges > 0 && (
                <div className="flex items-center gap-2 text-gray-300">
                  <Calendar className="w-4 h-4 text-yellow-400" />
                  <span>{summary.yearChanges} year {summary.yearChanges === 1 ? 'update' : 'updates'}</span>
                </div>
              )}
            </div>
          </div>

          {/* Low confidence warning */}
          {summary.lowConfidenceCount > 0 && (
            <div className="bg-red-950/50 border border-red-900/50 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-semibold text-red-300">
                    {summary.lowConfidenceCount} book{summary.lowConfidenceCount > 1 ? 's have' : ' has'} low confidence
                  </h4>
                  <p className="text-sm text-red-400 mt-1">
                    Consider reviewing these before pushing:
                  </p>
                  <ul className="mt-2 text-sm text-red-400 space-y-1">
                    {summary.lowConfidenceBooks.map((book, idx) => (
                      <li key={idx} className="flex items-center gap-2">
                        <span className="text-red-500">●</span>
                        <span className="truncate">{book.title}</span>
                        <span className="text-red-400 font-medium">({book.confidence}%)</span>
                      </li>
                    ))}
                    {summary.lowConfidenceCount > 5 && (
                      <li className="text-red-400 font-medium">
                        ...and {summary.lowConfidenceCount - 5} more
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Warning */}
          <div className="bg-amber-950/50 border border-amber-900/50 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-300">
                <p><strong className="text-amber-200">This writes to your ABS server.</strong></p>
                <p className="mt-1 text-amber-400">Only fields you changed since import are sent. Tags and genres are merged with what is on the server.</p>
                <p className="mt-1 text-amber-400">This cannot be undone from this app. Back up your ABS database if unsure.</p>
              </div>
            </div>
          </div>

          {/* Typed confirmation for large batches */}
          {needsTypedConfirmation && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">
                Type <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-green-400">push {summary.totalBooks}</code> to confirm:
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={`push ${summary.totalBooks}`}
                className="w-full px-4 py-2 bg-neutral-950 border border-neutral-700 rounded-lg text-gray-100 placeholder-gray-500 focus:ring-2 focus:ring-green-500 focus:border-green-500 focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-800 bg-neutral-950 flex items-center justify-end gap-3">
          {busy ? (
            <button
              onClick={handleCancelPush}
              disabled={cancelRequested || !onCancelPush}
              className="px-4 py-2 text-red-300 hover:bg-red-500/10 rounded-lg transition-colors font-medium disabled:opacity-60"
            >
              {cancelRequested ? 'Cancelling...' : 'Cancel push'}
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-300 hover:bg-neutral-800 rounded-lg transition-colors font-medium"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleConfirm}
            disabled={busy || !confirmationValid}
            className={`px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-all ${
              confirmationValid && !busy
                ? 'bg-green-600 hover:bg-green-700 text-white'
                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
            }`}
          >
            {busy ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {progress?.total > 0 ? `Pushed ${progress.current || 0} of ${progress.total}` : 'Pushing...'}
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
