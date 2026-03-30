// src/components/BulkEditModal.jsx
import { useState } from 'react';
import { X, Save, Users, AlertCircle } from 'lucide-react';

export function BulkEditModal({ isOpen, onClose, onSave, selectedGroups }) {
  const [fieldsToEdit, setFieldsToEdit] = useState({
    author: false,
    narrator: false,
    genres: false,
    publisher: false,
    language: false,
    year: false,
    series: false,
    age_rating: false,
    content_rating: false,
  });

  const [values, setValues] = useState({
    author: '',
    narrator: '',
    genres: '',
    publisher: '',
    language: '',
    year: '',
    series: '',
    sequence: '',
    age_rating: '',
    content_rating: '',
  });

  if (!isOpen || !selectedGroups || selectedGroups.length === 0) return null;

  const handleToggleField = (field) => {
    setFieldsToEdit(prev => ({ ...prev, [field]: !prev[field] }));
  };

  const handleValueChange = (field, value) => {
    setValues(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    const updates = {};

    if (fieldsToEdit.author && values.author.trim()) {
      updates.author = values.author.trim();
    }
    if (fieldsToEdit.narrator && values.narrator.trim()) {
      updates.narrator = values.narrator.trim();
    }
    if (fieldsToEdit.genres && values.genres.trim()) {
      updates.genres = values.genres.split(',').map(g => g.trim()).filter(g => g).slice(0, 3);
    }
    if (fieldsToEdit.publisher && values.publisher.trim()) {
      updates.publisher = values.publisher.trim();
    }
    if (fieldsToEdit.language && values.language) {
      updates.language = values.language;
    }
    if (fieldsToEdit.year && values.year.trim()) {
      updates.year = values.year.trim();
    }
    if (fieldsToEdit.series) {
      updates.series = values.series.trim() || null;
      updates.sequence = values.sequence.trim() || null;
    }
    if (fieldsToEdit.age_rating && values.age_rating) {
      updates.age_rating = values.age_rating;
    }
    if (fieldsToEdit.content_rating && values.content_rating) {
      updates.content_rating = values.content_rating;
    }

    if (Object.keys(updates).length > 0) {
      onSave(updates);
    }
    onClose();
  };

  const hasAnyFieldSelected = Object.values(fieldsToEdit).some(v => v);

  // Get common values from selected groups
  const getCommonValue = (field) => {
    const uniqueValues = new Set(
      selectedGroups.map(g => {
        if (field === 'genres') {
          return g.metadata?.genres?.join(', ') || '';
        }
        return g.metadata?.[field] || '';
      }).filter(v => v)
    );
    return uniqueValues.size === 1 ? Array.from(uniqueValues)[0] : '';
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-xl shadow-2xl max-w-xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="p-6 border-b border-neutral-800 bg-gradient-to-r from-blue-900 to-indigo-50">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-100">Bulk Edit</h2>
              <div className="flex items-center gap-2 mt-1">
                <Users className="w-4 h-4 text-blue-600" />
                <span className="text-sm text-gray-400">
                  Editing {selectedGroups.length} book{selectedGroups.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-blue-100 rounded-lg transition-colors">
              <X className="w-6 h-6 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Info Banner */}
        <div className="px-6 py-3 bg-amber-50 border-b border-amber-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800">
            Check the fields you want to update. Only checked fields will be modified across all selected books.
          </p>
        </div>

        {/* Form */}
        <div className="overflow-y-auto max-h-[calc(90vh-280px)] p-6">
          <div className="space-y-4">
            {/* Author */}
            <div className={`p-4 rounded-lg border ${fieldsToEdit.author ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fieldsToEdit.author}
                  onChange={() => handleToggleField('author')}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-300">Author</span>
              </label>
              {fieldsToEdit.author && (
                <input
                  type="text"
                  value={values.author}
                  onChange={(e) => handleValueChange('author', e.target.value)}
                  placeholder={getCommonValue('author') || "Enter author name"}
                  className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              )}
            </div>

            {/* Narrator */}
            <div className={`p-4 rounded-lg border ${fieldsToEdit.narrator ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fieldsToEdit.narrator}
                  onChange={() => handleToggleField('narrator')}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-300">Narrator</span>
              </label>
              {fieldsToEdit.narrator && (
                <input
                  type="text"
                  value={values.narrator}
                  onChange={(e) => handleValueChange('narrator', e.target.value)}
                  placeholder={getCommonValue('narrator') || "Enter narrator name"}
                  className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              )}
            </div>

            {/* Series */}
            <div className={`p-4 rounded-lg border ${fieldsToEdit.series ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fieldsToEdit.series}
                  onChange={() => handleToggleField('series')}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-300">Series</span>
              </label>
              {fieldsToEdit.series && (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <input
                    type="text"
                    value={values.series}
                    onChange={(e) => handleValueChange('series', e.target.value)}
                    placeholder={getCommonValue('series') || "Series name"}
                    className="col-span-2 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <input
                    type="text"
                    value={values.sequence}
                    onChange={(e) => handleValueChange('sequence', e.target.value)}
                    placeholder="Book #"
                    className="px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              )}
            </div>

            {/* Genres */}
            <div className={`p-4 rounded-lg border ${fieldsToEdit.genres ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fieldsToEdit.genres}
                  onChange={() => handleToggleField('genres')}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-300">
                  Genres <span className="text-xs text-gray-400">(comma-separated, max 3)</span>
                </span>
              </label>
              {fieldsToEdit.genres && (
                <input
                  type="text"
                  value={values.genres}
                  onChange={(e) => handleValueChange('genres', e.target.value)}
                  placeholder={getCommonValue('genres') || "Fantasy, Adventure, Fiction"}
                  className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              )}
            </div>

            {/* Publisher */}
            <div className={`p-4 rounded-lg border ${fieldsToEdit.publisher ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fieldsToEdit.publisher}
                  onChange={() => handleToggleField('publisher')}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-300">Publisher</span>
              </label>
              {fieldsToEdit.publisher && (
                <input
                  type="text"
                  value={values.publisher}
                  onChange={(e) => handleValueChange('publisher', e.target.value)}
                  placeholder={getCommonValue('publisher') || "Enter publisher name"}
                  className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              )}
            </div>

            {/* Year & Language */}
            <div className="grid grid-cols-2 gap-4">
              <div className={`p-4 rounded-lg border ${fieldsToEdit.year ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fieldsToEdit.year}
                    onChange={() => handleToggleField('year')}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-300">Year</span>
                </label>
                {fieldsToEdit.year && (
                  <input
                    type="text"
                    value={values.year}
                    onChange={(e) => handleValueChange('year', e.target.value)}
                    placeholder="YYYY"
                    className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                )}
              </div>

              <div className={`p-4 rounded-lg border ${fieldsToEdit.language ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fieldsToEdit.language}
                    onChange={() => handleToggleField('language')}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-300">Language</span>
                </label>
                {fieldsToEdit.language && (
                  <select
                    value={values.language}
                    onChange={(e) => handleValueChange('language', e.target.value)}
                    className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select...</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="it">Italian</option>
                    <option value="pt">Portuguese</option>
                    <option value="ja">Japanese</option>
                    <option value="zh">Chinese</option>
                  </select>
                )}
              </div>
            </div>

            {/* Age Rating & Content Rating */}
            <div className="grid grid-cols-2 gap-4">
              <div className={`p-4 rounded-lg border ${fieldsToEdit.age_rating ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fieldsToEdit.age_rating}
                    onChange={() => handleToggleField('age_rating')}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-300">Age Rating</span>
                </label>
                {fieldsToEdit.age_rating && (
                  <select
                    value={values.age_rating}
                    onChange={(e) => handleValueChange('age_rating', e.target.value)}
                    className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select...</option>
                    <option value="Childrens">Children's</option>
                    <option value="Teens">Teens</option>
                    <option value="Young Adult">Young Adult</option>
                    <option value="Adult">Adult</option>
                  </select>
                )}
              </div>

              <div className={`p-4 rounded-lg border ${fieldsToEdit.content_rating ? 'border-blue-300 bg-blue-900/30' : 'border-neutral-800'}`}>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fieldsToEdit.content_rating}
                    onChange={() => handleToggleField('content_rating')}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-300">Content Rating</span>
                </label>
                {fieldsToEdit.content_rating && (
                  <select
                    value={values.content_rating}
                    onChange={(e) => handleValueChange('content_rating', e.target.value)}
                    className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select...</option>
                    <option value="G">G - General Audiences</option>
                    <option value="PG">PG - Parental Guidance</option>
                    <option value="PG-13">PG-13 - Parents Strongly Cautioned</option>
                    <option value="R">R - Restricted</option>
                    <option value="X">X - Adults Only</option>
                  </select>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-neutral-800 flex gap-3 justify-end bg-neutral-950">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-300 bg-neutral-900 border border-neutral-700 rounded-lg hover:bg-neutral-950 transition-colors font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasAnyFieldSelected}
            className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors ${
              hasAnyFieldSelected
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
            }`}
          >
            <Save className="w-4 h-4" />
            Apply to {selectedGroups.length} Book{selectedGroups.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
