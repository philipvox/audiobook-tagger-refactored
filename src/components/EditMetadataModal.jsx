// src/components/EditMetadataModal.jsx
import { useState } from 'react';
import { X, Save } from 'lucide-react';

export function EditMetadataModal({ isOpen, onClose, onSave, metadata, groupName }) {
  const [editedMetadata, setEditedMetadata] = useState(metadata);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(editedMetadata);
    onClose();
  };

  const updateField = (field, value) => {
    setEditedMetadata(prev => ({ ...prev, [field]: value }));
  };

  const updateGenres = (genresString) => {
    const genresArray = genresString.split(',').map(g => g.trim()).filter(g => g);
    setEditedMetadata(prev => ({ ...prev, genres: genresArray }));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Edit Metadata</h2>
              <p className="text-sm text-gray-600 mt-1">{groupName}</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <X className="w-6 h-6 text-gray-600" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto max-h-[calc(90vh-180px)] p-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Title</label>
              <input
                type="text"
                value={editedMetadata.title}
                onChange={(e) => updateField('title', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Subtitle</label>
              <input
                type="text"
                value={editedMetadata.subtitle || ''}
                onChange={(e) => updateField('subtitle', e.target.value || null)}
                placeholder="Optional"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Author</label>
              <input
                type="text"
                value={editedMetadata.author}
                onChange={(e) => updateField('author', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Narrator</label>
              <input
                type="text"
                value={editedMetadata.narrator || ''}
                onChange={(e) => updateField('narrator', e.target.value || null)}
                placeholder="Optional"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Series</label>
                <input
                  type="text"
                  value={editedMetadata.series || ''}
                  onChange={(e) => updateField('series', e.target.value || null)}
                  placeholder="Optional"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Book Number</label>
                <input
                  type="text"
                  value={editedMetadata.sequence || ''}
                  onChange={(e) => updateField('sequence', e.target.value || null)}
                  placeholder="Optional"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Genres <span className="text-gray-500 text-xs">(comma-separated, max 3)</span>
              </label>
              <input
                type="text"
                value={editedMetadata.genres.join(', ')}
                onChange={(e) => updateGenres(e.target.value)}
                placeholder="Fiction, Fantasy, Adventure"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Publisher</label>
                <input
                  type="text"
                  value={editedMetadata.publisher || ''}
                  onChange={(e) => updateField('publisher', e.target.value || null)}
                  placeholder="Optional"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Year</label>
                <input
                  type="text"
                  value={editedMetadata.year || ''}
                  onChange={(e) => updateField('year', e.target.value || null)}
                  placeholder="YYYY"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
              <textarea
                value={editedMetadata.description || ''}
                onChange={(e) => updateField('description', e.target.value || null)}
                rows={4}
                placeholder="Optional"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">ISBN</label>
              <input
                type="text"
                value={editedMetadata.isbn || ''}
                onChange={(e) => updateField('isbn', e.target.value || null)}
                placeholder="Optional"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-gray-200 flex gap-3 justify-end">
          <button onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button onClick={handleSave} className="btn btn-primary flex items-center gap-2">
            <Save className="w-4 h-4" />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}