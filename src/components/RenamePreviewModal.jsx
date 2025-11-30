import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowRight, CheckCircle, Settings, FileType, Edit3 } from 'lucide-react';

export function RenamePreviewModal({ selectedFiles, metadata, onConfirm, onCancel }) {
  const [previews, setPreviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [customTemplate, setCustomTemplate] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  // Load templates on mount
  useEffect(() => {
    const loadTemplates = async () => {
      try {
        const result = await invoke('get_rename_templates');
        setTemplates(result);
        if (result.length > 0) {
          setSelectedTemplate(result[0]);
        }
      } catch (error) {
        console.error('Failed to load templates:', error);
        // Use default if API fails
        setSelectedTemplate({
          id: 'default',
          name: 'Standard',
          file_template: '{author} - {[series #sequence] }{title}{ (year)}',
        });
      }
    };
    loadTemplates();
  }, []);

  useEffect(() => {
    if (selectedTemplate || customTemplate) {
      generatePreviews();
    }
  }, [selectedFiles, metadata, selectedTemplate, customTemplate]);

  const getCurrentTemplate = () => {
    if (showCustom && customTemplate) {
      return customTemplate;
    }
    return selectedTemplate?.file_template || null;
  };

  const generatePreviews = async () => {
    setLoading(true);
    const results = [];
    const template = getCurrentTemplate();

    for (const filePath of selectedFiles) {
      try {
        const preview = await invoke('preview_rename', {
          filePath,
          metadata,
          template,
        });
        results.push(preview);
      } catch (error) {
        console.error('Preview error:', error);
      }
    }

    setPreviews(results);
    setLoading(false);
  };

  const changedCount = previews.filter(p => p.changed).length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Rename Preview</h2>
              <p className="text-gray-600 mt-1">Review proposed changes before renaming</p>
            </div>
            <FileType className="w-8 h-8 text-gray-400" />
          </div>
        </div>

        {/* Template Selection */}
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
              <Settings className="w-4 h-4" />
              Template:
            </label>

            {!showCustom ? (
              <div className="flex items-center gap-2 flex-1">
                <select
                  value={selectedTemplate?.id || ''}
                  onChange={(e) => {
                    const template = templates.find(t => t.id === e.target.value);
                    setSelectedTemplate(template);
                  }}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>

                <button
                  onClick={() => {
                    setShowCustom(true);
                    setCustomTemplate(selectedTemplate?.file_template || '');
                  }}
                  className="px-2 py-1.5 text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors flex items-center gap-1"
                >
                  <Edit3 className="w-3 h-3" />
                  Custom
                </button>

                <div className="text-xs text-gray-500 ml-2 font-mono truncate flex-1">
                  {selectedTemplate?.file_template}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-1">
                <input
                  type="text"
                  value={customTemplate}
                  onChange={(e) => setCustomTemplate(e.target.value)}
                  placeholder="{author} - {title}"
                  className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                />
                <button
                  onClick={() => setShowCustom(false)}
                  className="px-2 py-1.5 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Template help */}
          <div className="mt-2 text-xs text-gray-500">
            <span className="font-medium">Variables:</span>{' '}
            <code className="bg-gray-200 px-1 rounded">{'{author}'}</code>{' '}
            <code className="bg-gray-200 px-1 rounded">{'{title}'}</code>{' '}
            <code className="bg-gray-200 px-1 rounded">{'{series}'}</code>{' '}
            <code className="bg-gray-200 px-1 rounded">{'{sequence}'}</code>{' '}
            <code className="bg-gray-200 px-1 rounded">{'{year}'}</code>{' '}
            <code className="bg-gray-200 px-1 rounded">{'{narrator}'}</code>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <span className="ml-3 text-gray-600">Generating previews...</span>
            </div>
          ) : (
            <div className="space-y-4">
              {previews.map((preview, idx) => (
                <div
                  key={idx}
                  className={`p-4 rounded-lg border-2 ${
                    preview.changed ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'
                  }`}
                >
                  {preview.changed ? (
                    <div className="space-y-3">
                      <div className="text-sm">
                        <div className="text-xs text-gray-500 mb-1">From:</div>
                        <div className="font-mono text-sm bg-white px-3 py-2 rounded border">
                          {preview.old_path.split('/').pop()}
                        </div>
                      </div>
                      <div className="flex justify-center">
                        <ArrowRight className="w-5 h-5 text-blue-600" />
                      </div>
                      <div className="text-sm">
                        <div className="text-xs text-gray-500 mb-1">To:</div>
                        <div className="font-mono text-sm bg-green-50 px-3 py-2 rounded border border-green-200">
                          {preview.new_path.split('/').pop()}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 text-sm text-gray-600">
                      <CheckCircle className="w-5 h-5 text-gray-400" />
                      No changes needed
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-6 border-t border-gray-200 bg-gray-50">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">
              {changedCount > 0 && `${changedCount} file(s) will be renamed`}
            </div>
            <div className="flex gap-3">
              <button onClick={onCancel} className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium">
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={changedCount === 0 || loading}
                className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors ${
                  changedCount === 0 || loading
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                <CheckCircle className="w-4 h-4" />
                Confirm Rename
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
