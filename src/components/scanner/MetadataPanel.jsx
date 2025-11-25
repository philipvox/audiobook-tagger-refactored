import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Book, Edit, Upload, RefreshCw, Download, X, Image as ImageIcon } from 'lucide-react';

export function MetadataPanel({ group, onEdit }) {
  const [coverData, setCoverData] = useState(null);
  const [coverUrl, setCoverUrl] = useState(null);
  const [showCoverSearch, setShowCoverSearch] = useState(false);
  const [coverOptions, setCoverOptions] = useState([]);
  const [searchingCovers, setSearchingCovers] = useState(false);
  const [downloadingCover, setDownloadingCover] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  
  // Track blob URL for cleanup
  const blobUrlRef = useRef(null);

  // Cleanup blob URL when component unmounts or cover changes
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  // Load cover when group changes
  useEffect(() => {
    if (group) {
      loadCover();
    } else {
      // Cleanup when no group
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setCoverUrl(null);
      setCoverData(null);
    }
  }, [group?.id, refreshTrigger]);

  const loadCover = async () => {
    // Cleanup previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setCoverUrl(null);
    
    try {
      const cover = await invoke('get_cover_for_group', {
        groupId: group.id,
      });
      setCoverData(cover);
      
      // Create blob URL only once
      if (cover && cover.data) {
        try {
          const blob = new Blob([new Uint8Array(cover.data)], { type: cover.mime_type || 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          setCoverUrl(url);
        } catch (error) {
          console.error('Error creating cover URL:', error);
        }
      }
    } catch (error) {
      console.error('Failed to load cover:', error);
      setCoverData(null);
    }
  };

  const handleSearchCovers = async () => {
    setShowCoverSearch(true);
    setSearchingCovers(true);
    setCoverOptions([]);
    
    try {
      const results = await invoke('search_cover_options', {
        title: group.metadata.title,
        author: group.metadata.author,
        isbn: group.metadata.isbn,
      });
      setCoverOptions(results);
    } catch (error) {
      console.error('Cover search failed:', error);
    } finally {
      setSearchingCovers(false);
    }
  };

  const handleDownloadCover = async (url) => {
    setDownloadingCover(true);
    setSelectedUrl(url);
    
    try {
      await invoke('download_cover_from_url', {
        groupId: group.id,
        url,
      });
      setRefreshTrigger(prev => prev + 1);
      setShowCoverSearch(false);
      setCoverOptions([]);
    } catch (error) {
      console.error('Download failed:', error);
      alert('Failed to download cover: ' + error);
    } finally {
      setDownloadingCover(false);
      setSelectedUrl(null);
    }
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

      await invoke('set_cover_from_file', {
        groupId: group.id,
        imagePath: selected,
      });
      
      setRefreshTrigger(prev => prev + 1);
      setShowCoverSearch(false);
    } catch (error) {
      console.error('Upload failed:', error);
      alert('Failed to upload cover: ' + error);
    }
  };

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
                <div className="aspect-[2/3] bg-gradient-to-br from-gray-100 to-gray-200 rounded-2xl shadow-xl overflow-hidden border-4 border-white ring-1 ring-gray-200 relative">
                  {coverUrl ? (
                    <>
                      <img 
                        src={coverUrl} 
                        alt={`${metadata.title} cover`}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          console.error('Failed to load cover image');
                          e.target.style.display = 'none';
                        }}
                      />
                      {coverData && (
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent text-white text-xs px-3 py-2">
                          <div className="flex justify-between items-center">
                            <span className="font-medium">{coverData.size_kb} KB</span>
                            {coverData.width && coverData.height && (
                              <span className="text-white/80">{coverData.width}×{coverData.height}</span>
                            )}
                          </div>
                        </div>
                      )}
                    </>
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
                    onClick={handleSearchCovers}
                    className="w-full px-4 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-xl transition-all font-medium flex items-center justify-center gap-2 shadow-sm hover:shadow-md"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Find Better Cover
                  </button>
                  
                  <button
                    onClick={handleUploadCover}
                    className="w-full px-4 py-2.5 bg-white hover:bg-gray-50 text-gray-700 rounded-xl transition-all font-medium flex items-center justify-center gap-2 shadow-sm border border-gray-200 hover:shadow-md"
                  >
                    <Upload className="w-4 h-4" />
                    Upload Custom Cover
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Cover Search Modal */}
      {showCoverSearch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">Find Better Cover</h2>
                  <p className="text-sm text-gray-600 mt-1">{metadata.title}</p>
                </div>
                <button 
                  onClick={() => {
                    setShowCoverSearch(false);
                    setCoverOptions([]);
                  }} 
                  className="p-2 hover:bg-blue-100 rounded-lg transition-colors"
                >
                  <X className="w-6 h-6 text-gray-600" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {searchingCovers ? (
                <div className="text-center py-12">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                  <p className="text-gray-600">Searching for covers...</p>
                </div>
              ) : coverOptions.length === 0 ? (
                <div className="text-center py-12">
                  <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-600 mb-4">No covers found from online sources</p>
                  <button 
                    onClick={handleUploadCover} 
                    className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2 mx-auto"
                  >
                    <Upload className="w-4 h-4" />
                    Upload Custom Cover
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {coverOptions.map((option, idx) => (
                      <div 
                        key={idx} 
                        className="group border border-gray-200 rounded-lg overflow-hidden hover:shadow-xl hover:border-blue-300 transition-all bg-white"
                      >
                        <div className="aspect-[2/3] bg-gray-100 relative overflow-hidden">
                          <img
                            src={option.url}
                            alt="Cover preview"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            loading="lazy"
                            onError={(e) => {
                              e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="300"%3E%3Crect fill="%23ddd" width="200" height="300"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999" font-size="14"%3ENo Image%3C/text%3E%3C/svg%3E';
                            }}
                          />
                          
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center p-3">
                            <button
                              onClick={() => handleDownloadCover(option.url)}
                              disabled={downloadingCover && selectedUrl === option.url}
                              className="w-full px-3 py-2 bg-white hover:bg-gray-100 text-gray-900 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 text-sm"
                            >
                              {downloadingCover && selectedUrl === option.url ? (
                                <>
                                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-900"></div>
                                  <span>Downloading...</span>
                                </>
                              ) : (
                                <>
                                  <Download className="w-3 h-3" />
                                  <span>Use This</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                        
                        <div className="p-3 bg-white">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold text-gray-900 truncate">
                              {option.source}
                            </span>
                            {option.width > 0 && (
                              <span className="text-xs text-gray-500">
                                {option.width}×{option.height}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-600">
                            {option.size_estimate}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-gray-200 pt-6 mt-6">
                    <button
                      onClick={handleUploadCover}
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
      )}
    </div>
  );
}