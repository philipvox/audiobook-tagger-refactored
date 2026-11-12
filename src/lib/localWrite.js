// localWrite - pure helpers behind Write Tags and Rename for locally scanned
// books (#62): which books and files a click targets, and what the writer's
// per-file answer means for the user and for the staged changes.
//
// The Rust writer refuses some files on purpose and says why (an MP3 whose
// lyrics or comment frames could not be preserved, a file with more than one
// leading ID3 tag, ...). Every such reason reaches the user twice: in the
// result toast and as the book's lastError pill. A count alone is never the
// whole message.

import { isLocalGroup } from './applyMetadata.js';
import { splitFileChanges } from './writePayload.js';

/** The last segment of a POSIX or Windows path. */
export function fileNameOf(path) {
  return String(path || '').split(/[\\/]/).pop() || '';
}

/**
 * The selected books, the same derivation the Enrich actions use: the whole
 * library on the allSelected fast path, else the explicitly selected ids
 * (Select All with a filter active selects the filtered books explicitly).
 */
export function selectedGroupsFrom(groups, { allSelected, selectedGroupIds }) {
  if (allSelected) return groups || [];
  return (groups || []).filter((g) => selectedGroupIds?.has(g.id));
}

/**
 * The selection Select All produces. With no filter, or a filter that shows
 * every book, it is the allSelected fast path; otherwise exactly the filtered
 * books and their file ids (H-8).
 */
export function selectionForSelectAll(groups, filteredGroups) {
  const all = groups || [];
  if (!Array.isArray(filteredGroups) || filteredGroups.length === all.length) {
    return { allSelected: true, groupIds: new Set(), fileIds: new Set() };
  }
  const fileIds = new Set();
  filteredGroups.forEach((g) => (g.files || []).forEach((f) => { if (f.id != null) fileIds.add(f.id); }));
  return { allSelected: false, groupIds: new Set(filteredGroups.map((g) => g.id)), fileIds };
}

/**
 * What Write Tags acts on within a selection: the local books, the ids of
 * their files that have any staged change (in library order), and how many of
 * those changes the writer will actually write.
 */
export function localWriteTargets(selectedGroups) {
  const localGroups = (selectedGroups || []).filter(isLocalGroup);
  const fileIds = [];
  let writableCount = 0;
  for (const g of localGroups) {
    for (const f of g.files || []) {
      if (f.id == null || Object.keys(f.changes || {}).length === 0) continue;
      fileIds.push(f.id);
      writableCount += splitFileChanges(f).writable.length;
    }
  }
  return { localGroups, fileIds, writableCount };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Name each file with its reason; past `max` entries, point at the book pills.
function listed(items, render, max = 3) {
  const shown = items.slice(0, max).map(render).join('; ');
  const more = items.length - max;
  return more > 0 ? `${shown}; and ${more} more (see each book's error)` : shown;
}

function fileIndex(groups) {
  const index = new Map();
  for (const g of groups || []) {
    for (const f of g.files || []) {
      if (f.id != null) index.set(f.id, { group: g, file: f });
    }
  }
  return index;
}

/**
 * Read a write_tags result. Returns
 *   { written, failures: [{ fileId, groupId, name, error }],
 *     skipped: [{ fileId, groupId, name, fields }], toast: { type, title, message } }
 * `skipped` lists files that were written but where the writer could not
 * embed some requested fields.
 */
export function summarizeWriteResult(result, groups) {
  const index = fileIndex(groups);
  const describe = (fileId, path) => {
    const hit = index.get(fileId);
    return { groupId: hit?.group.id ?? null, name: fileNameOf(path || hit?.file.path) || String(fileId) };
  };
  const results = Array.isArray(result?.results) ? result.results : [];
  const errors = Array.isArray(result?.errors) ? result.errors : [];

  const failures = errors.map((e) => ({
    fileId: e.file_id,
    ...describe(e.file_id, e.path),
    error: String(e.error || 'not written'),
  }));
  const failedIds = new Set(failures.map((f) => f.fileId));
  // A result marked failed with no matching error entry still counts, with a
  // generic reason, so no failure is ever silent.
  for (const r of results) {
    if (r.status === 'failed' && !failedIds.has(r.file_id)) {
      failures.push({ fileId: r.file_id, ...describe(r.file_id, r.path), error: 'not written (no reason given)' });
      failedIds.add(r.file_id);
    }
  }
  const succeeded = results.filter((r) => r.status === 'success');
  const skipped = succeeded
    .filter((r) => Array.isArray(r.skipped_fields) && r.skipped_fields.length > 0)
    .map((r) => ({ fileId: r.file_id, ...describe(r.file_id, r.path), fields: [...r.skipped_fields] }));
  const written = succeeded.length;

  const parts = [];
  if (written > 0) parts.push(`Wrote tags to ${plural(written, 'file')}.`);
  if (failures.length > 0) {
    parts.push(`${plural(failures.length, 'file')} could not be written: ${listed(failures, (f) => `${f.name}: ${f.error}`)}.`);
  }
  if (skipped.length > 0) {
    parts.push(`Not written because the format has no tag for them: ${listed(skipped, (s) => `${s.name} (${s.fields.join(', ')})`)}.`);
  }

  let toast;
  if (failures.length > 0) {
    toast = { type: written > 0 ? 'warning' : 'error', title: written > 0 ? 'Write Partly Complete' : 'Write Failed', message: parts.join(' ') };
  } else if (skipped.length > 0) {
    toast = { type: 'warning', title: 'Some Fields Not Written', message: parts.join(' ') };
  } else if (written > 0) {
    toast = { type: 'success', title: 'Write Complete', message: parts.join(' ') };
  } else {
    toast = { type: 'info', title: 'Nothing Written', message: 'No file had a change the writer could write.' };
  }
  return { written, failures, skipped, toast };
}

// Same rule as applyMetadataToGroup: a representative file's change count.
function totalChanges(files) {
  const representative = files.find((f) => Object.keys(f.changes || {}).length > 0);
  return representative ? Object.keys(representative.changes).length : 0;
}

/**
 * Apply a write_tags result (with `result.sent`, the filesMap that was sent)
 * to the groups:
 *  - a written file loses the staged changes that were sent and embedded, so
 *    the same change is not offered again; fields the writer skipped, and
 *    fields never sent (app-only, unsupported by the format, unchecked in the
 *    preview), stay staged;
 *  - a failed file keeps every staged change;
 *  - a book with a failed file gets lastError (severity error) naming each
 *    file and reason; a book with only skipped fields gets a warning; a clean
 *    write clears an earlier write error (never another stage's).
 */
export function applyWriteResult(groups, result) {
  const sent = result?.sent || {};
  const results = Array.isArray(result?.results) ? result.results : [];
  const byId = new Map(results.map((r) => [r.file_id, r]));
  const { failures, skipped } = summarizeWriteResult(result, groups);
  const failuresByGroup = new Map();
  for (const f of failures) failuresByGroup.set(f.groupId, [...(failuresByGroup.get(f.groupId) || []), f]);
  const skippedByGroup = new Map();
  for (const s of skipped) skippedByGroup.set(s.groupId, [...(skippedByGroup.get(s.groupId) || []), s]);

  return (groups || []).map((g) => {
    const touched = failuresByGroup.has(g.id) || (g.files || []).some((f) => byId.has(f.id));
    if (!touched) return g;
    const files = g.files.map((f) => {
      const r = byId.get(f.id);
      if (!r || r.status !== 'success' || !sent[f.id]) return f;
      const notEmbedded = new Set(r.skipped_fields || []);
      const changes = {};
      for (const [field, change] of Object.entries(f.changes || {})) {
        const wasWritten = field in sent[f.id].changes && !notEmbedded.has(field);
        if (!wasWritten) changes[field] = change;
      }
      return { ...f, changes, status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged' };
    });
    const next = { ...g, files, total_changes: totalChanges(files) };
    const groupFailures = failuresByGroup.get(g.id);
    const groupSkipped = skippedByGroup.get(g.id);
    if (groupFailures) {
      next.lastError = {
        stage: 'write', kind: 'write', severity: 'error',
        message: `Tags not written: ${groupFailures.map((f) => `${f.name}: ${f.error}`).join('; ')}`,
      };
    } else if (groupSkipped) {
      next.lastError = {
        stage: 'write', kind: 'write', severity: 'warn',
        message: `Written, but this format has no tag for: ${groupSkipped.map((s) => `${s.name} (${s.fields.join(', ')})`).join('; ')}`,
      };
    } else if (g.lastError?.stage === 'write') {
      next.lastError = undefined;
    }
    return next;
  });
}

/**
 * Read a rename_files result. Returns
 *   { renamed, failures: [{ groupId, name, error }], toast }.
 */
export function summarizeRenameResult(result, groups) {
  const byPath = new Map();
  for (const g of groups || []) for (const f of g.files || []) if (f.path) byPath.set(f.path, g);
  const results = Array.isArray(result?.results) ? result.results : [];
  const renamed = Array.isArray(result?.renamed)
    ? result.renamed.length
    : results.filter((r) => r.status === 'renamed').length;
  const failures = results
    .filter((r) => r.status === 'failed')
    .map((r) => ({ groupId: byPath.get(r.old_path)?.id ?? null, name: fileNameOf(r.old_path), error: String(r.error || 'not renamed') }));

  let toast;
  const failedText = failures.length > 0
    ? `${plural(failures.length, 'file')} could not be renamed: ${listed(failures, (f) => `${f.name}: ${f.error}`)}.`
    : '';
  if (renamed > 0 && failures.length === 0) {
    toast = { type: 'success', title: 'Files Renamed', message: `Renamed ${plural(renamed, 'file')}.` };
  } else if (renamed > 0) {
    toast = { type: 'warning', title: 'Some Renames Failed', message: `Renamed ${plural(renamed, 'file')}. ${failedText}` };
  } else {
    toast = { type: 'error', title: 'Rename Failed', message: failedText || 'No files were renamed.' };
  }
  return { renamed, failures, toast };
}

/**
 * Apply a rename_files result: each renamed file takes its new path and
 * filename; a book with a file that could not be renamed gets lastError
 * naming the file and reason.
 */
export function applyRenameResult(groups, result) {
  const results = Array.isArray(result?.results) ? result.results : (result?.renamed || []);
  const moved = new Map();
  for (const r of results) {
    if (r?.status === 'renamed' && r.old_path && r.new_path) moved.set(r.old_path, r.new_path);
  }
  const { failures } = summarizeRenameResult(result, groups);
  const failuresByGroup = new Map();
  for (const f of failures) failuresByGroup.set(f.groupId, [...(failuresByGroup.get(f.groupId) || []), f]);

  return (groups || []).map((g) => {
    const hasMove = (g.files || []).some((f) => moved.has(f.path));
    const groupFailures = failuresByGroup.get(g.id);
    if (!hasMove && !groupFailures) return g;
    const files = hasMove
      ? g.files.map((f) => {
        const np = moved.get(f.path);
        return np ? { ...f, path: np, filename: fileNameOf(np) } : f;
      })
      : g.files;
    const next = { ...g, files };
    if (groupFailures) {
      next.lastError = {
        stage: 'rename', kind: 'rename', severity: 'error',
        message: `Not renamed: ${groupFailures.map((f) => `${f.name}: ${f.error}`).join('; ')}`,
      };
    } else if (g.lastError?.stage === 'rename') {
      next.lastError = undefined;
    }
    return next;
  });
}
