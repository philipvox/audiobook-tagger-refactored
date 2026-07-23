// buildWritePayload — pure builder for the write_tags request (H3).
//
// Data-preservation constraint: what gets written must equal exactly what the
// WritePreviewModal showed, minus the rows the user unchecked. The modal renders
// `file.changes` for each selected file and excludes rows by a "fileId:field"
// key; this builder applies the SAME filter so display and payload can never
// drift. Files whose changes are entirely excluded (or empty) are dropped.
//
//   groups            BookGroup[]
//   selectedFileIds   Set of file ids to write
//   excludedChanges   optional Set of "fileId:field" keys to omit
//
// Returns { fileIds, filesMap } where filesMap[id] = { path, changes }.
export function buildWritePayload(groups, selectedFileIds, excludedChanges = null) {
  const filesMap = {};
  const fileIds = [];

  (groups || []).forEach((group) => {
    (group.files || []).forEach((file) => {
      if (file.id == null || !selectedFileIds.has(file.id)) return;
      const allChanges = file.changes || {};
      const changes = {};
      for (const [field, val] of Object.entries(allChanges)) {
        if (excludedChanges && excludedChanges.has(`${file.id}:${field}`)) continue;
        changes[field] = val;
      }
      if (Object.keys(changes).length === 0) return;
      filesMap[file.id] = { path: file.path, changes };
      fileIds.push(file.id);
    });
  });

  return { fileIds, filesMap };
}
