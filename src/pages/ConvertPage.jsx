import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  FolderOpen, FileAudio, Settings, Play, X, Check, AlertTriangle,
  Loader2, Disc3, Clock, HardDrive, Music, ChevronDown, ChevronUp,
  Trash2, BookOpen, User, Mic, List, Image, Zap, Gauge
} from 'lucide-react';
import { ChapterPreviewModal } from '../components/ChapterPreviewModal';

export function ConvertPage() {
  // FFmpeg status
  const [ffmpegInfo, setFfmpegInfo] = useState(null);
  const [ffmpegChecking, setFfmpegChecking] = useState(true);

  // Source analysis
  const [sourcePath, setSourcePath] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  // Settings
  const [qualityPreset, setQualityPreset] = useState('standard');
  const [speedPreset, setSpeedPreset] = useState('balanced');
  const [chapterMode, setChapterMode] = useState('per_file');
  const [deleteSource, setDeleteSource] = useState(false);
  const [verifyOutput, setVerifyOutput] = useState(true);

  // Metadata
  const [metadata, setMetadata] = useState({
    title: '',
    author: '',
    narrator: '',
    series: '',
    series_part: '',
    genres: [],
    description: '',
    publisher: '',
    year: '',
    cover_path: '',
  });

  // Output settings
  const [outputPath, setOutputPath] = useState('');
  const [useCustomOutput, setUseCustomOutput] = useState(false);

  // Conversion state
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  // Modals
  const [showChapterPreview, setShowChapterPreview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Size estimation
  const [estimatedSize, setEstimatedSize] = useState(null);

  // Check FFmpeg on mount
  useEffect(() => {
    checkFfmpeg();
  }, []);

  // Listen for conversion progress
  useEffect(() => {
    const unlisten = listen('conversion_progress', (event) => {
      setProgress(event.payload);
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  // Update size estimate when preset or analysis changes
  useEffect(() => {
    if (analysis) {
      estimateSize();
    }
  }, [analysis, qualityPreset]);

  const checkFfmpeg = async () => {
    setFfmpegChecking(true);
    try {
      const info = await invoke('check_ffmpeg_available');
      setFfmpegInfo(info);
    } catch (error) {
      setFfmpegInfo({ available: false, error: error.toString() });
    } finally {
      setFfmpegChecking(false);
    }
  };

  const selectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Audiobook Folder',
      });

      if (selected) {
        setSourcePath(selected);
        analyzeSource(selected);
      }
    } catch (error) {
      console.error('Failed to select folder:', error);
    }
  };

  const analyzeSource = async (path) => {
    setAnalyzing(true);
    setAnalysis(null);
    setResult(null);

    try {
      const result = await invoke('analyze_for_conversion', { path });
      setAnalysis(result);

      // Pre-fill metadata from detected values
      if (result.detected_metadata) {
        setMetadata(prev => ({
          ...prev,
          title: result.detected_metadata.title || prev.title,
          author: result.detected_metadata.author || prev.author,
          narrator: result.detected_metadata.narrator || prev.narrator,
          series: result.detected_metadata.series || prev.series,
          series_part: result.detected_metadata.series_part || prev.series_part,
          cover_path: result.cover_source || prev.cover_path,
        }));
      }
    } catch (error) {
      console.error('Analysis failed:', error);
      alert(`Analysis failed: ${error}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const estimateSize = async () => {
    if (!analysis) return;

    try {
      const preset = getPresetObject();
      const estimate = await invoke('estimate_output_size', {
        analysis,
        preset,
      });
      setEstimatedSize(estimate);
    } catch (error) {
      console.error('Size estimation failed:', error);
    }
  };

  const getPresetObject = () => {
    switch (qualityPreset) {
      case 'economy':
        return { type: 'Economy' };
      case 'standard':
        return { type: 'Standard' };
      case 'high':
        return { type: 'High' };
      default:
        return { type: 'Standard' };
    }
  };

  const getChapterModeObject = () => {
    switch (chapterMode) {
      case 'per_file':
        return { type: 'PerFile' };
      case 'silence':
        return {
          type: 'SilenceDetection',
          min_silence_seconds: 2.0,
          noise_threshold_db: -50,
        };
      case 'none':
        return { type: 'None' };
      default:
        return { type: 'PerFile' };
    }
  };

  const getSpeedPresetString = () => {
    switch (speedPreset) {
      case 'max_quality':
        return 'MaxQuality';
      case 'balanced':
        return 'Balanced';
      case 'fast':
        return 'Fast';
      case 'max_speed':
        return 'MaxSpeed';
      case 'turbo':
        return 'Turbo';
      default:
        return 'Balanced';
    }
  };

  const startConversion = async () => {
    if (!analysis || !metadata.title) {
      alert('Please provide at least a title for the audiobook');
      return;
    }

    setConverting(true);
    setProgress(null);
    setResult(null);

    try {
      const request = {
        source_path: sourcePath,
        output_path: useCustomOutput && outputPath ? outputPath : null,
        quality_preset: getPresetObject(),
        speed_preset: getSpeedPresetString(),
        chapter_mode: getChapterModeObject(),
        metadata: {
          ...metadata,
          genres: metadata.genres || [],
        },
        delete_source: deleteSource,
        verify_output: verifyOutput,
      };

      const conversionResult = await invoke('convert_to_m4b', { request });
      setResult(conversionResult);

      if (conversionResult.success) {
        console.log('Conversion successful:', conversionResult);
      }
    } catch (error) {
      console.error('Conversion failed:', error);
      setResult({
        success: false,
        errors: [error.toString()],
      });
    } finally {
      setConverting(false);
    }
  };

  const cancelConversion = async () => {
    try {
      await invoke('cancel_conversion');
    } catch (error) {
      console.error('Cancel failed:', error);
    }
  };

  const formatDuration = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  };

  const formatBytes = (bytes) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} bytes`;
  };

  // FFmpeg not available
  if (ffmpegChecking) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Checking FFmpeg availability...</p>
        </div>
      </div>
    );
  }

  if (!ffmpegInfo?.available) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50 p-8">
        <div className="max-w-md bg-white rounded-xl shadow-lg p-8 text-center">
          <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">FFmpeg Required</h2>
          <p className="text-gray-600 mb-6">
            FFmpeg is required for audio conversion but was not found on your system.
          </p>
          <div className="bg-gray-50 rounded-lg p-4 text-left text-sm">
            <p className="font-medium text-gray-800 mb-2">Install FFmpeg:</p>
            <p className="text-gray-600 mb-2">
              <strong>macOS:</strong> <code className="bg-gray-200 px-1 rounded">brew install ffmpeg</code>
            </p>
            <p className="text-gray-600 mb-2">
              <strong>Windows:</strong> Download from ffmpeg.org
            </p>
            <p className="text-gray-600">
              <strong>Linux:</strong> <code className="bg-gray-200 px-1 rounded">apt install ffmpeg</code>
            </p>
          </div>
          <button
            onClick={checkFfmpeg}
            className="mt-6 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Check Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-purple-100 rounded-lg">
              <Disc3 className="w-6 h-6 text-purple-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">MP3 to M4B Conversion</h1>
          </div>
          <p className="text-gray-600">
            Convert your MP3 audiobook files into a single M4B file with chapters, metadata, and cover art.
          </p>
          {ffmpegInfo?.has_libfdk_aac && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
              <Check className="w-3 h-3" />
              High-quality libfdk_aac encoder available
            </div>
          )}
        </div>

        {/* Source Selection */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-gray-600" />
            Source Audiobook
          </h2>

          <button
            onClick={selectFolder}
            disabled={analyzing || converting}
            className="w-full p-4 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {analyzing ? (
              <div className="flex items-center justify-center gap-2 text-gray-600">
                <Loader2 className="w-5 h-5 animate-spin" />
                Analyzing files...
              </div>
            ) : sourcePath ? (
              <div className="text-left">
                <p className="font-medium text-gray-900 truncate">{sourcePath}</p>
                {analysis && (
                  <p className="text-sm text-gray-600 mt-1">
                    {analysis.files.length} files ({formatDuration(analysis.total_duration_ms)}) - {formatBytes(analysis.total_size_bytes)}
                  </p>
                )}
              </div>
            ) : (
              <div className="text-center text-gray-600">
                <FolderOpen className="w-8 h-8 mx-auto mb-2 text-gray-400" />
                Click to select audiobook folder
              </div>
            )}
          </button>

          {/* File List Preview */}
          {analysis && analysis.files.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowChapterPreview(true)}
                className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                <List className="w-4 h-4" />
                Preview {analysis.detected_chapters.length} chapters
              </button>
            </div>
          )}
        </div>

        {/* Quality Settings */}
        {analysis && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Settings className="w-5 h-5 text-gray-600" />
              Quality Settings
            </h2>

            <div className="grid grid-cols-3 gap-3">
              {[
                { id: 'economy', name: 'Economy', desc: '32k HE-AAC', size: '~14 MB/hr' },
                { id: 'standard', name: 'Standard', desc: '64k AAC', size: '~28 MB/hr' },
                { id: 'high', name: 'High', desc: '96k AAC', size: '~43 MB/hr' },
              ].map(preset => (
                <button
                  key={preset.id}
                  onClick={() => setQualityPreset(preset.id)}
                  className={`p-4 rounded-lg border-2 text-left transition-all ${
                    qualityPreset === preset.id
                      ? 'border-purple-500 bg-purple-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="font-medium text-gray-900">{preset.name}</div>
                  <div className="text-sm text-gray-600">{preset.desc}</div>
                  <div className="text-xs text-gray-500 mt-1">{preset.size}</div>
                </button>
              ))}
            </div>

            {/* Size Estimate */}
            {estimatedSize && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-gray-600">
                    <HardDrive className="w-4 h-4" />
                    <span>Estimated output:</span>
                  </div>
                  <div className="text-right">
                    <span className="font-semibold text-gray-900">{estimatedSize.output_formatted}</span>
                    <span className="text-sm text-green-600 ml-2">
                      ({estimatedSize.savings_percent.toFixed(0)}% smaller)
                    </span>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Original: {estimatedSize.input_formatted}
                </div>
              </div>
            )}

            {/* Speed Preset */}
            <div className="mt-6 pt-6 border-t border-gray-200">
              <h3 className="text-sm font-medium text-gray-900 mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4 text-yellow-500" />
                Conversion Speed
              </h3>
              <div className="grid grid-cols-5 gap-2">
                {[
                  { id: 'max_quality', name: 'Max Quality', icon: '🎯', desc: 'Slowest, best quality' },
                  { id: 'balanced', name: 'Balanced', icon: '⚖️', desc: 'Default' },
                  { id: 'fast', name: 'Fast', icon: '🚀', desc: 'Parallel processing' },
                  { id: 'max_speed', name: 'Max Speed', icon: '⚡', desc: 'All CPU cores' },
                  { id: 'turbo', name: 'Turbo', icon: '💨', desc: 'No re-encoding' },
                ].map(preset => (
                  <button
                    key={preset.id}
                    onClick={() => setSpeedPreset(preset.id)}
                    className={`p-3 rounded-lg border-2 text-center transition-all ${
                      speedPreset === preset.id
                        ? 'border-yellow-500 bg-yellow-50'
                        : preset.id === 'turbo' && !analysis?.can_stream_copy
                          ? 'border-gray-200 opacity-50 cursor-not-allowed'
                          : 'border-gray-200 hover:border-gray-300'
                    }`}
                    disabled={preset.id === 'turbo' && !analysis?.can_stream_copy}
                    title={preset.id === 'turbo' && !analysis?.can_stream_copy ? 'Turbo requires AAC source files (M4A/M4B)' : ''}
                  >
                    <div className="text-lg mb-1">{preset.icon}</div>
                    <div className="text-xs font-medium text-gray-900">{preset.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{preset.desc}</div>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {speedPreset === 'max_quality' && 'Single-threaded with highest quality encoder settings. Best for archival.'}
                {speedPreset === 'balanced' && 'Good balance of speed and quality. Recommended for most users.'}
                {speedPreset === 'fast' && 'Parallel file decoding with up to 4 CPU cores. Slight quality tradeoff.'}
                {speedPreset === 'max_speed' && 'Uses all available CPU cores for maximum speed. Best for large audiobooks.'}
                {speedPreset === 'turbo' && 'Stream copy AAC without re-encoding (~10x faster). Only works with M4A/M4B source files.'}
              </p>
              {analysis?.can_stream_copy && speedPreset !== 'turbo' && (
                <p className="text-xs text-green-600 mt-1">
                  Tip: Your source files are AAC - Turbo mode is available for fastest conversion!
                </p>
              )}
            </div>
          </div>
        )}

        {/* Chapter Options */}
        {analysis && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-gray-600" />
              Chapter Options
            </h2>

            <div className="space-y-3">
              {[
                { id: 'per_file', name: 'One chapter per file', desc: `${analysis.files.length} chapters from ${analysis.files.length} files` },
                { id: 'silence', name: 'Detect by silence', desc: 'Auto-detect chapter breaks' },
                { id: 'none', name: 'No chapters', desc: 'Single continuous audio' },
              ].map(mode => (
                <label
                  key={mode.id}
                  className={`flex items-center p-3 rounded-lg border cursor-pointer transition-colors ${
                    chapterMode === mode.id
                      ? 'border-purple-500 bg-purple-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="chapterMode"
                    value={mode.id}
                    checked={chapterMode === mode.id}
                    onChange={(e) => setChapterMode(e.target.value)}
                    className="sr-only"
                  />
                  <div className={`w-4 h-4 rounded-full border-2 mr-3 flex items-center justify-center ${
                    chapterMode === mode.id ? 'border-purple-500' : 'border-gray-300'
                  }`}>
                    {chapterMode === mode.id && (
                      <div className="w-2 h-2 rounded-full bg-purple-500" />
                    )}
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">{mode.name}</div>
                    <div className="text-sm text-gray-600">{mode.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Metadata */}
        {analysis && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Music className="w-5 h-5 text-gray-600" />
              Metadata
            </h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <BookOpen className="w-4 h-4 inline mr-1" />
                  Title *
                </label>
                <input
                  type="text"
                  value={metadata.title}
                  onChange={(e) => setMetadata(prev => ({ ...prev, title: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="Book title"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <User className="w-4 h-4 inline mr-1" />
                  Author
                </label>
                <input
                  type="text"
                  value={metadata.author}
                  onChange={(e) => setMetadata(prev => ({ ...prev, author: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="Author name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <Mic className="w-4 h-4 inline mr-1" />
                  Narrator
                </label>
                <input
                  type="text"
                  value={metadata.narrator || ''}
                  onChange={(e) => setMetadata(prev => ({ ...prev, narrator: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="Narrator name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Series
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={metadata.series || ''}
                    onChange={(e) => setMetadata(prev => ({ ...prev, series: e.target.value }))}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="Series name"
                  />
                  <input
                    type="text"
                    value={metadata.series_part || ''}
                    onChange={(e) => setMetadata(prev => ({ ...prev, series_part: e.target.value }))}
                    className="w-16 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="#"
                  />
                </div>
              </div>
            </div>

            {/* Cover Art */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Image className="w-4 h-4 inline mr-1" />
                Cover Art
              </label>
              <div className="flex items-center gap-3">
                {analysis.has_cover ? (
                  <div className="flex items-center gap-2 text-green-600 text-sm">
                    <Check className="w-4 h-4" />
                    Cover found: {analysis.cover_source?.split('/').pop()}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">No cover art detected</div>
                )}
              </div>
            </div>

            {/* Advanced Options Toggle */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="mt-4 flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
            >
              {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              Advanced options
            </button>

            {showAdvanced && (
              <div className="mt-4 pt-4 border-t border-gray-200 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Year</label>
                  <input
                    type="text"
                    value={metadata.year || ''}
                    onChange={(e) => setMetadata(prev => ({ ...prev, year: e.target.value }))}
                    className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="2024"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Publisher</label>
                  <input
                    type="text"
                    value={metadata.publisher || ''}
                    onChange={(e) => setMetadata(prev => ({ ...prev, publisher: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="Publisher name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={metadata.description || ''}
                    onChange={(e) => setMetadata(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="Book description..."
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Output Options */}
        {analysis && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Output Options</h2>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-900">Output filename</div>
                  <div className="text-sm text-gray-600">
                    {metadata.title || 'Untitled'}.m4b
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={verifyOutput}
                  onChange={(e) => setVerifyOutput(e.target.checked)}
                  className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
                />
                <div>
                  <div className="font-medium text-gray-900">Verify output</div>
                  <div className="text-sm text-gray-600">Check duration and chapters match</div>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteSource}
                  onChange={(e) => setDeleteSource(e.target.checked)}
                  className="w-4 h-4 text-red-600 border-gray-300 rounded focus:ring-red-500"
                />
                <div>
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    <Trash2 className="w-4 h-4 text-red-500" />
                    Delete source files after conversion
                  </div>
                  <div className="text-sm text-gray-600">Permanently remove original MP3 files</div>
                </div>
              </label>
            </div>
          </div>
        )}

        {/* Progress */}
        {converting && progress && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Converting...</h2>
              <button
                onClick={cancelConversion}
                className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>

            <div className="mb-4">
              <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
                <span>{progress.message || progress.phase}</span>
                <span>{progress.percent?.toFixed(1)}%</span>
              </div>
              <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-600 transition-all duration-300"
                  style={{ width: `${progress.percent || 0}%` }}
                />
              </div>
            </div>

            {progress.elapsed_seconds > 0 && (
              <div className="flex items-center gap-4 text-sm text-gray-600">
                <div className="flex items-center gap-1">
                  <Clock className="w-4 h-4" />
                  Elapsed: {formatDuration(progress.elapsed_seconds * 1000)}
                </div>
                {progress.eta_seconds && (
                  <div>ETA: {formatDuration(progress.eta_seconds * 1000)}</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Result */}
        {result && (
          <div className={`rounded-xl shadow-sm p-6 ${
            result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
          }`}>
            <div className="flex items-start gap-3">
              {result.success ? (
                <Check className="w-6 h-6 text-green-600 flex-shrink-0 mt-0.5" />
              ) : (
                <X className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
              )}
              <div className="flex-1">
                <h3 className={`font-semibold ${result.success ? 'text-green-800' : 'text-red-800'}`}>
                  {result.success ? 'Conversion Complete!' : 'Conversion Failed'}
                </h3>

                {result.success && (
                  <div className="mt-2 space-y-1 text-sm text-green-700">
                    <p>Output: {result.output_path}</p>
                    <p>Duration: {formatDuration(result.duration_ms)}</p>
                    <p>Chapters: {result.chapters_count}</p>
                    <p>Size: {formatBytes(result.output_size_bytes)} (saved {result.space_saved_percent.toFixed(0)}%)</p>
                  </div>
                )}

                {result.errors?.length > 0 && (
                  <div className="mt-2">
                    {result.errors.map((err, i) => (
                      <p key={i} className="text-sm text-red-700">{err}</p>
                    ))}
                  </div>
                )}

                {result.warnings?.length > 0 && (
                  <div className="mt-2 p-2 bg-yellow-100 rounded-lg">
                    <p className="text-sm font-medium text-yellow-800">Warnings:</p>
                    {result.warnings.map((warn, i) => (
                      <p key={i} className="text-sm text-yellow-700">{warn}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Convert Button */}
        {analysis && !converting && (
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowChapterPreview(true)}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Preview Chapters
            </button>
            <button
              onClick={startConversion}
              disabled={!metadata.title}
              className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              Convert to M4B
            </button>
          </div>
        )}
      </div>

      {/* Chapter Preview Modal */}
      {showChapterPreview && analysis && (
        <ChapterPreviewModal
          chapters={analysis.detected_chapters}
          totalDuration={analysis.total_duration_ms}
          onClose={() => setShowChapterPreview(false)}
        />
      )}
    </div>
  );
}
