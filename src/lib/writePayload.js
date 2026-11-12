// buildWritePayload - pure builder for the write_tags request (H3).
//
// Data-preservation constraint: what gets written must equal exactly what the
// WritePreviewModal showed, minus the rows the user unchecked. The modal renders
// `file.changes` for each selected file and excludes rows by a "fileId:field"
// key; this builder applies the SAME filter so display and payload can never
// drift. Files whose changes are entirely excluded (or empty) are dropped.
//
// #62: only fields the Rust writer actually embeds are sent (see
// unwritableReason). App-only fields (tags, DNA, age rating, ...) and fields
// the file's format has no tag for stay staged in the app; the preview lists
// them separately with the reason, so nothing reads as "will be written" that
// the writer would skip.
//
//   groups            BookGroup[]
//   selectedFileIds   Set of file ids to write
//   excludedChanges   optional Set of "fileId:field" keys to omit
//
// Returns { fileIds, filesMap } where filesMap[id] = { path, changes, group_size }.
// group_size is the book's file count: the writer puts a title change in the
// album field of a multi-file book and in the title field of a single file.

// The change keys src-tauri/src/writer.rs apply_changes embeds. Anything else
// is reported back by the writer as skipped, so it is never sent.
const TAG_FIELDS = new Set([
  'title', 'author', 'albumartist', 'artist', 'album', 'narrator', 'genre',
  'series', 'sequence', 'series_number', 'series-part', 'description',
  'publisher', 'language', 'subtitle', 'isbn', 'asin', 'year', 'track',
]);

const extensionOf = (path) => {
  const name = String(path || '').split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
const MP4_EXTENSIONS = new Set(['m4b', 'm4a', 'mp4']);
const ID3_EXTENSIONS = new Set(['mp3', 'aac']);

/**
 * Why a staged change will not be written into the file at `path`, or null
 * when the writer embeds it. Mirrors writer.rs: description has no ID3v2
 * home, publisher has no MP4 atom, ISBN/ASIN exist only as MP4 freeform atoms.
 */
export function unwritableReason(field, path) {
  if (!TAG_FIELDS.has(field)) return 'App only: audio files have no tag for this';
  const ext = extensionOf(path);
  if (field === 'description' && ID3_EXTENSIONS.has(ext)) return `${ext.toUpperCase()} tags have no description field`;
  if (field === 'publisher' && MP4_EXTENSIONS.has(ext)) return 'M4B and M4A tags have no publisher field';
  if ((field === 'isbn' || field === 'asin') && !MP4_EXTENSIONS.has(ext)) return 'Only M4B and M4A files have an ISBN or ASIN tag';
  return null;
}

/**
 * A file's staged changes, split into what the writer will write
 * (`writable`: [field, change] pairs) and what stays in the app
 * (`notWritten`: { field, change, reason }).
 */
export function splitFileChanges(file) {
  const writable = [];
  const notWritten = [];
  for (const [field, change] of Object.entries(file?.changes || {})) {
    const reason = unwritableReason(field, file.path);
    if (reason) notWritten.push({ field, change, reason });
    else writable.push([field, change]);
  }
  return { writable, notWritten };
}

export function buildWritePayload(groups, selectedFileIds, excludedChanges = null) {
  const filesMap = {};
  const fileIds = [];

  (groups || []).forEach((group) => {
    const groupSize = (group.files || []).length;
    (group.files || []).forEach((file) => {
      if (file.id == null || !selectedFileIds.has(file.id)) return;
      const changes = {};
      for (const [field, val] of splitFileChanges(file).writable) {
        if (excludedChanges && excludedChanges.has(`${file.id}:${field}`)) continue;
        changes[field] = val;
      }
      if (Object.keys(changes).length === 0) return;
      filesMap[file.id] = { path: file.path, changes, group_size: groupSize };
      fileIds.push(file.id);
    });
  });

  return { fileIds, filesMap };
}
