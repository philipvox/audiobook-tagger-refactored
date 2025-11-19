import { Book, Edit, Upload, RefreshCw } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';

export function MetadataPanel({ group, onEdit }) {
  const [refreshingCover, setRefreshingCover] = useState(false);
  
  if (!group) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-6">
          <div className="bg-white rounded-2xl p-8 border border-gray-200 shadow-sm">
            <Book className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Select a Book</h3>
            <p className="text-gray-600 text-sm">Choose a book from the list to view its metadata and processing details.</p>
          </div>
        </div>
      </div>
    );
  }

  const metadata = group.metadata;
  
  // Convert cover data to displayable URL
  const getCoverUrl = () => {
    if (metadata.cover_data && Array.isArray(metadata.cover_data)) {
      try {
        const base64 = btoa(
          new Uint8Array(metadata.cover_data)
            .reduce((data, byte) => data + String.fromCharCode(byte), '')
        );
        const mimeType = metadata.cover_mime || 'image/jpeg';
        return `data:${mimeType};base64,${base64}`;
      } catch (error) {
        console.error('Error converting cover data:', error);
        return metadata.cover_url;
      }
    }
    return metadata.cover_url;
  };

  const handleUploadCover = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{
          name: 'Images',
          extensions: ['jpg', 'jpeg', 'png', 'webp']
        }]
      });

      if (!selected) return;

      // Read the image file and update metadata
      const result = await invoke('set_cover_from_file', {
        groupId: group.id,
        imagePath: selected
      });

      if (result.success) {
        alert('Cover updated! Rescan to see changes.');
      }
    } catch (error) {
      console.error('Upload cover error:', error);
      alert('Failed to upload cover: ' + error);
    }
  };

  const handleRefreshCover = async () => {
    try {
      setRefreshingCover(true);
      
      const result = await invoke('fetch_better_cover', {
        groupId: group.id,
        title: metadata.title,
        author: metadata.author,
        isbn: metadata.isbn
      });

      if (result.success) {
        alert('Cover refreshed! Rescan to see the updated image.');
      } else {
        alert('No better cover found.');
      }
    } catch (error) {
      console.error('Refresh cover error:', error);
      alert('Failed to refresh cover: ' + error);
    } finally {
      setRefreshingCover(false);
    }
  };

  const coverUrl = getCoverUrl();

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-gradient-to-br from-gray-50 to-white">
      <div className="max-w-6xl mx-auto">
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden border border-gray-100">
          {/* Header with Edit Button */}
          <div className="px-8 pt-8 pb-6 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h1 className="text-4xl font-bold text-gray-900 leading-tight mb-2">
                  {metadata.title || 'Untitled'}
                </h1>
                {metadata.subtitle && (
                  <p className="text-xl text-gray-600 mt-2">{metadata.subtitle}</p>
                )}
              </div>
              {onEdit && (
                <button
                  onClick={() => onEdit(group)}
                  className="ml-6 px-5 py-2.5 bg-white hover:bg-gray-50 text-gray-700 rounded-xl transition-all font-medium flex items-center gap-2 shadow-sm border border-gray-200 hover:shadow-md"
                >
                  <Edit className="w-4 h-4" />
                  Edit
                </button>
              )}
            </div>
          </div>

          {/* Main Content Area */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 p-8">
            {/* Left Column - Main Info (2/3 width) */}
            <div className="lg:col-span-2 space-y-8">
              {/* Author and Year */}
              <div className="flex flex-wrap items-center gap-4 text-base">
                <div>
                  <span className="text-gray-500">by </span>
                  <span className="font-semibold text-gray-900">{metadata.author || 'Unknown Author'}</span>
                </div>
                {metadata.year && (
                  <span className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm font-medium">
                    {metadata.year}
                  </span>
                )}
                {group && (
                  <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium">
                    {group.files.length} file{group.files.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              {/* Series */}
              {metadata.series && (
                <div className="space-y-3">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Series</div>
                  <div className="inline-flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200">
                    <Book className="w-5 h-5 text-indigo-600" />
                    <span className="font-semibold text-gray-900 text-lg">{metadata.series}</span>
                    {metadata.sequence && (
                      <span className="ml-1 px-2.5 py-0.5 bg-indigo-600 text-white text-sm font-bold rounded-full">
                        #{metadata.sequence}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Narrator */}
              {metadata.narrator && (
                <div className="space-y-3">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Narrated by</div>
                  <p className="text-lg font-medium text-gray-900">{metadata.narrator}</p>
                </div>
              )}

              {/* Genres */}
              {metadata.genres && metadata.genres.length > 0 && (
                <div className="space-y-3">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Genres</div>
                  <div className="flex flex-wrap gap-2">
                    {metadata.genres.map((genre, idx) => (
                      <span key={idx} className="inline-flex items-center px-4 py-2 bg-gradient-to-r from-gray-800 to-gray-900 text-white text-sm font-semibold rounded-full shadow-sm hover:shadow-md transition-shadow">
                        {genre}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Description */}
              {metadata.description && (
                <div className="space-y-3">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">About</div>
                  <div className="prose prose-sm max-w-none">
                    <p className="text-gray-700 leading-relaxed whitespace-pre-wrap">
                      {metadata.description}
                    </p>
                  </div>
                </div>
              )}

              {/* Publisher & ISBN */}
              {(metadata.publisher || metadata.isbn) && (
                <div className="pt-6 border-t border-gray-200">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    {metadata.publisher && (
                      <div className="space-y-1">
                        <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Publisher</div>
                        <div className="text-gray-900 font-medium">{metadata.publisher}</div>
                      </div>
                    )}
                    {metadata.isbn && (
                      <div className="space-y-1">
                        <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">ISBN</div>
                        <div className="text-gray-900 font-mono text-sm">{metadata.isbn}</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* File Details */}
              {group && group.files && group.files.length > 0 && (
                <div className="pt-6 border-t border-gray-200">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
                    Files ({group.files.length})
                  </div>
                  <div className="space-y-2">
                    {group.files.slice(0, 5).map((file, idx) => (
                      <div key={idx} className="text-sm text-gray-600 truncate font-mono bg-gray-50 px-3 py-2 rounded-lg border border-gray-100">
                        {file.filename}
                      </div>
                    ))}
                    {group.files.length > 5 && (
                      <div className="text-sm text-gray-500 italic pl-3">
                        + {group.files.length - 5} more files
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Right Column - Cover Art */}
            <div className="lg:col-span-1">
              <div className="sticky top-6 space-y-4">
                <div className="aspect-[2/3] bg-gradient-to-br from-gray-100 to-gray-200 rounded-2xl shadow-xl overflow-hidden border-4 border-white ring-1 ring-gray-200">
                  {coverUrl ? (
                    <img 
                      src={coverUrl} 
                      alt={`${metadata.title} cover`}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        console.error('Failed to load cover image');
                        e.target.style.display = 'none';
                        const fallback = document.createElement('div');
                        fallback.className = 'w-full h-full flex flex-col items-center justify-center p-6';
                        fallback.innerHTML = '<svg class="w-20 h-20 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg><p class="text-center text-sm text-gray-500 font-medium">Cover Not Available</p>';
                        e.target.parentElement.appendChild(fallback);
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center p-6">
                      <Book className="w-20 h-20 text-gray-400 mb-4" />
                      <p className="text-center text-sm text-gray-500 font-medium">No Cover Available</p>
                    </div>
                  )}
                </div>

                {/* Cover Management Buttons */}
                <div className="space-y-2">
                  <button
                    onClick={handleRefreshCover}
                    disabled={refreshingCover}
                    className="w-full px-4 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-xl transition-all font-medium flex items-center justify-center gap-2 shadow-sm hover:shadow-md disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${refreshingCover ? 'animate-spin' : ''}`} />
                    {refreshingCover ? 'Searching...' : 'Find Better Cover'}
                  </button>
                  
                  <button
                    onClick={handleUploadCover}
                    className="w-full px-4 py-2.5 bg-white hover:bg-gray-50 text-gray-700 rounded-xl transition-all font-medium flex items-center justify-center gap-2 shadow-sm border border-gray-200 hover:shadow-md"
                  >
                    <Upload className="w-4 h-4" />
                    Upload Custom Cover
                  </button>
                </div>

                <p className="text-xs text-gray-500 text-center">
                  Changes require rescanning to take effect
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}