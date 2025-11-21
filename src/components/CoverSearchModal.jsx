import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { X, Download, Upload, Image as ImageIcon } from 'lucide-react';

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
    try {
      const results = await invoke('search_cover_options', {
        title: group.metadata.title,
        author: group.metadata.author,
        isbn: group.metadata.isbn,
      });
      setOptions(results);
    } catch (error) {
      console.error('Cover search failed:', error);
    } finally {
      setSearching(false);
    }
  };

  const handleDownload = async (url) => {
    setDownloading(true);
    setSelectedUrl(url);
    try {
      await invoke('download_cover_from_url', {
        groupId: group.id,
        url,
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
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Find Better Cover</h2>
              <p className="text-sm text-gray-600 mt-1">{group?.metadata.title}</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-blue-100 rounded-lg transition-colors">
              <X className="w-6 h-6 text-gray-600" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {searching ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Searching for covers...</p>
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {options.map((option, idx) => (
                  <div key={idx} className="border border-gray-200 rounded-lg overflow-hidden hover:shadow-lg transition-shadow">
                    <div className="aspect-[2/3] bg-gray-100 relative">
                      <img
                        src={option.url}
                        alt="Cover preview"
                        className="w-full h-full object-contain"
                        onError={(e) => {
                          e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="300"%3E%3Crect fill="%23ddd" width="200" height="300"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999"%3ENo Image%3C/text%3E%3C/svg%3E';
                        }}
                      />
                    </div>
                    <div className="p-4 bg-white">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="font-medium text-gray-900">{option.source}</div>
                          <div className="text-sm text-gray-600">{option.size_estimate}</div>
                        </div>
                        <div className="text-xs text-gray-500">
                          {option.width > 0 && `${option.width}×${option.height}`}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDownload(option.url)}
                        disabled={downloading}
                        className={`w-full px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
                          downloading && selectedUrl === option.url
                            ? 'bg-gray-400 cursor-not-allowed'
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
                            Use This Cover
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ))}
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