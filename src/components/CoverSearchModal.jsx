import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { X, Download, Upload, Image as ImageIcon, Star, RefreshCw } from 'lucide-react';

export function CoverSearchModal({ isOpen, onClose, group, onCoverUpdated }) {
  const [searching, setSearching] = useState(false);
  const [options, setOptions] = useState([]);
  const [selectedUrl, setSelectedUrl] = useState(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (isOpen && group) {
      searchCovers();
    }
  }, [isOpen, group]);

  const searchCovers = async () => {
    setSearching(true);
    setOptions([]);
    try {
      const results = await invoke('search_cover_options', {
        title: group.metadata.title,
        author: group.metadata.author,
        isbn: group.metadata.isbn,
        asin: group.metadata.asin,
      });
      // Sort by quality score
      const sorted = results.sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));
      setOptions(sorted);
    } catch (error) {
      console.error('Cover search failed:', error);
    } finally {
      setSearching(false);
    }
  };

  const handleDownload = async (url, source) => {
    setDownloading(true);
    setSelectedUrl(url);
    try {
      await invoke('download_cover_from_url', {
        groupId: group.id,
        url,
        source: source || null,
      });
      onCoverUpdated();
      onClose();
    } catch (error) {
      console.error('Download failed:', error);
      alert('Failed to download cover: ' + error);
    } finally {
      setDownloading(false);
      setSelectedUrl(null);
    }
  };

  // Quality score badge color
  const getQualityColor = (score) => {
    if (score >= 80) return 'bg-green-100 text-green-800';
    if (score >= 60) return 'bg-blue-100 text-blue-800';
    if (score >= 40) return 'bg-yellow-100 text-yellow-800';
    return 'bg-gray-100 text-gray-800';
  };

  // Source icon/color
  const getSourceStyle = (source) => {
    const styles = {
      'iTunes': { bg: 'bg-pink-50', text: 'text-pink-700', icon: '🍎' },
      'Audible': { bg: 'bg-orange-50', text: 'text-orange-700', icon: '🎧' },
      'Amazon': { bg: 'bg-yellow-50', text: 'text-yellow-700', icon: '📦' },
      'Google Books': { bg: 'bg-blue-50', text: 'text-blue-700', icon: '📚' },
      'Open Library': { bg: 'bg-green-50', text: 'text-green-700', icon: '📖' },
    };
    // Check if source starts with any known prefix
    for (const [key, style] of Object.entries(styles)) {
      if (source && source.startsWith(key)) return style;
    }
    return { bg: 'bg-gray-50', text: 'text-gray-700', icon: '🖼️' };
  };

  const handleUploadCustom = async () => {
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

      await invoke('set_cover_from_file', {
        groupId: group.id,
        imagePath: selected,
      });
      onCoverUpdated();
      onClose();
    } catch (error) {
      console.error('Upload failed:', error);
      alert('Failed to upload cover: ' + error);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Find Cover Art</h2>
              <p className="text-sm text-gray-600 mt-1">{group?.metadata.title} by {group?.metadata.author}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={searchCovers}
                disabled={searching}
                className="p-2 hover:bg-blue-100 rounded-lg transition-colors"
                title="Refresh search"
              >
                <RefreshCw className={`w-5 h-5 text-gray-600 ${searching ? 'animate-spin' : ''}`} />
              </button>
              <button onClick={onClose} className="p-2 hover:bg-blue-100 rounded-lg transition-colors">
                <X className="w-6 h-6 text-gray-600" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {searching ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Searching iTunes, Audible, Google Books, Open Library...</p>
            </div>
          ) : options.length === 0 ? (
            <div className="text-center py-12">
              <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-600 mb-4">No covers found from online sources</p>
              <button onClick={handleUploadCustom} className="btn btn-primary flex items-center gap-2 mx-auto">
                <Upload className="w-4 h-4" />
                Upload Custom Cover
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>Found {options.length} cover options (sorted by quality)</span>
                {options[0]?.quality_score && (
                  <span className="flex items-center gap-1">
                    <Star className="w-4 h-4 text-yellow-500" />
                    Best: {options[0].quality_score}/100
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {options.map((option, idx) => {
                  const sourceStyle = getSourceStyle(option.source);
                  const isBest = idx === 0;

                  return (
                    <div
                      key={idx}
                      className={`border rounded-lg overflow-hidden hover:shadow-lg transition-shadow ${
                        isBest ? 'border-green-300 ring-2 ring-green-100' : 'border-gray-200'
                      }`}
                    >
                      <div className="aspect-square bg-gray-100 relative">
                        {isBest && (
                          <div className="absolute top-2 left-2 bg-green-500 text-white text-xs px-2 py-1 rounded font-medium z-10">
                            Best Match
                          </div>
                        )}
                        <img
                          src={option.url}
                          alt="Cover preview"
                          className="w-full h-full object-contain"
                          loading="lazy"
                          onError={(e) => {
                            e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23f3f4f6" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999" font-size="14"%3EFailed to load%3C/text%3E%3C/svg%3E';
                          }}
                        />
                      </div>
                      <div className="p-3 bg-white">
                        <div className="flex items-start justify-between mb-2">
                          <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${sourceStyle.bg} ${sourceStyle.text}`}>
                            <span>{sourceStyle.icon}</span>
                            <span>{option.source}</span>
                          </div>
                          {option.quality_score > 0 && (
                            <div className={`px-2 py-1 rounded text-xs font-medium ${getQualityColor(option.quality_score)}`}>
                              {option.quality_score}/100
                            </div>
                          )}
                        </div>
                        <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
                          <span>{option.size_estimate}</span>
                          {option.width > 0 && <span>{option.width}×{option.height}</span>}
                        </div>
                        {option.book_title && option.book_title !== group?.metadata.title && (
                          <div className="text-xs text-gray-500 mb-2 truncate" title={option.book_title}>
                            {option.book_title}
                          </div>
                        )}
                        <button
                          onClick={() => handleDownload(option.url, option.source)}
                          disabled={downloading}
                          className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                            downloading && selectedUrl === option.url
                              ? 'bg-gray-300 cursor-not-allowed text-gray-500'
                              : isBest
                                ? 'bg-green-600 hover:bg-green-700 text-white'
                                : 'bg-blue-600 hover:bg-blue-700 text-white'
                          }`}
                        >
                          {downloading && selectedUrl === option.url ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                              Downloading...
                            </>
                          ) : (
                            <>
                              <Download className="w-4 h-4" />
                              {isBest ? 'Use Best Cover' : 'Use This Cover'}
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-gray-200 pt-6">
                <button
                  onClick={handleUploadCustom}
                  className="w-full px-4 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  Upload Custom Cover Instead
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}