// applyTagResults - pure per-group appliers for AI Tags and Generate DNA (audit C-2).
//
// Both go through mergeClassifyTags so curated ABS tags are never replaced
// wholesale: old dna: tags are dropped only when new dna: tags came back.
// Changes are stamped via applyMetadataToGroup so changedFields/file.changes
// are tracked the same way the Classify action tracks them.

import { mergeClassifyTags } from './mergeClassifyTags';
import { applyMetadataToGroup } from './applyMetadata';

const nonEmpty = (a) => Array.isArray(a) && a.length > 0;

// Tag lists to keep: the ABS import snapshot when present, else everything
// currently on the book (nothing existing is ever dropped).
const keepTags = (group) => group.abs_original?.tags ?? group.metadata?.tags ?? [];

// lastError is cleared by a clean run for the same stage only.
const clearStage = (group, stage) =>
  group.lastError && group.lastError.stage === stage ? { ...group, lastError: undefined } : group;

const withError = (group, stage, kind, message) => ({
  ...group,
  lastError: { stage, kind, message, severity: 'error' },
});

// results from generate_book_dna_batch may be an array or { results: [...] }.
export function normalizeResults(res) {
  return Array.isArray(res) ? res : (res?.results || []);
}

// tagResult: one entry of assign_tags_with_gpt results, or undefined.
// Returns { group, outcome } where outcome is 'ok' | 'partial' | 'failed' | 'empty' | 'none'.
export function applyTagsResultToGroup(group, tagResult) {
  if (!tagResult) return { group, outcome: 'none' };
  if (!tagResult.success) {
    return {
      group: withError(group, 'tags', 'ai', tagResult.error || 'AI Tags failed.'),
      outcome: 'failed',
    };
  }
  if (!nonEmpty(tagResult.tags) && !nonEmpty(tagResult.dna_tags)) {
    return {
      group: withError(group, 'tags', 'parse', 'The AI returned no tags, so nothing was changed.'),
      outcome: 'empty',
    };
  }
  const existing = group.metadata?.tags || [];
  const merged = mergeClassifyTags(
    existing,
    { tags: tagResult.tags, dna_tags: tagResult.dna_tags },
    keepTags(group)
  );
  let next = merged.changed ? applyMetadataToGroup(group, { tags: merged.tags }, ['tags']) : group;
  if (tagResult.dna_error) {
    return {
      group: withError(next, 'tags', 'dna', `DNA tags were not updated: ${tagResult.dna_error}`),
      outcome: 'partial',
    };
  }
  return { group: clearStage(next, 'tags'), outcome: 'ok' };
}

// dnaResult: one entry of generate_book_dna_batch results, or undefined.
export function applyDnaResultToGroup(group, dnaResult) {
  if (!dnaResult) return { group, outcome: 'none' };
  if (!dnaResult.success || !nonEmpty(dnaResult.dna_tags)) {
    return {
      group: withError(group, 'dna', 'ai', dnaResult.error || 'DNA generation returned nothing.'),
      outcome: 'failed',
    };
  }
  const existing = group.metadata?.tags || [];
  const merged = mergeClassifyTags(existing, { dna_tags: dnaResult.dna_tags }, existing);
  const next = merged.changed ? applyMetadataToGroup(group, { tags: merged.tags }, ['tags']) : group;
  return { group: clearStage(next, 'dna'), outcome: 'ok' };
}
