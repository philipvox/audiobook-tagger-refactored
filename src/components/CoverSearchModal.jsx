import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { X, Download, Upload, Image as ImageIcon, Star, RefreshCw, ChevronDown, Check } from 'lucide-react';

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

  // Group options by source to show resolution dropdown
  const groupedOptions = useMemo(() => {
    const groups = {};
    options.forEach(opt => {
      const key = opt.source || 'Unknown';
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(opt);
    });

    // Sort each group by resolution (highest first)
    Object.values(groups).forEach(group => {
      group.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    });

    return groups;
  }, [options]);

  // Get unique covers (one per source, highest resolution)
  const uniqueCovers = useMemo(() => {
    const seen = new Map();
    options.forEach(opt => {
      const key = opt.source || 'Unknown';
      if (!seen.has(key) || (opt.width * opt.height) > (seen.get(key).width * seen.get(key).height)) {
        seen.set(key, opt);
      }
    });
    return Array.from(seen.values()).sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));
  }, [options]);

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
    };
    // Check if source starts with any known prefix
    for (const [key, style] of Object.entries(styles)) {
      if (source && source.startsWith(key)) return style;
    }
    return { bg: 'bg-gray-50', text: 'text-gray-700', icon: '🖼️' };
  };

  // Get size label
  const getSizeLabel = (width, height) => {
    if (width >= 2000) return 'Extra Large (Best Quality)';
    if (width >= 1000) return 'Large';
    if (width >= 500) return 'Medium';
    if (width >= 200) return 'Small';
    return 'Thumbnail';
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
      <div className="bg-white rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-900">Find Better Cover</h2>
              <p className="text-sm text-gray-600 mt-0.5">{group?.metadata.title}</p>
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

        <div className="flex-1 overflow-y-auto p-4">
          {searching ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Searching iTunes, Audible, Google Books...</p>
            </div>
          ) : uniqueCovers.length === 0 ? (
            <div className="text-center py-12">
              <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-600 mb-4">No covers found from online sources</p>
              <button onClick={handleUploadCustom} className="btn btn-primary flex items-center gap-2 mx-auto">
                <Upload className="w-4 h-4" />
                Upload Custom Cover
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>Found {uniqueCovers.length} cover sources (sorted by quality)</span>
                {uniqueCovers[0]?.quality_score > 0 && (
                  <span className="flex items-center gap-1">
                    <Star className="w-4 h-4 text-yellow-500" />
                    Best: {uniqueCovers[0].quality_score}/100
                  </span>
                )}
              </div>

              {/* Square Grid Layout */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {uniqueCovers.map((option, idx) => {
                  const sourceStyle = getSourceStyle(option.source);
                  const isBest = idx === 0;
                  const sourceKey = option.source || 'Unknown';
                  const resolutionOptions = groupedOptions[sourceKey] || [option];
                  const hasMultipleResolutions = resolutionOptions.length > 1;

                  return (
                    <CoverCard
                      key={idx}
                      option={option}
                      isBest={isBest}
                      sourceStyle={sourceStyle}
                      resolutionOptions={resolutionOptions}
                      hasMultipleResolutions={hasMultipleResolutions}
                      downloading={downloading}
                      selectedUrl={selectedUrl}
                      onDownload={handleDownload}
                      getQualityColor={getQualityColor}
                      getSizeLabel={getSizeLabel}
                    />
                  );
                })}
              </div>

              <div className="border-t border-gray-200 pt-4">
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

// Individual cover card component with resolution dropdown
function CoverCard({
  option,
  isBest,
  sourceStyle,
  resolutionOptions,
  hasMultipleResolutions,
  downloading,
  selectedUrl,
  onDownload,
  getQualityColor,
  getSizeLabel
}) {
  const [selectedResolution, setSelectedResolution] = useState(option);
  const [showDropdown, setShowDropdown] = useState(false);

  return (
    <div
      className={`border rounded-lg overflow-hidden hover:shadow-lg transition-shadow ${
        isBest ? 'border-green-300 ring-2 ring-green-100' : 'border-gray-200'
      }`}
    >
      {/* Square aspect ratio container */}
      <div
        className="w-full bg-gray-100 relative"
        style={{ aspectRatio: '1 / 1' }}
      >
        {isBest && (
          <div className="absolute top-2 left-2 bg-green-500 text-white text-xs px-2 py-1 rounded font-medium z-10">
            Best Match
          </div>
        )}
        <div className="w-full h-full flex items-center justify-center p-2">
          <img
            src={selectedResolution.url}
            alt="Cover preview"
            className="max-w-full max-h-full object-contain"
            loading="lazy"
            onError={(e) => {
              e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23f3f4f6" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999" font-size="14"%3EFailed to load%3C/text%3E%3C/svg%3E';
            }}
          />
        </div>
      </div>

      <div className="p-3 bg-white flex-1 flex flex-col">
        {/* Source and Quality badges */}
        <div className="flex items-start justify-between mb-2">
          <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${sourceStyle.bg} ${sourceStyle.text}`}>
            <span>{sourceStyle.icon}</span>
            <span>{selectedResolution.source}</span>
          </div>
          {selectedResolution.quality_score > 0 && (
            <div className={`px-2 py-1 rounded text-xs font-medium ${getQualityColor(selectedResolution.quality_score)}`}>
              {selectedResolution.quality_score}/100
            </div>
          )}
        </div>

        {/* Resolution dropdown */}
        {hasMultipleResolutions ? (
          <div className="relative mb-2">
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              className="w-full flex items-center justify-between px-2 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs hover:bg-gray-100 transition-colors"
            >
              <span className="flex items-center gap-2">
                <span className="font-medium">{selectedResolution.width}×{selectedResolution.height}</span>
                <span className="text-gray-500">{getSizeLabel(selectedResolution.width, selectedResolution.height)}</span>
              </span>
              <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
            </button>

            {showDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-40 overflow-y-auto">
                {resolutionOptions.map((res, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setSelectedResolution(res);
                      setShowDropdown(false);
                    }}
                    className={`w-full px-3 py-2 text-left text-xs hover:bg-gray-50 flex items-center justify-between ${
                      res.url === selectedResolution.url ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div>
                      <span className="font-medium">{res.width}×{res.height}</span>
                      <span className="text-gray-500 ml-2">{getSizeLabel(res.width, res.height)}</span>
                    </div>
                    {res.url === selectedResolution.url && (
                      <Check className="w-4 h-4 text-blue-600" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-gray-500 mb-2">
            {selectedResolution.width > 0 && `${selectedResolution.width}×${selectedResolution.height}`}
          </div>
        )}

        {/* Download button */}
        <button
          onClick={() => onDownload(selectedResolution.url, selectedResolution.source)}
          disabled={downloading}
          className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 mt-auto ${
            downloading && selectedUrl === selectedResolution.url
              ? 'bg-gray-300 cursor-not-allowed text-gray-500'
              : isBest
                ? 'bg-green-600 hover:bg-green-700 text-white'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {downloading && selectedUrl === selectedResolution.url ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              Downloading...
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              {isBest ? 'Use Best' : 'Use This'}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
