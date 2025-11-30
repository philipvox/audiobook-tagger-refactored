import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  X, Scissors, Play, Pause, Clock, BookOpen, AlertTriangle,
  RefreshCw, FolderOpen, Settings, Check, Edit2, Save
} from 'lucide-react';

export function ChaptersModal({ isOpen, onClose, group }) {
  const [loading, setLoading] = useState(true);
  const [ffmpegInfo, setFfmpegInfo] = useState(null);
  const [chapterInfo, setChapterInfo] = useState(null);
  const [error, setError] = useState(null);

  // Splitting state
  const [splitting, setSplitting] = useState(false);
  const [splitProgress, setSplitProgress] = useState(null);
  const [outputDir, setOutputDir] = useState('');
  const [outputFormat, setOutputFormat] = useState('same');
  const [namingPattern, setNamingPattern] = useState('{num} - {title}');

  // Editing state
  const [editingChapter, setEditingChapter] = useState(null);
  const [editedTitle, setEditedTitle] = useState('');
  const [selectedChapters, setSelectedChapters] = useState(new Set());

  // Silence detection settings
  const [showSettings, setShowSettings] = useState(false);
  const [silenceSettings, setSilenceSettings] = useState({
    noiseThreshold: -30,
    minSilenceDuration: 0.5,
    minChapterDuration: 60,
  });

  useEffect(() => {
    if (isOpen && group) {
      checkFfmpegAndLoadChapters();
    }
  }, [isOpen, group]);

  const checkFfmpegAndLoadChapters = async () => {
    setLoading(true);
    setError(null);

    try {
      // Check FFmpeg availability
      const info = await invoke('check_ffmpeg');
      setFfmpegInfo(info);

      if (!info.installed) {
        setError('FFmpeg is not installed. Please install FFmpeg to use chapter features.');
        setLoading(false);
        return;
      }

      // Get the first file in the group for chapter detection
      const filePath = group.files?.[0]?.path;
      if (!filePath) {
        setError('No audio files found in this group.');
        setLoading(false);
        return;
      }

      // Try to get chapters
      const result = await invoke('get_or_detect_chapters', {
        filePath,
        useSilenceDetection: false, // Don't auto-detect, let user choose
      });

      setChapterInfo(result.chapter_info);

      // Set default output directory
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/') || filePath.lastIndexOf('\\'));
      setOutputDir(parentDir + '/chapters');

      // Select all chapters by default
      if (result.chapter_info?.chapters) {
        setSelectedChapters(new Set(result.chapter_info.chapters.map(c => c.id)));
      }
    } catch (err) {
      console.error('Failed to load chapters:', err);
      setError(err.toString());
    } finally {
      setLoading(false);
    }
  };

  const detectWithSilence = async () => {
    setLoading(true);
    setError(null);

    try {
      const filePath = group.files?.[0]?.path;
      const result = await invoke('detect_chapters_silence', {
        filePath,
        noiseThresholdDb: silenceSettings.noiseThreshold,
        minSilenceDuration: silenceSettings.minSilenceDuration,
        minChapterDuration: silenceSettings.minChapterDuration,
      });

      setChapterInfo(result);
      setSelectedChapters(new Set(result.chapters.map(c => c.id)));
    } catch (err) {
      console.error('Silence detection failed:', err);
      setError('Silence detection failed: ' + err.toString());
    } finally {
      setLoading(false);
    }
  };

  const handleSelectOutputDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (selected) {
        setOutputDir(selected);
      }
    } catch (err) {
      console.error('Failed to select directory:', err);
    }
  };

  const handleSplitChapters = async () => {
    if (!chapterInfo || selectedChapters.size === 0) {
      return;
    }

    setSplitting(true);
    setSplitProgress({ status: 'Starting split...', percent: 0 });

    try {
      const chaptersToSplit = chapterInfo.chapters.filter(c =>
        selectedChapters.has(c.id)
      );

      const result = await invoke('split_audiobook_chapters', {
        request: {
          file_path: chapterInfo.file_path,
          chapters: chaptersToSplit,
          output_dir: outputDir,
          output_format: outputFormat,
          naming_pattern: namingPattern,
          copy_metadata: true,
          embed_cover: true,
          create_playlist: true,
        }
      });

      if (result.success) {
        setSplitProgress({
          status: 'Complete!',
          percent: 100,
          message: result.message,
          files: result.output_files,
        });
      } else {
        throw new Error(result.message);
      }
    } catch (err) {
      console.error('Split failed:', err);
      setError('Split failed: ' + err.toString());
      setSplitProgress(null);
    } finally {
      setSplitting(false);
    }
  };

  const handleEditChapter = (chapter) => {
    setEditingChapter(chapter.id);
    setEditedTitle(chapter.title);
  };

  const handleSaveChapterTitle = async () => {
    if (!chapterInfo || editingChapter === null) return;

    const updatedChapters = chapterInfo.chapters.map(c =>
      c.id === editingChapter ? { ...c, title: editedTitle } : c
    );

    setChapterInfo({
      ...chapterInfo,
      chapters: updatedChapters,
    });

    setEditingChapter(null);
    setEditedTitle('');
  };

  const toggleChapterSelection = (id) => {
    const newSelected = new Set(selectedChapters);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedChapters(newSelected);
  };

  const selectAllChapters = () => {
    if (chapterInfo?.chapters) {
      setSelectedChapters(new Set(chapterInfo.chapters.map(c => c.id)));
    }
  };

  const deselectAllChapters = () => {
    setSelectedChapters(new Set());
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-purple-50 to-indigo-50">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                <BookOpen className="w-6 h-6 text-purple-600" />
                Chapters
              </h2>
              <p className="text-sm text-gray-600 mt-1">{group?.metadata?.title}</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-purple-100 rounded-lg transition-colors">
              <X className="w-6 h-6 text-gray-600" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* FFmpeg Warning */}
          {ffmpegInfo && !ffmpegInfo.installed && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-yellow-600 mt-0.5" />
                <div>
                  <h3 className="font-medium text-yellow-800">FFmpeg Required</h3>
                  <p className="text-sm text-yellow-700 mt-1">
                    FFmpeg is not installed on your system. Please install FFmpeg to use chapter detection and splitting features.
                  </p>
                  <a
                    href="https://ffmpeg.org/download.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-yellow-800 underline mt-2 inline-block"
                  >
                    Download FFmpeg
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p className="text-red-700">{error}</p>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading chapters...</p>
            </div>
          )}

          {/* Chapter List */}
          {!loading && chapterInfo && (
            <div className="space-y-6">
              {/* Chapter Info Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="text-sm text-gray-600">
                    {chapterInfo.chapters.length} chapters found
                    {chapterInfo.has_embedded_chapters ? ' (embedded)' : ' (detected)'}
                  </span>
                  <span className="text-sm text-gray-500">
                    <Clock className="w-4 h-4 inline mr-1" />
                    {chapterInfo.total_duration_display}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {!chapterInfo.has_embedded_chapters && (
                    <button
                      onClick={() => setShowSettings(!showSettings)}
                      className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg flex items-center gap-1"
                    >
                      <Settings className="w-4 h-4" />
                      Settings
                    </button>
                  )}
                  <button
                    onClick={detectWithSilence}
                    disabled={loading}
                    className="px-3 py-1.5 text-sm bg-purple-100 hover:bg-purple-200 text-purple-700 rounded-lg flex items-center gap-1"
                  >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    Detect via Silence
                  </button>
                </div>
              </div>

              {/* Silence Detection Settings */}
              {showSettings && (
                <div className="bg-gray-50 rounded-lg p-4 space-y-4">
                  <h4 className="font-medium text-gray-800">Silence Detection Settings</h4>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Noise Threshold (dB)</label>
                      <input
                        type="number"
                        value={silenceSettings.noiseThreshold}
                        onChange={(e) => setSilenceSettings(s => ({ ...s, noiseThreshold: parseInt(e.target.value) }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Min Silence (sec)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={silenceSettings.minSilenceDuration}
                        onChange={(e) => setSilenceSettings(s => ({ ...s, minSilenceDuration: parseFloat(e.target.value) }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Min Chapter (sec)</label>
                      <input
                        type="number"
                        value={silenceSettings.minChapterDuration}
                        onChange={(e) => setSilenceSettings(s => ({ ...s, minChapterDuration: parseFloat(e.target.value) }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Selection Controls */}
              <div className="flex items-center gap-2">
                <button
                  onClick={selectAllChapters}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Select All
                </button>
                <span className="text-gray-300">|</span>
                <button
                  onClick={deselectAllChapters}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Deselect All
                </button>
                <span className="text-sm text-gray-500 ml-4">
                  {selectedChapters.size} selected
                </span>
              </div>

              {/* Chapter Table */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50 text-sm">
                    <tr>
                      <th className="w-12 px-4 py-3 text-left"></th>
                      <th className="w-12 px-4 py-3 text-left">#</th>
                      <th className="px-4 py-3 text-left">Title</th>
                      <th className="w-32 px-4 py-3 text-left">Start</th>
                      <th className="w-32 px-4 py-3 text-left">End</th>
                      <th className="w-24 px-4 py-3 text-left">Duration</th>
                      <th className="w-16 px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {chapterInfo.chapters.map((chapter, idx) => (
                      <tr
                        key={chapter.id}
                        className={`hover:bg-gray-50 ${selectedChapters.has(chapter.id) ? 'bg-purple-50' : ''}`}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedChapters.has(chapter.id)}
                            onChange={() => toggleChapterSelection(chapter.id)}
                            className="w-4 h-4 text-purple-600 rounded border-gray-300"
                          />
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">{idx + 1}</td>
                        <td className="px-4 py-3">
                          {editingChapter === chapter.id ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={editedTitle}
                                onChange={(e) => setEditedTitle(e.target.value)}
                                className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveChapterTitle();
                                  if (e.key === 'Escape') setEditingChapter(null);
                                }}
                              />
                              <button
                                onClick={handleSaveChapterTitle}
                                className="p-1 text-green-600 hover:text-green-800"
                              >
                                <Save className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <span className="text-sm font-medium text-gray-900">{chapter.title}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-mono">{chapter.start_display}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-mono">{chapter.end_display}</td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {formatDuration(chapter.duration)}
                        </td>
                        <td className="px-4 py-3">
                          {editingChapter !== chapter.id && (
                            <button
                              onClick={() => handleEditChapter(chapter)}
                              className="p-1 text-gray-400 hover:text-gray-600"
                              title="Edit title"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Split Options */}
              <div className="border-t border-gray-200 pt-6 space-y-4">
                <h3 className="font-medium text-gray-900">Split Options</h3>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Output Directory</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={outputDir}
                        onChange={(e) => setOutputDir(e.target.value)}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      />
                      <button
                        onClick={handleSelectOutputDir}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg"
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Output Format</label>
                    <select
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    >
                      <option value="same">Same as Source (Lossless)</option>
                      <option value="m4a">M4A (AAC)</option>
                      <option value="mp3">MP3</option>
                      <option value="opus">Opus (Smallest)</option>
                    </select>
                  </div>

                  <div className="col-span-2">
                    <label className="block text-sm text-gray-600 mb-1">Naming Pattern</label>
                    <input
                      type="text"
                      value={namingPattern}
                      onChange={(e) => setNamingPattern(e.target.value)}
                      placeholder="{num} - {title}"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Available: {'{num}'} (track number), {'{title}'} (chapter title)
                    </p>
                  </div>
                </div>
              </div>

              {/* Split Progress */}
              {splitProgress && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    {splitting ? (
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-purple-600"></div>
                    ) : (
                      <Check className="w-5 h-5 text-green-600" />
                    )}
                    <div className="flex-1">
                      <p className="font-medium text-purple-800">{splitProgress.status}</p>
                      {splitProgress.message && (
                        <p className="text-sm text-purple-600 mt-1">{splitProgress.message}</p>
                      )}
                    </div>
                  </div>
                  {splitProgress.percent > 0 && splitProgress.percent < 100 && (
                    <div className="mt-3 bg-purple-200 rounded-full h-2">
                      <div
                        className="bg-purple-600 h-2 rounded-full transition-all"
                        style={{ width: `${splitProgress.percent}%` }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Empty State */}
          {!loading && (!chapterInfo || chapterInfo.chapters.length === 0) && !error && (
            <div className="text-center py-12">
              <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-600 mb-4">No chapters found in this file</p>
              <button
                onClick={detectWithSilence}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium"
              >
                Detect Chapters via Silence
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium"
          >
            Close
          </button>

          {chapterInfo && chapterInfo.chapters.length > 0 && (
            <button
              onClick={handleSplitChapters}
              disabled={splitting || selectedChapters.size === 0}
              className={`px-6 py-2 rounded-lg font-medium flex items-center gap-2 ${
                splitting || selectedChapters.size === 0
                  ? 'bg-gray-300 cursor-not-allowed text-gray-500'
                  : 'bg-purple-600 hover:bg-purple-700 text-white'
              }`}
            >
              <Scissors className="w-4 h-4" />
              {splitting ? 'Splitting...' : `Split ${selectedChapters.size} Chapters`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Helper function to format duration
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
