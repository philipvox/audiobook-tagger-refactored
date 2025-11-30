// src/components/ExportImportModal.jsx
import { useState } from 'react';
import { X, Download, Upload, FileJson, FileSpreadsheet, Check, AlertCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';

export function ExportImportModal({ isOpen, onClose, groups, onImport }) {
  const [mode, setMode] = useState('export'); // 'export' or 'import'
  const [format, setFormat] = useState('csv'); // 'csv' or 'json'
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    setResult(null);

    try {
      const defaultName = `audiobooks_${new Date().toISOString().split('T')[0]}`;
      const filePath = await save({
        defaultPath: `${defaultName}.${format}`,
        filters: format === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'JSON', extensions: ['json'] }],
      });

      if (!filePath) {
        setExporting(false);
        return;
      }

      let message;
      if (format === 'csv') {
        message = await invoke('export_to_csv', { groups, filePath });
      } else {
        message = await invoke('export_to_json', { groups, filePath, pretty: true });
      }

      setResult({ type: 'success', message });
    } catch (err) {
      setError(err.toString());
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    setResult(null);

    try {
      const filePath = await open({
        filters: format === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'JSON', extensions: ['json'] }],
      });

      if (!filePath) {
        setImporting(false);
        return;
      }

      if (format === 'csv') {
        const importResult = await invoke('import_from_csv', { filePath, groups });
        setResult({
          type: 'success',
          message: `Matched ${importResult.matched} books, ${importResult.unmatched} unmatched`,
          data: importResult,
        });

        if (importResult.updates.length > 0 && onImport) {
          onImport(importResult.updates);
        }
      } else {
        const importedGroups = await invoke('import_from_json', { filePath });
        setResult({
          type: 'success',
          message: `Loaded ${importedGroups.length} books from JSON`,
          data: { groups: importedGroups },
        });

        if (onImport) {
          onImport(importedGroups);
        }
      }
    } catch (err) {
      setError(err.toString());
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-indigo-50 to-purple-50">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Export / Import</h2>
              <p className="text-sm text-gray-600 mt-1">
                {groups.length} book{groups.length === 1 ? '' : 's'} in library
              </p>
            </div>
            <button onClick={handleClose} className="p-2 hover:bg-indigo-100 rounded-lg transition-colors">
              <X className="w-6 h-6 text-gray-600" />
            </button>
          </div>
        </div>

        {/* Mode Tabs */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setMode('export')}
            className={`flex-1 py-3 px-4 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
              mode === 'export'
                ? 'text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <Download className="w-4 h-4" />
            Export
          </button>
          <button
            onClick={() => setMode('import')}
            className={`flex-1 py-3 px-4 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
              mode === 'import'
                ? 'text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <Upload className="w-4 h-4" />
            Import
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Format Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-3">Format</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setFormat('csv')}
                className={`p-4 rounded-lg border-2 transition-all flex items-center gap-3 ${
                  format === 'csv'
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <FileSpreadsheet className={`w-6 h-6 ${format === 'csv' ? 'text-indigo-600' : 'text-gray-400'}`} />
                <div className="text-left">
                  <div className={`font-medium ${format === 'csv' ? 'text-indigo-900' : 'text-gray-700'}`}>CSV</div>
                  <div className="text-xs text-gray-500">Spreadsheet format</div>
                </div>
              </button>
              <button
                onClick={() => setFormat('json')}
                className={`p-4 rounded-lg border-2 transition-all flex items-center gap-3 ${
                  format === 'json'
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <FileJson className={`w-6 h-6 ${format === 'json' ? 'text-indigo-600' : 'text-gray-400'}`} />
                <div className="text-left">
                  <div className={`font-medium ${format === 'json' ? 'text-indigo-900' : 'text-gray-700'}`}>JSON</div>
                  <div className="text-xs text-gray-500">Full data backup</div>
                </div>
              </button>
            </div>
          </div>

          {/* Mode-specific info */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            {mode === 'export' ? (
              <div className="text-sm text-gray-600">
                <p className="font-medium text-gray-900 mb-2">Export will include:</p>
                <ul className="space-y-1 list-disc list-inside">
                  <li>All metadata fields (title, author, narrator, etc.)</li>
                  <li>Series and sequence information</li>
                  <li>Folder paths for each book</li>
                  {format === 'json' && <li>Full file details and source tracking</li>}
                </ul>
              </div>
            ) : (
              <div className="text-sm text-gray-600">
                <p className="font-medium text-gray-900 mb-2">Import will:</p>
                <ul className="space-y-1 list-disc list-inside">
                  <li>Match books by folder path or title</li>
                  <li>Update metadata for matched books</li>
                  <li>Report unmatched entries</li>
                </ul>
              </div>
            )}
          </div>

          {/* Result/Error Display */}
          {result && (
            <div className={`mb-4 p-4 rounded-lg flex items-start gap-3 ${
              result.type === 'success' ? 'bg-green-50' : 'bg-amber-50'
            }`}>
              <Check className={`w-5 h-5 flex-shrink-0 ${
                result.type === 'success' ? 'text-green-600' : 'text-amber-600'
              }`} />
              <div className="text-sm">
                <p className={`font-medium ${
                  result.type === 'success' ? 'text-green-800' : 'text-amber-800'
                }`}>
                  {result.message}
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 p-4 bg-red-50 rounded-lg flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
              <div className="text-sm text-red-800">{error}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 flex gap-3 justify-end bg-gray-50">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
          >
            Close
          </button>
          {mode === 'export' ? (
            <button
              onClick={handleExport}
              disabled={exporting || groups.length === 0}
              className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors ${
                exporting || groups.length === 0
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              <Download className="w-4 h-4" />
              {exporting ? 'Exporting...' : `Export ${groups.length} Books`}
            </button>
          ) : (
            <button
              onClick={handleImport}
              disabled={importing}
              className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors ${
                importing
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              <Upload className="w-4 h-4" />
              {importing ? 'Importing...' : 'Import from File'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
