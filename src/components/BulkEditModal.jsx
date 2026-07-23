// src/components/BulkEditModal.jsx
import { useState, useEffect } from 'react';
import { X, Save, Users, AlertCircle } from 'lucide-react';
import { computeBulkUpdates } from '../lib/bulkEditUpdates';

// Compute the value shared by every selected group for a field, or '' if they
// differ. Used both to prefill inputs (M10) and to skip no-op writes (H1).
function commonValueOf(selectedGroups, field) {
  const uniqueValues = new Set(
    selectedGroups.map(g => {
      if (field === 'genres') {
        return g.metadata?.genres?.join(', ') || '';
      }
      return g.metadata?.[field] != null ? String(g.metadata[field]) : '';
    }).filter(v => v)
  );
  return uniqueValues.size === 1 ? Array.from(uniqueValues)[0] : '';
}

// H1: a per-field "Clear" toggle. Rendered as a sibling of the field's main
// checkbox (not nested inside its <label>) so clicking Clear doesn't also flip
// the field-enable checkbox.
function ClearToggle({ active, checked, onToggle }) {
  if (!active) return null;
  return (
    <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-500 hover:text-gray-300 flex-shrink-0">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={onToggle}
        className="w-3.5 h-3.5 text-red-500 rounded focus:ring-red-500"
      />
      Clear
    </label>
  );
}

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

  // H1: per-field "clear" flags. A checked field left blank is a SKIP; only an
  // explicit clear intentionally wipes the value across the selection.
  const [clearFields, setClearFields] = useState({});

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

  // M10: prefill inputs with the common value when the modal opens (was shown
  // only as a placeholder before, so the value never survived to save).
  useEffect(() => {
    if (!isOpen || !selectedGroups || selectedGroups.length === 0) return;
    setValues({
      author: commonValueOf(selectedGroups, 'author'),
      narrator: commonValueOf(selectedGroups, 'narrator'),
      genres: commonValueOf(selectedGroups, 'genres'),
      publisher: commonValueOf(selectedGroups, 'publisher'),
      language: commonValueOf(selectedGroups, 'language'),
      year: commonValueOf(selectedGroups, 'year'),
      series: commonValueOf(selectedGroups, 'series'),
      sequence: commonValueOf(selectedGroups, 'sequence'),
      age_rating: commonValueOf(selectedGroups, 'age_rating'),
      content_rating: commonValueOf(selectedGroups, 'content_rating'),
    });
    setFieldsToEdit({
      author: false, narrator: false, genres: false, publisher: false,
      language: false, year: false, series: false, age_rating: false, content_rating: false,
    });
    setClearFields({});
  }, [isOpen, selectedGroups]);

  if (!isOpen || !selectedGroups || selectedGroups.length === 0) return null;

  const getCommonValue = (field) => commonValueOf(selectedGroups, field);

  const handleToggleField = (field) => {
    setFieldsToEdit(prev => ({ ...prev, [field]: !prev[field] }));
  };

  const handleToggleClear = (field) => {
    setClearFields(prev => ({ ...prev, [field]: !prev[field] }));
  };

  const handleValueChange = (field, value) => {
    setValues(prev => ({ ...prev, [field]: value }));
  };

  // H1/M10: precedence per field = clear > non-empty-and-changed > skip.
  // Delegated to a pure helper so the semantics are unit-tested.
  const handleSave = () => {
    const commonValues = {
      author: getCommonValue('author'),
      narrator: getCommonValue('narrator'),
      publisher: getCommonValue('publisher'),
      year: getCommonValue('year'),
      language: getCommonValue('language'),
      age_rating: getCommonValue('age_rating'),
      content_rating: getCommonValue('content_rating'),
      genres: getCommonValue('genres'),
      series: getCommonValue('series'),
      sequence: getCommonValue('sequence'),
    };
    const updates = computeBulkUpdates({ fieldsToEdit, clearFields, values, commonValues });

    if (Object.keys(updates).length > 0) {
      onSave(updates);
    }
    onClose();
  };

  const hasAnyFieldSelected = Object.values(fieldsToEdit).some(v => v);

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
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="text"
                    value={clearFields.author ? '' : values.author}
                    disabled={clearFields.author}
                    onChange={(e) => handleValueChange('author', e.target.value)}
                    placeholder={clearFields.author ? 'Will be cleared' : 'Enter author name'}
                    className="flex-1 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                  />
                  <ClearToggle active={fieldsToEdit.author} checked={clearFields.author} onToggle={() => handleToggleClear('author')} />
                </div>
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
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="text"
                    value={clearFields.narrator ? '' : values.narrator}
                    disabled={clearFields.narrator}
                    onChange={(e) => handleValueChange('narrator', e.target.value)}
                    placeholder={clearFields.narrator ? 'Will be cleared' : 'Enter narrator name'}
                    className="flex-1 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                  />
                  <ClearToggle active={fieldsToEdit.narrator} checked={clearFields.narrator} onToggle={() => handleToggleClear('narrator')} />
                </div>
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
                <>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <input
                      type="text"
                      value={clearFields.series ? '' : values.series}
                      disabled={clearFields.series}
                      onChange={(e) => handleValueChange('series', e.target.value)}
                      placeholder={clearFields.series ? 'Will be cleared' : 'Series name'}
                      className="col-span-2 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                    />
                    <input
                      type="text"
                      value={clearFields.series ? '' : values.sequence}
                      disabled={clearFields.series}
                      onChange={(e) => handleValueChange('sequence', e.target.value)}
                      placeholder="Book #"
                      className="px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                    />
                  </div>
                  <div className="mt-2 flex justify-end">
                    <ClearToggle active={fieldsToEdit.series} checked={clearFields.series} onToggle={() => handleToggleClear('series')} />
                  </div>
                </>
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
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="text"
                    value={clearFields.genres ? '' : values.genres}
                    disabled={clearFields.genres}
                    onChange={(e) => handleValueChange('genres', e.target.value)}
                    placeholder={clearFields.genres ? 'Will be cleared' : 'Fantasy, Adventure, Fiction'}
                    className="flex-1 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                  />
                  <ClearToggle active={fieldsToEdit.genres} checked={clearFields.genres} onToggle={() => handleToggleClear('genres')} />
                </div>
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
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="text"
                    value={clearFields.publisher ? '' : values.publisher}
                    disabled={clearFields.publisher}
                    onChange={(e) => handleValueChange('publisher', e.target.value)}
                    placeholder={clearFields.publisher ? 'Will be cleared' : 'Enter publisher name'}
                    className="flex-1 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                  />
                  <ClearToggle active={fieldsToEdit.publisher} checked={clearFields.publisher} onToggle={() => handleToggleClear('publisher')} />
                </div>
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
                  <>
                    <input
                      type="text"
                      value={clearFields.year ? '' : values.year}
                      disabled={clearFields.year}
                      onChange={(e) => handleValueChange('year', e.target.value)}
                      placeholder={clearFields.year ? 'Will be cleared' : 'YYYY'}
                      className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                    />
                    <div className="mt-2 flex justify-end">
                      <ClearToggle active={fieldsToEdit.year} checked={clearFields.year} onToggle={() => handleToggleClear('year')} />
                    </div>
                  </>
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
                  <>
                  <select
                    value={clearFields.language ? '' : values.language}
                    disabled={clearFields.language}
                    onChange={(e) => handleValueChange('language', e.target.value)}
                    className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
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
                  <div className="mt-2 flex justify-end">
                    <ClearToggle active={fieldsToEdit.language} checked={clearFields.language} onToggle={() => handleToggleClear('language')} />
                  </div>
                  </>
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
                  <>
                  <select
                    value={clearFields.age_rating ? '' : values.age_rating}
                    disabled={clearFields.age_rating}
                    onChange={(e) => handleValueChange('age_rating', e.target.value)}
                    className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                  >
                    <option value="">Select...</option>
                    <option value="Childrens">Children's</option>
                    <option value="Teens">Teens</option>
                    <option value="Young Adult">Young Adult</option>
                    <option value="Adult">Adult</option>
                  </select>
                  <div className="mt-2 flex justify-end">
                    <ClearToggle active={fieldsToEdit.age_rating} checked={clearFields.age_rating} onToggle={() => handleToggleClear('age_rating')} />
                  </div>
                  </>
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
                  <>
                  <select
                    value={clearFields.content_rating ? '' : values.content_rating}
                    disabled={clearFields.content_rating}
                    onChange={(e) => handleValueChange('content_rating', e.target.value)}
                    className="w-full mt-3 px-3 py-2 text-sm border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                  >
                    <option value="">Select...</option>
                    <option value="G">G - General Audiences</option>
                    <option value="PG">PG - Parental Guidance</option>
                    <option value="PG-13">PG-13 - Parents Strongly Cautioned</option>
                    <option value="R">R - Restricted</option>
                    <option value="X">X - Adults Only</option>
                  </select>
                  <div className="mt-2 flex justify-end">
                    <ClearToggle active={fieldsToEdit.content_rating} checked={clearFields.content_rating} onToggle={() => handleToggleClear('content_rating')} />
                  </div>
                  </>
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
