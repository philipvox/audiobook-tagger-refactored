# Audit Fixes 2026-11-12 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding in `docs/AUDIT-2026-11-12.md` so that Push can no longer damage a curated ABS library, every visible control does what it says, and local folders can be scanned, tagged, renamed and undone from the GUI.

**Architecture:** Five waves in risk order. Wave 1 changes only pure lib functions and the push path (test seams exist). Wave 2 fixes reachable UI behaviour. Wave 3 hardens the Rust scanner/writer, and only then Wave 4 adds the missing buttons. Wave 5 is installers, CI and docs. Each task is one commit and leaves both suites green.

**Tech Stack:** Tauri 2, Rust (lofty, reqwest, tokio), React 18, Vite, vitest + Testing Library, cargo test.

**Spec:** `docs/AUDIT-2026-11-12.md`. Finding ids (C-1, H-3, W-5 ...) refer to it. Read the finding before starting a task.

## Global Constraints

- Branch `fix/audit-2026-11-12` off `main`. One conventional commit per task, ending with the trailer `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. **Do not push, tag or release.**
- TDD where a unit seam exists: failing test first, then the fix. UI wiring without a seam gets a component test that clicks the control.
- After every task: `npm run test:run` green (baseline 623 pass / 22 skipped), and for Rust tasks `cargo test --manifest-path src-tauri/Cargo.toml` green (baseline 95) with `cargo check` at zero warnings. `npm run build` green at the end of each wave.
- Never weaken or delete an existing test. If one encodes the audited bug, change its expectation and say so in the commit body.
- Data-preservation rule: when in doubt, send nothing. A push never sends an empty array, an AI-derived value never removes a value that was in ABS at import, and a failure is always visible to the user.
- No em dashes anywhere. No cosmetic sweeps of untouched code. Do not delete the unwired modals or handlers that this plan does not wire.
- No network calls to a real ABS server or AI provider from tests.

## Decisions taken (flagged in the audit as needing one)

- **H-1:** `preserve_existing_genres` defaults to **true** (an absent key means true). Classify supplements genres; replacing is opt-in.
- **#62:** local scan, Write Tags, Rename and Undo get buttons (Wave 4). Push is disabled for folder-scanned books. The other unwired modals stay unwired.
- **H-11:** `concurrency_abs_push` is wired (clamped 1 to 10, default 3). The `local_concurrency` and `custom_approved_genres` controls are removed; their stored values are left in config untouched.
- **H-13:** macOS FFmpeg installs through Homebrew, which the macOS whisper install already requires.
- Not in this plan: Apple notarization and Windows code signing (need certificates), a version bump or release, the 22 backend commands with no handler (all behind unwired controls), and the external-link behaviour (needs a click-test in a built app).

## Review Focus

1. A book whose ABS tags or genres changed on the server after import, then pushed: server-side additions must survive (Task 5).
2. A session saved by v2.2.2 or earlier, restored and pushed: nothing is sent until re-import (Task 6).
3. An AI answer that is empty, truncated, or `"N/A"`: nothing staged, the book shows an error (Tasks 1, 2, 7).
4. A folder holding two unrelated single-file books, scanned then renamed: two books, two names (Task 13).
5. A user with a search filter active who clicks Select All then any batch action: only the visible books are touched (Task 9).

---

## Wave 1 - Push safety (lib level)

### Task 1: Classify never empties genres or tags (C-1, H-1)

**Files:** Modify `src/lib/mergeGenres.js`, `src/lib/mergeClassifyTags.js`, `src/pages/ScannerPage.jsx:2676-2712`, `src/api.js:60-70` (DEFAULT_CONFIG), `src/api.js:879-887`, `src/pages/SettingsPage.jsx` (checkbox copy). Test: `src/lib/mergeGenres.test.js`, new `src/lib/classifyForce.test.js`.

**Interfaces - Produces:** `applyClassifyResult(metadata, result, { force, preserveGenres, originalTags }) -> { metadata, changedFields, error }` in new file `src/lib/applyClassifyResult.js`. Pure. `error` is `'empty-answer'` when `result.genres` and `result.tags` are both empty or absent; in that case `metadata` is returned unchanged.

- [ ] Test: `applyClassifyResult` with `force: true` and `result = { success: true, genres: [], tags: [] }` returns the input metadata unchanged and `error === 'empty-answer'`.
- [ ] Test: `force: true`, result has genres but no tags: genres updated, tags unchanged (an array is only cleared when the AI supplied a non-empty replacement for that same array).
- [ ] Test: `mergeGenres(['Cozy Witchy','Fantasy'], ['Fantasy','Adventure'], {})` returns `['Cozy Witchy','Fantasy','Adventure']` (preserve is now the default); with `{ preserve: false }` it returns `['Fantasy','Adventure']`.
- [ ] Implement `applyClassifyResult`; replace the inline block in ScannerPage with a call to it and set `lastError` on `'empty-answer'`. `classify` in `api.js` returns `success: false, error: 'Empty AI answer'` when both arrays are empty.
- [ ] `DEFAULT_CONFIG.preserve_existing_genres = true`; every reader uses `config.preserve_existing_genres !== false`. Settings checkbox relabelled "Keep existing genres and add AI suggestions (recommended)".
- [ ] Run suites, commit `fix(classify): never empty genres or tags; supplement genres by default`.

### Task 2: AI Tags and Generate DNA merge instead of replacing (C-2)

**Files:** Modify `src/api.js:1236-1262, 1515-1523`, `src/pages/ScannerPage.jsx:2372-2390, 2541-2553`. Test: new `src/api.ai-tags-merge.test.js`.

**Interfaces - Consumes:** `mergeClassifyTags(existingTags, result, originalTags)` from `src/lib/mergeClassifyTags.js`.

- [ ] Test: book tags `['favorite','kids-bedtime','dna:pacing:fast']`, AI Tags returns `['fast-paced']` and the DNA call throws: resulting tags contain `favorite`, `kids-bedtime`, `dna:pacing:fast` and `fast-paced`; the result carries `dna_error` with the message.
- [ ] Test: Generate DNA returning `{}` leaves every existing `dna:` tag in place and reports the book as failed.
- [ ] Test: Generate DNA returning new dna tags replaces the old `dna:` tags and keeps all non-dna tags.
- [ ] Implement: both appliers go through `mergeClassifyTags`; old `dna:` tags are removed only when at least one new `dna:` tag came back; a swallowed DNA failure becomes a visible per-book error.
- [ ] Commit `fix(tags): AI Tags and DNA merge into existing tags`.

### Task 3: Series import matches what ABS really returns (C-3, M-3 series part)

**Files:** Modify `src/api.js:1900-1950` (group builder), `src/api.js:305-330` (import loop), `src/lib/absPayload.js:59-120, 183-232`. Test: `src/lib/absPayload.test.js`, new `src/api.import-series.test.js`.

Fact (verified against a live server): `/api/libraries/:id/items?expanded=1` returns `metadata.seriesName` only, e.g. `"Rivers of London #8.1"` or `"The Plantagenet and Tudor #6, Tudor Court #1"`. There is no `series` array and no `seriesSequence`.

**Interfaces - Produces:** `parseSeriesName(str) -> { name, sequence } | null` in `absPayload.js` for a single-series string (no `, ` followed by another `#`); `isPlaceholderSeries(str) -> boolean` (true for empty, `N/A`, `None`, `Standalone`, `Unknown`, `null`, case-insensitive). Group field `metadata.series_unresolved: boolean`.

- [ ] Test: `parseSeriesName('Rivers of London #8.1')` gives `{ name: 'Rivers of London', sequence: '8.1' }`; `'Discworld'` gives `{ name: 'Discworld', sequence: null }`.
- [ ] Test: import of an item with `seriesName: 'A #6, B #1'` calls `GET /api/items/:id?expanded=1` once and builds `all_series` from that response's `metadata.series`; if that GET fails, `series_unresolved` is true.
- [ ] Test: `buildAbsPayload` never includes `series` when `meta.series_unresolved` is true, and never when the new series value satisfies `isPlaceholderSeries`.
- [ ] Test: single-series import sets `series`, `sequence` and a one-entry `all_series`, and the snapshot matches, so an untouched book yields an empty payload.
- [ ] Implement, commit `fix(series): parse seriesName on import; fetch multi-series; never push a placeholder`.

### Task 4: Fix Authors stops rewriting correct names (C-4)

**Files:** Modify `src/lib/normalize.js:347-416, 699-740`. Test: `src/lib/normalize.test.js` (or the existing author test file).

- [ ] Test: `cleanAuthorName` returns its input unchanged for `Don DeLillo`, `Tim O'Brien`, `Mary McCarthy`, `Ta-Nehisi Coates`, `CS Lewis`, `J.R.R. Tolkien`, `Ursula K. Le Guin`, `bell hooks`.
- [ ] Test: `cleanAuthorName('STEPHEN KING')` gives `Stephen King`; `cleanAuthorName('king, stephen')` gives `Stephen King`.
- [ ] Test: `cleanAuthorName('Homer, Emily Wilson')` is unchanged and `splitAuthors('Homer, Emily Wilson')` gives `['Homer', 'Emily Wilson']`; `splitAuthors('King, Stephen')` gives `['Stephen King']`.
- [ ] Implement: re-case only when the name is entirely upper case or entirely lower case; treat a comma as "Last, First" only when each side is a single word.
- [ ] Commit `fix(authors): keep mixed-case names; stop inverting co-author pairs`.

### Task 5: Push applies a delta to the live item (H-5, M-9, H-11 workers)

**Files:** Modify `src/api.js:255-395` (`push_abs_imports` and the single push), `src/lib/absPush.js`, `src/lib/absPayload.js`. Test: `src/lib/absPush.test.js`, `src/api.abs-write-integrity.test.js`.

**Interfaces - Produces:** `rebaseArrayOnLive(snapshotArr, localArr, liveArr) -> string[]` in `absPayload.js`: `live + (local - snapshot) - (snapshot - local)`, case-insensitive, live order and casing kept. Push result shape `{ updated: [{id,title}], skipped: [{id,title,reason}], failed: [{id,title,error}] }`. `runPool(items, worker, concurrency)` in `absPush.js`.

- [ ] Test: snapshot tags `['a','b']`, local `['a','b','c']`, live `['a','b','x']` gives `['a','b','x','c']`. Snapshot `['a','b']`, local `['a']`, live `['a','b','x']` gives `['a','x']`.
- [ ] Test: push does `GET /api/items/:id` before `PATCH`, and the PATCH body's `tags` and `genres` are the rebased arrays.
- [ ] Test: a book whose payload is empty lands in `skipped` with reason `'no changes'`, not in `updated`; a 500 lands in `failed` with its `id` and `title`.
- [ ] Test: after a successful push the group has `total_changes === 0`, empty `changedFields`, and every `file.changes` is `{}`.
- [ ] Test: `runPool` with concurrency 3 never has more than 3 workers in flight; concurrency is read from `config.concurrency_abs_push`, clamped to 1..10, default 3.
- [ ] Implement; the toast and the push summary list failed titles (first 5, then "and N more").
- [ ] Commit `fix(push): rebase tags and genres on the live item; report per book`.

### Task 6: Year pushes, and no push without a snapshot (H-2, H-4)

**Files:** Modify `src/lib/absPayload.js:25-35, 183-225`, `src/lib/session.js:110-135`, `src/pages/ScannerPage.jsx:1384`, `src/components/scanner/MetadataPanel.jsx:863`, `src/components/EditMetadataModal.jsx:363`, `src/lib/applyMetadata.js`. Test: `src/lib/absPayload.test.js`, `src/lib/session.test.js`.

**Interfaces - Produces:** `setYear(metadata, value) -> metadata` in `applyMetadata.js`, writing both `year` and `published_year`. Group flag `needs_reimport: true`.

- [ ] Test: snapshot year 1999, `metadata.year = '2005'` with `published_year` still 1999: payload is `{ metadata: { publishedYear: '2005' } }`.
- [ ] Test: `buildAbsPayload(meta, null)` for a group with `source: 'abs'` returns an empty payload (the old send-everything fallback is gone).
- [ ] Test: `parseSession` marks every ABS group lacking `abs_original` with `needs_reimport: true`; the push puts such a group in `skipped` with reason `'Re-import from ABS before pushing'`.
- [ ] Implement; route all three year writers through `setYear`. Commit `fix(push): year edits reach ABS; books without a snapshot are not pushed`.

### Task 7: AI response handling (M-1, M-2, M-3, H-6)

**Files:** Modify `src/lib/proxy.js:1-70, 140-240, 340-440`, `src/api.js:589-601, 690-710, 1800-1830`. Test: `src/lib/proxy.test.js` (extend), new `src/lib/proxy.truncation.test.js`.

- [ ] Test: `parseAIJson('{"genres":["Fantasy","Adv')` throws; `parseAIJson('Here you go: {"a":1} thanks')` returns `{ a: 1 }`; a response whose first bracket opens an object that never closes throws even if a later complete array exists.
- [ ] Test: an OpenAI response with `status: 'incomplete'` and an Anthropic response with `stop_reason: 'max_tokens'` both reject with an error whose message contains `truncated`.
- [ ] Test: in the Tauri branch a request that never resolves rejects after `timeoutMs` (use fake timers and an `AbortController` signal; assert the signal was passed to the fetch).
- [ ] Test: a 429 is retried up to 2 times with backoff, honouring `Retry-After` when present.
- [ ] Test: with no `VITE_PROXY_URL` set, a failed direct fetch rejects and no request is made to any other host; with it set, the fallback happens only when the direct error is a `TypeError`.
- [ ] Test: `resolve_metadata_batch` ignores a result with `confidence < 60`; the OpenLibrary source is labelled `OpenLibrary` in the prompt.
- [ ] Implement, commit `fix(ai): reject truncated answers; real timeouts; no default third-party proxy`.

---

## Wave 2 - Reachable UI

### Task 8: The five AI actions apply their results (H-3, M-5, M-7)

**Files:** Modify `src/api.js:806-845, 1195, 1293, 1546`, `src/pages/ScannerPage.jsx:1000-1080, 1120-1150, 880-910, 1620-1680, 1720-1785, 2450`. Test: new `src/api.result-shapes.test.js`, `src/pages/ScannerPage.fix-series.test.jsx`.

**Interfaces - Produces:** every single-book AI handler returns `{ success: boolean, result?: object, error?: string }`. `resolve_title.result = { title, author, subtitle, series, sequence, narrator, confidence }`; `resolve_series.result = { series, sequence }`; `fix_subtitles` items carry `fixed: boolean, subtitle`; `cleanup_genres_with_gpt` items carry `changed: boolean, cleaned_genres: string[]`; `lookup_age` returns `{ age_category, age_tags, age_rating }`.

- [ ] Test per handler: with `callAI` mocked to a valid answer the returned shape matches the table above.
- [ ] Test: Fix Series correcting `Stormlight` to `The Stormlight Archive` leaves `all_series` with exactly one entry (replace index 0, do not prepend).
- [ ] Test: with every per-book call rejecting, Fix Titles, Fix Series, Fix Subtitles, Age and audio check each produce an error toast naming the failure count (route through the existing `summarizeBatch`).
- [ ] Implement; compute audio check's `updatedCount` outside the state updater. Commit `fix(enrich): AI actions apply their results and report failures`.

### Task 9: Selection, cancel and import errors (H-7, H-8, H-9, M-6, plus LOW items)

**Files:** Modify `src/hooks/useScan.js:520-540, 885-920`, `src/api.js:300-395, 1844`, `src/pages/ScannerPage.jsx:400-430, 2010-2020, 2155-2165, 2650-2660, 3350-3355, 3400-3500`, `src/components/scanner/ActionBar.jsx:110-120, 440-495`, `src/components/ABSPushModal.jsx`. Test: `src/components/scanner/ActionBar.test.jsx`, `src/hooks/useScan.test.js` (new cases, do not touch the 22 skipped), `src/api.cancel.test.js`.

**Interfaces - Produces:** module-level `cancelToken = { cancelled: boolean }` in `src/lib/cancel.js` with `requestCancel()`, `resetCancel()`, `isCancelled()`. Import and push loops check `isCancelled()` between items; resolve, descriptions and classify run in chunks of 25 with `setGroups` after each chunk and the same check.

- [ ] Test: with a filter active and 30 of 3,000 books shown, Select All selects exactly those 30 (`onSelectAll` receives `filteredGroups`).
- [ ] Test: `requestCancel()` during a 50-book push stops after the in-flight book; the result reports the remainder as `skipped` with reason `'cancelled'`.
- [ ] Test: an import that rejects produces an error toast with the message, and `hasAbsConnection` is false without `abs_library_id`.
- [ ] Test: ABSPushModal's Confirm is disabled while a push is running; Push with no selection is disabled.
- [ ] Test: classify on 60 books calls `setGroups` three times (25, 25, 10).
- [ ] Implement; add `fixingSubtitles` to `isProcessing`; move the DNA `unlisten` into `finally`. Commit `fix(scanner): filtered select-all, real cancel, visible import errors`.

### Task 10: Narrator extraction and genre cleanup gate (M-4, M-8)

**Files:** Modify `src/pages/ScannerPage.jsx:835-910, 2160-2175`, `src/hooks/useScan.js:860-885`; new `src/lib/extractNarrator.js`. Test: `src/lib/extractNarrator.test.js`.

**Interfaces - Produces:** `extractNarrator(description) -> string | null`.

- [ ] Test: `'Read by the author with a full cast.'` gives `null`; `'Narrated by John Lee and featuring original music'` gives `'John Lee'`; `'read by Bahni Turpin.'` gives `'Bahni Turpin'`; `'Performed by a full cast'` gives `null`.
- [ ] Test: genre cleanup with only an Anthropic key or with local AI on takes the AI path; the static path stamps `changedFields` and toasts its result.
- [ ] Implement, commit `fix(enrich): narrator extraction and genre-cleanup provider gate`.

### Task 11: Onboarding, settings and push modal (H-10, H-11, H-12, M-10, M-11, LOW)

**Files:** Modify `src/components/OnboardingWizard.jsx:140-200, 320, 370-430`, `src/pages/SettingsPage.jsx:240, 400-500, 575-620, 790-880, 910-920, 1055-1070, 1350-1420`, `src/components/ABSPushModal.jsx:20-30, 95-175`, `src/components/scanner/MetadataPanel.jsx:300-310, 436-446`, `src/lib/proxy.js:75-85`. Test: `src/pages/SettingsPage.test.jsx`, new `src/components/OnboardingWizard.test.jsx`, `src/components/ABSPushModal.test.jsx`.

- [ ] Test: completing the wizard's import step puts the imported groups in context (`setGroups` called with them); the green "N books imported" box appears only after the import promise resolves.
- [ ] Test: the wizard's first screen offers "I only use local folders", which completes onboarding and lands on the Library tab.
- [ ] Test: Settings shows a "Use Local AI" switch whose state is `config.use_local_ai`, independent of whether Ollama is running; turning it on with zero models installed shows "Download a model first" and leaves the config unchanged.
- [ ] Test: with only an Anthropic key, saving switches `ai_model` to the default Anthropic model; with only an OpenAI key the reverse.
- [ ] Test: blurring the Ollama URL field persists only `ollama_base_url`; `handleSave` trims the ABS URL and token and strips trailing slashes.
- [ ] Test: the "Local AI Workers" and "Approved Genres" controls are gone; "ABS Push Workers" is a 1 to 10 control.
- [ ] Test: ABSPushModal copy reads "Only fields you changed since import are sent. Tags and genres are merged with what is on the server." and a 12-file book with a title change counts as 1 title update.
- [ ] Test: clicking a multi-file book's file count expands its file list (`onToggleGroup` is called from `BookList.jsx`).
- [ ] Implement; remove the "Save Local" button. Commit `fix(settings): local-AI switch, working import in onboarding, honest push copy`.

---

## Wave 3 - Rust scanner and writer (before any button exists)

### Task 12: Writer correctness (W-2, W-3, W-5, W-6, W-7)

**Files:** Modify `src-tauri/src/writer.rs:100-190, 300-460, 555-580, 715-800, 855-880`, `src-tauri/src/scanner.rs:115-130, 180-190`, `src-tauri/src/lib.rs`. Tests in the existing `#[cfg(test)]` modules, using the existing ffmpeg-free fixture helpers.

- [ ] Test `multi_file_title_goes_to_album`: a 3-file mp3 group, change `title`: every file's album is the new title, track titles are unchanged, and a rescan reports the new book title.
- [ ] Test `mp3_with_uslt_frame_writes`: a file with a USLT frame accepts a title write and the lyrics text is still present afterwards.
- [ ] Test `temp_name_is_short_and_skipped`: the temp file is named `.tagtmp-<uuid>.<ext>` (so a 230-character filename writes), the scanner ignores any file whose name starts with `.tagtmp-`, and `sweep_temp_files(dir)` removes them.
- [ ] Test `journal_write_is_atomic`: `write_journal` writes a sibling temp file, fsyncs and renames (reuse `session::atomic_write`; make it `pub(crate)`).
- [ ] Test `mp3_decimal_series_roundtrip`: sequence `1.5` is read back as `1.5` (also write and read `TXXX:SERIES-PART`).
- [ ] Test `m4b_year_replaces_full_date`: a file dated `2015-06-01` written with year `2020` reads back `2020`.
- [ ] Test `rename_template_values_are_literal`: title `Weird {Unabridged} Book` with template `{title} - {author}` renders `Weird {Unabridged} Book - A`; title `CON` renders `CON_`.
- [ ] Test `rename_refuses_symlink_source`.
- [ ] Implement; make `write_tags`, `rename_files` and `undo_last_write` async with `spawn_blocking`. Commit `fix(writer): album for multi-file titles, lyrics, atomic journal, safe temp names`.

### Task 13: Scanner grouping (W-1, W-4)

**Files:** Modify `src-tauri/src/scanner.rs:170-190, 720-830`. Tests in its test module.

- [ ] Test `numeric_title_is_its_own_book`: `1984.m4b` + `Animal Farm.m4b` in one folder give two groups.
- [ ] Test `albumless_mp3s_with_distinct_titles_split`: `Carrie.mp3` + `Misery.mp3`, titles set, no album, no shared numbering: two groups.
- [ ] Test `stray_file_does_not_join_keyed_book`: `Dune.m4b` + `Emma.mp3` give two groups.
- [ ] Test `per_track_m4a_with_shared_album_is_one_book`: `01.m4a..03.m4a`, album `Dune`, differing titles: one group titled `Dune` whose author is not the folder name.
- [ ] Test `numbered_track_set_stays_one_book`: `01 - Chapter.mp3 .. 30 - Chapter.mp3` with no album stay one group (the existing behaviour must hold).
- [ ] Test `dot_named_root_scans`: scanning a root folder named `.books` returns its books.
- [ ] Implement: an all-digit title falls back to the file stem as key; album-less files get a title or stem key unless the folder is a numbered track set; m4a/m4b sharing one album with differing titles key by album. Commit `fix(scanner): stop merging unrelated books in one folder`.

---

## Wave 4 - Wire local files (#62)

### Task 14: Scan Folder, with progress and cancel (headline, W-8)

**Files:** Modify `src/components/scanner/ActionBar.jsx`, `src/components/scanner/BookList.jsx:620-680`, `src/hooks/useScan.js:130-290`, `src/api.js:1843-1844, 2018-2031`, `src-tauri/src/scanner.rs` (progress + cancel), `src-tauri/src/lib.rs`. Test: `src/components/scanner/ActionBar.test.jsx`, `src/components/scanner/BookList.test.jsx`, `src/hooks/useScan.test.js`, scanner test module.

**Interfaces - Produces:** Tauri commands `get_scan_progress() -> { scanning, current, total }` and `cancel_scan()` backed by atomics in `scanner.rs`; `handleScan()` takes no arguments (a click event must not become `scanMode`). ActionBar pill "Scan Folder" (icon `FolderOpen`) always enabled when not processing; the empty state shows two equal choices, "Scan a local folder" and "Load from AudiobookShelf".

- [ ] Test: with no ABS credentials the empty state shows "Scan a local folder" and clicking it calls `onScan`.
- [ ] Test: `handleScan` with a non-empty workspace that has staged changes asks for confirmation before replacing; a rejected scan shows an error toast; a successful scan clears the selection.
- [ ] Test (Rust): `cancel_scan` during a scan makes `scan_library` return the groups found so far with `cancelled: true`.
- [ ] Remove `handleImport` and its `onImport` prop (it calls `import_folders`, which does not exist).
- [ ] Implement, commit `feat(scan): Scan Folder button with progress and cancel (#62)`.

### Task 15: Write Tags, Rename and Undo buttons (headline, W-8)

**Files:** Modify `src/components/scanner/ActionBar.jsx`, `src/pages/ScannerPage.jsx:510-545, 670-690, 3100-3270, 3400-3410`, `src/hooks/useTagOperations.js:55-175`, `src/lib/applyMetadata.js`. Test: `src/components/scanner/ActionBar.test.jsx`, `src/hooks/useTagOperations.test.js`, `src/lib/applyMetadata.test.js`.

**Interfaces - Consumes:** `write_tags`, `preview_rename`, `rename_files`, `undo_last_write`, `get_undo_status` (existing commands). **Produces:** `isLocalGroup(group) -> boolean` in `applyMetadata.js` (`source !== 'abs'` and at least one file with a `path`).

- [ ] Test: with a locally scanned book selected, ActionBar shows "Write Tags" and "Rename"; with only ABS books selected it shows neither. "Undo last write" shows when `get_undo_status` reports a journal.
- [ ] Test: Push is disabled when the selection contains only local groups, with the tooltip "Local folders have no ABS item to push to"; in a mixed selection local groups land in `skipped`.
- [ ] Test: every enrich applier (classify, tags, DNA, age, ISBN, audio check, batch fix) stamps `file.changes` through `applyMetadataToGroup`, so `buildWritePayload` for an enriched local book is not empty.
- [ ] Test: `handleBulkSave` on a file with no `changes` object does not throw.
- [ ] Test: the rename result uses `path.split(/[\\/]/).pop()` so a Windows path shows only the filename.
- [ ] Implement, commit `feat(files): Write Tags, Rename and Undo buttons (#62)`.

---

## Wave 5 - Installers, CI, docs

### Task 16: Whisper and FFmpeg install (H-13, H-14, H-15 partial, M-12 partial)

**Files:** Modify `src-tauri/src/whisper_local.rs:100-180, 395-520, 590-760, 880-905`, `src-tauri/src/whisper.rs:455-535`.

- [ ] Test `finds_whisper_cli_in_release_dir`: an extracted tree with `Release/main.exe` and `Release/whisper-cli.exe` selects `whisper-cli.exe`, and `install_release_dir` copies every file of `Release/` beside it. `main` and `main.exe` are no longer candidates.
- [ ] macOS FFmpeg: replace the evermeet URL with `brew install ffmpeg`, surfacing brew's stderr on failure; if brew is absent return "Install Homebrew, or install FFmpeg yourself and restart".
- [ ] Linux FFmpeg: pin a versioned johnvansickle URL and an in-source SHA-256 (compute it from the file; record the version in a comment). Whisper models: pin the Hugging Face revision hash in the URL and verify each model's SHA-256 (take them from the HF API `lfs.sha256` field).
- [ ] Test `model_hash_mismatch_is_rejected`.
- [ ] ffmpeg/whisper children: spawn with tokio, `-rw_timeout 30000000` for network input, a 10 minute overall timeout, kill on `CANCELLED`. The ABS token must not appear in any argv: download the needed byte range with reqwest and feed it to ffmpeg on stdin. Add `creation_flags(0x08000000)` on Windows to every spawn.
- [ ] Commit `fix(whisper): working macOS and Windows installs, pinned and hashed downloads, timeouts`. State in the commit body that the Windows path is untested on Windows.

### Task 17: Ollama install and pull (H-15, H-16, M-12, LOW)

**Files:** Modify `src-tauri/src/ollama.rs:115-130, 335-520`, `src-tauri/src/lib.rs:40-55`.

- [ ] Pin one Ollama release version; URLs point at that tag's assets; SHA-256 per asset in source (take them from the GitHub release API `digest` field). Stream to disk, verify, then extract.
- [ ] Install the whole `Ollama.app/Contents/Resources/` directory (macOS) or the tarball's `bin/` and `lib/` tree (Linux) and run the binary from there.
- [ ] Test `pull_error_line_is_an_error`: a stream containing `{"error":"model not found"}` returns `Err`; a stream that ends without `{"status":"success"}` returns `Err`.
- [ ] Replace total-request timeouts with a 30 s connect timeout and a 60 s idle timeout between chunks for every download and the pull.
- [ ] `is_running` gets a 3 s timeout. On startup, if a PID file from a previous run points at a live `ollama` process started by this app, adopt it so Stop works.
- [ ] Commit `fix(ollama): pinned verified install, full runtime, truthful pull result`.

### Task 18: CI, SECURITY.md, README (M-13, LOW)

**Files:** Modify `.github/workflows/build.yml`, `SECURITY.md`, `README.md`, `src-tauri/Cargo.toml` (lofty stays; note only).

- [ ] Pin `tauri-apps/tauri-action` and `dtolnay/rust-toolchain` to commit SHAs with the version in a trailing comment; move `permissions: contents: write` onto the release job only; the release step runs only when `startsWith(github.ref, 'refs/tags/v')`; add a step that uploads `SHA256SUMS.txt` for the artifacts.
- [ ] SECURITY.md: list the hosts the app contacts (ABS, the AI provider, localhost, github.com, huggingface.co, gyan.dev, johnvansickle.com, ollama.com and its registry), state that the HTTP scope allows any host because ABS servers are user-chosen, supported versions `2.2.x`.
- [ ] README: local scanning section describing Scan Folder, Write Tags, Rename, Undo; push workers "default 3, set 1 for a NAS"; remove claims for anything still unwired.
- [ ] Update `docs/AUDIT-2026-11-12.md` with a status block at the top listing what was fixed, what was deliberately left, and the final test counts.
- [ ] Commit `ci,docs: pin actions, scope release permissions, document what the app does`.
