import { useState } from 'react';
import {
  X, RefreshCw, Zap, Sparkles, Shield, User, Mic, FileText,
  BookOpen, Tag, Building, Image, CheckSquare, Square, Mic2
} from 'lucide-react';

// Scan level options
const SCAN_LEVELS = [
  {
    id: 'normal',
    label: 'Smart Scan',
    description: 'Skip books with existing metadata, only scan new ones',
    icon: Zap,
    color: 'blue',
  },
  {
    id: 'force_fresh',
    label: 'Clean Scan',
    description: 'Clear caches and fetch all fresh data from APIs',
    icon: Sparkles,
    color: 'purple',
  },
  {
    id: 'super_scanner',
    label: 'Deep Scan',
    description: 'Maximum accuracy with validation, retries, and GPT on all',
    icon: Shield,
    color: 'orange',
  },
];

// Metadata fields that can be selectively refreshed
const METADATA_FIELDS = [
  { id: 'title', label: 'Title', icon: BookOpen, description: 'Book title' },
  { id: 'authors', label: 'Author', icon: User, description: 'Author name(s)' },
  { id: 'narrators', label: 'Narrator', icon: Mic, description: 'Narrator name(s)' },
  { id: 'series', label: 'Series', icon: Tag, description: 'Series name and number' },
  { id: 'description', label: 'Description', icon: FileText, description: 'Book description/summary' },
  { id: 'genres', label: 'Genres', icon: Tag, description: 'Genre categories' },
  { id: 'publisher', label: 'Publisher', icon: Building, description: 'Publisher name' },
  { id: 'cover', label: 'Cover Art', icon: Image, description: 'Cover image' },
];

export function RescanModal({ isOpen, onClose, onRescan, selectedCount, scanning }) {
  const [scanLevel, setScanLevel] = useState('force_fresh');
  const [useSelectiveFields, setUseSelectiveFields] = useState(false);
  const [selectedFields, setSelectedFields] = useState(new Set());
  const [enableTranscription, setEnableTranscription] = useState(false);

  if (!isOpen) return null;

  const toggleField = (fieldId) => {
    const newFields = new Set(selectedFields);
    if (newFields.has(fieldId)) {
      newFields.delete(fieldId);
    } else {
      newFields.add(fieldId);
    }
    setSelectedFields(newFields);
  };

  const selectAllFields = () => {
    setSelectedFields(new Set(METADATA_FIELDS.map(f => f.id)));
  };

  const clearAllFields = () => {
    setSelectedFields(new Set());
  };

  const handleRescan = () => {
    const options = { enableTranscription };
    if (useSelectiveFields && selectedFields.size > 0) {
      // Selective field rescan
      onRescan('selective_refresh', Array.from(selectedFields), options);
    } else {
      // Full rescan with selected level
      onRescan(scanLevel, null, options);
    }
    onClose();
  };

  const canRescan = !useSelectiveFields || selectedFields.size > 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900">
              Rescan {selectedCount} {selectedCount === 1 ? 'Book' : 'Books'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* Scan Level Selection */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">Scan Level</h3>
            <div className="space-y-2">
              {SCAN_LEVELS.map((level) => {
                const Icon = level.icon;
                const isSelected = scanLevel === level.id && !useSelectiveFields;
                return (
                  <button
                    key={level.id}
                    onClick={() => {
                      setScanLevel(level.id);
                      setUseSelectiveFields(false);
                    }}
                    className={`w-full p-3 rounded-lg border-2 text-left transition-all flex items-start gap-3 ${
                      isSelected
                        ? `border-${level.color}-500 bg-${level.color}-50`
                        : 'border-gray-200 hover:border-gray-300 bg-white'
                    }`}
                  >
                    <Icon className={`w-5 h-5 mt-0.5 ${isSelected ? `text-${level.color}-600` : 'text-gray-400'}`} />
                    <div>
                      <div className={`font-medium ${isSelected ? `text-${level.color}-900` : 'text-gray-900'}`}>
                        {level.label}
                      </div>
                      <div className={`text-xs ${isSelected ? `text-${level.color}-700` : 'text-gray-500'}`}>
                        {level.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Audio Verification Toggle */}
          <div
            onClick={() => setEnableTranscription(!enableTranscription)}
            className={`p-3 rounded-lg border-2 cursor-pointer transition-all flex items-start gap-3 ${
              enableTranscription
                ? 'border-green-500 bg-green-50'
                : 'border-gray-200 hover:border-gray-300 bg-white'
            }`}
          >
            <div className={`p-1.5 rounded-md ${enableTranscription ? 'bg-green-100' : 'bg-gray-100'}`}>
              <Mic2 className={`w-4 h-4 ${enableTranscription ? 'text-green-600' : 'text-gray-400'}`} />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className={`font-medium ${enableTranscription ? 'text-green-900' : 'text-gray-900'}`}>
                  Audio Verification
                </span>
                {enableTranscription && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-200 text-green-800 rounded">
                    ON
                  </span>
                )}
              </div>
              <div className={`text-xs ${enableTranscription ? 'text-green-700' : 'text-gray-500'}`}>
                Transcribe first 90s to verify book identity (~$0.01/book)
              </div>
            </div>
            <div className={`w-10 h-6 rounded-full p-0.5 transition-colors ${enableTranscription ? 'bg-green-500' : 'bg-gray-300'}`}>
              <div className={`w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${enableTranscription ? 'translate-x-4' : 'translate-x-0'}`} />
            </div>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white text-gray-500">or</span>
            </div>
          </div>

          {/* Selective Field Refresh */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-700">Refresh Specific Fields</h3>
              <button
                onClick={() => setUseSelectiveFields(!useSelectiveFields)}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  useSelectiveFields
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {useSelectiveFields ? 'Active' : 'Enable'}
              </button>
            </div>

            {useSelectiveFields && (
              <div className="space-y-2">
                {/* Quick actions */}
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={selectAllFields}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Select All
                  </button>
                  <span className="text-gray-300">|</span>
                  <button
                    onClick={clearAllFields}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Clear All
                  </button>
                </div>

                {/* Field checkboxes */}
                <div className="grid grid-cols-2 gap-2">
                  {METADATA_FIELDS.map((field) => {
                    const Icon = field.icon;
                    const isChecked = selectedFields.has(field.id);
                    return (
                      <button
                        key={field.id}
                        onClick={() => toggleField(field.id)}
                        className={`p-2 rounded-lg border text-left transition-all flex items-center gap-2 ${
                          isChecked
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300 bg-white'
                        }`}
                      >
                        {isChecked ? (
                          <CheckSquare className="w-4 h-4 text-blue-600 flex-shrink-0" />
                        ) : (
                          <Square className="w-4 h-4 text-gray-300 flex-shrink-0" />
                        )}
                        <Icon className={`w-4 h-4 flex-shrink-0 ${isChecked ? 'text-blue-600' : 'text-gray-400'}`} />
                        <span className={`text-sm ${isChecked ? 'text-blue-900' : 'text-gray-700'}`}>
                          {field.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {selectedFields.size > 0 && (
                  <p className="text-xs text-gray-500 mt-2">
                    Will refresh: {Array.from(selectedFields).join(', ')}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleRescan}
            disabled={!canRescan || scanning}
            className={`px-4 py-2 rounded-lg transition-colors font-medium flex items-center gap-2 ${
              canRescan && !scanning
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? 'Scanning...' : 'Start Rescan'}
          </button>
        </div>
      </div>
    </div>
  );
}
