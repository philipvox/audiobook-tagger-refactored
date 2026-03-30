import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Book, Edit, Upload, RefreshCw, Download, X, Image as ImageIcon, Database, Folder, Bot, FileAudio, Globe, Music, Library, FolderOpen } from 'lucide-react';

// Source badge configuration
const SOURCE_CONFIG = {
  audible: { label: 'Audible', color: 'bg-orange-500/20 text-orange-400 border-orange-500/30', icon: Music },
  googlebooks: { label: 'Google', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', icon: Globe },
  itunes: { label: 'iTunes', color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', icon: Music },
  gpt: { label: 'AI', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30', icon: Bot },
  filetag: { label: 'File', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30', icon: FileAudio },
  folder: { label: 'Folder', color: 'bg-green-500/20 text-green-400 border-green-500/30', icon: Folder },
  manual: { label: 'Manual', color: 'bg-teal-500/20 text-teal-400 border-teal-500/30', icon: Edit },
  unknown: { label: '?', color: 'bg-gray-500/20 text-gray-500 border-gray-500/30', icon: Database },
};

// Confidence level configuration
const getConfidenceConfig = (score) => {
  if (score >= 85) return { label: 'High', color: 'bg-green-500', textColor: 'text-green-400', borderColor: 'border-green-500/30', bgColor: 'bg-green-500/10' };
  if (score >= 60) return { label: 'Medium', color: 'bg-yellow-500', textColor: 'text-yellow-400', borderColor: 'border-yellow-500/30', bgColor: 'bg-yellow-500/10' };
  return { label: 'Low', color: 'bg-red-500', textColor: 'text-red-400', borderColor: 'border-red-500/30', bgColor: 'bg-red-500/10' };
};

// Check if a string looks like a person's name
const looksLikePersonName = (s) => {
  const words = s.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  const lower = s.toLowerCase();
  const seriesIndicators = ['series', 'saga', 'chronicles', 'trilogy', 'book', 'collection',
                            'adventures', 'mysteries', 'tales', 'stories', 'cycle'];
  if (seriesIndicators.some(ind => lower.includes(ind))) return false;
  for (const word of words) {
    const wordLower = word.toLowerCase();
    if (['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'md', 'dr', 'dr.'].includes(wordLower)) continue;
    if (/\d/.test(word)) return false;
    if (word.length > 0 && word[0] !== word[0].toUpperCase()) return false;
  }
  return true;
};

// Validate series name
const isValidSeries = (series, author = null) => {
  if (!series || typeof series !== 'string') return false;
  const s = series.trim();
  if (s.length < 2) return false;
  const lower = s.toLowerCase();
  const invalidValues = [
    'null', 'or null', 'none', 'n/a', 'na', 'unknown', 'unknown series',
    'standalone', 'stand-alone', 'stand alone', 'single', 'single book',
    'not a series', 'no series', 'not part of a series', 'no series name',
    'series name', 'series', 'title', 'book', 'audiobook',
    'undefined', 'not applicable', 'not available', 'tbd', 'tba',
    'biography', 'autobiography', 'memoir', 'memoirs', 'fiction', 'non-fiction',
    'nonfiction', 'mystery', 'thriller', 'romance', 'fantasy', 'science fiction',
  ];
  if (invalidValues.includes(lower)) return false;
  if (lower.includes('or null') || lower.includes('#or null')) return false;
  if (author) {
    const authorLower = author.toLowerCase().trim();
    if (lower === authorLower) return false;
    if (authorLower.includes(lower)) return false;
  }
  if (looksLikePersonName(s)) {
    const words = s.trim().split(/\s+/);
    if (words.length === 2) return false;
  }
  return true;
};

const isValidSequence = (seq) => {
  if (!seq || typeof seq !== 'string') return false;
  const s = seq.trim();
  if (s.length === 0) return false;
  const lower = s.toLowerCase();
  const invalidValues = ['null', 'or null', 'none', 'n/a', 'na', 'unknown', '?', 'tbd'];
  if (invalidValues.includes(lower)) return false;
  return true;
};

// Small badge showing data source
function SourceBadge({ source }) {
  if (!source) return null;
  const config = SOURCE_CONFIG[source.toLowerCase()] || SOURCE_CONFIG.unknown;
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border ${config.color}`}>
      <Icon className="w-2.5 h-2.5" />
      {config.label}
    </span>
  );
}

// Confidence card for Details tab
function ConfidenceCard({ confidence }) {
  if (!confidence) return null;
  const config = getConfidenceConfig(confidence.overall);

  return (
    <div className={`rounded-xl border ${config.borderColor} ${config.bgColor} p-5`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${config.color}`} />
          <span className={`font-semibold ${config.textColor}`}>
            {config.label} Confidence
          </span>
        </div>
        <span className={`text-3xl font-bold ${config.textColor}`}>
          {confidence.overall}%
        </span>
      </div>

      <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden mb-4">
        <div
          className={`h-full ${config.color} transition-all duration-300`}
          style={{ width: `${confidence.overall}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Title</span>
          <span className={`font-medium ${getConfidenceConfig(confidence.title).textColor}`}>
            {confidence.title}%
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Author</span>
          <span className={`font-medium ${getConfidenceConfig(confidence.author).textColor}`}>
            {confidence.author}%
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Narrator</span>
          <span className={`font-medium ${getConfidenceConfig(confidence.narrator).textColor}`}>
            {confidence.narrator}%
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Series</span>
          <span className={`font-medium ${getConfidenceConfig(confidence.series).textColor}`}>
            {confidence.series}%
          </span>
        </div>
      </div>
    </div>
  );
}

// Helper: check if a field was changed by enrichment
function isChanged(group, field) {
  return group?.changedFields?.includes(field);
}

// CSS class for changed field highlight — subtle left border + faint background glow
function changedClass(group, field) {
  return isChanged(group, field) ? 'ring-1 ring-amber-500/40 bg-amber-500/5' : '';
}

export function MetadataPanel({ group, onEdit }) {
  const [coverData, setCoverData] = useState(null);
  const [coverUrl, setCoverUrl] = useState(null);
  const [showCoverSearch, setShowCoverSearch] = useState(false);
  const [coverOptions, setCoverOptions] = useState([]);
  const [searchingCovers, setSearchingCovers] = useState(false);
  const [downloadingCover, setDownloadingCover] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [activeTab, setActiveTab] = useState('about');
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [absChapters, setAbsChapters] = useState([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [chaptersError, setChaptersError] = useState(null);

  const blobUrlRef = useRef(null);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (group) {
      loadCover();
      setActiveTab('about');
      setDescriptionExpanded(false);
      setAbsChapters([]);
      setChaptersError(null);
    } else {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setCoverUrl(null);
      setCoverData(null);
      setAbsChapters([]);
    }
  }, [group?.id, refreshTrigger]);

  // Load chapters when switching to chapters tab
  useEffect(() => {
    if (activeTab === 'chapters' && group?.id && absChapters.length === 0 && !loadingChapters) {
      loadAbsChapters();
    }
  }, [activeTab, group?.id]);

  const loadAbsChapters = async () => {
    if (!group?.id) return;

    setLoadingChapters(true);
    setChaptersError(null);

    try {
      const result = await invoke('get_abs_chapters', { absId: group.id });
      setAbsChapters(result.chapters || []);
    } catch (error) {
      console.error('Failed to load chapters:', error);
      setChaptersError(error.toString());
    } finally {
      setLoadingChapters(false);
    }
  };

  // Format time from seconds to HH:MM:SS or MM:SS
  const formatTime = (seconds) => {
    if (!seconds && seconds !== 0) return '--:--';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const loadCover = async () => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setCoverUrl(null);

    try {
      const cover = await invoke('get_cover_for_group', {
        groupId: group.id,
        coverUrl: group.metadata?.cover_url || null,
      });
      setCoverData(cover);

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
      <div className="flex-1 flex items-center justify-center bg-neutral-950">
        <div className="text-center max-w-md px-6">
          <Book className="w-16 h-16 text-neutral-700 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">Select a Book</h3>
          <p className="text-gray-500">Choose a book from the list to view its metadata.</p>
        </div>
      </div>
    );
  }

  const metadata = group.metadata;
  const hasSeries = isValidSeries(metadata.series, metadata.author) || metadata.all_series?.length > 0;
  const primarySeries = metadata.all_series?.[0] || (hasSeries ? { name: metadata.series, sequence: metadata.sequence } : null);

  // Format duration
  const formatDuration = (minutes) => {
    if (!minutes) return null;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins} min`;
  };

  const confidence = metadata.confidence;
  const confidenceConfig = confidence ? getConfidenceConfig(confidence.overall) : null;

  return (
    <div className="flex-1 overflow-y-auto bg-neutral-950">
      {/* Header Section */}
      <div className="p-6 pb-0">
        <div className="flex gap-6">
          {/* Cover Art */}
          <div className="flex-shrink-0 w-48">
            <div className="aspect-square bg-neutral-900 rounded-lg overflow-hidden relative">
              {coverUrl ? (
                <>
                  <img
                    src={coverUrl}
                    alt={`${metadata.title} cover`}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.target.style.display = 'none';
                    }}
                  />
                  {coverData && (
                    <div className="absolute bottom-2 right-2 px-2 py-0.5 bg-black/70 rounded text-xs text-white font-medium">
                      {coverData.size_kb}KB
                    </div>
                  )}
                </>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center">
                  <Book className="w-16 h-16 text-neutral-700 mb-2" />
                  <p className="text-sm text-neutral-600">No Cover</p>
                </div>
              )}
            </div>

            {/* Cover buttons */}
            <button
              onClick={handleSearchCovers}
              className="w-full mt-3 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors font-medium flex items-center justify-center gap-2 text-sm"
            >
              <RefreshCw className="w-4 h-4" />
              Find Better Cover
            </button>
            <button
              onClick={handleUploadCover}
              className="w-full mt-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-gray-300 rounded-lg transition-colors font-medium flex items-center justify-center gap-2 text-sm"
            >
              <Upload className="w-4 h-4" />
              Upload Cover
            </button>
          </div>

          {/* Title & Info */}
          <div className="flex-1 min-w-0">
            {/* Series Badge */}
            {primarySeries && (
              <div className="mb-3">
                <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium ${isChanged(group, 'series') || isChanged(group, 'sequence') ? 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40' : 'bg-indigo-500/20 text-indigo-400'}`}>
                  <Library className="w-4 h-4" />
                  {primarySeries.name}
                  {isValidSequence(primarySeries.sequence) && (
                    <span className="px-1.5 py-0.5 bg-indigo-500 text-white text-xs font-bold rounded">
                      #{primarySeries.sequence}
                    </span>
                  )}
                </span>
              </div>
            )}

            {/* Title */}
            <h1 className={`text-3xl font-bold text-white mb-1 leading-tight ${isChanged(group, 'title') ? 'border-l-2 border-amber-500 pl-2' : ''}`}>
              {metadata.title || 'Untitled'}
              {isChanged(group, 'title') && <span className="text-amber-500 text-xs ml-2 font-normal align-middle">changed</span>}
            </h1>

            {/* Subtitle as series reference */}
            {hasSeries && (
              <p className="text-lg text-gray-400 mb-3 italic">
                {primarySeries?.name}{isValidSequence(primarySeries?.sequence) ? `, Book ${primarySeries.sequence}` : ''}
              </p>
            )}

            {/* Author & Narrator */}
            <div className="flex items-center gap-2 text-gray-300 mb-4">
              <span className={`font-medium ${isChanged(group, 'author') ? 'text-amber-300' : ''}`}>
                {metadata.author || 'Unknown Author'}
                {isChanged(group, 'author') && <span className="text-amber-500 text-[10px] ml-1">●</span>}
              </span>
              {metadata.narrator && (
                <>
                  <span className="text-gray-600">·</span>
                  <span className={`text-gray-400 ${isChanged(group, 'narrator') ? 'text-amber-300' : ''}`}>
                    Read by {metadata.narrator}
                    {isChanged(group, 'narrator') && <span className="text-amber-500 text-[10px] ml-1">●</span>}
                  </span>
                </>
              )}
            </div>

            {/* Stats Row */}
            <div className="flex items-center gap-8">
              {metadata.runtime_minutes && (
                <div className="text-center">
                  <div className="text-xl font-semibold text-white">
                    {formatDuration(metadata.runtime_minutes)}
                  </div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider">Duration</div>
                </div>
              )}
              {metadata.year && (
                <div className={`text-center ${isChanged(group, 'year') ? 'ring-1 ring-amber-500/40 rounded-lg px-2 py-1 bg-amber-500/5' : ''}`}>
                  <div className="text-xl font-semibold text-white">{metadata.year}</div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider">Published</div>
                </div>
              )}
              {confidence && (
                <div className="text-center">
                  <div className={`text-xl font-semibold ${confidenceConfig.textColor}`}>
                    {confidence.overall}%
                  </div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider">Confidence</div>
                </div>
              )}
            </div>

            {/* Edit Button */}
            {onEdit && (
              <button
                onClick={() => onEdit(group)}
                className="mt-4 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg transition-colors font-medium flex items-center gap-2 text-sm"
              >
                <Edit className="w-4 h-4" />
                Edit
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 mt-6 border-b border-neutral-800">
        <div className="flex gap-6">
          {['about', 'chapters', 'details'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium transition-colors relative ${
                activeTab === tab
                  ? 'text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {activeTab === tab && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="p-6">
        {activeTab === 'about' && (
          <div className="space-y-6">
            {/* Description with Drop Cap */}
            {metadata.description && (
              <div className={`${isChanged(group, 'description') ? 'border-l-2 border-amber-500 pl-4' : ''}`}>
                {isChanged(group, 'description') && (
                  <div className="text-[10px] uppercase tracking-wider text-amber-500 font-semibold mb-2">Updated by enrichment</div>
                )}
                <div className="text-gray-300 leading-relaxed">
                  <span className="float-left text-6xl font-serif text-white mr-3 mt-1 leading-none">
                    {metadata.description.charAt(0).toUpperCase()}
                  </span>
                  <span>
                    {descriptionExpanded
                      ? metadata.description.slice(1)
                      : metadata.description.slice(1, 300) + (metadata.description.length > 300 ? '...' : '')
                    }
                  </span>
                </div>
                {metadata.description.length > 300 && (
                  <button
                    onClick={() => setDescriptionExpanded(!descriptionExpanded)}
                    className="text-blue-400 hover:text-blue-300 text-sm mt-2"
                  >
                    {descriptionExpanded ? 'Show less' : 'Read more'}
                  </button>
                )}
              </div>
            )}

            {/* Genres */}
            {metadata.genres && metadata.genres.length > 0 && (
              <div className={`${isChanged(group, 'genres') ? 'border-l-2 border-amber-500 pl-4' : ''}`}>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Genres {isChanged(group, 'genres') && <span className="text-amber-500">● updated</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {metadata.genres.map((genre, idx) => (
                    <span
                      key={idx}
                      className="px-4 py-2 bg-neutral-800 text-white text-sm font-medium rounded-full"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Tags */}
            {metadata.tags && metadata.tags.length > 0 && (
              <div className={`${isChanged(group, 'tags') ? 'border-l-2 border-amber-500 pl-4' : ''}`}>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Tags {isChanged(group, 'tags') && <span className="text-amber-500">● updated</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {metadata.tags.map((tag, idx) => (
                    <span
                      key={idx}
                      className="px-3 py-1.5 border border-amber-600/50 text-amber-500 text-sm rounded-full"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'chapters' && (
          <div className="space-y-4">
            {loadingChapters ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mx-auto mb-3"></div>
                <p className="text-gray-500">Loading chapters...</p>
              </div>
            ) : chaptersError ? (
              <div className="text-center py-8">
                <p className="text-red-400 mb-2">Failed to load chapters</p>
                <p className="text-gray-500 text-sm">{chaptersError}</p>
                <button
                  onClick={loadAbsChapters}
                  className="mt-4 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-sm"
                >
                  Retry
                </button>
              </div>
            ) : absChapters.length > 0 ? (
              <>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Chapters ({absChapters.length})
                </div>
                <div className="space-y-1">
                  {absChapters.map((chapter, idx) => (
                    <div
                      key={chapter.id}
                      className="flex items-center gap-3 p-3 bg-neutral-900 rounded-lg border border-neutral-800 hover:border-neutral-700 transition-colors"
                    >
                      <span className="w-8 h-8 flex-shrink-0 flex items-center justify-center bg-indigo-500/20 text-indigo-400 rounded text-sm font-bold">
                        {idx + 1}
                      </span>
                      <span className="text-gray-300 text-sm flex-1 truncate">
                        {chapter.title}
                      </span>
                      <span className="text-gray-500 text-xs font-mono flex-shrink-0">
                        {formatTime(chapter.start)}
                      </span>
                      <span className="text-gray-600 text-xs">-</span>
                      <span className="text-gray-500 text-xs font-mono flex-shrink-0">
                        {formatTime(chapter.end)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Files ({group.files?.length || 0})
                </div>
                {group.files && group.files.length > 0 ? (
                  <div className="space-y-1">
                    {group.files.map((file, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 p-3 bg-neutral-900 rounded-lg border border-neutral-800"
                      >
                        <span className="w-8 h-8 flex items-center justify-center bg-indigo-500/20 text-indigo-400 rounded text-sm font-bold">
                          {idx + 1}
                        </span>
                        <span className="text-gray-300 text-sm font-mono truncate flex-1">
                          {file.filename}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-gray-500">
                    No chapters or files available
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'details' && (
          <div className="space-y-6">
            {/* Detail Cards Grid */}
            <div className="grid grid-cols-2 gap-4">
              {metadata.isbn && (
                <div className={`p-4 bg-neutral-900 rounded-xl border ${isChanged(group, 'isbn') ? 'border-amber-500/50 ring-1 ring-amber-500/20' : 'border-neutral-800'}`}>
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    ISBN {isChanged(group, 'isbn') && <span className="text-amber-500">●</span>}
                  </div>
                  <div className="text-white font-mono">{metadata.isbn}</div>
                </div>
              )}
              {metadata.asin && (
                <div className={`p-4 bg-neutral-900 rounded-xl border ${isChanged(group, 'asin') ? 'border-amber-500/50 ring-1 ring-amber-500/20' : 'border-neutral-800'}`}>
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    ASIN {isChanged(group, 'asin') && <span className="text-amber-500">●</span>}
                  </div>
                  <div className="text-white font-mono">{metadata.asin}</div>
                </div>
              )}
              {metadata.year && (
                <div className={`p-4 bg-neutral-900 rounded-xl border ${isChanged(group, 'year') ? 'border-amber-500/50 ring-1 ring-amber-500/20' : 'border-neutral-800'}`}>
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Year {isChanged(group, 'year') && <span className="text-amber-500">●</span>}
                  </div>
                  <div className="text-white text-xl font-semibold">{metadata.year}</div>
                </div>
              )}
              {metadata.runtime_minutes && (
                <div className="p-4 bg-neutral-900 rounded-xl border border-neutral-800">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Duration
                  </div>
                  <div className="text-white text-xl font-semibold">
                    {formatDuration(metadata.runtime_minutes)}
                  </div>
                </div>
              )}
              {metadata.publisher && (
                <div className="p-4 bg-neutral-900 rounded-xl border border-neutral-800">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Publisher
                  </div>
                  <div className="text-white">{metadata.publisher}</div>
                </div>
              )}
              {metadata.language && (
                <div className="p-4 bg-neutral-900 rounded-xl border border-neutral-800">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Language
                  </div>
                  <div className="text-white uppercase">{metadata.language}</div>
                </div>
              )}
            </div>

            {/* File Location */}
            {group.files && group.files[0]?.path && (
              <div className="p-4 bg-neutral-900 rounded-xl border border-neutral-800">
                <div className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  <FolderOpen className="w-4 h-4" />
                  File Location
                </div>
                <div className="text-gray-400 font-mono text-sm break-all">
                  {group.files[0].path.replace(/\/[^/]+$/, '')}
                </div>
              </div>
            )}

            {/* Confidence Card */}
            <ConfidenceCard confidence={confidence} />
          </div>
        )}
      </div>

      {/* Cover Search Modal */}
      {showCoverSearch && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-neutral-900 rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col border border-neutral-800">
            <div className="p-6 border-b border-neutral-800">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-white">Find Better Cover</h2>
                  <p className="text-sm text-gray-400 mt-1">{metadata.title}</p>
                </div>
                <button
                  onClick={() => {
                    setShowCoverSearch(false);
                    setCoverOptions([]);
                  }}
                  className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
                >
                  <X className="w-6 h-6 text-gray-400" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {searchingCovers ? (
                <div className="text-center py-12">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500 mx-auto mb-4"></div>
                  <p className="text-gray-400">Searching for covers...</p>
                </div>
              ) : coverOptions.length === 0 ? (
                <div className="text-center py-12">
                  <ImageIcon className="w-16 h-16 text-neutral-700 mx-auto mb-4" />
                  <p className="text-gray-400 mb-4">No covers found from online sources</p>
                  <button
                    onClick={handleUploadCover}
                    className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2 mx-auto"
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
                        className="group border border-neutral-800 rounded-lg overflow-hidden hover:border-indigo-500 transition-all bg-neutral-900"
                      >
                        <div className="aspect-square bg-neutral-800 relative overflow-hidden flex items-center justify-center">
                          <img
                            src={option.url}
                            alt="Cover preview"
                            className="max-w-full max-h-full object-contain group-hover:scale-105 transition-transform duration-300"
                            loading="lazy"
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
                        <div className="p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold text-white truncate">
                              {option.source}
                            </span>
                            {option.width > 0 && (
                              <span className="text-xs text-gray-500">
                                {option.width}×{option.height}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500">
                            {option.size_estimate}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-neutral-800 pt-6 mt-6">
                    <button
                      onClick={handleUploadCover}
                      className="w-full px-4 py-3 bg-neutral-800 hover:bg-neutral-700 text-gray-300 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
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
