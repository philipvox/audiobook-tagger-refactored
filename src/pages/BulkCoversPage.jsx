import { useState, useEffect, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Image, Download, FolderOpen, Check, AlertCircle, Loader2,
  Search, X, ChevronLeft, ChevronRight, CheckSquare, Square,
  Grid, List
} from 'lucide-react';

// Component to load images through our proxy
function ProxiedImage({ url, alt, className, fallback }) {
  const [src, setSrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      setError(true);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(false);
    setSrc(null);

    invoke('proxy_image', { url })
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.data_url) {
          setSrc(result.data_url);
        } else {
          setError(true);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [url]);

  if (loading) {
    return (
      <div className={`${className} flex items-center justify-center bg-neutral-800`}>
        <Loader2 className="w-6 h-6 text-neutral-500 animate-spin" />
      </div>
    );
  }

  if (error || !src) {
    return fallback || (
      <div className={`${className} flex items-center justify-center bg-neutral-800`}>
        <Image className="w-8 h-8 text-neutral-600" />
      </div>
    );
  }

  return <img src={src} alt={alt} className={className} />;
}

export function BulkCoversPage() {
  const [outputFolder, setOutputFolder] = useState('');
  const [phase, setPhase] = useState('idle'); // idle, searching, preview, downloading, done
  const [progress, setProgress] = useState(null);
  const [searchResult, setSearchResult] = useState(null);
  const [books, setBooks] = useState([]);
  const [downloadResult, setDownloadResult] = useState(null);
  const [error, setError] = useState(null);
  const [selectedBook, setSelectedBook] = useState(null);
  const [filterMode, setFilterMode] = useState('all'); // all, withCovers, noCovers
  const [viewMode, setViewMode] = useState('grid'); // grid, list

  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen('bulk_cover_progress', (event) => {
        setProgress(event.payload);
      });
      return unlisten;
    };

    const unlistenPromise = setupListener();
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const selectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Output Folder for Covers',
      });
      if (selected) {
        setOutputFolder(selected);
        setError(null);
      }
    } catch (err) {
      console.error('Folder selection error:', err);
    }
  };

  const startSearch = async () => {
    setPhase('searching');
    setSearchResult(null);
    setBooks([]);
    setError(null);
    setProgress(null);

    try {
      const result = await invoke('bulk_search_covers');
      setSearchResult(result);
      setBooks(result.books);
      setPhase('preview');
    } catch (err) {
      console.error('Search error:', err);
      setError(typeof err === 'string' ? err : err.message || 'Search failed');
      setPhase('idle');
    }
  };

  const startDownload = async () => {
    if (!outputFolder) {
      setError('Please select an output folder first');
      return;
    }

    setPhase('downloading');
    setDownloadResult(null);
    setError(null);

    try {
      const result = await invoke('bulk_download_selected_covers', {
        books,
        outputFolder,
      });
      setDownloadResult(result);
      setPhase('done');
    } catch (err) {
      console.error('Download error:', err);
      setError(typeof err === 'string' ? err : err.message || 'Download failed');
      setPhase('preview');
    }
  };

  const toggleBookSelection = useCallback((bookId) => {
    setBooks(prev => prev.map(b =>
      b.id === bookId ? { ...b, selected: !b.selected } : b
    ));
  }, []);

  const selectAll = () => {
    setBooks(prev => prev.map(b => ({ ...b, selected: b.best_candidate !== null })));
  };

  const deselectAll = () => {
    setBooks(prev => prev.map(b => ({ ...b, selected: false })));
  };

  const filteredBooks = useMemo(() => {
    return books.filter(b => {
      if (filterMode === 'withCovers') return b.best_candidate !== null;
      if (filterMode === 'noCovers') return b.best_candidate === null;
      return true;
    });
  }, [books, filterMode]);

  const withCoversCount = books.filter(b => b.best_candidate !== null).length;
  const selectedCount = books.filter(b => b.selected).length;

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  // Book detail modal
  const BookDetailModal = ({ book, onClose, onPrev, onNext, hasPrev, hasNext }) => {
    if (!book) return null;

    const currentBook = books.find(b => b.id === book.id);
    if (!currentBook) return null;

    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
        <div className="bg-neutral-900 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-neutral-700">
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-lg text-white truncate">{currentBook.title}</h3>
              <p className="text-neutral-400 text-sm truncate">{currentBook.author}</p>
            </div>
            <div className="flex items-center gap-2 ml-4">
              <button
                onClick={() => toggleBookSelection(currentBook.id)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  currentBook.selected
                    ? 'bg-purple-600 text-white'
                    : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                }`}
              >
                {currentBook.selected ? 'Selected' : 'Select'}
              </button>
              <button onClick={onClose} className="p-2 hover:bg-neutral-700 rounded text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="p-4 overflow-auto max-h-[calc(90vh-120px)]">
            {/* Best cover */}
            {currentBook.best_candidate ? (
              <div className="mb-6">
                <h4 className="text-sm font-medium text-neutral-400 mb-2">Best Cover</h4>
                <div className="flex gap-4">
                  <ProxiedImage
                    url={currentBook.best_candidate.url}
                    alt={currentBook.title}
                    className="w-48 h-auto rounded shadow-lg object-cover"
                  />
                  <div className="text-sm text-neutral-400">
                    <p><span className="text-neutral-500">Source:</span> <span className="text-white">{currentBook.best_candidate.source}</span></p>
                    <p><span className="text-neutral-500">Size:</span> <span className="text-white">{currentBook.best_candidate.width} x {currentBook.best_candidate.height}</span></p>
                    <p><span className="text-neutral-500">Quality:</span> <span className="text-white">{currentBook.best_candidate.quality_score}/100</span></p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-6 p-8 bg-neutral-800 rounded-lg text-center">
                <Image className="w-12 h-12 text-neutral-600 mx-auto mb-2" />
                <p className="text-neutral-500">No cover found</p>
              </div>
            )}

            {/* All candidates */}
            {currentBook.candidates.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-neutral-400 mb-2">
                  All Candidates ({currentBook.candidates.length})
                </h4>
                <div className="grid grid-cols-4 gap-3">
                  {currentBook.candidates.map((c, i) => (
                    <div key={i} className="bg-neutral-800 rounded p-2">
                      <ProxiedImage
                        url={c.url}
                        alt={`Candidate ${i + 1}`}
                        className="w-full h-32 object-cover rounded mb-1"
                      />
                      <div className="text-xs text-neutral-500">
                        <p className="truncate">{c.source}</p>
                        <p>{c.width}x{c.height}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Metadata */}
            <div className="mt-6 p-3 bg-neutral-800 rounded text-sm">
              <p className="text-neutral-500">ASIN: <span className="text-neutral-300">{currentBook.asin || 'N/A'}</span></p>
              <p className="text-neutral-500">ISBN: <span className="text-neutral-300">{currentBook.isbn || 'N/A'}</span></p>
              <p className="text-neutral-500">Has ABS Cover: <span className="text-neutral-300">{currentBook.has_abs_cover ? 'Yes' : 'No'}</span></p>
            </div>
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between p-4 border-t border-neutral-700">
            <button
              onClick={onPrev}
              disabled={!hasPrev}
              className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed rounded flex items-center gap-2 text-white"
            >
              <ChevronLeft className="w-4 h-4" /> Previous
            </button>
            <button
              onClick={onNext}
              disabled={!hasNext}
              className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed rounded flex items-center gap-2 text-white"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const currentBookIndex = selectedBook ? filteredBooks.findIndex(b => b.id === selectedBook.id) : -1;

  return (
    <div className="h-full overflow-auto p-6 bg-neutral-950">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Image className="w-8 h-8 text-purple-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">Bulk Cover Downloader</h1>
            <p className="text-neutral-400 text-sm">
              Search and download high-quality covers for your AudiobookShelf library
            </p>
          </div>
        </div>

        {/* Phase: Idle - Start Search */}
        {phase === 'idle' && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 text-center">
            <Search className="w-12 h-12 text-purple-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-white mb-2">Search for Covers</h3>
            <p className="text-neutral-400 text-sm mb-6">
              Search iTunes, Audible, Google Books, and more for the best covers
            </p>
            <button
              onClick={startSearch}
              className="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white font-medium rounded-lg transition-colors"
            >
              <Search className="w-5 h-5 inline mr-2" />
              Search All Books
            </button>
          </div>
        )}

        {/* Phase: Searching */}
        {phase === 'searching' && progress && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
              <div>
                <div className="font-medium text-white">{progress.phase}</div>
                {progress.current_book && (
                  <div className="text-sm text-neutral-400 truncate max-w-md">
                    {progress.current_book}
                  </div>
                )}
              </div>
            </div>

            <div className="w-full bg-neutral-700 rounded-full h-2 mb-3">
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="flex gap-4 text-sm text-neutral-400">
              <span>{progress.current} / {progress.total}</span>
              <span className="text-green-400">Found: {progress.covers_found}</span>
            </div>
          </div>
        )}

        {/* Phase: Preview - Gallery View */}
        {phase === 'preview' && (
          <>
            {/* Controls */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 mb-4">
              <div className="flex flex-wrap items-center gap-4">
                {/* Stats */}
                <div className="text-sm text-neutral-400">
                  <span className="text-white font-medium">{books.length}</span> books |
                  <span className="text-green-400 ml-1">{withCoversCount}</span> with covers |
                  <span className="text-purple-400 ml-1">{selectedCount}</span> selected
                </div>

                {/* Filter */}
                <div className="flex items-center gap-1 bg-neutral-800 rounded p-1">
                  <button
                    onClick={() => setFilterMode('all')}
                    className={`px-3 py-1 rounded text-sm ${filterMode === 'all' ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setFilterMode('withCovers')}
                    className={`px-3 py-1 rounded text-sm ${filterMode === 'withCovers' ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                  >
                    With Covers
                  </button>
                  <button
                    onClick={() => setFilterMode('noCovers')}
                    className={`px-3 py-1 rounded text-sm ${filterMode === 'noCovers' ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                  >
                    No Covers
                  </button>
                </div>

                {/* View mode */}
                <div className="flex items-center gap-1 bg-neutral-800 rounded p-1">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-1.5 rounded ${viewMode === 'grid' ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                  >
                    <Grid className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                  >
                    <List className="w-4 h-4" />
                  </button>
                </div>

                {/* Selection controls */}
                <div className="flex items-center gap-2 ml-auto">
                  <button
                    onClick={selectAll}
                    className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white rounded text-sm"
                  >
                    Select All
                  </button>
                  <button
                    onClick={deselectAll}
                    className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white rounded text-sm"
                  >
                    Deselect All
                  </button>
                </div>
              </div>
            </div>

            {/* Gallery Grid */}
            {viewMode === 'grid' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3 mb-24">
                {filteredBooks.map(book => (
                  <div
                    key={book.id}
                    className={`relative group cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
                      book.selected ? 'border-purple-500' : 'border-transparent hover:border-neutral-600'
                    }`}
                    onClick={() => setSelectedBook(book)}
                  >
                    {/* Cover image */}
                    <div className="aspect-[2/3] bg-neutral-800">
                      {book.best_candidate ? (
                        <ProxiedImage
                          url={book.best_candidate.url}
                          alt={book.title}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Image className="w-8 h-8 text-neutral-600" />
                        </div>
                      )}
                    </div>

                    {/* Selection checkbox */}
                    <div
                      className="absolute top-2 right-2 z-10"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBookSelection(book.id);
                      }}
                    >
                      {book.selected ? (
                        <CheckSquare className="w-6 h-6 text-purple-400 bg-black/50 rounded" />
                      ) : (
                        <Square className="w-6 h-6 text-neutral-400 bg-black/50 rounded opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </div>

                    {/* Title overlay */}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2">
                      <p className="text-xs text-white truncate font-medium">{book.title}</p>
                      <p className="text-xs text-neutral-400 truncate">{book.author}</p>
                    </div>

                    {/* No cover badge */}
                    {!book.best_candidate && (
                      <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-red-600/80 text-white text-xs rounded">
                        No cover
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* List View */}
            {viewMode === 'list' && (
              <div className="space-y-2 mb-24">
                {filteredBooks.map(book => (
                  <div
                    key={book.id}
                    className={`flex items-center gap-4 p-3 bg-neutral-900 rounded-lg cursor-pointer border-2 transition-all ${
                      book.selected ? 'border-purple-500' : 'border-transparent hover:border-neutral-700'
                    }`}
                    onClick={() => setSelectedBook(book)}
                  >
                    {/* Checkbox */}
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBookSelection(book.id);
                      }}
                    >
                      {book.selected ? (
                        <CheckSquare className="w-5 h-5 text-purple-400" />
                      ) : (
                        <Square className="w-5 h-5 text-neutral-500" />
                      )}
                    </div>

                    {/* Cover thumbnail */}
                    <div className="w-12 h-16 bg-neutral-800 rounded overflow-hidden flex-shrink-0">
                      {book.best_candidate ? (
                        <ProxiedImage
                          url={book.best_candidate.url}
                          alt={book.title}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Image className="w-5 h-5 text-neutral-600" />
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium truncate">{book.title}</p>
                      <p className="text-neutral-400 text-sm truncate">{book.author}</p>
                    </div>

                    {/* Cover info */}
                    <div className="text-right text-sm">
                      {book.best_candidate ? (
                        <div className="text-neutral-400">
                          <p className="text-white">{book.best_candidate.source}</p>
                          <p>{book.best_candidate.width}x{book.best_candidate.height}</p>
                        </div>
                      ) : (
                        <span className="text-red-400">No cover</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Download section - Fixed at bottom */}
            <div className="fixed bottom-0 left-0 right-0 bg-neutral-950 border-t border-neutral-800 p-4 z-40">
              <div className="max-w-7xl mx-auto flex items-center gap-4">
                {/* Folder picker */}
                <div className="flex-1 flex gap-2">
                  <input
                    type="text"
                    value={outputFolder}
                    readOnly
                    placeholder="Select output folder..."
                    className="flex-1 px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 text-sm"
                  />
                  <button
                    onClick={selectFolder}
                    className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white rounded-lg transition-colors flex items-center gap-2"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                </div>

                {/* Download button */}
                <button
                  onClick={startDownload}
                  disabled={!outputFolder || selectedCount === 0}
                  className="px-6 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  Download {selectedCount} Covers
                </button>

                {/* New search */}
                <button
                  onClick={() => { setPhase('idle'); setBooks([]); setSearchResult(null); }}
                  className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white rounded-lg"
                >
                  New Search
                </button>
              </div>
            </div>
          </>
        )}

        {/* Phase: Downloading */}
        {phase === 'downloading' && progress && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
              <div>
                <div className="font-medium text-white">{progress.phase}</div>
                {progress.current_book && (
                  <div className="text-sm text-neutral-400 truncate max-w-md">
                    {progress.current_book}
                  </div>
                )}
              </div>
            </div>

            <div className="w-full bg-neutral-700 rounded-full h-2 mb-3">
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="flex gap-4 text-sm">
              <span className="text-neutral-400">{progress.current} / {progress.total}</span>
              <span className="text-green-400">Downloaded: {progress.covers_found}</span>
              <span className="text-red-400">Failed: {progress.covers_failed}</span>
            </div>
          </div>
        )}

        {/* Phase: Done */}
        {phase === 'done' && downloadResult && (
          <div className="bg-green-900/30 border border-green-700 rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <Check className="w-6 h-6 text-green-400" />
              <span className="font-medium text-green-300 text-lg">Download Complete!</span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-neutral-800/50 rounded p-3">
                <div className="text-neutral-400 text-sm">Selected</div>
                <div className="text-2xl font-bold text-white">{downloadResult.total_selected}</div>
              </div>
              <div className="bg-neutral-800/50 rounded p-3">
                <div className="text-neutral-400 text-sm">Downloaded</div>
                <div className="text-2xl font-bold text-green-400">{downloadResult.covers_downloaded}</div>
              </div>
              <div className="bg-neutral-800/50 rounded p-3">
                <div className="text-neutral-400 text-sm">Failed</div>
                <div className="text-2xl font-bold text-red-400">{downloadResult.covers_failed}</div>
              </div>
              <div className="bg-neutral-800/50 rounded p-3">
                <div className="text-neutral-400 text-sm">Success Rate</div>
                <div className="text-2xl font-bold text-white">
                  {downloadResult.total_selected > 0
                    ? Math.round((downloadResult.covers_downloaded / downloadResult.total_selected) * 100)
                    : 0}%
                </div>
              </div>
            </div>

            <div className="text-sm text-neutral-400 mb-4">
              Saved to: <span className="text-neutral-300">{downloadResult.output_folder}</span>
            </div>

            <button
              onClick={() => { setPhase('idle'); setBooks([]); setSearchResult(null); setDownloadResult(null); }}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg"
            >
              Start New Search
            </button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="mt-4 bg-red-900/30 border border-red-700 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="text-red-300">{error}</div>
          </div>
        )}

        {/* Book Detail Modal */}
        {selectedBook && (
          <BookDetailModal
            book={selectedBook}
            onClose={() => setSelectedBook(null)}
            onPrev={() => {
              const idx = filteredBooks.findIndex(b => b.id === selectedBook.id);
              if (idx > 0) setSelectedBook(filteredBooks[idx - 1]);
            }}
            onNext={() => {
              const idx = filteredBooks.findIndex(b => b.id === selectedBook.id);
              if (idx < filteredBooks.length - 1) setSelectedBook(filteredBooks[idx + 1]);
            }}
            hasPrev={currentBookIndex > 0}
            hasNext={currentBookIndex < filteredBooks.length - 1}
          />
        )}
      </div>
    </div>
  );
}
