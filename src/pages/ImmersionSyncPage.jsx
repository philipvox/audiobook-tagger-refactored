import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Headphones,
  BookOpen,
  RefreshCw,
  Play,
  Pause,
  X,
  CheckCircle,
  AlertCircle,
  Clock,
  Download,
  Trash2,
  RotateCcw,
  FileText,
  Loader2,
  ChevronRight,
  Info,
  FolderOpen,
  Library,
  FileAudio,
  FileType,
  Plus
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { ConfirmModal } from '../components/ConfirmModal';

export function ImmersionSyncPage() {
  const { startGlobalProgress, endGlobalProgress, updateGlobalProgress } = useApp();
  const [status, setStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState({});
  const [confirmModal, setConfirmModal] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);

  // Local test state
  const [localAudioPath, setLocalAudioPath] = useState('');
  const [localEpubPath, setLocalEpubPath] = useState('');
  const [localTestResult, setLocalTestResult] = useState(null);
  const [localTestError, setLocalTestError] = useState(null);

  // Library scan state
  const [eligibleBooks, setEligibleBooks] = useState([]);
  const [scanningLibrary, setScanningLibrary] = useState(false);

  // Load status and jobs on mount
  useEffect(() => {
    loadStatus();
    loadJobs();

    // Poll for updates every 5 seconds
    const interval = setInterval(() => {
      loadJobs();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const loadStatus = async () => {
    try {
      // Call check_aeneas_available directly for more reliable detection
      const aeneasAvailable = await invoke('check_aeneas_available');

      // Try to get full status, but don't fail if queue has issues
      let queueStats = { pending: 0, processing: 0, completed: 0, failed: 0, totalAlignments: 0 };
      try {
        const result = await invoke('get_alignment_status');
        queueStats = result.queueStats;
      } catch (queueErr) {
        console.warn('Queue status unavailable:', queueErr);
      }

      setStatus({ aeneasAvailable, queueStats });
    } catch (e) {
      console.error('Failed to load alignment status:', e);
    }
  };

  const loadJobs = async () => {
    try {
      const result = await invoke('get_alignment_jobs');
      setJobs(result);
    } catch (e) {
      console.error('Failed to load jobs:', e);
    }
  };

  const handleCancelJob = async (jobId) => {
    try {
      await invoke('cancel_alignment_job', { jobId });
      loadJobs();
    } catch (e) {
      console.error('Failed to cancel job:', e);
    }
  };

  const handleRetryJob = async (jobId) => {
    try {
      await invoke('retry_alignment_job', { jobId });
      loadJobs();
    } catch (e) {
      console.error('Failed to retry job:', e);
    }
  };

  const handleClearCompleted = async () => {
    try {
      const count = await invoke('clear_completed_jobs');
      loadJobs();
    } catch (e) {
      console.error('Failed to clear completed jobs:', e);
    }
  };

  const handleExportVTT = async (bookId) => {
    try {
      setLoading(prev => ({ ...prev, [`export-${bookId}`]: true }));
      const vtt = await invoke('export_alignment_vtt', { bookId });

      // Download as file
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `alignment-${bookId}.vtt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export VTT:', e);
    } finally {
      setLoading(prev => ({ ...prev, [`export-${bookId}`]: false }));
    }
  };

  const handleExportSRT = async (bookId) => {
    try {
      setLoading(prev => ({ ...prev, [`export-srt-${bookId}`]: true }));
      const srt = await invoke('export_alignment_srt', { bookId });

      const blob = new Blob([srt], { type: 'text/srt' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `alignment-${bookId}.srt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export SRT:', e);
    } finally {
      setLoading(prev => ({ ...prev, [`export-srt-${bookId}`]: false }));
    }
  };

  // Local file testing
  const handleSelectAudio = async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: 'Audio', extensions: ['m4b', 'm4a', 'mp3', 'opus', 'ogg', 'flac', 'wav'] }]
      });
      if (file) {
        setLocalAudioPath(file);
        setLocalTestResult(null);
        setLocalTestError(null);
      }
    } catch (e) {
      console.error('Failed to select audio:', e);
    }
  };

  const handleSelectEpub = async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: 'EPUB', extensions: ['epub'] }]
      });
      if (file) {
        setLocalEpubPath(file);
        setLocalTestResult(null);
        setLocalTestError(null);
      }
    } catch (e) {
      console.error('Failed to select epub:', e);
    }
  };

  const handleTestLocal = async () => {
    if (!localAudioPath || !localEpubPath) return;

    try {
      setLoading(prev => ({ ...prev, localTest: true }));
      setLocalTestError(null);
      setLocalTestResult(null);

      const result = await invoke('align_local_files', {
        audioPath: localAudioPath,
        epubPath: localEpubPath,
        options: { language: 'eng', granularity: 'sentence' }
      });

      setLocalTestResult(result);
    } catch (e) {
      console.error('Local test failed:', e);
      setLocalTestError(e.toString());
    } finally {
      setLoading(prev => ({ ...prev, localTest: false }));
    }
  };

  // Library scanning
  const handleScanLibrary = async () => {
    try {
      setScanningLibrary(true);
      setEligibleBooks([]);

      const books = await invoke('scan_library_for_alignment');
      setEligibleBooks(books);
    } catch (e) {
      console.error('Failed to scan library:', e);
    } finally {
      setScanningLibrary(false);
    }
  };

  const handleQueueBook = async (book) => {
    try {
      await invoke('queue_alignment', {
        bookId: book.id,
        libraryId: book.libraryId,
        title: book.title,
        author: book.author
      });
      loadJobs();
      // Remove from eligible list
      setEligibleBooks(prev => prev.filter(b => b.id !== book.id));
    } catch (e) {
      console.error('Failed to queue book:', e);
    }
  };

  const handleQueueAll = async () => {
    try {
      setLoading(prev => ({ ...prev, queueAll: true }));
      const books = eligibleBooks.map(b => ({
        bookId: b.id,
        libraryId: b.libraryId,
        title: b.title,
        author: b.author
      }));
      await invoke('queue_alignment_batch', { books });
      loadJobs();
      setEligibleBooks([]);
    } catch (e) {
      console.error('Failed to queue all:', e);
    } finally {
      setLoading(prev => ({ ...prev, queueAll: false }));
    }
  };

  const getStatusIcon = (jobStatus) => {
    switch (jobStatus) {
      case 'pending':
        return <Clock className="w-4 h-4 text-gray-400" />;
      case 'downloading':
      case 'processing':
        return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-400" />;
      case 'failed':
        return <AlertCircle className="w-4 h-4 text-red-400" />;
      case 'cancelled':
        return <X className="w-4 h-4 text-gray-500" />;
      default:
        return <Clock className="w-4 h-4 text-gray-400" />;
    }
  };

  const getStatusColor = (jobStatus) => {
    switch (jobStatus) {
      case 'pending':
        return 'bg-gray-500/20 text-gray-400';
      case 'downloading':
      case 'processing':
        return 'bg-blue-500/20 text-blue-400';
      case 'completed':
        return 'bg-green-500/20 text-green-400';
      case 'failed':
        return 'bg-red-500/20 text-red-400';
      case 'cancelled':
        return 'bg-gray-500/20 text-gray-500';
      default:
        return 'bg-gray-500/20 text-gray-400';
    }
  };

  const pendingCount = jobs.filter(j => j.status === 'pending').length;
  const processingCount = jobs.filter(j => ['downloading', 'processing'].includes(j.status)).length;
  const completedCount = jobs.filter(j => j.status === 'completed').length;
  const failedCount = jobs.filter(j => j.status === 'failed').length;

  return (
    <div className="h-full overflow-y-auto bg-neutral-950">
      <div className="p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-gradient-to-br from-purple-500/20 to-pink-500/20 rounded-xl">
                  <Headphones className="w-8 h-8 text-purple-400" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-gray-100">Immersion Sync</h2>
                  <p className="text-gray-400">
                    Align audiobooks with EPUB text for synchronized reading
                  </p>
                </div>
              </div>
              <button
                onClick={() => { loadStatus(); loadJobs(); }}
                className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
                title="Refresh"
              >
                <RefreshCw className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* Status Bar */}
            <div className="mt-6 pt-4 border-t border-neutral-800">
              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800 rounded-lg">
                  <div className={`w-2 h-2 rounded-full ${status?.aeneasAvailable ? 'bg-green-400' : 'bg-red-400'}`} />
                  <span className="text-sm text-gray-300">
                    Aeneas: {status?.aeneasAvailable ? 'Available' : 'Not Found'}
                  </span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800 rounded-lg">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-300">Pending: {pendingCount}</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800 rounded-lg">
                  <Loader2 className="w-4 h-4 text-blue-400" />
                  <span className="text-sm text-gray-300">Processing: {processingCount}</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800 rounded-lg">
                  <CheckCircle className="w-4 h-4 text-green-400" />
                  <span className="text-sm text-gray-300">Completed: {completedCount}</span>
                </div>
                {failedCount > 0 && (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-red-400" />
                    <span className="text-sm text-red-400">Failed: {failedCount}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Aeneas Not Available Warning */}
          {status && !status.aeneasAvailable && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5" />
                <div>
                  <h3 className="font-medium text-amber-200">Aeneas Not Installed</h3>
                  <p className="text-sm text-amber-300/80 mt-1">
                    Aeneas is required for text-to-audio alignment. Install it with:
                  </p>
                  <code className="block mt-2 p-2 bg-neutral-900 rounded text-sm text-gray-300 font-mono">
                    pip install aeneas numpy scipy
                  </code>
                </div>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Test Local Files */}
            <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
              <div className="flex items-center gap-3 mb-4">
                <FolderOpen className="w-5 h-5 text-orange-400" />
                <h3 className="font-semibold text-gray-100">Test Local Files</h3>
              </div>

              <div className="space-y-3">
                <div>
                  <button
                    onClick={handleSelectAudio}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-colors text-left"
                  >
                    <FileAudio className="w-4 h-4 text-gray-400" />
                    <span className="text-sm text-gray-300 truncate flex-1">
                      {localAudioPath ? localAudioPath.split('/').pop() : 'Select Audio File...'}
                    </span>
                  </button>
                </div>

                <div>
                  <button
                    onClick={handleSelectEpub}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-colors text-left"
                  >
                    <FileType className="w-4 h-4 text-gray-400" />
                    <span className="text-sm text-gray-300 truncate flex-1">
                      {localEpubPath ? localEpubPath.split('/').pop() : 'Select EPUB File...'}
                    </span>
                  </button>
                </div>

                <button
                  onClick={handleTestLocal}
                  disabled={!localAudioPath || !localEpubPath || loading.localTest || !status?.aeneasAvailable}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-neutral-700 disabled:text-gray-500 rounded-lg transition-colors text-white font-medium"
                >
                  {loading.localTest ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  Test Alignment
                </button>

                {localTestError && (
                  <div className="p-2 bg-red-500/10 rounded text-sm text-red-400">
                    {localTestError}
                  </div>
                )}

                {localTestResult && (
                  <div className="p-2 bg-green-500/10 rounded text-sm text-green-400">
                    Aligned {localTestResult.chapters?.length || 0} chapters successfully!
                  </div>
                )}
              </div>
            </div>

            {/* Scan Library */}
            <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
              <div className="flex items-center gap-3 mb-4">
                <Library className="w-5 h-5 text-blue-400" />
                <h3 className="font-semibold text-gray-100">AudiobookShelf Library</h3>
              </div>

              <div className="space-y-3">
                <p className="text-sm text-gray-400">
                  Scan your library for books with both audiobook and EPUB files attached.
                </p>

                <button
                  onClick={handleScanLibrary}
                  disabled={scanningLibrary}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-gray-500 rounded-lg transition-colors text-white font-medium"
                >
                  {scanningLibrary ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  Scan Library
                </button>

                {eligibleBooks.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">
                        Found {eligibleBooks.length} eligible book{eligibleBooks.length !== 1 ? 's' : ''}
                      </span>
                      <button
                        onClick={handleQueueAll}
                        disabled={loading.queueAll}
                        className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1"
                      >
                        {loading.queueAll ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                        Queue All
                      </button>
                    </div>

                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {eligibleBooks.map((book) => (
                        <div
                          key={book.id}
                          className="flex items-center justify-between p-2 bg-neutral-800 rounded-lg"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-gray-200 truncate">{book.title}</p>
                            <p className="text-xs text-gray-500 truncate">{book.author}</p>
                          </div>
                          <button
                            onClick={() => handleQueueBook(book)}
                            className="p-1 hover:bg-neutral-700 rounded transition-colors ml-2"
                            title="Add to queue"
                          >
                            <Plus className="w-4 h-4 text-blue-400" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Job Queue */}
          <div className="bg-neutral-900 rounded-xl border border-neutral-800 overflow-hidden">
            <div className="bg-gradient-to-r from-purple-900/30 to-blue-900/20 px-6 py-4 border-b border-neutral-800">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <BookOpen className="w-5 h-5 text-purple-400" />
                  <h3 className="text-lg font-semibold text-gray-100">Alignment Queue</h3>
                </div>
                {completedCount > 0 && (
                  <button
                    onClick={handleClearCompleted}
                    className="text-sm text-gray-400 hover:text-gray-200 flex items-center gap-1"
                  >
                    <Trash2 className="w-4 h-4" />
                    Clear Completed
                  </button>
                )}
              </div>
            </div>

            {jobs.length === 0 ? (
              <div className="p-12 text-center">
                <Headphones className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <p className="text-gray-400">No alignment jobs in queue</p>
                <p className="text-sm text-gray-500 mt-1">
                  Add books from the Library tab to start alignment
                </p>
              </div>
            ) : (
              <div className="divide-y divide-neutral-800">
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    className="p-4 hover:bg-neutral-800/50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {getStatusIcon(job.status)}
                        <div className="min-w-0">
                          <p className="font-medium text-gray-200 truncate">
                            {job.title}
                          </p>
                          <p className="text-sm text-gray-500 truncate">
                            {job.author}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {/* Progress for active jobs */}
                        {['downloading', 'processing'].includes(job.status) && (
                          <div className="w-32">
                            <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                              <span>
                                {job.currentChapter && job.totalChapters
                                  ? `Chapter ${job.currentChapter}/${job.totalChapters}`
                                  : job.status}
                              </span>
                              <span>{Math.round(job.progress)}%</span>
                            </div>
                            <div className="h-1.5 bg-neutral-700 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 transition-all"
                                style={{ width: `${job.progress}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {/* Status Badge */}
                        <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(job.status)}`}>
                          {job.status}
                        </span>

                        {/* Actions */}
                        <div className="flex items-center gap-1">
                          {job.status === 'pending' && (
                            <button
                              onClick={() => handleCancelJob(job.id)}
                              className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
                              title="Cancel"
                            >
                              <X className="w-4 h-4 text-gray-400" />
                            </button>
                          )}
                          {job.status === 'failed' && (
                            <button
                              onClick={() => handleRetryJob(job.id)}
                              className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
                              title="Retry"
                            >
                              <RotateCcw className="w-4 h-4 text-gray-400" />
                            </button>
                          )}
                          {job.status === 'completed' && (
                            <>
                              <button
                                onClick={() => handleExportVTT(job.bookId)}
                                disabled={loading[`export-${job.bookId}`]}
                                className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
                                title="Export VTT"
                              >
                                {loading[`export-${job.bookId}`] ? (
                                  <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4 text-gray-400" />
                                )}
                              </button>
                              <button
                                onClick={() => handleExportSRT(job.bookId)}
                                disabled={loading[`export-srt-${job.bookId}`]}
                                className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
                                title="Export SRT"
                              >
                                <FileText className="w-4 h-4 text-gray-400" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Error message */}
                    {job.error && (
                      <div className="mt-2 p-2 bg-red-500/10 rounded text-sm text-red-400">
                        {job.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Total Alignments */}
          {status?.queueStats?.totalAlignments > 0 && (
            <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-green-400" />
                <span className="text-gray-300">
                  {status.queueStats.totalAlignments} book{status.queueStats.totalAlignments !== 1 ? 's' : ''} aligned and ready for immersion reading
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirm Modal */}
      {confirmModal && (
        <ConfirmModal
          {...confirmModal}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
}
