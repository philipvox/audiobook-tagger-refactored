import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Wand2,
  FolderOpen,
  FileEdit,
  FolderTree,
  Sparkles,
  Loader2,
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  ChevronDown,
  Info,
  RefreshCw,
  BookOpen,
  FileAudio,
} from 'lucide-react';

export function SmartRenamePage() {
  const [folderPath, setFolderPath] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [selectedFolders, setSelectedFolders] = useState(new Set());
  const [expandedBooks, setExpandedBooks] = useState(new Set());
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('files');

  const handlePickFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select audiobook folder to analyze',
      });
      if (selected) {
        setFolderPath(selected);
        setAnalysis(null);
        setResult(null);
        setError(null);
      }
    } catch (e) {
      setError('Failed to open folder picker: ' + e.toString());
    }
  };

  const handleAnalyze = async () => {
    if (!folderPath) {
      setError('Please select a folder first');
      return;
    }

    setAnalyzing(true);
    setError(null);
    setResult(null);

    try {
      const result = await invoke('analyze_smart_rename', {
        path: folderPath,
        includeSubfolders: true,
      });

      setAnalysis(result);

      // Select all by default
      setSelectedFiles(new Set(result.file_proposals.map(p => p.id)));
      setSelectedFolders(new Set(result.folder_proposals.map(p => p.id)));

      // Expand first book by default
      if (result.detected_books.length > 0) {
        setExpandedBooks(new Set([result.detected_books[0].id]));
      }
    } catch (e) {
      setError(e.toString());
    } finally {
      setAnalyzing(false);
    }
  };

  const handleApply = async () => {
    if (!analysis) return;

    setApplying(true);
    setError(null);

    try {
      const result = await invoke('apply_smart_renames', {
        fileProposals: analysis.file_proposals.map(p => ({
          ...p,
          selected: selectedFiles.has(p.id),
        })),
        folderProposals: analysis.folder_proposals.map(p => ({
          ...p,
          selected: selectedFolders.has(p.id),
        })),
        createBackup: true,
      });

      setResult(result);
      if (result.success) {
        setAnalysis(null);
      }
    } catch (e) {
      setError(e.toString());
    } finally {
      setApplying(false);
    }
  };

  const toggleBook = (bookId) => {
    const newExpanded = new Set(expandedBooks);
    if (newExpanded.has(bookId)) {
      newExpanded.delete(bookId);
    } else {
      newExpanded.add(bookId);
    }
    setExpandedBooks(newExpanded);
  };

  const toggleAllFiles = (select) => {
    if (select) {
      setSelectedFiles(new Set(analysis.file_proposals.map(p => p.id)));
    } else {
      setSelectedFiles(new Set());
    }
  };

  const toggleAllFolders = (select) => {
    if (select) {
      setSelectedFolders(new Set(analysis.folder_proposals.map(p => p.id)));
    } else {
      setSelectedFolders(new Set());
    }
  };

  const getConfidenceColor = (confidence) => {
    if (confidence >= 80) return 'text-green-600';
    if (confidence >= 50) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getConfidenceBg = (confidence) => {
    if (confidence >= 80) return 'bg-green-100';
    if (confidence >= 50) return 'bg-yellow-100';
    return 'bg-red-100';
  };

  const getAudiobookTypeLabel = (type) => {
    switch (type) {
      case 'SingleFile': return 'Single File';
      case 'MultiPart': return 'Multi-Part';
      case 'ChapterSplit': return 'Chapter Split';
      default: return 'Unknown';
    }
  };

  const getAudiobookTypeIcon = (type) => {
    switch (type) {
      case 'SingleFile': return <FileAudio className="w-4 h-4" />;
      case 'MultiPart': return <BookOpen className="w-4 h-4" />;
      case 'ChapterSplit': return <FileEdit className="w-4 h-4" />;
      default: return <FileAudio className="w-4 h-4" />;
    }
  };

  const getIssueIcon = (issueType) => {
    switch (issueType) {
      case 'GenericFilenames':
        return <FileEdit className="w-4 h-4 text-yellow-500" />;
      case 'MessyBookTitle':
        return <AlertTriangle className="w-4 h-4 text-orange-500" />;
      case 'MissingChapterNames':
        return <FileAudio className="w-4 h-4 text-blue-500" />;
      default:
        return <AlertTriangle className="w-4 h-4 text-gray-500" />;
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl">
                <Wand2 className="w-8 h-8 text-white" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-gray-900">AI Smart Rename</h2>
                <p className="text-gray-600">
                  Intelligently rename files and reorganize folders using AI
                </p>
              </div>
            </div>
          </div>

          {/* Folder Selection */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex gap-4">
              <div className="flex-1">
                <input
                  type="text"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  placeholder="Select folder to analyze..."
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                />
              </div>
              <button
                onClick={handlePickFolder}
                className="px-6 py-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                <FolderOpen className="w-5 h-5" />
              </button>
              <button
                onClick={handleAnalyze}
                disabled={analyzing || !folderPath}
                className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all"
              >
                {analyzing ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Sparkles className="w-5 h-5" />
                )}
                {analyzing ? 'Analyzing...' : 'Analyze with AI'}
              </button>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-center gap-3 text-red-700">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Result Display */}
          {result && (
            <div className={`p-4 rounded-xl border ${
              result.success ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
            }`}>
              <div className="flex items-center gap-3">
                <CheckCircle className={`w-5 h-5 ${result.success ? 'text-green-600' : 'text-yellow-600'}`} />
                <span className={`font-medium ${result.success ? 'text-green-700' : 'text-yellow-700'}`}>
                  Renamed {result.files_renamed} files, reorganized {result.folders_moved} folders
                </span>
              </div>
              {result.errors?.length > 0 && (
                <div className="mt-2 text-sm text-red-600">
                  {result.errors.slice(0, 3).map((err, i) => (
                    <div key={i}>{err}</div>
                  ))}
                  {result.errors.length > 3 && (
                    <div>...and {result.errors.length - 3} more errors</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Analysis Results */}
          {analysis && (
            <div className="space-y-6">
              {/* Statistics Cards */}
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-white p-4 rounded-xl border border-gray-200 text-center">
                  <div className="text-3xl font-bold text-gray-900">
                    {analysis.detected_books.length}
                  </div>
                  <div className="text-sm text-gray-500">Books Detected</div>
                </div>
                <div className="bg-white p-4 rounded-xl border border-gray-200 text-center">
                  <div className="text-3xl font-bold text-purple-600">
                    {analysis.statistics.files_to_rename}
                  </div>
                  <div className="text-sm text-gray-500">Files to Rename</div>
                </div>
                <div className="bg-white p-4 rounded-xl border border-gray-200 text-center">
                  <div className="text-3xl font-bold text-pink-600">
                    {analysis.statistics.folders_to_rename}
                  </div>
                  <div className="text-sm text-gray-500">Folders to Move</div>
                </div>
                <div className="bg-yellow-50 p-4 rounded-xl border border-yellow-200 text-center">
                  <div className="text-3xl font-bold text-yellow-700">
                    {analysis.issues.length}
                  </div>
                  <div className="text-sm text-yellow-600">Issues Found</div>
                </div>
              </div>

              {/* Tabs */}
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="flex border-b border-gray-200">
                  <button
                    onClick={() => setActiveTab('files')}
                    className={`px-6 py-3 font-medium transition-colors ${
                      activeTab === 'files'
                        ? 'bg-purple-50 text-purple-700 border-b-2 border-purple-600'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <FileEdit className="w-4 h-4 inline mr-2" />
                    File Renames ({analysis.file_proposals.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('folders')}
                    className={`px-6 py-3 font-medium transition-colors ${
                      activeTab === 'folders'
                        ? 'bg-purple-50 text-purple-700 border-b-2 border-purple-600'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <FolderTree className="w-4 h-4 inline mr-2" />
                    Folder Moves ({analysis.folder_proposals.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('issues')}
                    className={`px-6 py-3 font-medium transition-colors ${
                      activeTab === 'issues'
                        ? 'bg-purple-50 text-purple-700 border-b-2 border-purple-600'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <AlertTriangle className="w-4 h-4 inline mr-2" />
                    Issues ({analysis.issues.length})
                  </button>
                </div>

                {/* Select All / None */}
                {activeTab === 'files' && analysis.file_proposals.length > 0 && (
                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-4">
                    <span className="text-sm text-gray-600">
                      {selectedFiles.size} of {analysis.file_proposals.length} selected
                    </span>
                    <button
                      onClick={() => toggleAllFiles(true)}
                      className="text-sm text-purple-600 hover:text-purple-800"
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => toggleAllFiles(false)}
                      className="text-sm text-gray-600 hover:text-gray-800"
                    >
                      Select None
                    </button>
                  </div>
                )}

                {activeTab === 'folders' && analysis.folder_proposals.length > 0 && (
                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-4">
                    <span className="text-sm text-gray-600">
                      {selectedFolders.size} of {analysis.folder_proposals.length} selected
                    </span>
                    <button
                      onClick={() => toggleAllFolders(true)}
                      className="text-sm text-purple-600 hover:text-purple-800"
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => toggleAllFolders(false)}
                      className="text-sm text-gray-600 hover:text-gray-800"
                    >
                      Select None
                    </button>
                  </div>
                )}

                <div className="max-h-[500px] overflow-y-auto">
                  {/* Files Tab */}
                  {activeTab === 'files' && (
                    <div className="divide-y divide-gray-100">
                      {analysis.detected_books.map((book) => {
                        const bookProposals = analysis.file_proposals.filter(p =>
                          book.chapters.some(c => c.file_path === p.source_path)
                        );
                        if (bookProposals.length === 0) return null;

                        return (
                          <div key={book.id} className="border-b border-gray-100 last:border-b-0">
                            {/* Book Header */}
                            <button
                              onClick={() => toggleBook(book.id)}
                              className="w-full px-6 py-4 flex items-center gap-3 hover:bg-gray-50 transition-colors"
                            >
                              {expandedBooks.has(book.id) ? (
                                <ChevronDown className="w-5 h-5 text-gray-400" />
                              ) : (
                                <ChevronRight className="w-5 h-5 text-gray-400" />
                              )}
                              <div className="flex-1 text-left">
                                <div className="font-medium text-gray-900">{book.title}</div>
                                <div className="text-sm text-gray-500">
                                  {book.author}
                                  {book.series && ` - ${book.series}`}
                                  {book.sequence && ` #${book.sequence}`}
                                </div>
                              </div>
                              <span className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${
                                book.audiobook_type === 'ChapterSplit' ? 'bg-blue-100 text-blue-700' :
                                book.audiobook_type === 'MultiPart' ? 'bg-orange-100 text-orange-700' :
                                'bg-gray-100 text-gray-600'
                              }`}>
                                {getAudiobookTypeIcon(book.audiobook_type)}
                                {getAudiobookTypeLabel(book.audiobook_type)}
                              </span>
                              <span className={`px-2 py-1 rounded text-sm font-medium ${getConfidenceBg(book.confidence)} ${getConfidenceColor(book.confidence)}`}>
                                {book.confidence}%
                              </span>
                            </button>

                            {/* Expanded Chapter List */}
                            {expandedBooks.has(book.id) && (
                              <div className="px-6 pb-4 space-y-2 bg-gray-50">
                                {bookProposals.map((proposal) => (
                                  <label
                                    key={proposal.id}
                                    className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                                      selectedFiles.has(proposal.id)
                                        ? 'bg-purple-50 border border-purple-200'
                                        : 'bg-white border border-gray-200 hover:bg-gray-50'
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedFiles.has(proposal.id)}
                                      onChange={() => {
                                        const newSelected = new Set(selectedFiles);
                                        if (newSelected.has(proposal.id)) {
                                          newSelected.delete(proposal.id);
                                        } else {
                                          newSelected.add(proposal.id);
                                        }
                                        setSelectedFiles(newSelected);
                                      }}
                                      className="mt-1 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="font-mono text-sm text-gray-600 truncate">
                                        {proposal.source_path.split('/').pop()}
                                      </div>
                                      <div className="flex items-center gap-2 mt-1">
                                        <ChevronRight className="w-4 h-4 text-purple-400 flex-shrink-0" />
                                        <div className="font-mono text-sm text-purple-700 truncate">
                                          {proposal.proposed_path.split('/').pop()}
                                        </div>
                                      </div>
                                    </div>
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {analysis.file_proposals.length === 0 && (
                        <div className="p-8 text-center text-gray-500">
                          No file renames needed
                        </div>
                      )}
                    </div>
                  )}

                  {/* Folders Tab */}
                  {activeTab === 'folders' && (
                    <div className="divide-y divide-gray-100">
                      {analysis.folder_proposals.map((proposal) => (
                        <label
                          key={proposal.id}
                          className={`flex items-start gap-4 p-4 cursor-pointer transition-colors ${
                            selectedFolders.has(proposal.id)
                              ? 'bg-purple-50'
                              : 'hover:bg-gray-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedFolders.has(proposal.id)}
                            onChange={() => {
                              const newSelected = new Set(selectedFolders);
                              if (newSelected.has(proposal.id)) {
                                newSelected.delete(proposal.id);
                              } else {
                                newSelected.add(proposal.id);
                              }
                              setSelectedFolders(newSelected);
                            }}
                            className="mt-1 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm text-gray-600 truncate">
                              {proposal.source_path.replace(folderPath, '.')}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <ChevronRight className="w-4 h-4 text-pink-400 flex-shrink-0" />
                              <div className="font-mono text-sm text-pink-700 truncate">
                                {proposal.proposed_path.replace(folderPath, '.')}
                              </div>
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {proposal.file_count} files - {proposal.reason}
                            </div>
                          </div>
                          <span className={`px-2 py-1 rounded text-sm font-medium ${getConfidenceBg(proposal.confidence)} ${getConfidenceColor(proposal.confidence)}`}>
                            {proposal.confidence}%
                          </span>
                        </label>
                      ))}
                      {analysis.folder_proposals.length === 0 && (
                        <div className="p-8 text-center text-gray-500">
                          No folder moves needed
                        </div>
                      )}
                    </div>
                  )}

                  {/* Issues Tab */}
                  {activeTab === 'issues' && (
                    <div className="divide-y divide-gray-100">
                      {analysis.issues.map((issue, idx) => (
                        <div key={idx} className="p-4 flex items-start gap-3">
                          {getIssueIcon(issue.issue_type)}
                          <div className="flex-1">
                            <div className="font-mono text-xs text-gray-500 truncate">
                              {issue.path.replace(folderPath, '.')}
                            </div>
                            <div className="text-sm text-gray-700">{issue.description}</div>
                          </div>
                          <span className={`px-2 py-1 rounded text-xs ${
                            issue.severity >= 3 ? 'bg-red-100 text-red-700' :
                            issue.severity >= 2 ? 'bg-yellow-100 text-yellow-700' :
                            'bg-blue-100 text-blue-700'
                          }`}>
                            {issue.severity >= 3 ? 'High' : issue.severity >= 2 ? 'Medium' : 'Low'}
                          </span>
                        </div>
                      ))}
                      {analysis.issues.length === 0 && (
                        <div className="p-8 text-center text-gray-500">
                          No issues found
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Action Bar */}
              <div className="flex justify-between items-center bg-white rounded-xl border border-gray-200 p-4">
                <div className="text-sm text-gray-600">
                  {selectedFiles.size} files, {selectedFolders.size} folders selected
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleAnalyze}
                    disabled={analyzing}
                    className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2"
                  >
                    <RefreshCw className={`w-4 h-4 ${analyzing ? 'animate-spin' : ''}`} />
                    Re-analyze
                  </button>
                  <button
                    onClick={handleApply}
                    disabled={applying || (selectedFiles.size === 0 && selectedFolders.size === 0)}
                    className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all"
                  >
                    {applying && <Loader2 className="w-4 h-4 animate-spin" />}
                    Apply Changes
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Info Box - shown when no analysis */}
          {!analysis && !result && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
              <div className="flex gap-3">
                <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-medium text-blue-900">What AI Smart Rename does</h4>
                  <ul className="mt-2 space-y-1 text-sm text-blue-800">
                    <li>Detects book title, author, and series from messy filenames</li>
                    <li>Identifies chapter names for split audiobooks (Track01.mp3 becomes proper chapter names)</li>
                    <li>Reorganizes folders into Author/Series/Title structure</li>
                    <li>Cleans up ASIN codes, quality markers, and upload tags</li>
                    <li>Uses GPT to infer missing information from context</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
