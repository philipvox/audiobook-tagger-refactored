import { useState, useEffect, useCallback } from 'react';
import { Folder, File, ChevronRight, X, ArrowUp } from 'lucide-react';
import { callBackend, resolveFileBrowser, getFileBrowserOptions } from '../api';

export function FileBrowser({ onClose }) {
  const [currentPath, setCurrentPath] = useState('/mnt/audiobooks');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const options = getFileBrowserOptions();
  const directoryMode = options?.directory;

  const loadDirectory = useCallback(async (path) => {
    setLoading(true);
    setError('');
    try {
      const result = await callBackend('list_directory', {
        path,
        type: directoryMode ? 'directory' : 'all',
      });
      setEntries(result);
      setCurrentPath(path);
    } catch (err) {
      setError(err.message || 'Failed to load directory');
    } finally {
      setLoading(false);
    }
  }, [directoryMode]);

  useEffect(() => {
    loadDirectory(currentPath);
  }, []);

  const handleSelect = (entry) => {
    if (entry.is_dir) {
      if (directoryMode) {
        // In directory mode, clicking navigates into the folder
        loadDirectory(entry.path);
      } else {
        loadDirectory(entry.path);
      }
    } else {
      // File selected
      resolveFileBrowser(entry.path);
      onClose();
    }
  };

  const handleSelectCurrent = () => {
    resolveFileBrowser(currentPath);
    onClose();
  };

  const handleCancel = () => {
    resolveFileBrowser(null);
    onClose();
  };

  const goUp = () => {
    const parent = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
    loadDirectory(parent);
  };

  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-neutral-900 rounded-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-medium text-white">
            {directoryMode ? 'Select Folder' : 'Select File'}
          </h2>
          <button onClick={handleCancel} className="text-neutral-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 px-4 py-2 text-xs text-neutral-400 overflow-x-auto">
          <button onClick={() => loadDirectory('/')} className="hover:text-white shrink-0">/</button>
          {pathParts.map((part, i) => (
            <span key={i} className="flex items-center gap-1 shrink-0">
              <ChevronRight className="w-3 h-3" />
              <button
                onClick={() => loadDirectory('/' + pathParts.slice(0, i + 1).join('/'))}
                className="hover:text-white"
              >
                {part}
              </button>
            </span>
          ))}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {/* Go up */}
          {currentPath !== '/' && (
            <button
              onClick={goUp}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg hover:bg-neutral-800 text-sm text-neutral-400"
            >
              <ArrowUp className="w-4 h-4" />
              <span>..</span>
            </button>
          )}

          {loading && <p className="text-sm text-neutral-500 px-2 py-4">Loading...</p>}
          {error && <p className="text-sm text-red-400 px-2 py-4">{error}</p>}

          {!loading && entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => handleSelect(entry)}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg hover:bg-neutral-800 text-sm text-left"
            >
              {entry.is_dir
                ? <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                : <File className="w-4 h-4 text-neutral-500 shrink-0" />
              }
              <span className="text-neutral-200 truncate">{entry.name}</span>
              {entry.size != null && !entry.is_dir && (
                <span className="text-neutral-600 text-xs ml-auto shrink-0">
                  {formatSize(entry.size)}
                </span>
              )}
            </button>
          ))}

          {!loading && entries.length === 0 && !error && (
            <p className="text-sm text-neutral-500 px-2 py-4">Empty directory</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-800">
          <span className="text-xs text-neutral-500 truncate max-w-[60%]">{currentPath}</span>
          <div className="flex gap-2">
            <button onClick={handleCancel} className="btn btn-secondary text-xs px-3 py-1.5">
              Cancel
            </button>
            {directoryMode && (
              <button onClick={handleSelectCurrent} className="btn btn-primary text-xs px-3 py-1.5">
                Select This Folder
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
