// src/api.js
// Transport adapter — 100% client-side. No backend server needed.
// All API calls go through the Cloudflare Worker CORS proxy.
// Config lives in browser localStorage.

import { absApi, callAI, parseAIJson, proxyFetch } from './lib/proxy';
import { buildMetadataPrompt, buildClassificationPrompt, buildDescriptionPrompt, buildDnaPrompt, BOOK_DNA_SYSTEM_PROMPT, SYSTEM_PROMPT, DEFAULT_TAG_INSTRUCTIONS } from './lib/prompts';
import { toTitleCase, removeJunkSuffixes, cleanAuthorName, cleanNarratorName } from './lib/normalize';
import { APPROVED_GENRES, APPROVED_TAGS, GENRE_ALIASES, mapGenre, enforceGenrePolicyWithSplit, enforceTagPolicyWithDna } from './lib/genres';
import { isTauri } from './lib/platform.js';

/** Safely serialize a value for AI prompts (escapes quotes/newlines). */
function safe(value) {
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(String(value));
}

/** Get the effective system prompt (custom override or default). */
function getSystemPrompt(config) {
  return config?.custom_system_prompt?.trim() || SYSTEM_PROMPT;
}

/** Get the effective DNA system prompt (custom override or default). */
function getDnaSystemPrompt(config) {
  return config?.custom_dna_prompt?.trim() || BOOK_DNA_SYSTEM_PROMPT;
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
  performance_preset: 'balanced',
  ai_model: 'gpt-5-nano',
  ai_base_url: 'https://api.openai.com',
  use_local_ai: false,
  ollama_model: null,
  local_concurrency: 2,
  cloud_concurrency: 5,
  local_skip_dna: false,
  custom_providers: [],
};

export function getLocalConfig() {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch (e) {
    console.warn('Failed to load config:', e);
  }
  return { ...DEFAULT_CONFIG };
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
  'ollama_get_status',
  'ollama_get_model_presets',
  'ollama_get_disk_usage',
  'ollama_start',
  'ollama_stop',
  'ollama_install',
  'ollama_uninstall',
  'ollama_pull_model',
  'ollama_delete_model',
]);

// ============================================================================
// callBackend() — main dispatch function
// Routes commands to client-side handlers or CORS proxy.
// All existing component code calls this — we just changed what's under the hood.
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

  // Commands that aren't wired up yet — return a stub instead of crashing
  console.warn(`Command '${cmd}' not available in web version`);
  return { _stub: true, message: `'${cmd}' is not available in the web version.` };
}

// ============================================================================
// DNA-TO-TAGS CONVERTER — converts BookDNA JSON to dna: prefixed tags
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
// ABS PAYLOAD BUILDER — matches desktop build_update_payload() exactly
// ============================================================================

/**
 * Build ABS-formatted PATCH payload from internal metadata.
 * Matches src-tauri/src/commands/abs.rs build_update_payload():
 * - Authors: split on , and & → [{id: "new-N", name}]
 * - Narrators: wrapped as array
 * - Series: [{name, sequence}] with NO id field (ABS matches by name)
 * - Genres: enforced (max 3, validated)
 * - Tags: at TOP LEVEL, DNA-aware enforcement
 */
function buildAbsPayload(meta) {
  const metadata = {};

  if (meta.title) metadata.title = meta.title;
  if (meta.subtitle) metadata.subtitle = meta.subtitle;
  if (meta.description) metadata.description = meta.description;
  if (meta.publisher) metadata.publisher = meta.publisher;
  if (meta.published_year || meta.publishedYear) metadata.publishedYear = meta.published_year || meta.publishedYear;
  if (meta.isbn) metadata.isbn = meta.isbn;
  if (meta.asin) metadata.asin = meta.asin;
  if (meta.language) metadata.language = meta.language;

  // Authors: split on , and & (matching desktop), create {id, name} objects
  if (meta.author) {
    const authors = meta.author.split(/[,&]/)
      .map(a => a.trim())
      .filter(a => a)
      .map((name, i) => ({ id: `new-${i + 1}`, name }));
    if (authors.length > 0) metadata.authors = authors;
  }

  // Narrators: split on , into array (desktop wraps single as [n])
  if (meta.narrator) {
    metadata.narrators = meta.narrator.split(',').map(n => n.trim()).filter(Boolean);
  }

  // Genres: enforce policy (max 3, validated against approved list) if enabled
  if (meta.genres && meta.genres.length > 0) {
    const config = getLocalConfig();
    metadata.genres = config.genre_enforcement !== false
      ? enforceGenrePolicyWithSplit(meta.genres)
      : meta.genres.slice(0, 3);
  }

  // Series: use all_series if available, fall back to series/sequence
  // NO id field — let ABS match by name to avoid duplicates
  if (meta.all_series && meta.all_series.length > 0) {
    metadata.series = meta.all_series.map(s => {
      const obj = { name: s.name };
      if (s.sequence != null) obj.sequence = String(s.sequence);
      return obj;
    });
  } else if (meta.series) {
    const obj = { name: meta.series };
    if (meta.sequence != null) obj.sequence = String(meta.sequence);
    metadata.series = [obj];
  } else {
    metadata.series = [];
  }

  // Tags: TOP LEVEL (not inside metadata), DNA-aware enforcement
  const finalTags = enforceTagPolicyWithDna(meta.tags || []);
  const payload = { metadata };
  if (finalTags.length > 0) payload.tags = finalTags;

  return payload;
}

// ============================================================================
// COMMAND HANDLERS — client-side implementations
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
    let total = 0;

    do {
      const data = await absApi(baseUrl, token, `/api/libraries/${libraryId}/items?limit=${limit}&page=${page}&expanded=1`);
      const items = data.results || [];
      total = data.total || 0;
      allItems.push(...items);
      page++;
    } while (allItems.length < total);

    // Convert ABS items to book groups
    const groups = allItems.map(item => absItemToBookGroup(item, baseUrl));
    return { groups, total: groups.length };
  },

  // === ABS Push ===
  push_abs_updates: async (args) => {
    const config = getLocalConfig();
    const { abs_base_url: baseUrl, abs_api_token: token } = config;
    const items = args.request?.items || args.items || [];
    let success = 0, failed = 0;
    const errors = [];

    for (const item of items) {
      try {
        const absId = item.abs_id || item.id;
        if (!absId) { failed++; errors.push({ id: 'unknown', error: 'Missing item ID' }); continue; }
        const meta = item.metadata || item;
        const payload = buildAbsPayload(meta);
        await absApi(baseUrl, token, `/api/items/${absId}/media`, {
          method: 'PATCH',
          body: payload,
        });
        success++;
      } catch (err) {
        failed++;
        errors.push({ id: item.abs_id || item.id, error: err.message });
      }
    }
    return { success, failed, errors };
  },

  // === ABS Push Imports (same formatting, different return shape) ===
  push_abs_imports: async (args) => {
    const config = getLocalConfig();
    const { abs_base_url: baseUrl, abs_api_token: token } = config;
    const items = args.request?.items || args.items || [];
    let updated = 0, failed = 0;
    const errors = [];

    for (const item of items) {
      try {
        const absId = item.id || item.abs_id;
        if (!absId) { failed++; errors.push('Missing item ID'); continue; }
        const meta = item.metadata || {};
        const payload = buildAbsPayload(meta);
        await absApi(baseUrl, token, `/api/items/${absId}/media`, {
          method: 'PATCH',
          body: payload,
        });
        updated++;
      } catch (err) {
        failed++;
        errors.push(err.message);
      }
    }
    return { updated, failed, errors };
  },

  // === ABS Chapters ===
  get_abs_chapters: async (args) => {
    const config = getLocalConfig();
    const data = await absApi(config.abs_base_url, config.abs_api_token, `/api/items/${args.absId}`);
    return { chapters: data.media?.chapters || [] };
  },

  // === Full Pipeline (matching desktop process_with_pipeline) ===
  process_with_pipeline: async (args) => {
    const config = getLocalConfig();
    const request = args.request || {};
    const books = request.books || [];
    const results = [];
    let processed = 0, failed = 0;

    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      try {
        emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'classifying', message: `Classifying ${book.title}...` });

        // Step 1: Classification (genres, tags, age, themes, tropes)
        const classifyPrompt = buildClassificationPrompt(book, null, config.custom_classification_rules || null);
        const classifyResponse = await callAI(config, getSystemPrompt(config), classifyPrompt, 2000);
        const classify = parseAIJson(classifyResponse);

        // Step 2: DNA generation
        let dna_tags = [];
        try {
          emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'dna', message: `DNA for ${book.title}...` });
          const dnaPrompt = buildDnaPrompt(book);
          const dnaResponse = await callAI(config, getDnaSystemPrompt(config), dnaPrompt, 3000);
          dna_tags = convertDnaToTags(parseAIJson(dnaResponse));
        } catch (e) { console.warn('DNA failed:', e.message); }

        // Step 3: Description
        let description = book.description;
        let description_changed = false;
        try {
          emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'description', message: `Description for ${book.title}...` });
          const descPrompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
          const descResponse = await callAI(config, getSystemPrompt(config), descPrompt, 800);
          const desc = parseAIJson(descResponse);
          if (desc.description) { description = desc.description; description_changed = true; }
        } catch (e) { console.warn('Description failed:', e.message); }

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

        results.push({
          abs_id: book.abs_id,
          success: true,
          metadata: {
            genres: classify.genres || [],
            tags: allTags,
            themes: classify.themes || [],
            tropes: classify.tropes || [],
            description,
          },
        });
        processed++;
      } catch (err) {
        results.push({ abs_id: book.abs_id, success: false, error: err.message });
        failed++;
      }
    }
    return { books: results, processed, failed };
  },

  // === ABS Cache (client-side in-memory) ===
  get_abs_cache_status: () => ({ stats: { total_items: 0 }, stale: true }),
  refresh_abs_cache: async () => ({ refreshed: true, stats: { total_items: 0 } }),
  get_cached_items: () => [],
  clear_abs_full_cache: () => 'Cache cleared',
  clear_abs_library_cache: () => 'Cache cleared',

  // === External Data Gathering (stub — desktop-only feature, calls Audible/Goodreads via Rust) ===
  gather_external_data: async (args) => {
    // Web can't call these APIs directly (no CORS). Return empty results.
    // handleRunAll catches this gracefully and continues without gathered data.
    const books = args.books || [];
    return { results: books.map(b => ({ id: b.id, gathered: false })) };
  },
  get_unprocessed_abs_items: async () => ({ items: [] }),

  // === GPT: Metadata Resolution (batch) ===
  resolve_metadata_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const isLocalAI = !!(config.use_local_ai && config.ollama_model);
    const CONCURRENCY = isLocalAI ? (config.local_concurrency || 1) : (config.cloud_concurrency || 5);
    const results = [];

    const processBook = async (book) => {
      try {
        const prompt = buildMetadataPrompt(book);
        const response = await callAI(config, SYSTEM_PROMPT, prompt, 1500);
        const parsed = parseAIJson(response);
        const title = parsed.title || book.current_title;
        const author = parsed.author || book.current_author;
        const subtitle = parsed.subtitle || null;
        const series = parsed.series !== undefined ? parsed.series : null;
        const sequence = parsed.sequence !== undefined ? parsed.sequence : null;
        const narrator = parsed.narrator || null;
        const changed = title !== book.current_title || author !== book.current_author
          || subtitle !== (book.current_subtitle || null)
          || series !== (book.current_series || null)
          || sequence !== (book.current_sequence || null);
        return { id: book.id, title, author, subtitle, series, sequence, narrator, confidence: parsed.confidence || 75, changed };
      } catch (err) {
        return { id: book.id, error: err.message, changed: false };
      }
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }
    const total_processed = results.filter(r => !r.error).length;
    const total_failed = results.filter(r => r.error).length;
    return { results, total_processed, total_failed };
  },

  // === GPT: Metadata Resolution (single) ===
  resolve_title: async (args) => {
    const config = getLocalConfig();
    const input = args.request || args;
    const prompt = buildMetadataPrompt(input);
    const response = await callAI(config, SYSTEM_PROMPT, prompt, 1500);
    const parsed = parseAIJson(response);
    return {
      title: parsed.title || input.current_title,
      author: parsed.author || input.current_author,
      subtitle: parsed.subtitle || null,
      series: parsed.series || null,
      sequence: parsed.sequence || null,
      narrator: parsed.narrator || null,
      confidence: parsed.confidence || 75,
      notes: parsed.notes || null,
    };
  },

  // === GPT: Series Resolution ===
  resolve_series: async (args) => {
    const config = getLocalConfig();
    const input = args.request || args;
    const prompt = `Find the series for this audiobook:
Title: ${safe(input.title)}
Author: ${safe(input.author)}
${input.current_series ? `Current series: ${safe(input.current_series)}` : ''}

Return JSON: {"series":null,"sequence":null,"confidence":0,"source":"gpt"}
If it's part of a series, fill in the name and book number. If standalone, use null.`;
    const response = await callAI(config, SYSTEM_PROMPT, prompt, 500);
    return parseAIJson(response);
  },

  // === GPT: Classification (genres + tags + age + DNA + themes/tropes — matching desktop classify_book) ===
  classify_books_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const isLocal = !!(config.use_local_ai && config.ollama_model);
    const dnaEnabled = (args.dnaEnabled !== false) && !(isLocal && config.local_skip_dna);
    const CONCURRENCY = isLocal ? (config.local_concurrency || 1) : (config.cloud_concurrency || 5);
    const results = [];

    // Process a single book (classification + DNA in parallel — Ollama queues internally)
    const processBook = async (book) => {
      try {
        const classifyPromise = callAI(config, getSystemPrompt(config),
          buildClassificationPrompt(book, null, config.custom_classification_rules || null), 2000);
        const dnaPromise = dnaEnabled
            ? callAI(config, getDnaSystemPrompt(config), buildDnaPrompt(book), 1500).catch(() => null)
            : Promise.resolve(null);

        const [response, dnaResponse] = await Promise.all([classifyPromise, dnaPromise]);
        const parsed = parseAIJson(response);

        const age_tags = [];
        const ageRating = parsed.age_rating;
        if (ageRating && typeof ageRating === 'object') {
          if (ageRating.intended_for_kids === true) age_tags.push('for-kids');
          else age_tags.push('not-for-kids');
          const catMap = { "Children's 0-2": 'age-childrens', "Children's 3-5": 'age-childrens', "Children's 6-8": 'age-childrens', "Children's 9-12": 'age-childrens', 'Teen 13-17': 'age-teens', 'Young Adult': 'age-young-adult', 'Adult': 'age-adult', 'Middle Grade': 'age-middle-grade' };
          if (catMap[ageRating.age_category]) age_tags.push(catMap[ageRating.age_category]);
          const ratingMap = { 'G': 'rated-g', 'PG': 'rated-pg', 'PG-13': 'rated-pg13', 'R': 'rated-r', 'X': 'rated-x' };
          if (ratingMap[ageRating.content_rating]) age_tags.push(ratingMap[ageRating.content_rating]);
          const recMap = { "Children's 0-2": 'age-rec-0', "Children's 3-5": 'age-rec-3', "Children's 6-8": 'age-rec-6', "Children's 9-12": 'age-rec-10', 'Teen 13-17': 'age-rec-14', 'Young Adult': 'age-rec-16', 'Adult': 'age-rec-18', 'Middle Grade': 'age-rec-8' };
          if (recMap[ageRating.age_category]) age_tags.push(recMap[ageRating.age_category]);
        } else if (typeof ageRating === 'number') {
          if (ageRating <= 6) { age_tags.push('age-childrens', 'for-kids', 'rated-g', 'age-rec-0'); }
          else if (ageRating <= 9) { age_tags.push('age-childrens', 'for-kids', 'rated-g', 'age-rec-6'); }
          else if (ageRating <= 12) { age_tags.push('age-middle-grade', 'for-kids', 'rated-pg', 'age-rec-10'); }
          else if (ageRating <= 15) { age_tags.push('age-teens', 'for-teens', 'rated-pg13', 'age-rec-14'); }
          else if (ageRating <= 17) { age_tags.push('age-young-adult', 'for-ya', 'rated-pg13', 'age-rec-16'); }
          else { age_tags.push('age-adult', 'not-for-kids', 'rated-r', 'age-rec-18'); }
        }

        let dna_tags = [];
        if (dnaResponse) {
          try { dna_tags = convertDnaToTags(parseAIJson(dnaResponse)); } catch {}
        }

        return {
          id: book.id, success: true,
          genres: parsed.genres || [], tags: parsed.tags || [],
          age_tags, dna_tags,
          themes: parsed.themes || [], tropes: parsed.tropes || [],
          age_category: ageRating?.age_category || null,
          content_rating: ageRating?.content_rating || null,
          intended_for_kids: ageRating?.intended_for_kids || false,
        };
      } catch (err) {
        return { id: book.id, success: false, error: err.message };
      }
    };

    // Process in batches of CONCURRENCY
    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(chunk.map(processBook));
      results.push(...chunkResults);
    }

    const total_processed = results.filter(r => r.success).length;
    const total_failed = results.filter(r => !r.success).length;
    return { results, total_processed, total_failed };
  },

  // === GPT: Description Processing ===
  fix_descriptions_with_gpt: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const isLocalAI = !!(config.use_local_ai && config.ollama_model);
    const CONCURRENCY = isLocalAI ? (config.local_concurrency || 1) : (config.cloud_concurrency || 5);
    const results = [];

    const processBook = async (book) => {
      try {
        const prompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
        const response = await callAI(config, getSystemPrompt(config), prompt, 800);
        const parsed = parseAIJson(response);
        const action = parsed.action || 'kept';
        return { id: book.id, success: true, fixed: action === 'rewritten' || action === 'generated', new_description: parsed.description || null, action, reason: parsed.reason || null };
      } catch (err) {
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
    const isLocalAI = !!(config.use_local_ai && config.ollama_model);
    const CONCURRENCY = isLocalAI ? (config.local_concurrency || 1) : (config.cloud_concurrency || 5);
    const results = [];

    const processBook = async (book) => {
      try {
        const prompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
        const response = await callAI(config, getSystemPrompt(config), prompt, 800);
        const parsed = parseAIJson(response);
        const action = parsed.action || 'kept';
        return { id: book.id, success: true, changed: action === 'rewritten' || action === 'generated', description: parsed.description || null, action, reason: parsed.reason || null };
      } catch (err) {
        return { id: book.id, success: false, error: err.message };
      }
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }
    const total_processed = results.filter(r => r.success && r.changed).length;
    const total_failed = results.filter(r => !r.success).length;
    return { results, total_processed, total_failed };
  },

  // === GPT: Genre Cleanup ===
  cleanup_genres_with_gpt: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const results = [];

    for (const book of books) {
      try {
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
        const response = await callAI(config, SYSTEM_PROMPT, prompt, 500);
        const parsed = parseAIJson(response);
        // Enforce genre policy on AI output if enabled
        const genres = config.genre_enforcement !== false
          ? enforceGenrePolicyWithSplit(parsed.genres || [])
          : (parsed.genres || []).slice(0, 3);
        results.push({ id: book.id, success: true, genres });
      } catch (err) {
        results.push({ id: book.id, success: false, error: err.message });
      }
    }
    return { results };
  },

  // === GPT: Tag Assignment (standard tags + DNA, matching desktop classify_book) ===
  assign_tags_with_gpt: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const dnaEnabled = args.dnaEnabled !== false; // default ON
    const results = [];

    for (const book of books) {
      try {
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
        if (dnaEnabled) {
          try {
            const dnaPrompt = buildDnaPrompt(book);
            const dnaResponse = await callAI(config, getDnaSystemPrompt(config), dnaPrompt, 3000);
            const dna = parseAIJson(dnaResponse);
            dnaTags = convertDnaToTags(dna);
          } catch (dnaErr) {
            console.warn(`DNA generation failed for ${book.title}:`, dnaErr.message);
          }
        }

        // Merge standard + DNA tags
        const allTags = [...standardTags, ...dnaTags];
        results.push({ id: book.id, success: true, tags: standardTags, suggested_tags: allTags, dna_tags: dnaTags });
      } catch (err) {
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

    for (const book of books) {
      try {
        const prompt = `Find the official subtitle for this audiobook, if one exists.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
${book.series ? `Series: ${safe(book.series)}` : ''}

Return JSON: {"subtitle":null}
If the book has a well-known subtitle (e.g., "Dune: The Desert Planet"), include it. Otherwise null.`;
        const response = await callAI(config, SYSTEM_PROMPT, prompt, 300);
        const parsed = parseAIJson(response);
        results.push({ id: book.id, success: true, subtitle: parsed.subtitle || null });
      } catch (err) {
        results.push({ id: book.id, success: false, error: err.message });
      }
    }
    return { results };
  },

  // === GPT: Author Fix ===
  fix_authors_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const results = [];

    for (const book of books) {
      try {
        const cleaned = cleanAuthorName(book.author || '');
        results.push({ id: book.id, success: true, author: cleaned || book.author });
      } catch (err) {
        results.push({ id: book.id, success: false, error: err.message });
      }
    }
    return { results };
  },

  // === GPT: Year Fix ===
  fix_years_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const force = args.force || false;
    const results = [];
    let total_fixed = 0, total_skipped = 0, total_failed = 0;

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
        continue;
      }

      try {
        const descSnippet = book.description ? `Description: ${safe(book.description.slice(0, 200))}\n` : '';
        const prompt = `You are a librarian. Find the ORIGINAL FIRST publication year for this book.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
${book.series ? `Series: ${safe(book.series)}\n` : ''}${descSnippet}
Return the ORIGINAL first publication year, NOT audiobook release, reprint, or new edition date.
Return JSON: {"year":"2005"}`;
        const response = await callAI(config, SYSTEM_PROMPT, prompt, 200);
        const parsed = parseAIJson(response);
        const year = parsed.year ? String(parsed.year) : null;
        if (year && isValidYear(year)) {
          const date = `${year}-01-01`;
          results.push({ id: book.id, year, pub_date: date, pub_tag: `pub-${date}`, source: 'ai', fixed: true });
          total_fixed++;
        } else {
          results.push({ id: book.id, year: null, fixed: false, error: 'Invalid year from AI' });
          total_failed++;
        }
      } catch (err) {
        results.push({ id: book.id, year: null, fixed: false, error: err.message });
        total_failed++;
      }
    }
    return { results, total_fixed, total_skipped, total_failed };
  },

  // === BookDNA Generation ===
  generate_book_dna_batch: async (args) => {
    const config = getLocalConfig();
    const items = args.request?.items || args.items || [];
    const results = [];

    for (const item of items) {
      try {
        const prompt = buildDnaPrompt(item);
        const response = await callAI(config, getDnaSystemPrompt(config), prompt, 3000);
        const parsed = parseAIJson(response);
        const dnaTags = convertDnaToTags(parsed);

        // Merge with existing tags (preserve non-DNA tags, replace DNA ones)
        const existingNonDna = (item.tags || []).filter(t => !t.startsWith('dna:'));
        const mergedTags = [...existingNonDna, ...dnaTags];

        results.push({ id: item.id, success: true, dna_tags: dnaTags, merged_tags: mergedTags });
      } catch (err) {
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
      const response = await callAI(config, SYSTEM_PROMPT, prompt, 1000);
      const parsed = parseAIJson(response);
      return { success: true, age_rating: parsed.age_rating, age_rating_reason: parsed.age_rating_reason };
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
      const changed = JSON.stringify(cleanedGenres) !== JSON.stringify(originalGenres);
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
    const url = `${base}/api/items/${args.groupId}/cover?token=${encodeURIComponent(config.abs_api_token)}`;
    try {
      const res = await proxyFetch(url, { method: 'GET' });
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

  // === ISBN/ASIN Lookup (via Caddy proxy to Audible + Open Library) ===
  lookup_book_isbn: async (args) => {
    const { title, author } = args.request || args;
    if (!title) return { success: false, error: 'No title' };

    let isbn = null;
    let asin = null;

    // ASIN via Audible public catalog API (proxied through Caddy)
    try {
      const titleParam = encodeURIComponent(title);
      const authorParam = encodeURIComponent(author || '');
      const audibleRes = await fetch(`/api/audible/1.0/catalog/products?title=${titleParam}&author=${authorParam}&num_results=3&response_groups=product_desc`);
      if (audibleRes.ok) {
        const data = await audibleRes.json();
        const products = data.products || [];
        if (products.length > 0) {
          const titleLower = title.toLowerCase();
          const match = products.find(p => p.title?.toLowerCase() === titleLower) || products[0];
          asin = match.asin;
        }
      }
    } catch {}

    // ISBN via Open Library (proxied through Caddy)
    try {
      const query = encodeURIComponent(`${title} ${author || ''}`);
      const olRes = await fetch(`/api/openlibrary/search.json?q=${query}&limit=5&fields=isbn,title,author_name`);
      if (olRes.ok) {
        const data = await olRes.json();
        for (const doc of (data.docs || [])) {
          if (doc.isbn?.length > 0) {
            isbn = doc.isbn.find(i => i.length === 13) || doc.isbn[0];
            break;
          }
        }
      }
    } catch {}

    if (isbn || asin) {
      return { success: true, isbn, asin };
    }
    return { success: false, error: 'Not found' };
  },

  // === Maintenance ===
  clear_cache: () => 'Cache cleared',
  get_cache_stats: () => ({ genre_cache_size: 0, response_cache_size: 0 }),
  get_genre_stats: () => 'No server-side genre stats in web mode',
  normalize_genres: () => 'Genre normalization runs client-side in web mode',

  // === Scan progress (no-op in client mode) ===
  get_scan_progress: () => ({ scanning: false, current: 0, total: 0 }),
  cancel_scan: () => {},

  // === Undo (client-side) ===
  get_undo_status: () => ({ has_undo: false }),
  clear_undo_state: () => {},

  // === Ollama (disabled in web mode) ===
  ollama_get_status: () => ({ installed: false, running: false, models: [] }),
  ollama_get_model_presets: () => [],
  ollama_get_disk_usage: () => 0,
};

// ============================================================================
// ABS Item → BookGroup conversion (runs in browser)
// ============================================================================

function absItemToBookGroup(item, absBaseUrl) {
  const meta = item.media?.metadata || {};
  const base = absBaseUrl.replace(/\/$/, '');

  // ABS returns authors as both `authorName` (string) and `authors` (array of {id, name})
  const author = meta.authorName
    || (meta.authors || []).map(a => typeof a === 'string' ? a : a.name).join(', ')
    || 'Unknown';

  const narrator = meta.narratorName
    || (meta.narrators || []).map(n => typeof n === 'string' ? n : n.name).join(', ')
    || null;

  // Series can be in metadata.series (array) or metadata.seriesName (string)
  const seriesArr = (meta.series || []).map(s => ({
    name: typeof s === 'string' ? s : s.name,
    sequence: s.sequence || null,
    source: 'abs',
  }));

  return {
    id: item.id || crypto.randomUUID(),
    abs_id: item.id,
    source: 'abs',
    metadata: {
      title: meta.title || 'Unknown',
      author,
      narrator,
      subtitle: meta.subtitle || null,
      series: seriesArr[0]?.name || meta.seriesName || null,
      sequence: seriesArr[0]?.sequence || meta.seriesSequence || null,
      all_series: seriesArr,
      genres: meta.genres || [],
      tags: item.media?.tags || [],
      description: meta.description || null,
      publisher: meta.publisher || null,
      published_year: meta.publishedYear || meta.publishedDate?.substring(0, 4) || null,
      language: meta.language || null,
      isbn: meta.isbn || null,
      asin: meta.asin || null,
      cover_url: item.id ? `${base}/api/items/${item.id}/cover?token=${encodeURIComponent(getLocalConfig().abs_api_token)}` : null,
      duration: item.media?.duration || null,
      added_at: item.addedAt || item.createdAt || 0,
    },
    files: (item.media?.audioFiles || []).map(f => ({
      path: f.metadata?.path || '',
      filename: f.metadata?.filename || '',
      duration: f.duration || 0,
      size: f.metadata?.size || 0,
    })),
  };
}

// ============================================================================
// EVENT SUBSCRIPTION (SSE — only needed if using Axum backend, otherwise no-op)
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
// FILE PICKER (server-side file browser — kept for API compatibility)
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

export function resolveFileBrowser(path) {
  if (fileBrowserResolver) { fileBrowserResolver(path); fileBrowserResolver = null; fileBrowserOptions = null; }
}
export function getFileBrowserOptions() { return fileBrowserOptions; }
