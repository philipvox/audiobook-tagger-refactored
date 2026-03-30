// src/components/EditMetadataModal.jsx
import { useState } from 'react';
import { X, Save, Library, Type, Loader2, Users } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

export function EditMetadataModal({ isOpen, onClose, onSave, metadata, groupName, folderPath }) {
  const [editedMetadata, setEditedMetadata] = useState(metadata);
  const [isFixingTitle, setIsFixingTitle] = useState(false);
  const [isFixingSeries, setIsFixingSeries] = useState(false);
  const [isLookingUpAge, setIsLookingUpAge] = useState(false);
  const [fixError, setFixError] = useState(null);

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

  // Fix title/author/subtitle only (no series)
  const handleFixTitle = async () => {
    setIsFixingTitle(true);
    setFixError(null);

    try {
      const result = await invoke('resolve_title', {
        request: {
          filename: null,
          folder_name: groupName,
          folder_path: folderPath,
          current_title: editedMetadata.title,
          current_author: editedMetadata.author,
          current_series: editedMetadata.series,
          current_sequence: editedMetadata.sequence,
          additional_context: null
        }
      });

      if (result.success && result.result) {
        const r = result.result;
        setEditedMetadata(prev => ({
          ...prev,
          title: r.title || prev.title,
          author: r.author || prev.author,
          subtitle: r.subtitle || prev.subtitle
          // Note: series/sequence are NOT updated here - use Fix Series button
        }));
      } else if (result.error) {
        setFixError(result.error);
      }
    } catch (err) {
      setFixError(err.toString());
    } finally {
      setIsFixingTitle(false);
    }
  };

  // Fix series name and book number using Audible + GPT
  const handleFixSeries = async () => {
    setIsFixingSeries(true);
    setFixError(null);

    try {
      const result = await invoke('resolve_series', {
        request: {
          title: editedMetadata.title,
          author: editedMetadata.author,
          current_series: editedMetadata.series,
          current_sequence: editedMetadata.sequence
        }
      });

      if (result.success && result.result) {
        const r = result.result;
        setEditedMetadata(prev => ({
          ...prev,
          series: r.series || prev.series,
          sequence: r.sequence || prev.sequence
        }));
      } else if (result.error) {
        setFixError(result.error);
      }
    } catch (err) {
      setFixError(err.toString());
    } finally {
      setIsFixingSeries(false);
    }
  };

  // Lookup age rating via web search (Goodreads, etc.)
  const handleLookupAge = async () => {
    setIsLookingUpAge(true);
    setFixError(null);

    try {
      const result = await invoke('resolve_book_age_rating', {
        request: {
          title: editedMetadata.title,
          author: editedMetadata.author,
          series: editedMetadata.series,
          description: editedMetadata.description,
          genres: editedMetadata.genres || [],
          publisher: editedMetadata.publisher || null,
        }
      });

      if (result.success) {
        // Update genres with age category if it's a children's/YA book
        let newGenres = [...(editedMetadata.genres || [])];
        const ageCategory = result.age_category;

        // Add age-specific genre if applicable
        if (ageCategory && ageCategory !== 'Adult') {
          // Remove any existing age genres first
          newGenres = newGenres.filter(g =>
            !g.startsWith("Children's") &&
            g !== "Teen 13-17" &&
            g !== "Young Adult" &&
            g !== "Middle Grade"
          );
          // Add the new age genre
          if (!newGenres.includes(ageCategory)) {
            newGenres.splice(1, 0, ageCategory); // Insert after primary genre
          }
        }

        setEditedMetadata(prev => ({
          ...prev,
          genres: newGenres,
          age_rating: ageCategory,
          content_rating: result.content_rating
        }));

        // Show the reasoning as a success message
        if (result.reasoning) {
          setFixError(`✓ ${ageCategory}: ${result.reasoning}`);
        }
      } else if (result.error) {
        setFixError(result.error);
      }
    } catch (err) {
      setFixError(err.toString());
    } finally {
      setIsLookingUpAge(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden">
        <div className="p-6 border-b border-neutral-800">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-100">Edit Metadata</h2>
              <p className="text-sm text-gray-400 mt-1">{groupName}</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <X className="w-6 h-6 text-gray-400" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto max-h-[calc(90vh-180px)] p-6">
          <div className="space-y-4">
            {/* AI Fix Buttons - separate title and series resolution */}
            <div className="bg-gradient-to-r from-neutral-800/80 to-neutral-800/40 rounded-xl p-4 border border-neutral-700/50">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                AI-Powered Fixes
              </div>
              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={handleFixTitle}
                  disabled={isFixingTitle || isFixingSeries || isLookingUpAge}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all duration-200
                    bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 hover:border-blue-500/50
                    disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600/20"
                  title="Fix title, author, and subtitle"
                >
                  {isFixingTitle ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Fixing...</span>
                    </>
                  ) : (
                    <>
                      <Type className="w-4 h-4" />
                      <span>Fix Title</span>
                    </>
                  )}
                </button>
                <button
                  onClick={handleFixSeries}
                  disabled={isFixingTitle || isFixingSeries || isLookingUpAge}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all duration-200
                    bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 border border-purple-500/30 hover:border-purple-500/50
                    disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-purple-600/20"
                  title="Look up series name and book number via Audible"
                >
                  {isFixingSeries ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Looking up...</span>
                    </>
                  ) : (
                    <>
                      <Library className="w-4 h-4" />
                      <span>Fix Series</span>
                    </>
                  )}
                </button>
                <button
                  onClick={handleLookupAge}
                  disabled={isFixingTitle || isFixingSeries || isLookingUpAge}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all duration-200
                    bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-500/30 hover:border-green-500/50
                    disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-green-600/20"
                  title="Search web for age rating (Goodreads, etc.)"
                >
                  {isLookingUpAge ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Searching...</span>
                    </>
                  ) : (
                    <>
                      <Users className="w-4 h-4" />
                      <span>Lookup Age</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {fixError && (
              <div className={`rounded-lg p-3 text-sm ${
                fixError.startsWith('✓')
                  ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
              }`}>
                {fixError}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Title</label>
              <input
                type="text"
                value={editedMetadata.title}
                onChange={(e) => updateField('title', e.target.value)}
                className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Subtitle</label>
              <input
                type="text"
                value={editedMetadata.subtitle || ''}
                onChange={(e) => updateField('subtitle', e.target.value || null)}
                placeholder="Optional"
                className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Author</label>
              <input
                type="text"
                value={editedMetadata.author}
                onChange={(e) => updateField('author', e.target.value)}
                className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Narrator</label>
              <input
                type="text"
                value={editedMetadata.narrator || ''}
                onChange={(e) => updateField('narrator', e.target.value || null)}
                placeholder="Optional"
                className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Series</label>
                <input
                  type="text"
                  value={editedMetadata.series || ''}
                  onChange={(e) => updateField('series', e.target.value || null)}
                  placeholder="Optional"
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Book Number</label>
                <input
                  type="text"
                  value={editedMetadata.sequence || ''}
                  onChange={(e) => updateField('sequence', e.target.value || null)}
                  placeholder="Optional"
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Genres <span className="text-gray-400 text-xs">(comma-separated, max 3)</span>
              </label>
              <input
                type="text"
                value={editedMetadata.genres.join(', ')}
                onChange={(e) => updateGenres(e.target.value)}
                placeholder="Fiction, Fantasy, Adventure"
                className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Publisher</label>
                <input
                  type="text"
                  value={editedMetadata.publisher || ''}
                  onChange={(e) => updateField('publisher', e.target.value || null)}
                  placeholder="Optional"
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Year</label>
                <input
                  type="text"
                  value={editedMetadata.year || ''}
                  onChange={(e) => updateField('year', e.target.value || null)}
                  placeholder="YYYY"
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Description</label>
              <textarea
                value={editedMetadata.description || ''}
                onChange={(e) => updateField('description', e.target.value || null)}
                rows={4}
                placeholder="Optional"
                className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">ISBN</label>
                <input
                  type="text"
                  value={editedMetadata.isbn || ''}
                  onChange={(e) => updateField('isbn', e.target.value || null)}
                  placeholder="Optional"
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">ASIN</label>
                <input
                  type="text"
                  value={editedMetadata.asin || ''}
                  onChange={(e) => updateField('asin', e.target.value || null)}
                  placeholder="Optional"
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Language</label>
                <select
                  value={editedMetadata.language || ''}
                  onChange={(e) => updateField('language', e.target.value || null)}
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
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
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Runtime (min)</label>
                <input
                  type="number"
                  value={editedMetadata.runtime_minutes || ''}
                  onChange={(e) => updateField('runtime_minutes', e.target.value ? parseInt(e.target.value) : null)}
                  placeholder="Minutes"
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                />
              </div>
              <div className="flex items-center pt-7">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editedMetadata.abridged === true}
                    onChange={(e) => updateField('abridged', e.target.checked ? true : null)}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-300">Abridged</span>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Age Rating</label>
                <select
                  value={editedMetadata.age_rating || ''}
                  onChange={(e) => updateField('age_rating', e.target.value || null)}
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                >
                  <option value="">Select...</option>
                  <option value="Childrens">Children's</option>
                  <option value="Teens">Teens</option>
                  <option value="Young Adult">Young Adult</option>
                  <option value="Adult">Adult</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Content Rating</label>
                <select
                  value={editedMetadata.content_rating || ''}
                  onChange={(e) => updateField('content_rating', e.target.value || null)}
                  className="w-full px-4 py-2 bg-neutral-800 text-gray-100 border border-neutral-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-500"
                >
                  <option value="">Select...</option>
                  <option value="G">G - General Audiences</option>
                  <option value="PG">PG - Parental Guidance</option>
                  <option value="PG-13">PG-13 - Parents Strongly Cautioned</option>
                  <option value="R">R - Restricted</option>
                  <option value="X">X - Adults Only</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-neutral-800 flex gap-3 justify-end">
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