// src/api.js
// Transport adapter, 100% client-side. No backend server needed.
// All API calls go through the Cloudflare Worker CORS proxy.
// Config lives in browser localStorage.

import { absApi, callAI, parseAIJson, proxyFetch, retryOn429, usesLocalAi, resolveOpenAIModel } from './lib/proxy';
import { buildMetadataPrompt, buildClassificationPrompt, buildBatchClassificationPrompt, buildBatchMetadataPrompt, buildDescriptionPrompt, buildDnaPrompt, BOOK_DNA_SYSTEM_PROMPT, BOOK_DNA_SYSTEM_PROMPT_COMPACT, SYSTEM_PROMPT, DEFAULT_TAG_INSTRUCTIONS } from './lib/prompts';
import { toTitleCase, removeJunkSuffixes, cleanAuthorName, cleanNarratorName, isPlaceholderAuthor, isPlaceholderTitle } from './lib/normalize';
import { isPlaceholderSeries } from './lib/absPayload.js';
import { lookupHitMatch, lookupHitMatches, pickLookupHit, hasRealAuthor } from './lib/lookupMatch.js';
import { APPROVED_GENRES, APPROVED_TAGS, GENRE_ALIASES, mapGenre, enforceGenrePolicyWithSplit } from './lib/genres';
import { pushAbsItems } from './lib/absPush.js';
import { isCancelled } from './lib/cancel.js';
import { absItemsToBookGroups } from './lib/absGroup.js';
import { isTauri } from './lib/platform.js';
import { DEFAULT_OPENAI_MODEL } from './lib/configSave.js';
import { mapAgeCategory } from './lib/ageCategory.js';
import { makeErrorDetail, errorDetailFromException } from './lib/errorDetail.js';

/** Safely serialize a value for AI prompts (escapes quotes/newlines). */
function safe(value) {
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(String(value));
}

/** Get the effective system prompt (custom override or default). */
function getSystemPrompt(config) {
  return config?.custom_system_prompt?.trim() || SYSTEM_PROMPT;
}

/** Get the effective DNA system prompt (custom override or default).
 *  Uses compact prompt for local AI, fewer fields, ~50% less output. */
function getDnaSystemPrompt(config) {
  if (config?.custom_dna_prompt?.trim()) return config.custom_dna_prompt.trim();
  const isLocal = usesLocalAi(config);
  return isLocal ? BOOK_DNA_SYSTEM_PROMPT_COMPACT : BOOK_DNA_SYSTEM_PROMPT;
}

// ============================================================================
// LOCAL CONFIG (browser localStorage)
// ============================================================================

const CONFIG_KEY = 'audiobook_tagger_config';

const DEFAULT_CONFIG = {
  abs_base_url: '',
  abs_api_token: '',
  abs_library_id: '',
  openai_api_key: null,
  anthropic_api_key: null,
  backup_tags: true,
  genre_enforcement: true,
  // #54: when true, AI classification genres SUPPLEMENT the book's existing
  // genres instead of replacing them. On by default; readers use `!== false`.
  // getLocalConfig migrates configs saved before the default flipped (marker
  // genres_default_v2).
  preserve_existing_genres: true,
  genres_default_v2: true,
  // #54: when true, tags outside the approved vocabulary survive the ABS push
  // with their original casing instead of being dropped by mapTag. Off by
  // default (and an absent key reads as false).
  preserve_existing_tags: false,
  performance_preset: 'balanced',
  ai_model: DEFAULT_OPENAI_MODEL,
  ai_base_url: 'https://api.openai.com',
  // use_local_ai is intentionally omitted from defaults: `undefined` means the
  // user has never made a choice (allows one-time Ollama auto-detect), while an
  // explicit `true`/`false` is a user decision that auto-detect must respect.
  ollama_model: null,
  ollama_base_url: '',
  local_concurrency: 2,
  cloud_concurrency: 5,
  local_skip_dna: true,
  custom_providers: [],
};

export function getLocalConfig() {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
      // A model OpenAI has retired shows (and runs) as its replacement. Not
      // written back: the stored config only changes on an explicit save.
      if (cfg.ai_model) cfg.ai_model = resolveOpenAIModel(cfg.ai_model, cfg.ai_base_url || undefined);
      // One-time migration: older saves persisted preserve_existing_genres:false
      // (the old default). Flip it once, then the marker protects later choices.
      const raw = JSON.parse(stored);
      if (raw.genres_default_v2 !== true) {
        cfg.preserve_existing_genres = true;
        cfg.genres_default_v2 = true;
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { /* non-fatal */ }
      }
      return cfg;
    }
  } catch (e) {
    console.warn('Failed to load config:', e);
  }
  return { ...DEFAULT_CONFIG };
}

// Default Ollama base URL when user has not configured a remote instance.
// Keep in sync with effective_base() in src-tauri/src/ollama.rs and whisper.rs.
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

// Returns the configured Ollama base URL, falling back to localhost default.
export function getOllamaBaseUrl() {
  const configured = getLocalConfig().ollama_base_url?.trim();
  return configured || DEFAULT_OLLAMA_BASE_URL;
}

// Wrapper for Ollama-touching Tauri commands, injects baseUrl from config.
export async function ollamaCall(cmd, args = {}) {
  return callBackend(cmd, { baseUrl: getOllamaBaseUrl(), ...args });
}

export function saveLocalConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      throw new Error('Browser storage is full. Clear some data in Settings or use a different browser.');
    }
    console.warn('Failed to save config:', e);
    throw new Error('Failed to save settings: ' + e.message);
  }
}

// ============================================================================
// Tauri-native command overrides (populated lazily on first use)
// ============================================================================

let tauriInvoke = null;

async function getTauriInvoke() {
  if (!tauriInvoke) {
    const { invoke } = await import('@tauri-apps/api/core');
    tauriInvoke = invoke;
  }
  return tauriInvoke;
}

// Commands that route to Rust when running in Tauri
const TAURI_COMMANDS = new Set([
  'scan_library',
  // #62: local folder scan progress and cancel. The HANDLERS stubs below are
  // the browser-build fallback only (the browser build has no local scanning).
  'get_scan_progress',
  'cancel_scan',
  // Task 9b: local-file write/undo/rename backend (Tauri-only; the browser build
  // keeps the stub behavior, which the frontend already reports as a visible
  // failure). No HANDLERS fallback by design.
  'write_tags',
  'get_undo_status',
  'undo_last_write',
  'clear_undo_state',
  'preview_rename',
  'rename_files',
  // #58: session snapshot + persistent operation log. Tauri-only by design.
  // The browser build has no writable app data dir, so src/lib/session.js
  // branches on isTauri() and falls back to localStorage rather than relying
  // on a HANDLERS stub, and logEvent no-ops entirely.
  'save_session',
  'load_session',
  'clear_session',
  'preserve_session',
  'append_log',
  'get_log_path',
  'ollama_get_status',
  'ollama_get_model_presets',
  'ollama_get_disk_usage',
  'ollama_start',
  'ollama_stop',
  'ollama_install',
  'ollama_uninstall',
  'ollama_pull_model',
  'ollama_delete_model',
  'extract_audio_intro',
  'batch_extract_audio_intros',
  'cancel_audio_extraction',
  'whisper_local_get_status',
  'whisper_local_get_model_presets',
  'whisper_local_install',
  'whisper_local_download_model',
  'whisper_local_delete_model',
  'whisper_local_get_disk_usage',
  'whisper_local_uninstall',
]);

// ============================================================================
// callBackend(), main dispatch function
// Routes commands to client-side handlers or CORS proxy.
// All existing component code calls this, we just changed what's under the hood.
// ============================================================================

export async function callBackend(cmd, args = {}) {
  // In Tauri, check if this command has a native override
  if (isTauri() && TAURI_COMMANDS.has(cmd)) {
    const invoke = await getTauriInvoke();
    return invoke(cmd, args);
  }

  const handler = HANDLERS[cmd];
  if (handler) {
    return handler(args);
  }

  // v2.2.3: commands with no implementation THROW. Returning a stub object
  // let callers report success for work that never happened (e.g. "Rescan"
  // on ABS books, series analysis). Every caller must surface this error.
  console.warn(`Command '${cmd}' is not implemented`);
  const err = new Error(`'${cmd}' is not available in this version of Audiobook Tagger.`);
  err.code = 'NOT_IMPLEMENTED';
  err.command = cmd;
  throw err;
}

// M-3: a placeholder answer ("N/A", "Unknown", ...) is no answer. It must
// never be staged over the current value, so drop it before the merge.
function withoutPlaceholders(parsed) {
  const clean = { ...parsed };
  if (isPlaceholderTitle(clean.title)) delete clean.title;
  if (isPlaceholderAuthor(clean.author)) delete clean.author;
  if (isPlaceholderAuthor(clean.narrator)) delete clean.narrator;
  if (isPlaceholderSeries(clean.subtitle)) delete clean.subtitle;
  // The sequence belongs to the series: a placeholder series takes its
  // sequence with it. (A missing series is left to the caller's fallback.)
  if (String(clean.series ?? '').trim() && isPlaceholderSeries(clean.series)) { delete clean.series; delete clean.sequence; }
  return clean;
}

// ============================================================================
// RESOLVE RESULT (batch and single-book metadata resolution)
// ============================================================================

// Helper: did the AI produce any non-null value across the fields we asked
// about? Partial results count as useful, we don't want to double-surface
// what the changedFields diff already shows (AI returned data but nothing
// changed is a distinct signal, tracked separately).
function aiReturnedNothingUseful(parsed) {
  if (!parsed || typeof parsed !== 'object') return true;
  const fields = ['title', 'author', 'subtitle', 'series', 'sequence', 'narrator'];
  return !fields.some((f) => {
    const v = parsed[f];
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
}

// Helper: is a value "present" for fallback purposes? Missing (undefined),
// explicit null, and empty string all count as "the AI didn't say anything".
const hasValue = (v) => v !== undefined && v !== null && v !== '';

// Helper: compare two values as strings, collapsing null/undefined to ''
// first so numeric 3 vs "3" (or null vs undefined) isn't a spurious change.
const strEq = (a, b) => (a == null ? '' : String(a)) === (b == null ? '' : String(b));

// M-3: an answer below this confidence changes nothing.
const MIN_CONFIDENCE = 60;

// Build a resolve result from parsed metadata. Shared by the batch handler
// and resolve_title so the single-book path has the same confidence gate and
// placeholder fallbacks.
function buildResolveResult(book, rawParsed, rawResponse) {
  const confidence = Number(rawParsed?.confidence);
  if (rawParsed && typeof rawParsed === 'object' && !aiReturnedNothingUseful(rawParsed)
      && Number.isFinite(confidence) && confidence < MIN_CONFIDENCE) {
    return {
      id: book.id,
      title: book.current_title,
      author: book.current_author,
      subtitle: book.current_subtitle ?? null,
      series: book.current_series ?? null,
      sequence: book.current_sequence ?? null,
      narrator: book.current_narrator ?? null,
      confidence,
      changed: false,
      errorDetail: makeErrorDetail({
        stage: 'resolve',
        kind: 'low-confidence',
        message: `AI confidence ${confidence} is below ${MIN_CONFIDENCE}; kept the current metadata.`,
        responsePreview: rawResponse,
      }),
    };
  }
  const parsed = withoutPlaceholders(rawParsed || {});
  const title = parsed.title || book.current_title;
  const author = parsed.author || book.current_author;
  // item 12: a missing OR null subtitle in the AI response must fall back
  // to the book's current subtitle, same as title/author/series/sequence/
  // narrator - an AI response can't clear a curated subtitle.
  const subtitle = hasValue(parsed.subtitle) ? parsed.subtitle : (book.current_subtitle ?? null);
  // CR-4b: a missing OR null series/sequence in the AI response must fall
  // back to the book's current series/sequence, exactly like title/author
  // do: never to null. An AI response can't clear a series. (0 is a valid
  // sequence value, so we check presence rather than truthiness.)
  const series = hasValue(parsed.series) ? parsed.series : (book.current_series ?? null);
  const sequence = hasValue(parsed.sequence) ? parsed.sequence : (book.current_sequence ?? null);
  console.log(`[series-fix] GPT returned for "${title}": series="${series}" sequence="${sequence}"`);
  if (series && /[#]|\bbook\b|\bvol/i.test(series)) {
    console.warn(`[series-fix] WARNING: GPT returned embedded sequence in series name: "${series}"`);
  }
  // Data-preservation: an AI response that omits narrator shouldn't wipe a
  // curated one either.
  const narrator = hasValue(parsed.narrator) ? parsed.narrator : (book.current_narrator ?? null);
  const changed = title !== book.current_title || author !== book.current_author
    || !strEq(subtitle, book.current_subtitle)
    || series !== (book.current_series || null)
    || !strEq(sequence, book.current_sequence)
    || !strEq(narrator, book.current_narrator);
  const result = { id: book.id, title, author, subtitle, series, sequence, narrator, confidence: parsed.confidence || 75, changed };
  // Silent-success surfacing: the caller already selected this book for
  // resolution (missing/bad author/title/series), so an empty AI response
  // means the model had no grounded signal. Amber pill so the user knows
  // it ran and yielded nothing, not "nothing happened". Checked on the
  // cleaned answer: an all-placeholder answer is as empty as all-null.
  if (aiReturnedNothingUseful(parsed)) {
    result.errorDetail = makeErrorDetail({
      stage: 'resolve',
      kind: 'empty-content',
      message: 'AI returned no usable metadata for this book.',
      responsePreview: rawResponse,
    });
  }
  return result;
}

// Age tags from a classifier age_rating (object or a numeric age). Shared by
// classify_books_batch and resolve_book_age_rating.
function ageTagsFromRating(ageRating) {
  const age_tags = [];
  if (ageRating && typeof ageRating === 'object') {
    age_tags.push(ageRating.intended_for_kids === true ? 'for-kids' : 'not-for-kids');
    const catMap = { "Children's 0-2": 'age-childrens', "Children's 3-5": 'age-childrens', "Children's 6-8": 'age-childrens', "Children's 9-12": 'age-childrens', 'Teen 13-17': 'age-teens', 'Young Adult': 'age-young-adult', 'Adult': 'age-adult', 'Middle Grade': 'age-middle-grade' };
    if (catMap[ageRating.age_category]) age_tags.push(catMap[ageRating.age_category]);
    const ratingMap = { 'G': 'rated-g', 'PG': 'rated-pg', 'PG-13': 'rated-pg13', 'R': 'rated-r', 'X': 'rated-x' };
    if (ratingMap[ageRating.content_rating]) age_tags.push(ratingMap[ageRating.content_rating]);
    const recMap = { "Children's 0-2": 'age-rec-0', "Children's 3-5": 'age-rec-3', "Children's 6-8": 'age-rec-6', "Children's 9-12": 'age-rec-10', 'Teen 13-17': 'age-rec-14', 'Young Adult': 'age-rec-16', 'Adult': 'age-rec-18', 'Middle Grade': 'age-rec-8' };
    if (recMap[ageRating.age_category]) age_tags.push(recMap[ageRating.age_category]);
  } else if (typeof ageRating === 'number') {
    if (ageRating <= 6) age_tags.push('age-childrens', 'for-kids', 'rated-g', 'age-rec-0');
    else if (ageRating <= 9) age_tags.push('age-childrens', 'for-kids', 'rated-g', 'age-rec-6');
    else if (ageRating <= 12) age_tags.push('age-middle-grade', 'for-kids', 'rated-pg', 'age-rec-10');
    else if (ageRating <= 15) age_tags.push('age-teens', 'for-teens', 'rated-pg13', 'age-rec-14');
    else if (ageRating <= 17) age_tags.push('age-young-adult', 'for-ya', 'rated-pg13', 'age-rec-16');
    else age_tags.push('age-adult', 'not-for-kids', 'rated-r', 'age-rec-18');
  }
  return age_tags;
}

// ============================================================================
// DNA-TO-TAGS CONVERTER, converts BookDNA JSON to dna: prefixed tags
// ============================================================================

function convertDnaToTags(dna) {
  const tags = [];
  if (dna.length) tags.push(`dna:length:${dna.length}`);
  if (dna.pacing) tags.push(`dna:pacing:${dna.pacing}`);
  if (dna.structure) tags.push(`dna:structure:${dna.structure}`);
  if (dna.pov) tags.push(`dna:pov:${dna.pov}`);
  if (dna.series_position) tags.push(`dna:series-position:${dna.series_position}`);
  if (dna.pub_era) tags.push(`dna:pub-era:${dna.pub_era}`);
  if (dna.setting) tags.push(`dna:setting:${dna.setting}`);
  if (dna.ending_type) tags.push(`dna:ending:${dna.ending_type}`);
  if (dna.opening_energy) tags.push(`dna:opening-energy:${dna.opening_energy}`);
  if (dna.ending_energy) tags.push(`dna:ending-energy:${dna.ending_energy}`);
  if (dna.humor_type) tags.push(`dna:humor:${dna.humor_type}`);
  if (dna.stakes_level) tags.push(`dna:stakes:${dna.stakes_level}`);
  if (dna.protagonist_count) tags.push(`dna:protagonist:${dna.protagonist_count}`);
  if (dna.prose_style) tags.push(`dna:prose:${dna.prose_style}`);
  if (dna.series_dependency) tags.push(`dna:series-dependency:${dna.series_dependency}`);
  if (dna.production) tags.push(`dna:production:${dna.production}`);
  if (dna.narrator_performance) {
    const perfs = Array.isArray(dna.narrator_performance) ? dna.narrator_performance : [dna.narrator_performance];
    perfs.forEach(p => tags.push(`dna:narrator-performance:${p}`));
  }
  if (dna.audio_friendliness != null) tags.push(`dna:audio-friendliness:${dna.audio_friendliness}`);
  if (dna.re_listen_value != null) tags.push(`dna:re-listen-value:${dna.re_listen_value}`);
  if (dna.violence_level != null) tags.push(`dna:violence-level:${dna.violence_level}`);
  if (dna.intimacy_level != null) tags.push(`dna:intimacy-level:${dna.intimacy_level}`);
  if (dna.tropes) dna.tropes.forEach(t => tags.push(`dna:trope:${t}`));
  if (dna.themes) dna.themes.forEach(t => tags.push(`dna:theme:${t}`));
  if (dna.relationship_focus) {
    const rels = Array.isArray(dna.relationship_focus) ? dna.relationship_focus : [dna.relationship_focus];
    rels.forEach(r => tags.push(`dna:relationship:${r}`));
  }
  if (dna.shelves) {
    const shelves = Array.isArray(dna.shelves) ? dna.shelves : [dna.shelves];
    shelves.forEach(s => tags.push(`dna:shelf:${s}`));
  }
  if (dna.comp_authors) {
    const authors = Array.isArray(dna.comp_authors) ? dna.comp_authors : [dna.comp_authors];
    authors.forEach(a => tags.push(`dna:comp-author:${a}`));
  }
  if (dna.comp_vibes) {
    const vibes = Array.isArray(dna.comp_vibes) ? dna.comp_vibes : [dna.comp_vibes];
    vibes.forEach(v => tags.push(`dna:comp-vibe:${v}`));
  }
  if (dna.spectrums) {
    const specs = Array.isArray(dna.spectrums) ? dna.spectrums : [];
    specs.forEach(s => { if (s.dimension != null && s.value != null) tags.push(`dna:spectrum:${s.dimension}:${s.value}`); });
  }
  if (dna.moods) {
    const moods = Array.isArray(dna.moods) ? dna.moods : [];
    moods.forEach(m => { if (m.mood && m.intensity != null) tags.push(`dna:mood:${m.mood}:${m.intensity}`); });
  }
  return tags;
}

// ============================================================================
// ABS PAYLOAD BUILDER, matches desktop build_update_payload() exactly
// ============================================================================

// buildAbsPayload lives in ./lib/absPayload.js (v2.2.3 diff-based push).
// Both push commands go through pushAbsItems (lib/absPush.js): per book it
// diffs against the import snapshot, re-reads the live item, rebases tags and
// genres on it (H-5) and reports { updated, skipped, failed } (M-9), running
// config.concurrency_abs_push books at a time (H-11).
async function pushAbsHandler(args) {
  const config = getLocalConfig();
  const { abs_base_url: baseUrl, abs_api_token: token } = config;
  const items = args.request?.items || args.items || [];

  // Q: fail fast without issuing N doomed requests when ABS isn't
  // configured, but still name every book that was not pushed.
  if (!baseUrl || !token) {
    const error = 'ABS is not configured: missing base URL or API token';
    return {
      updated: [],
      skipped: [],
      failed: items.map((item) => ({
        id: item?.id ?? item?.group_id ?? item?.abs_id ?? null,
        title: item?.metadata?.title || '',
        error,
      })),
      snapshots: {},
    };
  }

  // H-7: the caller's cancel token (args.cancel, lib/cancel.js) stops the
  // pool; books not started come back skipped 'cancelled'.
  return pushAbsItems(items, {
    request: (path, options) => absApi(baseUrl, token, path, options),
    cfg: config,
    shouldStop: () => isCancelled(args.cancel),
    // I-2: per-book progress for the push modal and the scan bar.
    onProgress: (current, total, title) => emitEvent('push_progress', {
      current, total, message: title ? `Pushed ${title}` : `Pushed ${current} of ${total}`,
    }),
  });
}

// ============================================================================
// COMMAND HANDLERS, client-side implementations
// ============================================================================

const HANDLERS = {
  // === Config (localStorage) ===
  get_config: () => getLocalConfig(),
  save_config: (args) => { saveLocalConfig(args.config || args); return {}; },

  // === ABS Connection ===
  test_abs_connection: async (args) => {
    const config = args.config || getLocalConfig();
    if (!config.abs_base_url) return { success: false, message: 'No URL configured' };
    try {
      await absApi(config.abs_base_url, config.abs_api_token, '/api/libraries');
      return { success: true, message: `Connected to ${config.abs_base_url}` };
    } catch (err) {
      return { success: false, message: err.message };
    }
  },

  // === ABS Import ===
  import_from_abs: async (args) => {
    const config = getLocalConfig();
    const { abs_base_url: baseUrl, abs_api_token: token, abs_library_id: libraryId } = config;
    if (!baseUrl || !token || !libraryId) {
      throw new Error('Configure ABS URL, token, and library ID in Settings first');
    }

    const allItems = [];
    let page = 0;
    const limit = 100;

    // Pagination guards: some ABS responses omit `total`, in which case the
    // old `allItems.length < total` condition (total defaulting to 0) exited
    // after a single page even when more data existed. Loop on page shape
    // instead: keep going while the last page was a full page, stop on an
    // empty or short page, and cap iterations so a misbehaving server can't
    // spin this forever.
    // H-7: a cancelled import (args.cancel, lib/cancel.js) changes nothing;
    // the caller must not replace or merge the workspace when it sees
    // `cancelled`.
    const cancel = args?.cancel;
    const cancelledResult = { cancelled: true, groups: [], total: 0 };
    // I-1: progress for the scan bar (useScan subscribes to import_progress).
    let knownTotal = 0;
    const progress = (current, total, message, phase) => emitEvent('import_progress', { current, total, message, phase });
    while (true) {
      progress(allItems.length, knownTotal, `Fetching books from AudiobookShelf (page ${page + 1})...`, 'fetch');
      const data = await absApi(baseUrl, token, `/api/libraries/${libraryId}/items?limit=${limit}&page=${page}&expanded=1`);
      if (isCancelled(cancel)) return cancelledResult;
      const items = data.results || [];
      const total = data.total || 0;
      if (total) knownTotal = total;
      allItems.push(...items);
      progress(allItems.length, knownTotal || allItems.length, `Fetched ${allItems.length}${knownTotal ? ` of ${knownTotal}` : ''} books`, 'fetch');
      page++;
      if (items.length === 0) break;
      if (total && allItems.length >= total) break;
      if (items.length < limit) break;
      if (page > 1000) { console.warn('[import_from_abs] Pagination cap (1000 pages) hit; stopping.'); break; }
    }

    // Convert ABS items to book groups (shared builder, see lib/absGroup.js).
    const groups = await absItemsToBookGroups(
      baseUrl, token, allItems,
      (index, total) => {
        if ((index + 1) % 100 === 0 || index + 1 === total) progress(index + 1, total, `Building ${index + 1} of ${total} books`, 'build');
      },
      (done, total) => progress(done, total, `Reading series ${done} of ${total}`, 'series'),
      { shouldStop: () => isCancelled(cancel) },
    );
    if (isCancelled(cancel)) return cancelledResult;
    return { groups, total: groups.length };
  },

  // === ABS Push === (single-book / by-path push and the batch push share
  // one per-book path and one result shape, see pushAbsHandler)
  push_abs_updates: (args) => pushAbsHandler(args),
  push_abs_imports: (args) => pushAbsHandler(args),

  // === ABS Chapters ===
  get_abs_chapters: async (args) => {
    const config = getLocalConfig();
    const data = await absApi(config.abs_base_url, config.abs_api_token, `/api/items/${args.absId}`);
    return { chapters: data.media?.chapters || [] };
  },

  // === Full Pipeline (matching desktop process_with_pipeline) ===
  process_with_pipeline: async (args) => {
    const config = getLocalConfig();
    const isLocalAI = usesLocalAi(config);
    const request = args.request || {};
    const books = request.books || [];
    const results = [];
    let processed = 0, failed = 0, cancelled = 0;

    for (let i = 0; i < books.length; i++) {
      // H-7: a Cancel (args.cancel) starts no further book; done books stay done.
      if (isCancelled(args.cancel)) { cancelled = books.length - i; break; }
      const book = books[i];
      try {
        emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'classifying', message: `Classifying ${book.title}...` });

        // Step 1: Classification (genres, tags, age, themes, tropes)
        const classifyPrompt = buildClassificationPrompt(book, null, config.custom_classification_rules || null);
        const classifyResponse = await callAI(config, getSystemPrompt(config), classifyPrompt, 2000);
        const classify = parseAIJson(classifyResponse);

        // H: capture DNA/description sub-step failures as errorDetail (same
        // shape the classify handler uses) instead of console.warn only, so
        // the UI can render a diagnosable pill. Keeps whichever failed first
        // (DNA runs before description) if both fail.
        let subStepError = null;

        // Step 2: DNA generation
        let dna_tags = [];
        try {
          emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'dna', message: `DNA for ${book.title}...` });
          const dnaPrompt = buildDnaPrompt(book);
          const dnaResponse = await callAI(config, getDnaSystemPrompt(config), dnaPrompt, 1500);
          dna_tags = convertDnaToTags(parseAIJson(dnaResponse));
        } catch (e) {
          console.warn('DNA failed:', e.message);
          subStepError = errorDetailFromException(e, { stage: 'dna' });
        }

        // Step 3: Description
        let description = book.description;
        let description_changed = false;
        try {
          emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'description', message: `Description for ${book.title}...` });
          const descPrompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
          const descResponse = await callAI(config, getSystemPrompt(config), descPrompt, 800);
          const desc = parseAIJson(descResponse);
          if (desc.description) { description = desc.description; description_changed = true; }
        } catch (e) {
          console.warn('Description failed:', e.message);
          if (!subStepError) subStepError = errorDetailFromException(e, { stage: 'description' });
        }

        // Build age tags from structured age_rating
        const age_tags = [];
        const ar = classify.age_rating;
        if (ar && typeof ar === 'object') {
          age_tags.push(ar.intended_for_kids ? 'for-kids' : 'not-for-kids');
          const catMap = { "Children's 0-2": 'age-childrens', "Children's 3-5": 'age-childrens', "Children's 6-8": 'age-childrens', "Children's 9-12": 'age-childrens', 'Teen 13-17': 'age-teens', 'Young Adult': 'age-young-adult', 'Adult': 'age-adult', 'Middle Grade': 'age-middle-grade' };
          if (catMap[ar.age_category]) age_tags.push(catMap[ar.age_category]);
          const rMap = { 'G': 'rated-g', 'PG': 'rated-pg', 'PG-13': 'rated-pg13', 'R': 'rated-r' };
          if (rMap[ar.content_rating]) age_tags.push(rMap[ar.content_rating]);
        }

        // Merge all tags
        const allTags = [...new Set([...(classify.tags || []), ...age_tags, ...dna_tags])];

        const pipelineResult = {
          abs_id: book.abs_id,
          success: true,
          metadata: {
            genres: classify.genres || [],
            tags: allTags,
            themes: classify.themes || [],
            tropes: classify.tropes || [],
            description,
          },
        };
        if (subStepError) pipelineResult.errorDetail = subStepError;
        results.push(pipelineResult);
        processed++;
      } catch (err) {
        results.push({ abs_id: book.abs_id, success: false, error: err.message });
        failed++;
      }
    }
    return { books: results, processed, failed, ...(cancelled > 0 && { cancelled }) };
  },

  // === External Data Gathering ===
  // Two-tier lookup:
  //   1. If book has an ASIN, hit Audnexus (api.audnex.us), authoritative audiobook DB with CORS.
  //   2. Otherwise search OpenLibrary by title (+author), good recall, CORS, free.
  // Results are keyed by book id and shaped with `abs_*` field names because that's
  // what handleMetadataResolution already consumes.
  gather_external_data: async (args) => {
    const books = args.books || [];
    const CONCURRENCY = 3; // polite, these are free public APIs
    const results = [];

    const asJoinedNames = (arr) => {
      if (!Array.isArray(arr)) return null;
      const names = arr
        .map(x => typeof x === 'string' ? x : x?.name)
        .filter(s => s && String(s).trim());
      return names.length ? names.join(', ') : null;
    };

    const lookupByAsin = async (asin, book) => {
      const url = `https://api.audnex.us/books/${encodeURIComponent(asin)}`;
      try {
        // M: route through proxyFetch (like get_abs_author_image etc. do) so
        // the Tauri HTTP plugin bypasses CORS natively and the 30s timeout
        // applies uniformly, instead of a bare unbounded fetch(). A 429 is
        // retried with backoff (M-2).
        const res = await retryOn429(() => proxyFetch(url, {
          headers: { 'Accept': 'application/json' },
        }));
        if (!res.ok) {
          const preview = await res.text().catch(() => '');
          return { _error: makeErrorDetail({
            stage: 'gather-audnexus', kind: 'http',
            message: `Audnexus lookup failed: HTTP ${res.status}`,
            statusCode: res.status, url, responsePreview: preview,
          }) };
        }
        const d = await res.json();
        // M-3: an ASIN can be wrong too. A record for another book is no
        // result, so the title lookup gets its turn.
        if (!lookupHitMatches(book, { title: d.title, authors: (d.authors || []).map(a => a?.name || a) })) {
          return null;
        }
        return {
          abs_title: d.title || null,
          abs_subtitle: d.subtitle || null,
          abs_author: asJoinedNames(d.authors),
          abs_narrator: asJoinedNames(d.narrators),
          abs_series: d.seriesPrimary?.name || null,
          abs_sequence: d.seriesPrimary?.position || null,
          abs_description: d.description || (d.summary && String(d.summary).replace(/<[^>]+>/g, '').trim()) || null,
          abs_publisher: d.publisherName || null,
          abs_language: d.language || null,
          abs_year: d.releaseDate ? String(d.releaseDate).substring(0, 4) : null,
          source: 'audnexus',
        };
      } catch (err) {
        return { _error: errorDetailFromException(err, { stage: 'gather-audnexus', url }) };
      }
    };

    const lookupByTitle = async (title, author) => {
      if (!title || !String(title).trim()) return null;
      const hasAuthor = hasRealAuthor(author);
      const params = new URLSearchParams({
        title: String(title).trim(),
        limit: '5',
        fields: 'title,subtitle,author_name,isbn,first_publish_year,publisher',
      });
      if (hasAuthor) params.set('author', String(author).trim());
      const url = `https://openlibrary.org/search.json?${params}`;
      try {
        // M: route through proxyFetch - see lookupByAsin above.
        const res = await retryOn429(() => proxyFetch(url, {
          headers: { 'Accept': 'application/json' },
        }));
        if (!res.ok) {
          const preview = await res.text().catch(() => '');
          return { _error: makeErrorDetail({
            stage: 'gather-openlibrary', kind: 'http',
            message: `OpenLibrary lookup failed: HTTP ${res.status}`,
            statusCode: res.status, url, responsePreview: preview,
          }) };
        }
        const d = await res.json();
        const docs = (d.docs || []).slice(0, 5);
        if (docs.length === 0) return null;

        const candidates = docs.map(doc => ({
          title: doc.title || null,
          subtitle: doc.subtitle || null,
          author: asJoinedNames(doc.author_name),
          year: doc.first_publish_year ? String(doc.first_publish_year) : null,
          isbn: (doc.isbn || []).find(i => i.length === 13) || (doc.isbn || [])[0] || null,
          publisher: Array.isArray(doc.publisher) ? doc.publisher[0] : (doc.publisher || null),
        })).filter(c => c.author)
          // M-3: a hit for another book is no result (see lookupMatch.js).
          // Exact title matches come first, so the top hit is never a
          // containment match while an exact one exists.
          .map(c => ({ c, quality: lookupHitMatch({ title, author }, { title: c.title, authors: c.author }) }))
          .filter(x => x.quality)
          .sort((a, b) => (a.quality === 'exact' ? 0 : 1) - (b.quality === 'exact' ? 0 : 1))
          .map(x => x.c);

        if (candidates.length === 0) return null;

        // If we got the author parameter, we can be confident in the top hit.
        // Otherwise (title-only search) the first hit is often wrong for common
        // titles, surface ALL candidates and let the downstream AI disambiguate
        // using other signals (narrator, year, publisher).
        const top = candidates[0];
        const baseFields = {
          abs_title: top.title,
          abs_subtitle: top.subtitle,
          abs_year: top.year,
          abs_isbn: top.isbn,
          source: 'openlibrary',
          abs_candidate_count: candidates.length,
        };

        if (hasAuthor || candidates.length === 1) {
          return { ...baseFields, abs_author: top.author };
        }

        // Ambiguous: pass candidates instead of a single answer.
        return {
          ...baseFields,
          abs_author: null,
          abs_candidates: candidates.map(c => ({
            author: c.author,
            year: c.year,
            publisher: c.publisher,
            subtitle: c.subtitle,
          })),
        };
      } catch (err) {
        return { _error: errorDetailFromException(err, { stage: 'gather-openlibrary', url }) };
      }
    };

    const processBook = async (book) => {
      let found = null;
      let errorDetail = null;
      if (book.asin) {
        const res = await lookupByAsin(book.asin, { title: book.title, author: book.author });
        if (res?._error) errorDetail = res._error;
        else if (res) found = res;
      }
      if (!found) {
        const res = await lookupByTitle(book.title, book.author);
        if (res?._error) {
          // Title lookup error only surfaces if we have no prior ASIN success.
          if (!errorDetail) errorDetail = res._error;
        } else if (res) {
          found = res;
          errorDetail = null; // title lookup rescued the ASIN failure
        }
      }
      const result = { id: book.id, gathered: !!found, ...(found || {}) };
      if (!found && errorDetail) result.errorDetail = errorDetail;
      return result;
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }

    return { results };
  },
  get_unprocessed_abs_items: async () => ({ items: [] }),

  // === GPT: Metadata Resolution (batch) ===
  resolve_metadata_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const isLocalAI = usesLocalAi(config);
    const CONCURRENCY = isLocalAI ? 1 : (config.cloud_concurrency || 5);
    const BATCH_SIZE = isLocalAI ? 3 : 1;
    const results = [];
    let completed = 0;

    if (isLocalAI && books.length > 1) {
      // LOCAL AI: Batch 5 books per prompt
      for (let i = 0; i < books.length; i += BATCH_SIZE) {
        const batch = books.slice(i, i + BATCH_SIZE);
        const batchNames = batch.map(b => b.current_title).join(', ');
        emitEvent('batch-progress', { call_type: 'metadata', current: completed, total: books.length, title: `Resolving: ${batchNames}` });

        try {
          const batchPrompt = buildBatchMetadataPrompt(batch);
          const response = await callAI(config, getSystemPrompt(config), batchPrompt, BATCH_SIZE * 400);
          let parsedArray = parseAIJson(response);
          if (!Array.isArray(parsedArray)) {
            const wrapped = parsedArray.books || parsedArray.results || parsedArray.metadata || parsedArray.data;
            if (Array.isArray(wrapped)) parsedArray = wrapped;
            else parsedArray = [parsedArray];
          }

          // D: match results by id first, fall back to position only when no
          // id-matched entry exists AND the response length equals the batch
          // length (same rule as the classify handler).
          for (let j = 0; j < batch.length; j++) {
            const book = batch[j];
            const idMatch = parsedArray.find(p => p && p.id !== undefined && String(p.id) === String(book.id));
            const positionEligible = !idMatch && parsedArray.length === batch.length;
            const parsed = idMatch || (positionEligible ? parsedArray[j] : undefined) || {};
            results.push(buildResolveResult(book, parsed, response));
            completed++;
            emitEvent('batch-progress', { call_type: 'metadata', current: completed, total: books.length, title: book.current_title });
          }
        } catch (err) {
          // Batch failed, fall back to individual
          for (const book of batch) {
            try {
              const prompt = buildMetadataPrompt(book);
              const response = await callAI(config, getSystemPrompt(config), prompt, 1500);
              results.push(buildResolveResult(book, parseAIJson(response), response));
            } catch (e) {
              results.push({
                id: book.id,
                error: e.message,
                changed: false,
                errorDetail: errorDetailFromException(e, { stage: 'resolve' }),
              });
            }
            completed++;
            emitEvent('batch-progress', { call_type: 'metadata', current: completed, total: books.length, title: book.current_title });
          }
        }
      }
    } else {
      // CLOUD AI or single book: individual processing with concurrency
      const processBook = async (book) => {
        try {
          emitEvent('batch-progress', { call_type: 'metadata', current: completed, total: books.length, title: `Resolving: ${book.current_title}...` });
          const prompt = buildMetadataPrompt(book);
          const response = await callAI(config, getSystemPrompt(config), prompt, 1500);
          const result = buildResolveResult(book, parseAIJson(response), response);
          completed++;
          emitEvent('batch-progress', { call_type: 'metadata', current: completed, total: books.length, title: book.current_title });
          return result;
        } catch (err) {
          completed++;
          emitEvent('batch-progress', { call_type: 'metadata', current: completed, total: books.length, title: book.current_title });
          return {
            id: book.id,
            error: err.message,
            changed: false,
            errorDetail: errorDetailFromException(err, { stage: 'resolve' }),
          };
        }
      };

      for (let i = 0; i < books.length; i += CONCURRENCY) {
        const chunk = books.slice(i, i + CONCURRENCY);
        results.push(...await Promise.all(chunk.map(processBook)));
      }
    }

    const total_processed = results.filter(r => !r.error).length;
    const total_failed = results.filter(r => r.error).length;
    return { results, total_processed, total_failed };
  },

  // === GPT: Metadata Resolution (single) ===
  // H-3: returns { success, result, errorDetail? } (the shape the Fix Titles
  // caller reads), built by the same buildResolveResult as the batch handler.
  resolve_title: async (args) => {
    const config = getLocalConfig();
    const input = args.request || args;
    try {
      const prompt = buildMetadataPrompt(input);
      const response = await callAI(config, getSystemPrompt(config), prompt, 1500);
      const r = buildResolveResult(input, parseAIJson(response), response);
      const out = {
        success: true,
        changed: r.changed,
        result: {
          title: r.title,
          author: r.author,
          subtitle: r.subtitle,
          series: r.series,
          sequence: r.sequence,
          narrator: r.narrator,
          confidence: r.confidence,
        },
      };
      if (r.errorDetail) out.errorDetail = r.errorDetail;
      return out;
    } catch (err) {
      return { success: false, error: err.message, errorDetail: errorDetailFromException(err, { stage: 'resolve' }) };
    }
  },

  // === GPT: Series Resolution ===
  // H-3: returns { success, result: { series, sequence, confidence } }. A null
  // series means "no answer" (standalone, placeholder or low confidence): the
  // caller keeps the book's current series.
  resolve_series: async (args) => {
    const config = getLocalConfig();
    const input = args.request || args;
    const prompt = `Find the series for this audiobook:
Title: ${safe(input.title)}
Author: ${safe(input.author)}
${input.current_series ? `Current series: ${safe(input.current_series)}` : ''}

Return JSON: {"series":null,"sequence":null,"confidence":0,"source":"gpt"}
If it's part of a series, fill in the name and book number. If standalone, use null.`;
    try {
      const response = await callAI(config, getSystemPrompt(config), prompt, 500);
      const raw = parseAIJson(response);
      const confidence = Number(raw?.confidence);
      // M-3: same gate as resolve_metadata_batch.
      if (hasValue(raw?.series) && Number.isFinite(confidence) && confidence < MIN_CONFIDENCE) {
        return {
          success: true,
          result: { series: null, sequence: null, confidence },
          errorDetail: makeErrorDetail({
            stage: 'resolve',
            kind: 'low-confidence',
            message: `AI confidence ${confidence} is below ${MIN_CONFIDENCE}; kept the current series.`,
            responsePreview: response,
          }),
        };
      }
      const parsed = withoutPlaceholders(raw || {});
      // A placeholder series answer comes back as null, so callers keep theirs.
      const series = hasValue(parsed.series) ? parsed.series : null;
      const sequence = series && hasValue(parsed.sequence) ? parsed.sequence : null;
      console.log(`[series-fix] resolve_series for "${input.title}": series="${series}" sequence="${sequence}"`);
      if (series && /[#]|\bbook\b|\bvol/i.test(series)) {
        console.warn(`[series-fix] WARNING: GPT returned embedded sequence in series name: "${series}"`);
      }
      return {
        success: true,
        result: { series, sequence, confidence: Number.isFinite(confidence) ? confidence : null },
      };
    } catch (err) {
      return { success: false, error: err.message, errorDetail: errorDetailFromException(err, { stage: 'resolve' }) };
    }
  },

  // === GPT: Classification (genres + tags + age + DNA + themes/tropes) ===
  classify_books_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const isLocal = usesLocalAi(config);
    const dnaEnabled = args.dnaEnabled !== false;
    const CONCURRENCY = isLocal ? 1 : (config.cloud_concurrency || 5);
    const BATCH_SIZE = isLocal ? 3 : 1; // Local: batch 3 books per prompt (small models struggle with 5+)
    const results = [];

    // Helper: build result from parsed classification
    const buildResult = (book, parsed, dna_tags = []) => {
      const age_tags = ageTagsFromRating(parsed.age_rating);
      // Empty AI answer (no genres, tags, dna or age tags): report a failure
      // rather than a success the applier could mistake for "clear everything".
      if (!(parsed.genres || []).length && !(parsed.tags || []).length && !dna_tags.length && !age_tags.length) {
        return { id: book.id, success: false, error: 'Empty AI answer', errorDetail: { stage: 'classify', kind: 'parse', message: 'Empty AI answer' } };
      }
      return {
        id: book.id, success: true,
        genres: parsed.genres || [], tags: parsed.tags || [],
        age_tags, dna_tags,
        themes: parsed.themes || [], tropes: parsed.tropes || [],
        age_category: parsed.age_rating?.age_category || null,
        content_rating: parsed.age_rating?.content_rating || null,
        intended_for_kids: parsed.age_rating?.intended_for_kids || false,
      };
    };

    if (isLocal) {
      // LOCAL AI: Batch multiple books per prompt to reduce prompt eval overhead
      let completed = 0;
      for (let i = 0; i < books.length; i += BATCH_SIZE) {
        const batch = books.slice(i, i + BATCH_SIZE);
        const batchNames = batch.map(b => b.title).join(', ');

        try {
          // Step 1: Batched classification
          emitEvent('batch-progress', { call_type: 'classify', current: completed, total: books.length, title: `Classifying: ${batchNames}` });
          const batchPrompt = buildBatchClassificationPrompt(batch, config.custom_classification_rules || null);
          const response = await callAI(config, getSystemPrompt(config), batchPrompt, BATCH_SIZE * 600);
          let parsedArray;
          try {
            parsedArray = parseAIJson(response);
            // AI might wrap array in an object like {"books": [...]} or {"results": [...]}
            if (!Array.isArray(parsedArray)) {
              const wrapped = parsedArray.books || parsedArray.results || parsedArray.classifications || parsedArray.data;
              if (Array.isArray(wrapped)) {
                parsedArray = wrapped;
              } else {
                parsedArray = [parsedArray];
              }
            }
            console.log(`[Batch] Classification returned ${parsedArray.length} results for ${batch.length} books. Keys: ${parsedArray[0] ? Object.keys(parsedArray[0]).join(',') : 'none'}`);
          } catch {
            // If batch parse fails, fall back to individual processing.
            // G: run DNA per book here too (same as the main batch path below)
            // when dnaEnabled, and attach errorDetail on failures instead of a
            // bare { success:false, error } with no diagnosable detail.
            for (const book of batch) {
              try {
                const singleResp = await callAI(config, getSystemPrompt(config),
                  buildClassificationPrompt(book, null, config.custom_classification_rules || null), 2000);
                const parsed = parseAIJson(singleResp);

                let dna_tags = [];
                let dnaError = null;
                if (dnaEnabled) {
                  let dnaResp = null;
                  try {
                    dnaResp = await callAI(config, getDnaSystemPrompt(config), buildDnaPrompt(book), 1500);
                    dna_tags = convertDnaToTags(parseAIJson(dnaResp));
                  } catch (dnaErr) {
                    dnaError = errorDetailFromException(dnaErr, {
                      stage: 'dna',
                      responsePreview: dnaResp || undefined,
                    });
                  }
                }

                const bookResult = buildResult(book, parsed, dna_tags);
                if (dnaError) bookResult.errorDetail = dnaError;
                results.push(bookResult);
              } catch (err) {
                results.push({
                  id: book.id,
                  success: false,
                  error: err.message,
                  errorDetail: errorDetailFromException(err, { stage: 'classify' }),
                });
              }
              completed++;
              emitEvent('batch-progress', { call_type: 'classify', current: completed, total: books.length, title: book.title });
            }
            continue;
          }

          // Step 2: DNA for each book in batch (sequential)
          // C: match results by id first (echoed back by the model per the
          // prompt's "id" instruction); fall back to position only when no
          // id-matched entry exists AND the response length equals the batch
          // length. A book with no matching entry at all is a real failure
          // (errorDetail, success:false), never a silent empty success.
          for (let j = 0; j < batch.length; j++) {
            const book = batch[j];
            const idMatch = parsedArray.find(p => p && p.id !== undefined && String(p.id) === String(book.id));
            const positionEligible = !idMatch && parsedArray.length === batch.length;
            const parsed = idMatch || (positionEligible ? parsedArray[j] : undefined);

            if (!parsed) {
              completed++;
              emitEvent('batch-progress', { call_type: 'classify', current: completed, total: books.length, title: book.title });
              results.push({
                id: book.id,
                success: false,
                error: 'AI returned no classification for this book.',
                errorDetail: makeErrorDetail({
                  stage: 'classify',
                  kind: 'empty-response',
                  message: 'AI returned no classification result for this book (no id match, and response length did not match the batch size).',
                  responsePreview: JSON.stringify(parsedArray).slice(0, 500),
                }),
              });
              continue;
            }
            // Log if we got empty results for debugging
            if (!parsed.genres?.length && !parsed.tags?.length) {
              console.warn(`[Batch] Empty result for book ${j} "${book.title}", parsedArray has ${parsedArray.length} items`);
            }
            let dna_tags = [];
            let dnaError = null;
            let dnaResp = null;

            if (dnaEnabled) {
              emitEvent('batch-progress', { call_type: 'classify', current: completed + 0.5, total: books.length, title: `DNA: ${book.title}` });
              try {
                dnaResp = await callAI(config, getDnaSystemPrompt(config), buildDnaPrompt(book), 1500);
                dna_tags = convertDnaToTags(parseAIJson(dnaResp));
              } catch (err) {
                // DNA sub-step failed, surface via errorDetail while keeping the
                // book's classification result (success:true, amber warning pill).
                dnaError = errorDetailFromException(err, {
                  stage: 'dna',
                  responsePreview: dnaResp || undefined,
                });
              }
            }

            const bookResult = buildResult(book, parsed, dna_tags);
            if (dnaError) bookResult.errorDetail = dnaError;
            results.push(bookResult);
            completed++;
            emitEvent('batch-progress', { call_type: 'classify', current: completed, total: books.length, title: book.title });
          }
        } catch (err) {
          // Entire batch failed
          for (const book of batch) {
            results.push({ id: book.id, success: false, error: err.message });
            completed++;
          }
          emitEvent('batch-progress', { call_type: 'classify', current: completed, total: books.length, title: 'Error' });
        }
      }
    } else {
      // CLOUD AI: Process books individually with high concurrency (parallel)
      let completed = 0;
      const processBook = async (book) => {
        try {
          emitEvent('batch-progress', { call_type: 'classify', current: completed, total: books.length, title: `Classifying: ${book.title}` });
          // Race the classification and DNA calls. The classification result owns the
          // book's success; the DNA sub-step may fail independently and is surfaced via
          // errorDetail when it does, without demoting the book to success:false.
          let dnaError = null;
          const dnaPromise = dnaEnabled
            ? callAI(config, getDnaSystemPrompt(config), buildDnaPrompt(book), 1500).catch((err) => {
                dnaError = errorDetailFromException(err, { stage: 'dna' });
                return null;
              })
            : Promise.resolve(null);
          const [response, dnaResponse] = await Promise.all([
            callAI(config, getSystemPrompt(config),
              buildClassificationPrompt(book, null, config.custom_classification_rules || null), 2000),
            dnaPromise,
          ]);
          const parsed = parseAIJson(response);
          let dna_tags = [];
          if (dnaResponse) {
            try {
              dna_tags = convertDnaToTags(parseAIJson(dnaResponse));
            } catch (err) {
              // DNA response arrived but couldn't be parsed. Fetch-level dnaError
              // is impossible here (null response would have skipped this branch),
              // so overwriting is safe.
              dnaError = errorDetailFromException(err, {
                stage: 'dna',
                kind: 'parse',
                responsePreview: dnaResponse,
              });
            }
          }
          completed++;
          emitEvent('batch-progress', { call_type: 'classify', current: completed, total: books.length, title: book.title });
          const bookResult = buildResult(book, parsed, dna_tags);
          if (dnaError) bookResult.errorDetail = dnaError;
          return bookResult;
        } catch (err) {
          completed++;
          emitEvent('batch-progress', { call_type: 'classify', current: completed, total: books.length, title: book.title });
          return {
            id: book.id,
            success: false,
            error: err.message,
            errorDetail: errorDetailFromException(err, { stage: 'classify' }),
          };
        }
      };

      for (let i = 0; i < books.length; i += CONCURRENCY) {
        const chunk = books.slice(i, i + CONCURRENCY);
        results.push(...await Promise.all(chunk.map(processBook)));
      }
    }

    const total_processed = results.filter(r => r.success).length;
    const total_failed = results.filter(r => !r.success).length;
    return { results, total_processed, total_failed };
  },

  // === GPT: Description Processing ===
  fix_descriptions_with_gpt: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const isLocalAI = usesLocalAi(config);
    const CONCURRENCY = isLocalAI ? 1 : (config.cloud_concurrency || 5);
    const results = [];
    let completed = 0;

    const processBook = async (book) => {
      try {
        emitEvent('batch-progress', { call_type: 'description', current: completed, total: books.length, title: `Processing: ${book.title}` });
        const prompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
        const response = await callAI(config, getSystemPrompt(config), prompt, 800);
        const parsed = parseAIJson(response);
        const action = parsed.action || 'kept';
        completed++;
        emitEvent('batch-progress', { call_type: 'description', current: completed, total: books.length, title: book.title });
        return { id: book.id, success: true, fixed: action === 'rewritten' || action === 'generated', new_description: parsed.description || null, action, reason: parsed.reason || null };
      } catch (err) {
        completed++;
        emitEvent('batch-progress', { call_type: 'description', current: completed, total: books.length, title: book.title });
        return { id: book.id, success: false, error: err.message };
      }
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }
    return { results };
  },

  // === Description Processing (pipeline alias) ===
  process_descriptions_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || args.request?.books || [];
    const isLocalAI = usesLocalAi(config);
    const CONCURRENCY = isLocalAI ? 1 : (config.cloud_concurrency || 5);
    const results = [];
    let completed = 0;

    const processBook = async (book) => {
      try {
        emitEvent('batch-progress', { call_type: 'description', current: completed, total: books.length, title: `Processing: ${book.title}` });
        const prompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
        const response = await callAI(config, getSystemPrompt(config), prompt, 800);
        const parsed = parseAIJson(response);
        const action = parsed.action || 'kept';
        completed++;
        emitEvent('batch-progress', { call_type: 'description', current: completed, total: books.length, title: book.title });
        return { id: book.id, success: true, changed: action === 'rewritten' || action === 'generated', description: parsed.description || null, action, reason: parsed.reason || null };
      } catch (err) {
        completed++;
        emitEvent('batch-progress', { call_type: 'description', current: completed, total: books.length, title: book.title });
        return { id: book.id, success: false, error: err.message };
      }
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }
    // N: total_processed counts ALL successful results (changed or kept), not
    // just the changed ones - a book the AI validated and left as-is is still
    // a processed book, not an unprocessed one. total_unchanged tracks the
    // kept subset separately so callers can still distinguish the two.
    const total_processed = results.filter(r => r.success).length;
    const total_unchanged = results.filter(r => r.success && !r.changed).length;
    const total_failed = results.filter(r => !r.success).length;
    return { results, total_processed, total_unchanged, total_failed };
  },

  // === GPT: Genre Cleanup ===
  cleanup_genres_with_gpt: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const results = [];
    let completed = 0;

    for (const book of books) {
      try {
        emitEvent('batch-progress', { call_type: 'genres', current: completed, total: books.length, title: `Classifying: ${book.title}` });
        const prompt = `Classify the genres for this audiobook. Return 1-3 genres from the APPROVED LIST ONLY.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
Current genres: ${(book.genres || []).join(', ') || 'none'}
${book.description ? `Description: ${safe(book.description.substring(0, 300))}` : ''}

APPROVED GENRES (use ONLY these exact names):
Literary Fiction, Contemporary Fiction, Historical Fiction, Classics, Mystery, Thriller, Crime, Horror, Romance, Fantasy, Science Fiction, Western, Adventure, Humor, Satire, Women's Fiction, LGBTQ+ Fiction, Short Stories, Anthology, Biography, Autobiography, Memoir, History, True Crime, Science, Popular Science, Psychology, Self-Help, Business, Personal Finance, Health & Wellness, Philosophy, Religion & Spirituality, Politics, Essays, Journalism, Travel, Food & Cooking, Nature, Sports, Music, Art, Education, Parenting & Family, Relationships, Non-Fiction, Young Adult, Middle Grade, Children's, New Adult, Adult, Children's 0-2, Children's 3-5, Children's 6-8, Children's 9-12, Teen 13-17, Audiobook Original, Full Cast Production, Dramatized, Podcast Fiction

RULES:
- Max 3 genres. Specific first, broad last.
- "Young Adult" only for books published in the YA section. Adult books with young protagonists are NOT YA.
- Do NOT invent genres not on this list.

Return JSON: {"genres":["Genre1","Genre2"]}`;
        const response = await callAI(config, getSystemPrompt(config), prompt, 500);
        const parsed = parseAIJson(response);
        const aiGenres = (Array.isArray(parsed.genres) ? parsed.genres : [])
          .filter((g) => typeof g === 'string' && g.trim());
        // Enforce genre policy on AI output if enabled
        const cleaned = config.genre_enforcement !== false
          ? enforceGenrePolicyWithSplit(aiGenres)
          : aiGenres.slice(0, 3);
        completed++;
        emitEvent('batch-progress', { call_type: 'genres', current: completed, total: books.length, title: book.title });
        const original = book.genres || [];
        if (cleaned.length === 0) {
          // An empty answer is a failure, never "clear the genres".
          results.push({ id: book.id, success: false, changed: false, cleaned_genres: original, original_genres: original, error: 'The AI returned no approved genres.' });
          continue;
        }
        // Same order-insensitive comparison as the static cleanup_genres.
        const changed = JSON.stringify([...cleaned].sort()) !== JSON.stringify([...original].sort());
        results.push({ id: book.id, success: true, changed, cleaned_genres: cleaned, original_genres: original });
      } catch (err) {
        completed++;
        emitEvent('batch-progress', { call_type: 'genres', current: completed, total: books.length, title: book.title });
        results.push({ id: book.id, success: false, changed: false, error: err.message });
      }
    }
    // H-3: the item and total names the Clean Genres caller reads.
    return {
      results,
      total_cleaned: results.filter((r) => r.success && r.changed).length,
      total_unchanged: results.filter((r) => r.success && !r.changed).length,
      total_failed: results.filter((r) => !r.success).length,
    };
  },

  // === GPT: Tag Assignment (standard tags + DNA, matching desktop classify_book) ===
  assign_tags_with_gpt: async (args) => {
    const config = getLocalConfig();
    const isLocalAI = usesLocalAi(config);
    const books = args.books || [];
    const dnaEnabled = args.dnaEnabled !== false; // default ON
    const results = [];
    let completed = 0;

    for (const book of books) {
      try {
        emitEvent('batch-progress', { call_type: 'tags', current: completed, total: books.length, title: `Tagging: ${book.title}` });
        // Accept duration in seconds (book.duration) or minutes (book.duration_minutes)
        const durationSec = book.duration || (book.duration_minutes ? book.duration_minutes * 60 : null);
        const durationStr = durationSec ? `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m` : null;

        // --- STEP 1: Standard tags ---
        const tagInstructions = config.custom_tag_instructions || DEFAULT_TAG_INSTRUCTIONS;
        const prompt = `Assign comprehensive tags for this audiobook. Select ONLY from the approved tag list below.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
Genres: ${(book.genres || []).join(', ') || 'unknown'}
${book.series ? `Series: ${safe(book.series)}` : ''}
${book.narrator ? `Narrator: ${safe(book.narrator)}` : ''}
${durationStr ? `Duration: ${durationStr}` : ''}
${book.description ? `Description: ${safe(book.description.substring(0, 500))}` : ''}

${tagInstructions}

Return ONLY valid JSON:
{"tags":["tag-1","tag-2","tag-3"]}`;
        const response = await callAI(config, getSystemPrompt(config), prompt, 1000);
        const parsed = parseAIJson(response);
        let standardTags = parsed.tags || [];

        // --- STEP 2: Generate DNA tags (skip if disabled) ---
        let dnaTags = [];
        let dnaError;
        if (dnaEnabled) {
          try {
            emitEvent('batch-progress', { call_type: 'tags', current: completed + 0.5, total: books.length, title: `DNA: ${book.title}` });
            const dnaPrompt = buildDnaPrompt(book);
            const dnaResponse = await callAI(config, getDnaSystemPrompt(config), dnaPrompt, 1500);
            const dna = parseAIJson(dnaResponse);
            dnaTags = convertDnaToTags(dna);
            if (dnaTags.length === 0) dnaError = 'The AI returned no DNA tags.';
          } catch (dnaErr) {
            console.warn(`DNA generation failed for ${book.title}:`, dnaErr.message);
            dnaError = dnaErr.message || 'DNA generation failed.';
          }
        }

        // Merge standard + DNA tags
        const allTags = [...standardTags, ...dnaTags];
        completed++;
        emitEvent('batch-progress', { call_type: 'tags', current: completed, total: books.length, title: book.title });
        results.push({ id: book.id, success: true, tags: standardTags, suggested_tags: allTags, dna_tags: dnaTags, ...(dnaError ? { dna_error: dnaError } : {}) });
      } catch (err) {
        completed++;
        emitEvent('batch-progress', { call_type: 'tags', current: completed, total: books.length, title: book.title });
        results.push({ id: book.id, success: false, tags: [], suggested_tags: [], error: err.message });
      }
    }
    const total_success = results.filter(r => r.success).length;
    const total_failed = results.filter(r => !r.success).length;
    return { results, total_success, total_failed };
  },

  // === GPT: Subtitle Fix ===
  fix_subtitles_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const results = [];
    let completed = 0;

    for (const book of books) {
      try {
        emitEvent('batch-progress', { call_type: 'subtitles', current: completed, total: books.length, title: `Subtitle: ${book.title}` });
        const prompt = `Find the official subtitle for this audiobook, if one exists.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
${book.series ? `Series: ${safe(book.series)}` : ''}

Return JSON: {"subtitle":null}
If the book has a well-known subtitle (e.g., "Dune: The Desert Planet"), include it. Otherwise null.`;
        const response = await callAI(config, getSystemPrompt(config), prompt, 300);
        const parsed = withoutPlaceholders(parseAIJson(response));
        completed++;
        emitEvent('batch-progress', { call_type: 'subtitles', current: completed, total: books.length, title: book.title });
        const subtitle = hasValue(parsed.subtitle) ? String(parsed.subtitle).trim() || null : null;
        // H-3: `fixed` is what the Fix Subtitles caller reads. A null or
        // placeholder answer, or the subtitle the book already has, is no fix.
        const fixed = !!subtitle && !strEq(subtitle, book.current_subtitle);
        results.push({ id: book.id, success: true, fixed, subtitle });
      } catch (err) {
        completed++;
        emitEvent('batch-progress', { call_type: 'subtitles', current: completed, total: books.length, title: book.title });
        results.push({ id: book.id, success: false, fixed: false, error: err.message });
      }
    }
    return {
      results,
      total_fixed: results.filter((r) => r.fixed).length,
      total_skipped: results.filter((r) => r.success && !r.fixed).length,
      total_failed: results.filter((r) => !r.success).length,
    };
  },

  // === GPT: Author Fix ===
  // Strategy: if the current author is a valid name, just normalize it
  // (fast, free). Otherwise (empty / "Unknown" / path fragment) ask the AI
  // to derive the author from title + description + narrator + year + ids.
  fix_authors_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const force = !!args.force;
    const results = [];
    let completed = 0;
    let total_fixed = 0, total_skipped = 0, total_failed = 0;

    // Placeholder detection ("Unknown", "N/A", etc.) is shared with
    // ScannerPage's audio-check smart-skip gate via isPlaceholderAuthor
    // (issue #57) - single source of truth. Path-fragment detection is
    // specific to this AI-fix flow, so it stays here on top of the shared check.
    const isBadAuthor = (a) => {
      if (isPlaceholderAuthor(a)) return true;
      const s = String(a).trim();
      if (s.includes('/') || s.includes('\\')) return true;
      return false;
    };

    const isLocal = usesLocalAi(config);
    const CONCURRENCY = isLocal ? 1 : (config.cloud_concurrency || 5);

    const processBook = async (book) => {
      emitEvent('batch-progress', { call_type: 'authors', current: completed, total: books.length, title: `Author: ${book.title}` });

      const current = book.current_author ?? book.author ?? '';
      const needsAi = force || isBadAuthor(current);

      if (!needsAi) {
        // D-5: only a locally scanned book's tag may hold "Last, First"; in an
        // ABS value (or one of unknown source) the comma separates authors.
        const cleaned = cleanAuthorName(current, { commaSeparatesAuthors: book.source !== 'local' }) || current;
        const fixed = cleaned !== current;
        completed++;
        emitEvent('batch-progress', { call_type: 'authors', current: completed, total: books.length, title: book.title });
        if (fixed) total_fixed++; else total_skipped++;
        return { id: book.id, success: true, author: cleaned, fixed, source: fixed ? 'clean' : 'existing' };
      }

      try {
        const desc = book.description ? String(book.description).slice(0, 800) : '';
        const lines = [
          `Title: ${safe(book.title)}`,
          book.subtitle ? `Subtitle: ${safe(book.subtitle)}` : '',
          book.series ? `Series: ${safe(book.series)}` : '',
          book.narrator ? `Narrator: ${safe(book.narrator)}` : '',
          book.publisher ? `Publisher: ${safe(book.publisher)}` : '',
          book.year || book.published_year ? `Year: ${book.year || book.published_year}` : '',
          book.isbn ? `ISBN: ${safe(book.isbn)}` : '',
          book.asin ? `ASIN: ${safe(book.asin)}` : '',
          desc ? `Description (truncated): ${safe(desc)}` : '',
        ].filter(Boolean).join('\n');
        const prompt = `Identify the AUTHOR of this audiobook.

${lines}

Rules:
- If the description names the author ("Louise Erdrich's latest novel..."), extract that name.
- If the title + year + publisher uniquely identifies a real book you know, return the author.
- Use canonical form: "J.R.R. Tolkien", not "JRR Tolkien".
- Multiple co-authors: comma-separated, e.g. "Stephen King, Peter Straub".
- Return null ONLY if you truly have no grounded signal.

Return JSON: {"author":"Author Name","confidence":90}`;
        const response = await callAI(config, getSystemPrompt(config), prompt, 600);
        const parsed = parseAIJson(response);
        const raw = parsed?.author ? String(parsed.author).trim() : '';
        // The prompt asks for comma-separated co-authors, so never invert.
        const author = raw && !isBadAuthor(raw) ? cleanAuthorName(raw, { commaSeparatesAuthors: true }) || raw : '';
        completed++;
        emitEvent('batch-progress', { call_type: 'authors', current: completed, total: books.length, title: book.title });
        if (author && author !== current) {
          total_fixed++;
          return { id: book.id, success: true, author, fixed: true, source: 'ai', confidence: parsed?.confidence };
        }
        // E: the AI confirmed the existing (already-valid) author rather than
        // changing it - a real, successful result, not the ai-empty case below.
        // Counted as processed (total_skipped), never total_failed.
        if (author && author === current) {
          total_skipped++;
          return { id: book.id, success: true, changed: false, author, fixed: false, source: 'ai-confirmed', message: 'Author confirmed', confidence: parsed?.confidence };
        }
        // AI returned empty/bad author. Previously reported success:true + total_failed++
        // (inconsistent). Now reported as a non-fatal warning with errorDetail so the
        // UI renders an amber pill and counts match reality.
        total_failed++;
        return {
          id: book.id,
          success: false,
          author: current,
          fixed: false,
          source: 'ai-empty',
          errorDetail: makeErrorDetail({
            stage: 'fix-author',
            kind: 'empty-response',
            message: 'AI could not identify an author for this book.',
            responsePreview: response,
          }),
        };
      } catch (err) {
        completed++;
        emitEvent('batch-progress', { call_type: 'authors', current: completed, total: books.length, title: book.title });
        total_failed++;
        return {
          id: book.id,
          success: false,
          error: err.message,
          fixed: false,
          errorDetail: errorDetailFromException(err, { stage: 'fix-author' }),
        };
      }
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }

    return { results, total_fixed, total_skipped, total_failed };
  },

  // === GPT: Year Fix ===
  fix_years_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const force = args.force || false;
    const results = [];
    let total_fixed = 0, total_skipped = 0, total_failed = 0;
    let completed = 0;

    const isValidYear = (y) => {
      const n = parseInt(y, 10);
      return !isNaN(n) && n >= 1000 && n <= new Date().getFullYear() + 2;
    };

    for (const book of books) {
      // Skip books with valid years unless forcing
      if (!force && book.current_year && isValidYear(book.current_year)) {
        const date = `${book.current_year}-01-01`;
        results.push({ id: book.id, year: book.current_year, pub_date: date, pub_tag: `pub-${date}`, source: 'existing', fixed: false, skipped: true });
        total_skipped++;
        completed++;
        emitEvent('batch-progress', { call_type: 'years', current: completed, total: books.length, title: book.title });
        continue;
      }

      try {
        emitEvent('batch-progress', { call_type: 'years', current: completed, total: books.length, title: `Year: ${book.title}` });
        const descSnippet = book.description ? `Description: ${safe(book.description.slice(0, 200))}\n` : '';
        const prompt = `You are a librarian. Find the ORIGINAL FIRST publication year for this book.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
${book.series ? `Series: ${safe(book.series)}\n` : ''}${descSnippet}
Return the ORIGINAL first publication year, NOT audiobook release, reprint, or new edition date.
Return JSON: {"year":"2005"}`;
        const response = await callAI(config, getSystemPrompt(config), prompt, 600);
        const parsed = parseAIJson(response);
        const year = parsed.year ? String(parsed.year) : null;
        if (year && isValidYear(year)) {
          const date = `${year}-01-01`;
          results.push({ id: book.id, year, pub_date: date, pub_tag: `pub-${date}`, source: 'ai', fixed: true });
          total_fixed++;
        } else {
          results.push({
            id: book.id,
            year: null,
            fixed: false,
            error: 'Invalid year from AI',
            errorDetail: makeErrorDetail({
              stage: 'fix-year',
              kind: 'schema',
              message: year
                ? `AI returned an invalid year: "${year}" (outside 1000..current+2).`
                : 'AI returned no year for this book.',
              responsePreview: response,
            }),
          });
          total_failed++;
        }
        completed++;
        emitEvent('batch-progress', { call_type: 'years', current: completed, total: books.length, title: book.title });
      } catch (err) {
        results.push({
          id: book.id,
          year: null,
          fixed: false,
          error: err.message,
          errorDetail: errorDetailFromException(err, { stage: 'fix-year' }),
        });
        total_failed++;
        completed++;
        emitEvent('batch-progress', { call_type: 'years', current: completed, total: books.length, title: book.title });
      }
    }
    return { results, total_fixed, total_skipped, total_failed };
  },

  // === BookDNA Generation ===
  generate_book_dna_batch: async (args) => {
    const config = getLocalConfig();
    const isLocalAI = usesLocalAi(config);
    const items = args.request?.items || args.items || [];
    const results = [];
    let completed = 0;

    for (const item of items) {
      try {
        const prompt = buildDnaPrompt(item);
        const response = await callAI(config, getDnaSystemPrompt(config), prompt, 1500);
        const parsed = parseAIJson(response);
        const dnaTags = convertDnaToTags(parsed);
        if (dnaTags.length === 0) throw new Error('The AI returned no DNA tags, so existing DNA tags were kept.');

        // Merge with existing tags (preserve non-DNA tags, replace DNA ones only
        // because at least one new dna: tag came back)
        const existingNonDna = (item.tags || []).filter(t => !String(t).startsWith('dna:'));
        const mergedTags = [...existingNonDna, ...dnaTags];

        completed++;
        emitEvent('dna-progress', { current: completed, total: items.length, id: item.id, title: item.title || item.id, success: true, error: null });
        results.push({ id: item.id, success: true, dna_tags: dnaTags, merged_tags: mergedTags });
      } catch (err) {
        completed++;
        emitEvent('dna-progress', { current: completed, total: items.length, id: item.id, title: item.title || item.id, success: false, error: err.message });
        results.push({ id: item.id, success: false, dna_tags: [], merged_tags: item.tags || [], error: err.message });
      }
    }
    return { results, total_processed: results.filter(r => r.success).length, total_failed: results.filter(r => !r.success).length };
  },

  generate_book_dna: async (args) => {
    const result = await HANDLERS.generate_book_dna_batch({ items: [args.request || args] });
    return result.results[0] || { success: false, error: 'No result' };
  },

  // === Age Rating Resolution ===
  resolve_book_age_rating: async (args) => {
    const config = getLocalConfig();
    const book = args.request || args;
    try {
      const prompt = buildClassificationPrompt(book);
      const response = await callAI(config, getSystemPrompt(config), prompt, 1000);
      const parsed = parseAIJson(response);
      // H-3: the fields Lookup Age (ScannerPage, EditMetadataModal) reads.
      const rating = parsed.age_rating;
      const age_tags = ageTagsFromRating(rating);
      const age_category = rating && typeof rating === 'object' && hasValue(rating.age_category) ? rating.age_category : null;
      if (!age_category && age_tags.length === 0) {
        return { success: false, error: 'The AI returned no age rating.' };
      }
      return {
        success: true,
        age_category,
        age_tags,
        age_rating: mapAgeCategory(age_category),
        content_rating: rating && typeof rating === 'object' ? (rating.content_rating || null) : null,
        intended_for_kids: rating && typeof rating === 'object' ? rating.intended_for_kids === true : false,
        reasoning: parsed.age_rating_reason || null,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // === Genre Cleanup (local, no AI) ===
  cleanup_genres: (args) => {
    const config = getLocalConfig();
    const request = args.request || args;
    const groups = request.groups || [];
    let totalCleaned = 0, totalUnchanged = 0;
    const results = groups.map(g => {
      const originalGenres = g.genres || [];
      const cleanedGenres = config.genre_enforcement !== false
        ? enforceGenrePolicyWithSplit(originalGenres)
        : originalGenres;
      // R: compare order-insensitively - enforceGenrePolicyWithSplit's
      // priority sort (specific genres first, broad ones last) can legitimately
      // reorder an already-approved set without changing its membership, and
      // that reorder alone is not a "real" change worth flagging.
      const changed = JSON.stringify([...cleanedGenres].sort()) !== JSON.stringify([...originalGenres].sort());
      if (changed) totalCleaned++; else totalUnchanged++;
      return { id: g.id, changed, cleaned_genres: cleanedGenres, original_genres: originalGenres };
    });
    return { results, total_cleaned: totalCleaned, total_unchanged: totalUnchanged };
  },

  // === Metadata Providers ===
  get_available_providers: () => [
    { id: 'goodreads', name: 'Goodreads', enabled: true },
    { id: 'hardcover', name: 'Hardcover', enabled: true },
    { id: 'storytel/language:en', name: 'Storytel', enabled: true },
    { id: 'graphicaudio', name: 'Graphic Audio', enabled: true },
    { id: 'bigfinish', name: 'Big Finish', enabled: true },
    { id: 'librivox', name: 'LibriVox', enabled: false },
  ],
  get_custom_providers: () => {
    const config = getLocalConfig();
    return config.custom_providers || [];
  },
  toggle_provider: (args) => {
    const config = getLocalConfig();
    const providers = config.custom_providers || [];
    const idx = providers.findIndex(p => p.provider_id === args.providerId);
    if (idx >= 0) {
      providers[idx].enabled = args.enabled;
      saveLocalConfig({ ...config, custom_providers: providers });
    }
    return {};
  },
  remove_custom_provider: (args) => {
    const config = getLocalConfig();
    const providers = (config.custom_providers || []).filter(p => p.provider_id !== args.providerId);
    saveLocalConfig({ ...config, custom_providers: providers });
    return {};
  },
  add_abs_agg_provider: (args) => {
    const config = getLocalConfig();
    const providers = config.custom_providers || [];
    if (!providers.some(p => p.provider_id === args.providerId)) {
      providers.push({
        name: args.providerId,
        provider_id: args.providerId,
        base_url: 'https://provider.vito0912.de',
        auth_token: 'abs',
        enabled: true,
        priority: 50,
      });
      saveLocalConfig({ ...config, custom_providers: providers });
    }
    return {};
  },
  test_provider: async (args) => {
    try {
      const res = await proxyFetch(
        `https://provider.vito0912.de/search/${args.providerId}?query=${encodeURIComponent(args.title || 'test')}&author=${encodeURIComponent(args.author || '')}`,
        { method: 'GET', headers: { Authorization: 'abs' } }
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      return { success: true, results: data.length || 0 };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  reset_providers_to_defaults: () => {
    const config = getLocalConfig();
    saveLocalConfig({ ...config, custom_providers: DEFAULT_CONFIG.custom_providers });
    return {};
  },

  // === Cover Search ===
  search_cover_options: async (args) => {
    const config = getLocalConfig();
    const covers = [];
    // Search ABS for cover
    if (config.abs_base_url && args.title) {
      try {
        const data = await absApi(config.abs_base_url, config.abs_api_token,
          `/api/search/covers?title=${encodeURIComponent(args.title)}&author=${encodeURIComponent(args.author || '')}`);
        if (data?.covers) covers.push(...data.covers);
      } catch {}
    }
    return covers;
  },
  get_cover_for_group: async (args) => {
    const config = getLocalConfig();
    if (!config.abs_base_url || !args.groupId) return null;
    const base = config.abs_base_url.replace(/\/$/, '');
    const url = `${base}/api/items/${args.groupId}/cover`;
    try {
      const res = await proxyFetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${config.abs_api_token}` } });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.size) return null;
      return { blobUrl: URL.createObjectURL(blob), size_kb: Math.round(blob.size / 1024) };
    } catch {
      return null;
    }
  },
  proxy_image: async (args) => {
    try {
      const res = await proxyFetch(args.url, { method: 'GET' });
      if (!res.ok) return null;
      const blob = await res.blob();
      const reader = new FileReader();
      return new Promise(resolve => {
        reader.onloadend = () => resolve({ data: reader.result, mime_type: blob.type });
        reader.readAsDataURL(blob);
      });
    } catch { return null; }
  },

  // === Validation (client-side) ===
  scan_metadata_errors: (args) => {
    const groups = args.groups || [];
    const results = [];
    for (const group of groups) {
      const issues = [];
      const m = group.metadata;
      if (!m.title || m.title === 'Unknown') issues.push({ field: 'title', severity: 'error', message: 'Missing title' });
      if (!m.author || m.author === 'Unknown') issues.push({ field: 'author', severity: 'error', message: 'Missing author' });
      if (!m.genres || m.genres.length === 0) issues.push({ field: 'genres', severity: 'warning', message: 'No genres' });
      if (!m.description) issues.push({ field: 'description', severity: 'warning', message: 'No description' });
      if (issues.length > 0) results.push({ id: group.id, title: m.title, issues });
    }
    return { results, total_issues: results.reduce((a, r) => a + r.issues.length, 0), books: results, total_scanned: groups.length, books_with_errors: results.length };
  },
  analyze_authors: (args) => {
    const groups = args.groups || [];
    const authorMap = {};
    for (const g of groups) {
      const author = g.metadata?.author;
      if (author) {
        if (!authorMap[author]) authorMap[author] = [];
        authorMap[author].push(g.id);
      }
    }
    return { authors: Object.entries(authorMap).map(([name, ids]) => ({ name, book_count: ids.length })) };
  },

  // === Authors (ABS API) ===
  get_abs_authors: async () => {
    const config = getLocalConfig();
    const data = await absApi(config.abs_base_url, config.abs_api_token, `/api/libraries/${config.abs_library_id}/authors`);
    return data.authors || [];
  },
  get_abs_author_detail: async (args) => {
    const config = getLocalConfig();
    return absApi(config.abs_base_url, config.abs_api_token, `/api/authors/${args.authorId}?include=items`);
  },
  merge_abs_authors: async (args) => {
    const config = getLocalConfig();
    return absApi(config.abs_base_url, config.abs_api_token, `/api/authors/${args.primaryId}/merge`, {
      method: 'POST',
      body: { toMergeAuthorIds: args.secondaryIds },
    });
  },
  // Push staged name/description edits (useAuthors.js's pendingChanges) to
  // ABS. Contract useAuthors.js's pushToAbs trusts:
  // { updated: number, failed: number, errors: [{ id, error }] }.
  push_author_changes_to_abs: async (args) => {
    const config = getLocalConfig();
    const { abs_base_url: baseUrl, abs_api_token: token } = config;
    const items = args.items || args.request?.items || [];

    // Fail fast with a single result instead of issuing N doomed requests
    // when ABS isn't configured (same pattern as push_abs_updates).
    if (!baseUrl || !token) {
      return {
        updated: 0,
        failed: 1,
        errors: [{ id: 'config', error: 'ABS is not configured: missing base URL or API token' }],
      };
    }

    let updated = 0;
    let failed = 0;
    const errors = [];

    for (const item of items) {
      const id = item.id;
      if (!id) {
        failed++;
        errors.push({ id: 'unknown', error: 'Missing author id' });
        continue;
      }
      try {
        // Only send fields that were actually staged, so an unstaged field
        // (sent as null by pushToAbs) never overwrites the real value.
        const payload = {};
        if (item.name != null) payload.name = item.name;
        if (item.description != null) payload.description = item.description;
        await absApi(baseUrl, token, `/api/authors/${id}`, {
          method: 'PATCH',
          body: payload,
        });
        updated++;
      } catch (err) {
        failed++;
        errors.push({ id, error: err.message });
      }
    }

    return { updated, failed, errors };
  },
  get_abs_author_image: async (args) => {
    const config = getLocalConfig();
    try {
      const res = await proxyFetch(
        `${config.abs_base_url}/api/authors/${args.authorId}/image`,
        { method: 'GET', headers: { Authorization: `Bearer ${config.abs_api_token}` } }
      );
      if (!res.ok) return null;
      const blob = await res.blob();
      const reader = new FileReader();
      return new Promise(resolve => {
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } catch { return null; }
  },

  // === ISBN/ASIN Lookup via Audible + Open Library (Tauri HTTP plugin) ===
  lookup_book_isbn: async (args) => {
    const { title, author } = args.request || args;
    if (!title) return { success: false, error: 'No title' };

    let isbn = null;
    let asin = null;
    // M-3: a failed lookup is reported, not swallowed as "Not found".
    const errors = [];
    const book = { title, author };
    const lookup = async (source, url, pick) => {
      try {
        const res = await retryOn429(() => proxyFetch(url, { headers: { 'Accept': 'application/json' } }));
        if (!res.ok) {
          errors.push(makeErrorDetail({
            stage: 'lookup-isbn', kind: 'http', statusCode: res.status, url,
            message: `${source} lookup failed: HTTP ${res.status}`,
          }));
          return;
        }
        pick(await res.json());
      } catch (err) {
        errors.push(errorDetailFromException(err, { stage: 'lookup-isbn', url }));
      }
    };

    // ASIN via Audible public catalog API (Tauri http plugin bypasses CORS;
    // web variant deferred, see issue #53). Only a hit for this book counts.
    const titleParam = encodeURIComponent(title);
    const authorParam = encodeURIComponent(author || '');
    await lookup('Audible', `https://api.audible.com/1.0/catalog/products?title=${titleParam}&author=${authorParam}&num_results=3&response_groups=product_desc,contributors`, (data) => {
      const match = pickLookupHit(book, data.products, p => ({
        title: p.title,
        authors: (p.authors || []).map(a => a?.name).filter(Boolean),
      }), p => !!p.asin);
      if (match) asin = match.asin;
    });

    // ISBN via Open Library: the first hit for this book that has an ISBN.
    const query = encodeURIComponent(`${title} ${author || ''}`);
    await lookup('OpenLibrary', `https://openlibrary.org/search.json?q=${query}&limit=5&fields=isbn,title,author_name`, (data) => {
      const doc = pickLookupHit(book, data.docs, d => ({ title: d.title, authors: d.author_name || [] }),
        d => d.isbn?.length > 0);
      if (doc) isbn = doc.isbn.find(i => i.length === 13) || doc.isbn[0];
    });

    if (isbn || asin) {
      return { success: true, isbn, asin };
    }
    if (errors.length > 0) {
      const message = errors.map(e => e.message).join('; ');
      return {
        success: false,
        error: message,
        errorDetail: makeErrorDetail({ stage: 'lookup-isbn', kind: errors[0].kind, message }),
      };
    }
    return { success: false, error: 'Not found' };
  },

  // === Maintenance ===
  clear_cache: () => 'Cache cleared',
  get_cache_stats: () => ({ genre_cache_size: 0, response_cache_size: 0 }),
  get_genre_stats: () => 'No server-side genre stats in web mode',
  normalize_genres: () => 'Genre normalization runs client-side in web mode',

  // === Scan progress (browser build only; Tauri routes these to Rust) ===
  get_scan_progress: () => ({ scanning: false, current: 0, total: 0 }),
  cancel_scan: () => {},

  // === Undo (client-side) ===
  // Match the Rust get_undo_status shape so callers reading `.available`/`.files`
  // (UndoToast/ScannerPage) work identically in the browser build.
  get_undo_status: () => ({ available: false, books_count: 0, count: 0, age_seconds: 0, files: [] }),
  clear_undo_state: () => {},

  // === Rename templates (client-side; used by RenamePreviewModal in both the
  // Tauri and browser builds since it is not a TAURI_COMMANDS override). Shape is
  // { id, name, file_template } exactly as the modal's dropdown + preview consume.
  // Tokens use ONLY the plain vars the Rust render_template resolves
  // ({title}/{author}/{series}/{sequence}/{year}); any other {...} block is
  // stripped, so conditional-block syntax is avoided here.
  get_rename_templates: () => ([
    { id: 'standard', name: 'Standard (Title)', file_template: '{title}' },
    { id: 'author-title', name: 'Author - Title', file_template: '{author} - {title}' },
    { id: 'series', name: 'Series # - Title', file_template: '{series} {sequence} - {title}' },
    { id: 'author-series-title', name: 'Author - Series # - Title', file_template: '{author} - {series} {sequence} - {title}' },
    { id: 'title-year', name: 'Title (Year)', file_template: '{title} ({year})' },
  ]),

  // === Ollama (disabled in web mode) ===
  ollama_get_status: () => ({ installed: false, running: false, models: [] }),
  ollama_get_model_presets: () => [],
  ollama_get_disk_usage: () => 0,
};

// ============================================================================
// EVENT SUBSCRIPTION (SSE, only needed if using Axum backend, otherwise no-op)
// ============================================================================

const eventHandlers = new Map();

/**
 * Subscribe to progress events.
 * In client-side mode, this is mostly unused since operations run synchronously.
 * Kept for API compatibility with components that call subscribe().
 */
export function subscribe(eventType, handler) {
  if (!eventHandlers.has(eventType)) eventHandlers.set(eventType, new Set());
  eventHandlers.get(eventType).add(handler);
  return () => eventHandlers.get(eventType)?.delete(handler);
}

/** Emit a local event (for client-side progress tracking) */
export function emitEvent(eventType, data) {
  const handlers = eventHandlers.get(eventType);
  if (handlers) {
    for (const h of handlers) {
      try { h(data); } catch (err) { console.error(`Event handler error for '${eventType}':`, err); }
    }
  }
}

export function closeEventSource() {
  // No-op in client-side mode
}

// ============================================================================
// FILE PICKER (server-side file browser, kept for API compatibility)
// ============================================================================

let fileBrowserResolver = null;
let fileBrowserOptions = null;

export function pickPath(options = {}) {
  // In Tauri, use native file/folder dialog
  if (isTauri()) {
    return (async () => {
      const { open, save } = await import('@tauri-apps/plugin-dialog');
      if (options.save) {
        return save({ defaultPath: options.defaultPath });
      }
      return open({
        directory: options.directory || false,
        multiple: options.multiple || false,
      });
    })();
  }

  // Browser: existing implementation
  if (options.directory) {
    return new Promise((resolve) => {
      fileBrowserResolver = resolve;
      fileBrowserOptions = options;
      window.dispatchEvent(new CustomEvent('open-file-browser', { detail: options }));
    });
  }
  if (options.save) {
    return new Promise((resolve) => {
      const path = prompt('Enter save path:', options.defaultPath || '');
      resolve(path || null);
    });
  }
  // File upload
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple || false;
    if (options.filters) {
      input.accept = options.filters.flatMap(f => f.extensions || []).map(ext => `.${ext}`).join(',');
    }
    input.onchange = (e) => {
      const files = Array.from(e.target.files);
      resolve(files.length === 0 ? null : options.multiple ? files : files[0]);
    };
    input.click();
  });
}

/**
 * Ask the user a yes/no question before a destructive step. Native dialog in
 * Tauri, window.confirm in the browser. Resolves true only on an explicit yes.
 */
export async function askToConfirm(message, { title, okLabel, cancelLabel } = {}) {
  if (isTauri()) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return (await ask(message, { title, kind: 'warning', okLabel, cancelLabel })) === true;
  }
  return typeof window !== 'undefined' && window.confirm(message) === true;
}

export function resolveFileBrowser(path) {
  if (fileBrowserResolver) { fileBrowserResolver(path); fileBrowserResolver = null; fileBrowserOptions = null; }
}
export function getFileBrowserOptions() { return fileBrowserOptions; }
