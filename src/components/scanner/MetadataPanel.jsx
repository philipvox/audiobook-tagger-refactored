import { useState, useEffect, useRef } from 'react';
import { callBackend } from '../../api';
import { proxyFetch } from '../../lib/proxy';
import { Book, Edit, X, Database, Folder, Bot, FileAudio, Globe, Music, Library, FolderOpen, Search } from 'lucide-react';
import { useToast } from '../Toast';

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

export function MetadataPanel({ group, onEdit, onInlineEdit }) {
  const toast = useToast();
  const [coverData, setCoverData] = useState(null);
  const [coverUrl, setCoverUrl] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [activeTab, setActiveTab] = useState('about');
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [absChapters, setAbsChapters] = useState([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [chaptersError, setChaptersError] = useState(null);

  // Inline editing state
  const [editingField, setEditingField] = useState(null); // 'title' | 'author' | 'narrator' | 'description' | null
  const [editValue, setEditValue] = useState('');
  const [editingTagIdx, setEditingTagIdx] = useState(null); // index of tag being edited
  const [lookingUp, setLookingUp] = useState(null); // 'isbn' | 'asin' | null
  const [editingTagValue, setEditingTagValue] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [addingGenre, setAddingGenre] = useState(false);
  const [newTagValue, setNewTagValue] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pushResult, setPushResult] = useState(null); // 'success' | null
  const editInputRef = useRef(null);

  // Reset editing state when group changes
  useEffect(() => {
    setEditingField(null);
    setEditingTagIdx(null);
    setAddingTag(false);
    setAddingGenre(false);
    setDirty(false);
    setPushResult(null);
  }, [group?.id]);

  // Focus input when editing starts
  useEffect(() => {
    if (editInputRef.current) editInputRef.current.focus();
  }, [editingField, editingTagIdx, addingTag, addingGenre]);

  const startEdit = (field) => {
    const metadata = group?.metadata || {};
    setEditingField(field);
    setEditValue(metadata[field] || '');
  };

  const commitEdit = () => {
    if (!editingField || !onInlineEdit || !group) return;
    if (editValue !== (group.metadata?.[editingField] || '')) {
      onInlineEdit(group.id, editingField, editValue);
      setDirty(true);
    }
    setEditingField(null);
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditingTagIdx(null);
    setAddingTag(false);
    setAddingGenre(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && editingField !== 'description') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  };

  // Lookup ISBN via Open Library, ASIN via Audnexus (same API AudiobookShelf uses)
  const lookupIdentifier = async (field) => {
    if (!onInlineEdit || !group) return;
    const title = metadata.title || '';
    const author = metadata.author || '';
    if (!title) { toast.error('Lookup Failed', 'No title to search for'); return; }

    setLookingUp(field);
    try {
      let found = null;

      if (field === 'asin') {
        // Audible public catalog API — no auth needed
        const titleParam = encodeURIComponent(title);
        const authorParam = encodeURIComponent(author);
        // Audible catalog (Tauri http plugin bypasses CORS; web variant deferred — see issue #53)
        const res = await proxyFetch(`https://api.audible.com/1.0/catalog/products?title=${titleParam}&author=${authorParam}&num_results=5&response_groups=product_desc`);
        if (res.ok) {
          const data = await res.json();
          const products = data.products || [];
          if (products.length > 0) {
            // Try exact title match first, then take first result
            const titleLower = title.toLowerCase();
            const match = products.find(p => p.title?.toLowerCase() === titleLower) || products[0];
            found = match.asin;
          }
        }
      } else {
        // ISBN via Open Library
        const query = encodeURIComponent(`${title} ${author}`);
        const res = await proxyFetch(`https://openlibrary.org/search.json?q=${query}&limit=5&fields=isbn,title,author_name`);
        if (res.ok) {
          const data = await res.json();
          for (const doc of (data.docs || [])) {
            if (!doc.isbn || doc.isbn.length === 0) continue;
            found = doc.isbn.find(i => i.length === 13) || doc.isbn[0];
            if (found) break;
          }
        }
      }

      if (found) {
        onInlineEdit(group.id, field, found);
        toast.success('Found', `${field.toUpperCase()}: ${found}`);
      } else {
        toast.error('Not Found', `No ${field.toUpperCase()} found for "${title}"`);
      }
    } catch (e) {
      toast.error('Lookup Failed', e.message);
    }
    setLookingUp(null);
  };

  const removeTag = (idx) => {
    if (!onInlineEdit || !group) return;
    const tags = [...(group.metadata?.tags || [])];
    tags.splice(idx, 1);
    onInlineEdit(group.id, 'tags', tags);
    setDirty(true);
  };

  const removeGenre = (idx) => {
    if (!onInlineEdit || !group) return;
    const genres = [...(group.metadata?.genres || [])];
    genres.splice(idx, 1);
    onInlineEdit(group.id, 'genres', genres);
    setDirty(true);
  };

  const addTag = () => {
    if (!newTagValue.trim() || !onInlineEdit || !group) return;
    const tags = [...(group.metadata?.tags || []), newTagValue.trim().toLowerCase().replace(/\s+/g, '-')];
    onInlineEdit(group.id, 'tags', tags);
    setNewTagValue('');
    setAddingTag(false);
    setDirty(true);
  };

  const addGenre = () => {
    if (!newTagValue.trim() || !onInlineEdit || !group) return;
    const genres = [...(group.metadata?.genres || []), newTagValue.trim()];
    onInlineEdit(group.id, 'genres', genres);
    setNewTagValue('');
    setAddingGenre(false);
    setDirty(true);
  };

  const commitTagEdit = () => {
    if (editingTagIdx === null || !onInlineEdit || !group) return;
    const tags = [...(group.metadata?.tags || [])];
    tags[editingTagIdx] = editingTagValue.trim().toLowerCase().replace(/\s+/g, '-');
    onInlineEdit(group.id, 'tags', tags.filter(t => t));
    setEditingTagIdx(null);
    setDirty(true);
  };

  const saveLocally = () => {
    // Inline edits already update the group via onInlineEdit — just clear dirty flag
    setDirty(false);
    setPushResult('success');
    setTimeout(() => setPushResult(null), 2000);
  };

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
      const result = await callBackend('get_abs_chapters', { absId: group.id });
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
    setCoverData(null);

    try {
      const cover = await callBackend('get_cover_for_group', {
        groupId: group.id,
        coverUrl: group.metadata?.cover_url || null,
      });

      if (!cover || !cover.blobUrl) return;

      setCoverData(cover);
      blobUrlRef.current = cover.blobUrl;
      setCoverUrl(cover.blobUrl);
    } catch (error) {
      console.error('Failed to load cover:', error);
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
    <div className="flex-1 overflow-y-auto bg-neutral-950 relative">
      {/* Small save button — top-right corner when dirty */}
      {(dirty || pushResult) && (
        <button
          onClick={saveLocally}
          className={`absolute top-4 right-4 z-10 px-5 py-2.5 text-sm font-semibold rounded-xl transition-all shadow-lg ${
            pushResult === 'success'
              ? 'bg-green-500 text-white scale-95'
              : 'bg-green-600 hover:bg-green-500 text-white'
          }`}
        >
          {pushResult === 'success' ? 'Saved!' : 'Save Local'}
        </button>
      )}
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

            {/* Title — click to edit */}
            {editingField === 'title' ? (
              <input
                ref={editInputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={handleKeyDown}
                className="text-3xl font-bold text-white mb-1 leading-tight bg-neutral-800 border border-neutral-600 rounded-lg px-2 py-1 w-full focus:outline-none focus:border-blue-500"
              />
            ) : (
              <h1
                onClick={() => startEdit('title')}
                className={`text-3xl font-bold text-white mb-1 leading-tight cursor-text hover:bg-neutral-800/50 rounded px-1 -mx-1 transition-colors ${isChanged(group, 'title') ? 'border-l-2 border-amber-500 pl-2' : ''}`}
                title="Click to edit"
              >
                {metadata.title || 'Untitled'}
              </h1>
            )}

            {/* Subtitle as series reference */}
            {hasSeries && (
              <p className="text-lg text-gray-400 mb-3 italic">
                {primarySeries?.name}{isValidSequence(primarySeries?.sequence) ? `, Book ${primarySeries.sequence}` : ''}
              </p>
            )}

            {/* Author & Narrator — click to edit */}
            <div className="flex items-center gap-2 text-gray-300 mb-4">
              {editingField === 'author' ? (
                <input
                  ref={editInputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={handleKeyDown}
                  className="font-medium bg-neutral-800 border border-neutral-600 rounded px-2 py-0.5 text-white focus:outline-none focus:border-blue-500"
                />
              ) : (
                <span
                  onClick={() => startEdit('author')}
                  className="font-medium cursor-text hover:bg-neutral-800/50 rounded px-1 -mx-1 transition-colors"
                  title="Click to edit"
                >
                  {metadata.author || 'Unknown Author'}
                </span>
              )}
              <span className="text-gray-600">·</span>
              {editingField === 'narrator' ? (
                <input
                  ref={editInputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={handleKeyDown}
                  className="text-gray-400 bg-neutral-800 border border-neutral-600 rounded px-2 py-0.5 focus:outline-none focus:border-blue-500"
                  placeholder="Narrator name"
                />
              ) : (
                <span
                  onClick={() => startEdit('narrator')}
                  className="text-gray-400 cursor-text hover:bg-neutral-800/50 rounded px-1 -mx-1 transition-colors"
                  title="Click to edit"
                >
                  {metadata.narrator ? `Read by ${metadata.narrator}` : 'Add narrator'}
                </span>
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

            {/* Edit button — hidden since inline editing is available, kept as fallback */}
            {onEdit && !onInlineEdit && (
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
            {/* Description — click to edit */}
            {editingField === 'description' ? (
              <div>
                <textarea
                  ref={editInputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                  rows={8}
                  className="w-full text-gray-300 leading-relaxed bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500 resize-y text-sm"
                />
                <div className="flex gap-2 mt-1">
                  <button onClick={commitEdit} className="text-xs text-blue-400 hover:text-blue-300">Done</button>
                  <button onClick={cancelEdit} className="text-xs text-gray-500 hover:text-gray-400">Cancel</button>
                </div>
              </div>
            ) : metadata.description ? (
              <div
                onClick={() => startEdit('description')}
                className={`cursor-text hover:bg-neutral-800/30 rounded-lg p-1 -m-1 transition-colors ${isChanged(group, 'description') ? 'border-l-2 border-amber-500 pl-4' : ''}`}
                title="Click to edit"
              >
                <p className="text-gray-300 leading-relaxed">
                  {descriptionExpanded
                    ? metadata.description
                    : metadata.description.slice(0, 300) + (metadata.description.length > 300 ? '...' : '')
                  }
                </p>
                {metadata.description.length > 300 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setDescriptionExpanded(!descriptionExpanded); }}
                    className="text-blue-400 hover:text-blue-300 text-sm mt-2"
                  >
                    {descriptionExpanded ? 'Show less' : 'Read more'}
                  </button>
                )}
              </div>
            ) : (
              <p
                onClick={() => startEdit('description')}
                className="text-gray-600 cursor-text hover:bg-neutral-800/30 rounded p-1 -m-1 text-sm italic"
              >
                Click to add description...
              </p>
            )}

            {/* Genres — click X to remove, + to add */}
            <div className={`${isChanged(group, 'genres') ? 'border-l-2 border-amber-500 pl-4' : ''}`}>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Genres {isChanged(group, 'genres') && <span className="text-amber-500">● updated</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {(metadata.genres || []).map((genre, idx) => (
                  <span
                    key={idx}
                    className="px-3 py-1.5 bg-neutral-800 text-white text-sm font-medium rounded-full flex items-center gap-1.5 group/pill"
                  >
                    {genre}
                    <button
                      onClick={() => removeGenre(idx)}
                      className="opacity-0 group-hover/pill:opacity-100 text-gray-500 hover:text-red-400 transition-opacity"
                      title="Remove genre"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {addingGenre ? (
                  <input
                    ref={editInputRef}
                    value={newTagValue}
                    onChange={(e) => setNewTagValue(e.target.value)}
                    onBlur={() => { if (newTagValue.trim()) addGenre(); else setAddingGenre(false); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') addGenre(); if (e.key === 'Escape') { setAddingGenre(false); setNewTagValue(''); } }}
                    placeholder="Genre name"
                    className="px-3 py-1.5 bg-neutral-800 border border-neutral-600 text-white text-sm rounded-full focus:outline-none focus:border-blue-500 w-32"
                  />
                ) : (
                  <button
                    onClick={() => { setAddingGenre(true); setNewTagValue(''); }}
                    className="px-3 py-1.5 border border-dashed border-neutral-700 text-gray-500 hover:text-white hover:border-neutral-500 text-sm rounded-full transition-colors"
                  >
                    +
                  </button>
                )}
              </div>
            </div>

            {/* Tags — click X to remove, + to add, double-click to edit */}
            <div className={`${isChanged(group, 'tags') ? 'border-l-2 border-amber-500 pl-4' : ''}`}>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Tags {isChanged(group, 'tags') && <span className="text-amber-500">● updated</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {(metadata.tags || []).map((tag, idx) => (
                  editingTagIdx === idx ? (
                    <input
                      key={idx}
                      ref={editInputRef}
                      value={editingTagValue}
                      onChange={(e) => setEditingTagValue(e.target.value)}
                      onBlur={commitTagEdit}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitTagEdit(); if (e.key === 'Escape') setEditingTagIdx(null); }}
                      className="px-3 py-1 border border-blue-500 text-white text-sm rounded-full bg-neutral-800 focus:outline-none w-40"
                    />
                  ) : (
                    <span
                      key={idx}
                      className="px-3 py-1.5 border border-amber-600/50 text-amber-500 text-sm rounded-full flex items-center gap-1.5 group/pill cursor-default"
                      onDoubleClick={() => { setEditingTagIdx(idx); setEditingTagValue(tag); }}
                      title="Double-click to edit, hover for remove"
                    >
                      {tag}
                      <button
                        onClick={() => removeTag(idx)}
                        className="opacity-0 group-hover/pill:opacity-100 text-amber-700 hover:text-red-400 transition-opacity"
                        title="Remove tag"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  )
                ))}
                {addingTag ? (
                  <input
                    ref={editInputRef}
                    value={newTagValue}
                    onChange={(e) => setNewTagValue(e.target.value)}
                    onBlur={() => { if (newTagValue.trim()) addTag(); else setAddingTag(false); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') addTag(); if (e.key === 'Escape') { setAddingTag(false); setNewTagValue(''); } }}
                    placeholder="new-tag"
                    className="px-3 py-1 border border-neutral-600 text-amber-500 text-sm rounded-full bg-neutral-800 focus:outline-none focus:border-blue-500 w-32"
                  />
                ) : (
                  <button
                    onClick={() => { setAddingTag(true); setNewTagValue(''); }}
                    className="px-3 py-1.5 border border-dashed border-neutral-700 text-gray-500 hover:text-amber-400 hover:border-amber-600/50 text-sm rounded-full transition-colors"
                  >
                    +
                  </button>
                )}
              </div>
            </div>
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
                    {(group.files || []).map((file, idx) => (
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
            {/* Detail Cards Grid — editable */}
            <div className="grid grid-cols-2 gap-4">
              {[
                { field: 'isbn', label: 'ISBN', value: metadata.isbn, mono: true, canLookup: true },
                { field: 'asin', label: 'ASIN', value: metadata.asin, mono: true, canLookup: true },
                { field: 'published_year', label: 'Year', value: metadata.published_year || metadata.year },
                { field: 'publisher', label: 'Publisher', value: metadata.publisher },
                { field: 'language', label: 'Language', value: metadata.language },
              ].map(({ field, label, value, mono, canLookup }) => (
                <div
                  key={field}
                  className={`p-4 bg-neutral-900 rounded-xl border cursor-text ${isChanged(group, field) ? 'border-amber-500/50 ring-1 ring-amber-500/20' : 'border-neutral-800 hover:border-neutral-700'}`}
                  onClick={() => { if (onInlineEdit && editingField !== field) { setEditingField(field); setEditValue(value || ''); } }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      {label} {isChanged(group, field) && <span className="text-amber-500">●</span>}
                    </div>
                    {canLookup && onInlineEdit && (
                      <button
                        onClick={(e) => { e.stopPropagation(); lookupIdentifier(field); }}
                        disabled={lookingUp === field}
                        className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1 disabled:opacity-50"
                      >
                        <Search className="w-3 h-3" />
                        {lookingUp === field ? 'Looking up...' : 'Lookup'}
                      </button>
                    )}
                  </div>
                  {editingField === field ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingField(null); }}
                      className={`w-full bg-transparent text-white outline-none border-b border-blue-500 pb-0.5 ${mono ? 'font-mono' : ''}`}
                    />
                  ) : (
                    <div className={`text-white ${mono ? 'font-mono' : ''} ${!value ? 'text-gray-600 italic' : ''}`}>
                      {value || `No ${label.toLowerCase()}`}
                    </div>
                  )}
                </div>
              ))}
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

    </div>
  );
}
