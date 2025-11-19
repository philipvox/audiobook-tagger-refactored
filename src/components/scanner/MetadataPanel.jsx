import { Book, Edit } from 'lucide-react';

export function MetadataPanel({ group, onEdit }) {
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
    <div className="flex-1 overflow-y-auto p-6">
      <div className="bg-white rounded-xl shadow-sm p-8 space-y-8">
        <div className="flex items-start justify-between">
          <div className="space-y-2 flex-1">
            <h1 className="text-3xl font-bold text-gray-900 leading-tight">
              {metadata.title || 'Untitled'}
            </h1>
            {metadata.subtitle && (
              <p className="text-lg text-gray-600">{metadata.subtitle}</p>
            )}
          </div>
          {onEdit && (
            <button
              onClick={() => onEdit(group)}
              className="ml-4 px-4 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors font-medium flex items-center gap-2"
            >
              <Edit className="w-4 h-4" />
              Edit
            </button>
          )}
        </div>

        <div className="flex items-center gap-6 text-sm pb-6 border-b border-gray-100">
          <div>
            <span className="text-gray-500">by </span>
            <span className="font-medium text-gray-900">{metadata.author || 'Unknown Author'}</span>
          </div>
          {metadata.year && (
            <div className="text-gray-500">
              {metadata.year}
            </div>
          )}
          {group && (
            <div className="text-gray-500">
              {group.files.length} files
            </div>
          )}
        </div>

        {metadata.series && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Series
            </div>
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-lg border border-gray-200">
              <Book className="w-4 h-4 text-gray-600" />
              <span className="font-medium text-gray-900">{metadata.series}</span>
              {metadata.sequence && (
                <span className="text-gray-600">#{metadata.sequence}</span>
              )}
            </div>
          </div>
        )}

        {metadata.narrator && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Narrated by
            </div>
            <p className="text-gray-900">{metadata.narrator}</p>
          </div>
        )}

        {metadata.genres && metadata.genres.length > 0 && (
          <div className="space-y-3">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Genres
            </div>
            <div className="flex flex-wrap gap-2">
              {metadata.genres.map((genre, idx) => (
                <span 
                  key={idx}
                  className="inline-flex items-center px-3 py-1.5 bg-gray-900 text-white text-sm font-medium rounded-full"
                >
                  {genre}
                </span>
              ))}
            </div>
          </div>
        )}

        {metadata.description && (
          <div className="space-y-3">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              About
            </div>
            <p className="text-gray-700 leading-relaxed text-sm">
              {metadata.description}
            </p>
          </div>
        )}

        {(metadata.publisher || metadata.isbn) && (
          <div className="pt-6 border-t border-gray-100">
            <div className="grid grid-cols-2 gap-6 text-sm">
              {metadata.publisher && (
                <div>
                  <div className="text-xs text-gray-500 mb-1">Publisher</div>
                  <div className="text-gray-900">{metadata.publisher}</div>
                </div>
              )}
              {metadata.isbn && (
                <div>
                  <div className="text-xs text-gray-500 mb-1">ISBN</div>
                  <div className="text-gray-900 font-mono text-xs">{metadata.isbn}</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
