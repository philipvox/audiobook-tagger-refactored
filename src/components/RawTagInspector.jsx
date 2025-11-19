// RawTagInspector.jsx - Add this component to your app

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FileSearch, X, Copy, Music, Clock, Activity } from 'lucide-react';

export function RawTagInspector({ isOpen, onClose }) {
  const [loading, setLoading] = useState(false);
  const [tagData, setTagData] = useState(null);
  const [error, setError] = useState(null);

  const getFileName = (path) => {
    if (!path) return '';
    const segments = path.split(/[\\/]/);
    return segments.pop() || path;
  };

  const handleSelectFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{
          name: 'Audio Files',
          extensions: ['m4a', 'm4b', 'mp3', 'flac', 'ogg', 'opus']
        }]
      });

      if (!selected) return;

      setLoading(true);
      setError(null);
      
      const result = await invoke('inspect_file_tags', {
        filePath: selected
      });
      
      setTagData(result);
      setLoading(false);
    } catch (err) {
      console.error('Inspection failed:', err);
      setError(err.toString());
      setLoading(false);
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (clipboardError) {
      console.error('Clipboard copy failed:', clipboardError);
    }
  };

  const formatDuration = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${mins}m ${secs}s`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-red-50 to-orange-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <FileSearch className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Raw Tag Inspector</h2>
                <p className="text-sm text-gray-600">View file metadata without processing</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-red-100 rounded-lg transition-colors"
            >
              <X className="w-6 h-6 text-gray-600" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!tagData && !loading && (
            <div className="text-center py-16">
              <FileSearch className="w-20 h-20 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-600 mb-6">Select an audio file to inspect its metadata</p>
              <button
                onClick={handleSelectFile}
                className="btn btn-primary inline-flex items-center gap-2"
              >
                <FileSearch className="w-4 h-4" />
                Select File
              </button>
            </div>
          )}

          {loading && (
            <div className="text-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Reading file tags...</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-red-800 font-medium">Error reading file:</p>
              <p className="text-red-600 text-sm mt-1">{error}</p>
              <button
                onClick={handleSelectFile}
                className="mt-4 btn btn-secondary"
              >
                Try Another File
              </button>
            </div>
          )}

          {tagData && (
            <div className="space-y-6">
              {/* File Info Card */}
              <div className="bg-gradient-to-br from-gray-50 to-gray-100 rounded-xl p-6 border border-gray-200">
                <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
                  <Music className="w-5 h-5 text-red-600" />
                  File Information
                </h3>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-white rounded-lg p-4 border border-gray-200 md:col-span-2 space-y-2">
                    <div className="text-xs text-gray-500 uppercase tracking-wide">File Path</div>
                    <div className="flex flex-col gap-2">
                      <div className="text-sm font-semibold text-gray-900 break-all">
                        {tagData.file_path}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <span className="px-2 py-1 bg-gray-100 rounded">{getFileName(tagData.file_path)}</span>
                        <button
                          onClick={() => copyToClipboard(tagData.file_path)}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded transition-colors"
                          title="Copy full path"
                        >
                          <Copy className="w-3 h-3" />
                          Copy Path
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-lg p-4 border border-gray-200">
                    <div className="text-xs text-gray-500 mb-1">Format</div>
                    <div className="text-sm font-semibold text-gray-900">
                      {tagData.file_format}
                    </div>
                  </div>
                  
                  {tagData.duration_seconds && (
                    <div className="bg-white rounded-lg p-4 border border-gray-200">
                      <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Duration
                      </div>
                      <div className="text-sm font-semibold text-gray-900">
                        {formatDuration(tagData.duration_seconds)}
                      </div>
                    </div>
                  )}
                  
                  {tagData.bitrate && (
                    <div className="bg-white rounded-lg p-4 border border-gray-200">
                      <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                        <Activity className="w-3 h-3" />
                        Bitrate
                      </div>
                      <div className="text-sm font-semibold text-gray-900">
                        {tagData.bitrate} kbps
                      </div>
                    </div>
                  )}
                  
                  {tagData.sample_rate && (
                    <div className="bg-white rounded-lg p-4 border border-gray-200 col-span-2">
                      <div className="text-xs text-gray-500 mb-1">Sample Rate</div>
                      <div className="text-sm font-semibold text-gray-900">
                        {tagData.sample_rate} Hz
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Tags Table */}
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-red-600 to-orange-600 px-6 py-4">
                  <h3 className="text-lg font-bold text-white flex items-center justify-between">
                    <span>Metadata Tags ({tagData.tags.length})</span>
                    <span className="text-sm font-normal text-red-100">
                      Raw values from file
                    </span>
                  </h3>
                </div>
                
                {tagData.tags.length === 0 ? (
                  <div className="p-8 text-center">
                    <p className="text-gray-500">No tags found in file</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                            Tag Key
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                            Value
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                            Type
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {tagData.tags.map((tag, idx) => (
                          <tr key={idx} className="hover:bg-gray-50 transition-colors">
                            <td className="px-6 py-4">
                              <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                                tag.key.includes('Genre') 
                                  ? 'bg-purple-100 text-purple-800'
                                  : tag.key.includes('Narrator') || tag.key.includes('Composer')
                                  ? 'bg-green-100 text-green-800'
                                  : tag.key.includes('Custom')
                                  ? 'bg-orange-100 text-orange-800'
                                  : 'bg-blue-100 text-blue-800'
                              }`}>
                                {tag.key}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <div className="text-sm text-gray-900 max-w-md">
                                {tag.value.length > 100 ? (
                                  <details className="cursor-pointer">
                                    <summary className="font-medium text-blue-600 hover:text-blue-700">
                                      {tag.value.substring(0, 100)}... (click to expand)
                                    </summary>
                                    <div className="mt-2 p-3 bg-gray-50 rounded border border-gray-200 whitespace-pre-wrap text-xs">
                                      {tag.value}
                                    </div>
                                  </details>
                                ) : (
                                  <span className="break-words">{tag.value}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-xs text-gray-500 font-mono">
                                {tag.tag_type}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button
                                onClick={() => copyToClipboard(tag.value)}
                                className="inline-flex items-center gap-1 px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded transition-colors"
                                title="Copy value"
                              >
                                <Copy className="w-3 h-3" />
                                Copy
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={handleSelectFile}
                  className="btn btn-secondary flex items-center gap-2"
                >
                  <FileSearch className="w-4 h-4" />
                  Inspect Another File
                </button>
                <button
                  onClick={() => {
                    const json = JSON.stringify(tagData, null, 2);
                    copyToClipboard(json);
                    alert('Full JSON copied to clipboard!');
                  }}
                  className="btn btn-secondary flex items-center gap-2"
                >
                  <Copy className="w-4 h-4" />
                  Copy All as JSON
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
