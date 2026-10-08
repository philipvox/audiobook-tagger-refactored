// absPush.js: pure helpers for the "Push to AudiobookShelf" flow (#60).
//
// Routing used to key off `files.length === 0`, but books imported from ABS
// carry their audio files too, so they were sent down the path-based branch,
// which never included the ABS item id and failed every item with
// "Missing item ID" - silently. These helpers route by ABS id instead and
// normalise the two backend result shapes so the UI can report outcomes.

/** The ABS library item id for a group, or null if it is not ABS-backed. */
export function getAbsId(group) {
  if (!group) return null;
  if (group.abs_id) return group.abs_id;
  // Imported groups always set abs_id; source==='abs' with only `id` is a
  // defensive fallback (absItemToBookGroup sets id = item.id).
  if (group.source === 'abs' && group.id) return group.id;
  return null;
}

/**
 * Single definition of "this book lives in AudiobookShelf". Use this instead
 * of `files.length === 0`: imported books carry their audio files (#60).
 */
export function isAbsBacked(group) {
  return getAbsId(group) != null;
}

/**
 * Restrict a set of selected file ids to the files of the given groups, so a
 * mixed selection does not send ABS-backed books down a local-file path.
 */
export function fileIdsInGroups(fileIds, groups) {
  const allowed = new Set();
  for (const g of groups || []) {
    for (const f of g.files || []) if (f.id != null) allowed.add(f.id);
  }
  return new Set([...(fileIds || [])].filter(id => allowed.has(id)));
}

/** Split push groups into ABS-backed (push by id) and genuinely local ones. */
export function partitionPushGroups(groups) {
  const absGroups = [];
  const localGroups = [];
  for (const g of groups || []) {
    if (isAbsBacked(g)) absGroups.push(g);
    else localGroups.push(g);
  }
  return { absGroups, localGroups };
}

/** Coerce a count-or-array field to a number. */
export function toCount(value) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Turn one backend error entry (string or {id, error}) into a message. */
export function errorMessage(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err.error) return err.id && err.id !== 'unknown' ? `${err.id}: ${err.error}` : String(err.error);
  if (err.message) return String(err.message);
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Normalise a push result from push_abs_imports ({updated, failed, errors})
 * or push_abs_updates ({success, failed, errors}) or the hook's own
 * aggregated shape into { updated, failed, errors: string[] }.
 */
export function normalizePushResult(result) {
  const r = result || {};
  const errors = (Array.isArray(r.errors) ? r.errors : [])
    .map(errorMessage)
    .filter(Boolean);
  return {
    updated: toCount(r.updated ?? r.success),
    failed: toCount(r.failed),
    errors,
  };
}

/** Add several normalised results together. */
export function mergePushResults(...results) {
  const out = { updated: 0, failed: 0, errors: [] };
  for (const r of results) {
    if (!r) continue;
    const n = normalizePushResult(r);
    out.updated += n.updated;
    out.failed += n.failed;
    out.errors.push(...n.errors);
  }
  return out;
}

/**
 * Build the user-facing summary for a finished push.
 * Returns { type: 'success'|'warning'|'error'|'info', title, message }.
 */
export function summarizePush({ updated, failed, errors }, attempted) {
  const firstError = errors?.[0] ? ` First error: ${errors[0]}` : '';
  const plural = (n) => (n === 1 ? '' : 's');
  if (failed === 0 && updated > 0) {
    return {
      type: 'success',
      title: 'Push Complete',
      message: `Updated ${updated} book${plural(updated)} in AudiobookShelf.`,
    };
  }
  if (updated === 0 && failed > 0) {
    return {
      type: 'error',
      title: 'Push Failed',
      message: `No books were updated; ${failed} failed.${firstError}`,
    };
  }
  if (failed > 0) {
    return {
      type: 'warning',
      title: 'Push Partially Complete',
      message: `Updated ${updated}, failed ${failed}.${firstError}`,
    };
  }
  return {
    type: attempted > 0 ? 'warning' : 'info',
    title: 'Nothing Pushed',
    message: attempted > 0
      ? `None of the ${attempted} selected book${plural(attempted)} were pushed.`
      : 'No books were selected to push.',
  };
}

/**
 * Orchestrate a push for the confirmed groups (#60).
 *
 *   pushById(groups)        -> handlePushAbsImports; used for every ABS-backed
 *                              group, whether or not it carries files.
 *   pushByFileIds(Set<id>)  -> pushToAudiobookShelf; only for local groups.
 *
 * A branch that throws is recorded as all of its books failing, so one
 * branch's failure never hides the other's outcome. Never throws.
 * Returns { attempted, updated, failed, errors, summary }.
 */
export async function runPush(groups, { pushById, pushByFileIds }) {
  const { absGroups, localGroups } = partitionPushGroups(groups);
  const parts = [];

  if (absGroups.length > 0) {
    try {
      parts.push(await pushById(absGroups));
    } catch (error) {
      parts.push({ updated: 0, failed: absGroups.length, errors: [String(error?.message || error)] });
    }
  }

  if (localGroups.length > 0) {
    // M15: build the file-id set from the snapshot taken at modal open.
    const fileIds = new Set();
    localGroups.forEach(g =>
      (g.files || []).forEach(f => { if (f.id != null) fileIds.add(f.id); })
    );
    try {
      parts.push(await pushByFileIds(fileIds));
    } catch (error) {
      parts.push({ updated: 0, failed: localGroups.length, errors: [String(error?.message || error)] });
    }
  }

  const merged = mergePushResults(...parts);
  const attempted = absGroups.length + localGroups.length;
  return {
    attempted,
    absCount: absGroups.length,
    localCount: localGroups.length,
    ...merged,
    summary: summarizePush(merged, attempted),
  };
}
