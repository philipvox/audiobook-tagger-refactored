import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  FolderTree,
  AlertTriangle,
  CheckCircle,
  Play,
  Loader2,
  FolderInput,
  ArrowRight,
  RefreshCw,
  FolderOpen,
  Info,
  Wand2
} from 'lucide-react';

export function FolderFixerPage() {
  const [folderPath, setFolderPath] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [restructuring, setRestructuring] = useState(false);
  const [applying, setApplying] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [selectedChanges, setSelectedChanges] = useState(new Set());
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handlePickFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select folder to organize',
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
    setAnalysis(null);

    try {
      const result = await invoke('analyze_folders', { path: folderPath });
      setAnalysis(result);
      // Select all changes by default
      setSelectedChanges(new Set(result.proposed_changes.map(c => c.id)));
    } catch (e) {
      setError(e.toString());
    } finally {
      setAnalyzing(false);
    }
  };

  const handleQuickFix = async () => {
    if (!folderPath) {
      setError('Please select a folder first');
      return;
    }

    setApplying(true);
    setError(null);

    try {
      // Quick fix: just merge chapter folders
      const chapterFolders = await invoke('detect_chapter_folders', { path: folderPath });

      if (chapterFolders.length === 0) {
        setResult({ success: true, message: 'No chapter folders found to merge' });
        return;
      }

      const mergeResult = await invoke('merge_chapter_folders', { paths: chapterFolders });
      setResult({
        success: mergeResult.errors.length === 0,
        message: `Merged ${mergeResult.merged_count} folders, moved ${mergeResult.files_moved} files`,
        errors: mergeResult.errors
      });
    } catch (e) {
      setError(e.toString());
    } finally {
      setApplying(false);
    }
  };

  const handleRestructure = async () => {
    if (!folderPath) {
      setError('Please select a folder first');
      return;
    }

    setRestructuring(true);
    setError(null);
    setResult(null);
    setAnalysis(null);

    try {
      const result = await invoke('restructure_library', { path: folderPath });
      setAnalysis(result);
      // Select all changes by default
      setSelectedChanges(new Set(result.proposed_changes.map(c => c.id)));
    } catch (e) {
      setError(e.toString());
    } finally {
      setRestructuring(false);
    }
  };

  const handleApplySelected = async () => {
    if (!analysis || selectedChanges.size === 0) return;

    setApplying(true);
    setError(null);

    try {
      const changesToApply = analysis.proposed_changes.filter(c => selectedChanges.has(c.id));
      const result = await invoke('apply_fixes', {
        changes: changesToApply,
        rootPath: folderPath,
        createBackup: true
      });

      setResult({
        success: result.success,
        message: `Completed ${result.moves_completed} moves, ${result.moves_failed} failed`,
        errors: result.errors,
        backupPath: result.backup_path
      });

      // Clear analysis after applying
      if (result.success) {
        setAnalysis(null);
      }
    } catch (e) {
      setError(e.toString());
    } finally {
      setApplying(false);
    }
  };

  const toggleChange = (id) => {
    const newSelected = new Set(selectedChanges);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedChanges(newSelected);
  };

  const selectAll = () => {
    if (analysis) {
      setSelectedChanges(new Set(analysis.proposed_changes.map(c => c.id)));
    }
  };

  const selectNone = () => {
    setSelectedChanges(new Set());
  };

  const getIssueIcon = (type) => {
    switch (type) {
      case 'ChapterSubfolder':
        return <FolderTree className="w-4 h-4 text-yellow-600" />;
      case 'WrongNaming':
        return <AlertTriangle className="w-4 h-4 text-orange-600" />;
      case 'FlatStructure':
        return <FolderInput className="w-4 h-4 text-blue-600" />;
      default:
        return <AlertTriangle className="w-4 h-4 text-gray-600" />;
    }
  };

  const reset = () => {
    setAnalysis(null);
    setResult(null);
    setError(null);
    setSelectedChanges(new Set());
  };

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-purple-100 rounded-xl">
                <FolderTree className="w-8 h-8 text-purple-600" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Folder Fixer</h2>
                <p className="text-gray-600">
                  AI-powered folder organization for AudiobookShelf
                </p>
              </div>
            </div>
          </div>

          {/* Folder Selection */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-purple-50 to-violet-50 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <FolderOpen className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Select Folder</h3>
                  <p className="text-sm text-gray-600">Choose a folder containing audiobooks to organize</p>
                </div>
              </div>
            </div>

            <div className="p-6">
              <div className="flex gap-4">
                <div className="flex-1">
                  <input
                    type="text"
                    value={folderPath}
                    onChange={(e) => setFolderPath(e.target.value)}
                    placeholder="Select or enter folder path..."
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 font-mono text-sm"
                  />
                </div>
                <button
                  onClick={handlePickFolder}
                  className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium flex items-center gap-2"
                >
                  <FolderOpen className="w-5 h-5" />
                  Browse
                </button>
              </div>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
              <div className="flex items-center gap-2 text-red-700">
                <AlertTriangle className="w-5 h-5" />
                <span className="font-medium">Error</span>
              </div>
              <p className="text-sm text-red-600 mt-1">{error}</p>
            </div>
          )}

          {/* Result Display */}
          {result && (
            <div className={`p-4 rounded-xl border ${
              result.success
                ? 'bg-green-50 border-green-200'
                : 'bg-yellow-50 border-yellow-200'
            }`}>
              <div className="flex items-center gap-2">
                {result.success ? (
                  <CheckCircle className="w-5 h-5 text-green-600" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-yellow-600" />
                )}
                <span className={`font-medium ${result.success ? 'text-green-700' : 'text-yellow-700'}`}>
                  {result.message}
                </span>
              </div>
              {result.backupPath && (
                <p className="text-sm text-gray-600 mt-2">
                  Backup created at: <span className="font-mono">{result.backupPath}</span>
                </p>
              )}
              {result.errors?.length > 0 && (
                <ul className="text-sm text-red-600 mt-2 list-disc list-inside">
                  {result.errors.slice(0, 5).map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                  {result.errors.length > 5 && (
                    <li>...and {result.errors.length - 5} more</li>
                  )}
                </ul>
              )}
            </div>
          )}

          {/* Action Buttons */}
          {!analysis && (
            <div className="grid grid-cols-3 gap-4">
              <button
                onClick={handleRestructure}
                disabled={restructuring || analyzing || !folderPath}
                className="p-5 bg-white border-2 border-dashed border-gray-300 rounded-xl hover:border-blue-400 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex flex-col items-center gap-2">
                  {restructuring ? (
                    <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
                  ) : (
                    <Wand2 className="w-10 h-10 text-blue-600" />
                  )}
                  <span className="text-base font-medium text-gray-900">Restructure Library</span>
                  <span className="text-xs text-gray-500 text-center">
                    AI-powered reorganization to Author/Series/Title format (FAST)
                  </span>
                </div>
              </button>

              <button
                onClick={handleAnalyze}
                disabled={analyzing || restructuring || !folderPath}
                className="p-5 bg-white border-2 border-dashed border-gray-300 rounded-xl hover:border-purple-400 hover:bg-purple-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex flex-col items-center gap-2">
                  {analyzing ? (
                    <Loader2 className="w-10 h-10 text-purple-600 animate-spin" />
                  ) : (
                    <RefreshCw className="w-10 h-10 text-purple-600" />
                  )}
                  <span className="text-base font-medium text-gray-900">Full Analysis</span>
                  <span className="text-xs text-gray-500 text-center">
                    Detect issues and suggest organization fixes
                  </span>
                </div>
              </button>

              <button
                onClick={handleQuickFix}
                disabled={applying || restructuring || analyzing || !folderPath}
                className="p-5 bg-white border-2 border-dashed border-gray-300 rounded-xl hover:border-green-400 hover:bg-green-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex flex-col items-center gap-2">
                  {applying ? (
                    <Loader2 className="w-10 h-10 text-green-600 animate-spin" />
                  ) : (
                    <Play className="w-10 h-10 text-green-600" />
                  )}
                  <span className="text-base font-medium text-gray-900">Quick Fix</span>
                  <span className="text-xs text-gray-500 text-center">
                    Merge chapter subfolders into parent folders
                  </span>
                </div>
              </button>
            </div>
          )}

          {/* Info Box */}
          {!analysis && !result && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
              <div className="flex gap-3">
                <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-medium text-blue-900">What this tool does</h4>
                  <ul className="mt-2 space-y-1 text-sm text-blue-800">
                    <li className="flex items-center gap-2">
                      <span className="w-2 h-2 bg-yellow-500 rounded-full"></span>
                      Merge chapter subfolders (Part 1, Disc 1, CD1) into single book folders
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-2 h-2 bg-orange-500 rounded-full"></span>
                      Fix incorrect naming formats for AudiobookShelf
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                      Organize flat structures into Author/Title format
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-2 h-2 bg-red-500 rounded-full"></span>
                      Separate mixed books in the same folder
                    </li>
                  </ul>
                  <p className="mt-3 text-sm text-blue-700">
                    Target structure: <span className="font-mono">Author / Series / Book Title /</span>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Analysis Results */}
          {analysis && (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white p-4 rounded-xl border border-gray-200 text-center">
                  <div className="text-3xl font-bold text-gray-900">{analysis.total_folders}</div>
                  <div className="text-sm text-gray-500">Folders Scanned</div>
                </div>
                <div className="bg-white p-4 rounded-xl border border-gray-200 text-center">
                  <div className="text-3xl font-bold text-gray-900">{analysis.total_audio_files}</div>
                  <div className="text-sm text-gray-500">Audio Files</div>
                </div>
                <div className="bg-yellow-50 p-4 rounded-xl border border-yellow-200 text-center">
                  <div className="text-3xl font-bold text-yellow-700">{analysis.issues.length}</div>
                  <div className="text-sm text-yellow-600">Issues Found</div>
                </div>
              </div>

              {/* Issues List */}
              {analysis.issues.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                    <h3 className="font-semibold text-gray-900">Issues Found</h3>
                  </div>
                  <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                    {analysis.issues.map((issue, i) => (
                      <div key={i} className="flex items-start gap-3 p-4 hover:bg-gray-50">
                        {getIssueIcon(issue.issue_type)}
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-xs text-gray-500 truncate">{issue.path}</div>
                          <div className="text-sm text-gray-700">{issue.description}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Proposed Changes */}
              {analysis.proposed_changes.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900">
                      Proposed Changes ({selectedChanges.size}/{analysis.proposed_changes.length})
                    </h3>
                    <div className="flex gap-3">
                      <button
                        onClick={selectAll}
                        className="text-sm text-purple-600 hover:text-purple-800 font-medium"
                      >
                        Select All
                      </button>
                      <button
                        onClick={selectNone}
                        className="text-sm text-gray-600 hover:text-gray-800 font-medium"
                      >
                        Select None
                      </button>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
                    {analysis.proposed_changes.map((change) => (
                      <label
                        key={change.id}
                        className={`flex items-start gap-4 p-4 cursor-pointer transition-colors ${
                          selectedChanges.has(change.id)
                            ? 'bg-purple-50'
                            : 'hover:bg-gray-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedChanges.has(change.id)}
                          onChange={() => toggleChange(change.id)}
                          className="mt-1 w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="font-mono text-gray-600 truncate max-w-[250px]">
                              {change.source.split('/').pop()}
                            </span>
                            <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            <span className="font-mono text-purple-700 truncate">
                              {change.destination}
                            </span>
                          </div>
                          <div className="text-sm text-gray-600 mt-1">{change.reason}</div>
                          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                            <span>{change.file_count} files</span>
                            <span className="flex items-center gap-1">
                              Confidence:
                              <span className={`font-medium ${
                                change.confidence >= 80 ? 'text-green-600' :
                                change.confidence >= 50 ? 'text-yellow-600' : 'text-red-600'
                              }`}>
                                {change.confidence}%
                              </span>
                            </span>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Action Bar */}
              <div className="flex justify-between items-center bg-white rounded-xl border border-gray-200 p-4">
                <button
                  onClick={reset}
                  className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium"
                >
                  Reset
                </button>

                <div className="flex gap-3">
                  <button
                    onClick={handleAnalyze}
                    disabled={analyzing}
                    className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors font-medium flex items-center gap-2"
                  >
                    <RefreshCw className={`w-4 h-4 ${analyzing ? 'animate-spin' : ''}`} />
                    Re-analyze
                  </button>

                  {analysis.proposed_changes.length > 0 && (
                    <button
                      onClick={handleApplySelected}
                      disabled={applying || selectedChanges.size === 0}
                      className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 font-medium"
                    >
                      {applying && <Loader2 className="w-4 h-4 animate-spin" />}
                      Apply {selectedChanges.size} Changes
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
