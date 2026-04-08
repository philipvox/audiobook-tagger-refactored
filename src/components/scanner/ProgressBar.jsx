// src/components/scanner/ProgressBar.jsx
import { useState, useEffect, useRef } from 'react';
import { RefreshCw, Save, AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react';

export function ProgressBar({ type = 'scan', progress, onCancel, calculateETA }) {
  const [showErrors, setShowErrors] = useState(false);

  const isVisible = progress.total > 0;

  if (!isVisible) return null;

  const hasErrors = progress.error_count > 0;
  const errorCount = progress.error_count || 0;
  const recentErrors = progress.recent_errors || [];

  if (type === 'scan') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-neutral-800 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-5 h-5 text-blue-600 animate-spin" />
                <span className="font-semibold text-gray-100">
                  Scanning {progress.current} of {progress.total} files
                </span>
              </div>

              {/* Error indicator */}
              {hasErrors && (
                <button
                  onClick={() => setShowErrors(!showErrors)}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-700 text-sm font-medium rounded-lg transition-colors"
                >
                  <AlertTriangle className="w-4 h-4" />
                  <span>{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
                  {showErrors ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              )}

              {onCancel && (
                <button
                  onClick={onCancel}
                  className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-sm font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>

            <div className="text-right">
              {calculateETA && (
                <div className="font-semibold text-gray-100">
                  ETA: {calculateETA()}
                </div>
              )}
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}% complete
                {progress.covers_found > 0 && (
                  <span className="ml-2 text-green-600">• {progress.covers_found} covers</span>
                )}
              </div>
            </div>
          </div>

          <div className="mb-3">
            <div className="w-full bg-gray-600 rounded-full h-3">
              <div
                className="bg-gradient-to-r from-blue-500 to-blue-600 h-3 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentFile && (
            <div className="text-sm text-gray-300 truncate">
              <span className="font-medium">Processing:</span> {progress.currentFile}
            </div>
          )}

          {/* Error details panel */}
          {showErrors && recentErrors.length > 0 && (
            <div className="mt-3 pt-3 border-t border-neutral-800">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-red-700">Recent Errors</span>
                <button
                  onClick={() => setShowErrors(false)}
                  className="p-1 hover:bg-neutral-800 rounded"
                >
                  <X className="w-4 h-4 text-gray-400" />
                </button>
              </div>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {recentErrors.map((err, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-xs bg-red-50 rounded p-2">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${
                      err.error_type === 'api' ? 'bg-purple-100 text-purple-700' :
                      err.error_type === 'io' ? 'bg-blue-100 text-blue-300' :
                      err.error_type === 'timeout' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-neutral-800 text-gray-300'
                    }`}>
                      {err.error_type}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-200 truncate">{err.item}</div>
                      <div className="text-gray-400 truncate">{err.error}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'write') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-neutral-800 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Save className="w-5 h-5 text-green-600 animate-pulse" />
              <span className="font-semibold text-gray-100">
                Writing tags {progress.current} of {progress.total}
              </span>
            </div>
            <div className="text-sm text-gray-400">
              {Math.round((progress.current / progress.total) * 100)}% complete
            </div>
          </div>
          <div className="w-full bg-gray-600 rounded-full h-3">
            <div
              className="bg-green-600 h-3 rounded-full transition-all duration-300"
              style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
            ></div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'tags') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-amber-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-amber-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  🤖 GPT Assigning Tags: {progress.current} of {progress.total} books
                </span>
              </div>

              {progress.success > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.success} done
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}% complete
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-3">
              <div
                className="bg-gradient-to-r from-amber-600 to-amber-500 h-3 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-300 truncate">
              <span className="font-medium">Processing:</span> {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'genres') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-green-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-green-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  🤖 AI Cleaning Genres: {progress.current} of {progress.total} books
                </span>
              </div>

              {progress.cleaned > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.cleaned} cleaned
                </span>
              )}
              {progress.unchanged > 0 && (
                <span className="text-gray-400 text-sm">
                  ○ {progress.unchanged} OK
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}% complete
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-3">
              <div
                className="bg-gradient-to-r from-green-600 to-green-500 h-3 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-300 truncate">
              <span className="font-medium">Processing:</span> {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'descriptions') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-violet-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-violet-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  📝 GPT Fixing Descriptions: {progress.current} of {progress.total} books
                </span>
              </div>

              {progress.fixed > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.fixed} fixed
                </span>
              )}
              {progress.skipped > 0 && (
                <span className="text-gray-400 text-sm">
                  ○ {progress.skipped} OK
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}% complete
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-3">
              <div
                className="bg-gradient-to-r from-violet-600 to-violet-500 h-3 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-300 truncate">
              <span className="font-medium">Processing:</span> {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'titles') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-blue-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-blue-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  Fixing Titles: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.success > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.success} fixed
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-400 truncate">
              {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'subtitles') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-teal-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-teal-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  Fixing Subtitles: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.fixed > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.fixed} fixed
                </span>
              )}
              {progress.skipped > 0 && (
                <span className="text-gray-400 text-sm">
                  ○ {progress.skipped} OK
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-2">
              <div
                className="bg-teal-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-400 truncate">
              {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'authors') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-orange-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-orange-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  Fixing Authors: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.fixed > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.fixed} fixed
                </span>
              )}
              {progress.skipped > 0 && (
                <span className="text-gray-400 text-sm">
                  ○ {progress.skipped} OK
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-2">
              <div
                className="bg-orange-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-400 truncate">
              {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'years') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-indigo-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-indigo-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  Fixing Years: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.fixed > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.fixed} fixed
                </span>
              )}
              {progress.skipped > 0 && (
                <span className="text-gray-400 text-sm">
                  ○ {progress.skipped} OK
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-2">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-400 truncate">
              {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'series') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-purple-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-purple-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  Looking up Series: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.success > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.success} found
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-2">
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-400 truncate">
              {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'age') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-green-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-green-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  🔍 Looking up Age Ratings: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.success > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.success} found
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-2">
              <div
                className="bg-green-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-400 truncate">
              {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'isbn') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-cyan-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-cyan-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  # Looking up ISBN/ASIN: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.success > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.success} found
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} not found
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-2">
              <div
                className="bg-cyan-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-400 truncate">
              {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'enrichment') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-amber-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-amber-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  ⚡ Run All Enrichment: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.success > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.success} done
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-3">
              <div
                className="bg-gradient-to-r from-amber-600 to-amber-400 h-3 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-300 truncate">
              <span className="font-medium">Status:</span> {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'dna') {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-purple-700/50 shadow-lg z-50">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 text-purple-500">
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  🧬 Generating BookDNA: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.success > 0 && (
                <span className="text-green-400 text-sm">
                  ✓ {progress.success} done
                </span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">
                  ✗ {progress.failed} failed
                </span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-3">
              <div
                className="bg-gradient-to-r from-purple-600 to-purple-400 h-3 rounded-full transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-300 truncate">
              <span className="font-medium">Processing:</span> {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Consolidated GPT operations (metadata, classify, descriptionProcessing)
  const CONSOLIDATED_CONFIGS = {
    metadata: { label: 'Metadata Resolution', icon: '📝', gradient: 'from-blue-600 to-blue-400', border: 'border-blue-700/50', spinner: 'text-blue-500' },
    classify: { label: 'Classification & Tagging', icon: '🤖', gradient: 'from-amber-600 to-amber-400', border: 'border-amber-700/50', spinner: 'text-amber-500' },
    descriptionProcessing: { label: 'Description Processing', icon: '📖', gradient: 'from-cyan-600 to-cyan-400', border: 'border-cyan-700/50', spinner: 'text-cyan-500' },
  };

  const consolidated = CONSOLIDATED_CONFIGS[type];
  if (consolidated) {
    return (
      <div className={`fixed bottom-0 left-0 right-0 bg-neutral-900 border-t ${consolidated.border} shadow-lg z-50`}>
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className={`w-5 h-5 ${consolidated.spinner}`}>
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <span className="font-semibold text-gray-100">
                  {consolidated.icon} {consolidated.label}: {progress.current} of {progress.total}
                </span>
              </div>

              {progress.success > 0 && (
                <span className="text-green-400 text-sm">✓ {progress.success} done</span>
              )}
              {progress.failed > 0 && (
                <span className="text-red-400 text-sm">✗ {progress.failed} failed</span>
              )}
            </div>

            <div className="text-right">
              <div className="text-sm text-gray-400">
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
          </div>

          <div className="mb-2">
            <div className="w-full bg-gray-600 rounded-full h-3">
              <div
                className={`bg-gradient-to-r ${consolidated.gradient} h-3 rounded-full transition-all duration-300`}
                style={{
                  width: `${progress.total > 0 ? Math.max(2, (progress.current / progress.total) * 100) : 0}%`
                }}
              ></div>
            </div>
          </div>

          {progress.currentBook && (
            <div className="text-sm text-gray-300 truncate">
              <span className="font-medium">Processing:</span> {progress.currentBook}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// Top-positioned progress bar for consolidated GPT calls (A, B, C)
// Uses real per-book progress events to compute accurate ETA from actual throughput.
const TOP_BAR_CONFIGS = {
  metadata: {
    label: 'Metadata Resolution',
    icon: '📝',
    gradient: 'from-blue-600 to-blue-400',
    border: 'border-blue-700/50',
    spinnerColor: 'text-blue-500',
  },
  classify: {
    label: 'Classification & Tagging',
    icon: '🤖',
    gradient: 'from-amber-600 to-amber-400',
    border: 'border-amber-700/50',
    spinnerColor: 'text-amber-500',
  },
  description: {
    label: 'Description Processing',
    icon: '📖',
    gradient: 'from-cyan-600 to-cyan-400',
    border: 'border-cyan-700/50',
    spinnerColor: 'text-cyan-500',
  },
};

function formatTime(secs) {
  if (secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function TopProgressBar({ type, progress }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(null);

  const cfg = TOP_BAR_CONFIGS[type];
  const isActive = progress && progress.total > 0;
  const isComplete = isActive && progress.current >= progress.total && progress.current > 0;

  // Tick elapsed time every 500ms
  useEffect(() => {
    if (isActive && !isComplete) {
      if (!startRef.current) startRef.current = Date.now();
      const id = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 500);
      return () => clearInterval(id);
    } else if (!isActive) {
      startRef.current = null;
      setElapsed(0);
    }
  }, [isActive, isComplete]);

  if (!isActive || !cfg) return null;

  const current = progress.current || 0;
  const total = progress.total;
  const realPct = isComplete ? 100 : Math.round((current / total) * 100);
  const booksLeft = total - current;

  // Fake progress: smoothly crawl toward 90% based on elapsed time when no real progress yet
  // Uses log curve so it starts fast then slows down — feels natural
  const fakeProgress = isComplete ? 100 : Math.min(90, Math.round(30 * Math.log(1 + elapsed / 3)));
  const pct = isComplete ? 100 : Math.max(realPct, fakeProgress);

  // Compute ETA from actual throughput: (elapsed / booksCompleted) * booksLeft
  // Use a smoothed rate once we have at least 1 book done
  let remaining = 0;
  if (!isComplete && current > 0 && elapsed > 0) {
    const secsPerBook = elapsed / current;
    remaining = Math.round(secsPerBook * booksLeft);
  }

  return (
    <div className={`bg-neutral-900 border-b ${cfg.border} shadow-lg z-50`}>
      <div className="px-6 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            {!isComplete ? (
              <div className={`w-5 h-5 ${cfg.spinnerColor}`}>
                <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
            ) : (
              <span className="text-green-400 text-lg">✓</span>
            )}
            <span className="font-semibold text-gray-100">
              {cfg.icon} {cfg.label}: {current} of {total}
            </span>

            {progress.success > 0 && (
              <span className="text-green-400 text-sm">✓ {progress.success}</span>
            )}
            {progress.failed > 0 && (
              <span className="text-red-400 text-sm">✗ {progress.failed}</span>
            )}
          </div>

          <div className="flex items-center gap-3 text-sm text-gray-400">
            {isComplete ? (
              <span className="text-green-400 font-medium">Done in {formatTime(elapsed)}</span>
            ) : (
              <>
                <span>{formatTime(elapsed)} elapsed</span>
                {current > 0 && (
                  <>
                    <span className="text-gray-600">|</span>
                    <span>~{formatTime(remaining)} remaining</span>
                  </>
                )}
                {current === 0 && (
                  <>
                    <span className="text-gray-600">|</span>
                    <span>Working...</span>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="w-full bg-gray-700 rounded-full h-2.5">
          <div
            className={`bg-gradient-to-r ${cfg.gradient} h-2.5 rounded-full transition-all duration-1000 ease-out`}
            style={{ width: `${Math.max(2, pct)}%` }}
          ></div>
        </div>

        {progress.currentBook && !isComplete && (
          <div className="text-xs text-gray-500 mt-1 truncate">
            {progress.currentBook}
          </div>
        )}
      </div>
    </div>
  );
}