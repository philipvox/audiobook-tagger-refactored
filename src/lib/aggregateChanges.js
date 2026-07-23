// aggregateChanges — union the pending changes across all files of a group.
//
// L10: the ChangePreviewTooltip should show the union of changed fields across
// every file in the group, using the first file's old/new for each field as the
// representative (not just group.files[0]'s changes).

export function aggregateGroupChanges(group) {
  const allChanges = {};
  if (!group || !group.files) return allChanges;
  for (const file of group.files) {
    if (!file.changes) continue;
    for (const [field, change] of Object.entries(file.changes)) {
      if (!(field in allChanges)) {
        allChanges[field] = change; // first file with this field wins
      }
    }
  }
  return allChanges;
}
