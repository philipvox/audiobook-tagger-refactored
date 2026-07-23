# Audit Fix Plan - 2026-07-21

Executes fixes for every finding in `docs/AUDIT-2026-07-21.md` (read it for full failure scenarios). Branch: `fix/audit-2026-07-21`. Nine implementation tasks clustered by file domain so tasks never touch the same files.

## Global Constraints

- TDD where a unit seam exists: write the failing test first, then fix. UI-wiring fixes without a test seam (jsdom gaps documented in C7c) get manual verification notes in the commit message instead; do NOT fight the known useScan/jsdom scaffolding gap.
- After each task: `npm run test:run` must be fully green (118+ passing, 22 skipped allowed) and, for Rust tasks, `cargo test --manifest-path src-tauri/Cargo.toml` green. New tests must be added to the count, never removed.
- Never weaken an existing test to make it pass. Never delete curated-data safety behavior.
- Data-preservation default: when an AI response or partial input lacks a field, KEEP the existing value. Only explicit user action clears data.
- Commit per coherent chunk with conventional-commit messages ending in the Claude Code trailer. Do not push.
- No em dashes in any output, comments, or docs. Use regular dashes or colons.
- All paths below are relative to the v2 repo root (`audiobook-tagger-v2/`).
- Out of scope (documented, deliberate): wiring the dead CoverSearchModal / ChaptersModal / ChapterPreviewModal / RawTagInspector / LoginPage components (feature work, not logic fixes); the static-web-deploy proxy strategy (`proxy.js` `useLocalProxy`, needs infra decision).

---

## Task 1: api.js ABS write-path integrity

Files: `src/api.js`, `src/lib/abs-client.js`, tests in `src/api.*.test.js`.

Fix, with unit tests for each:

1. **CR-4a** `api.js:308-310`: `buildAbsPayload` must OMIT the `series` key from the metadata payload when the input carries no series information (currently defaults to `[]`, wiping curated ABS series on partial pushes). Only include `series` when `meta.series` is a non-empty string (or the existing series-array branch applies). There is no clear-series path today; removing series stays a manual-in-ABS operation.
2. **CR-4b** `api.js:685-686`: in `resolve_metadata_batch`, a missing OR null `series`/`sequence` key in the AI response must fall back to `book.current_series`/`book.current_sequence` exactly like title/author do, never to null. An AI response cannot clear a series.
3. **K** `api.js:265`: author splitting `meta.author.split(/[,&]/)` mangles "Martin Luther King, Jr.". Add a `splitAuthors(str)` helper (in `src/lib/normalize.js`, exported) that splits on `&` and " and ", and on commas ONLY when the comma-part is not a known suffix (Jr, Jr., Sr, Sr., II, III, IV, PhD, MD, M.D., Ph.D.). Use it in buildAbsPayload.
4. **F** `api.js:692-695`: include narrator in the `changed` computation, and compare sequence/subtitle with String() normalization on both sides so numeric 3 vs "3" is not a spurious change.
5. **J** `api.js:378` vs `405`: unify both push handlers to `item.abs_id || item.id`.
6. **L** `api.js:1754, 1779`: `sequence: s.sequence ?? null` (preserve 0); in buildAbsPayload treat empty-string sequence as absent (`s.sequence != null && s.sequence !== ''`).
7. **Pagination** `api.js:355-361` and `abs-client.js:48-55`: guard both loops: `if (items.length === 0) break;` plus a hard page cap (`page > 1000` break with console.warn). If the response omits `total`, keep looping until an empty/short page instead of exiting after page 1: loop while the last page returned exactly `limit` items.
8. **Q** `api.js` push handlers: before the loop, if `abs_base_url` or `abs_api_token` is missing, return a single failure result immediately instead of issuing N doomed requests.

Report totals: run `npm run test:run`; all green plus new tests.

---

## Task 2: api.js AI batch integrity + proxy parsing

Files: `src/api.js`, `src/lib/prompts.js`, `src/lib/proxy.js`, tests.

1. **C** classify positional matching (`api.js:916-918`) + prompts.js:302-309: add `"id"` to the required classify output schema example and instruction ("echo the id of each book verbatim"). In the handler, match results by id first (`parsedArray.find(p => String(p.id) === String(book.id))`), fall back to position only when no id-matched entry exists AND lengths are equal. When a book gets no entry, produce a per-book failure with errorDetail (kind 'empty-response'), never a silent empty success.
2. **D** `api.js:731` resolve: same id-first matching.
3. **E** `api.js:1302-1322` fix_authors: when the AI returns a valid author equal to the current one, report `success: true, changed: false` with message "Author confirmed" and count it as processed, not failed.
4. **G** `api.js:897-911` classify per-book fallback: run DNA when `dnaEnabled` (same as batch path) and attach errorDetail on failures instead of silent empty results.
5. **H** `api.js:455-466` process_with_pipeline: capture DNA/description failures as errorDetail on the per-book result (same shape the classify handler uses) instead of console.warn only.
6. **I** custom system prompt: replace bare `SYSTEM_PROMPT` with `getSystemPrompt(config)` at api.js:721, 741, 762, 795, 820, 1116, 1218, 1380, 1464 (verify each call site has config in scope).
7. **M** `api.js:524, 565` gather_external_data: route through `proxyFetch` (like `api.js:1686` does) so Tauri HTTP plugin + the 30s timeout apply.
8. **parseAIJson** `proxy.js:351-363`: make it robust: strip fences anywhere, then if `JSON.parse` fails, extract the first balanced `{...}` or `[...]` block (scan for matching braces respecting strings) and parse that; throw only if no parseable block exists. Add tests: prose-wrapped, fence-wrapped, trailing commentary, plain JSON, garbage.
9. **O/P** token budgets: raise `resolve_metadata_batch` to `BATCH_SIZE * 400`; raise fix_authors/fix_years `maxTokens` from 200 to 600 (Responses API budget includes reasoning tokens).
10. **N** `api.js:1085-1087`: descriptions accounting: `total_processed` = all successful results (changed or kept), add `total_unchanged` for kept ones.
11. **R** `api.js:1483`: compare genre arrays order-insensitively (sort copies before stringify).

---

## Task 3: lib normalization, genres, prompts

Files: `src/lib/normalize.js`, `src/lib/genres.js`, `src/lib/prompts.js`, `src/lib/errorDetail.js`, `src/context/AppContext.jsx` (one line), tests (`normalize.bugfixes.test.js`, `genres.bugfixes.test.js`, new files fine).

1. **H-2** `normalize.js:314-322` cleanAuthorName co-author corruption: apply the "Last, First" swap for 2 comma-parts ONLY when the first part is a single word and the second part is 1-2 words ("King, Stephen" and "King, Stephen Edwin" swap; "Stephen King, Peter Straub" does not: both parts multi-word means co-authors, return joined with ", " after per-name cleanup). For 3+ parts keep the existing suffix handling but treat all-multi-word parts as a co-author list.
2. **H-3** `genres.js:459-464` and `429-433`: forward containment only: map input -> approved only when the APPROVED tag's token set is a subset of the INPUT's token set (never when the approved tag merely contains the input's tokens). `mapTag("fantasy")` must return `"fantasy"` (exact) and never `"fantasy-romance"`.
3. **M-1** `normalize.js:473` stripTrackSuffixes: the trailing keyword regex must require a digit (`\s*\d+\s*$`), so "The Final Chapter" survives.
4. **M-2** `normalize.js:93-97` looksLikeAcronym: allow up to 6 chars and `&`/digits (`^[A-Z0-9&]{2,6}$`), and strip trailing punctuation before the check in toTitleCase so "FBI:" preserves.
5. **M-5** `genres.js:691-694, 712-715`: add `age-rec-0` and `age-rec-3` to both readingAgeTags lists.
6. **M-9** `normalize.js:167-195` removeJunkSuffixes: add parenthesized combos (`(Unabridged Edition)`, `(Unabridged Audiobook)`), bracketed bitrates (`[64kbps]`-style: `/^\[\d+\s*kbps\]$/i`), and make the strip iterative so `Title (Unabridged) (2001)` fully cleans.
7. **L-1** `normalize.js:249-255` extractSubtitle: apply the same narrator-prefix rejection to the colon branch as the dash branch.
8. **L-2** suffix casing: add phd/md/m.d./ph.d. to the special-case set so "King, PhD" keeps "PhD"; add dotted suffixes (M.D., Ph.D., Jr., Sr.) to the suffix list.
9. **L-3** `normalize.js:395-411` validateYear: fix the live bugs rather than leaving a trap: accept 1000..currentYear+2 (mirror api.js isValidYear) and use word-boundary regex `\b(1[0-9]{3}|20[0-9]{2})\b` so ISBN digit runs do not match.
10. **L-4** genres.js: singularize tokens before matching (strip trailing "s" when no exact match, so "Thrillers" -> thriller, "Mysteries" -> mystery via ies->y).
11. **L-5** `genres.js:593-610` splitCombinedGenres: split on ALL separators (`/`, `,`, `;`, `&`, ` and `) in one pass, not else-if.
12. **L-6** `prompts.js:165-174`: candidate block must emit title, author, year, publisher, narrator (when present) per candidate.
13. **L-7** sequence 0: `prompts.js:141, 252, 372` use `!= null` checks; `AppContext.jsx:336` same.
14. **L-8** `errorDetail.js:91-93`: classify messages containing "API key", "Invalid key", "unauthorized" as kind 'http' before the network fallback.

---

## Task 4: hooks + abs-client + AuthorsPage save

Files: `src/hooks/useScan.js`, `src/hooks/useAuthors.js`, `src/hooks/useFileSelection.js`, `src/hooks/useTagOperations.js`, `src/lib/abs-client.js`, `src/pages/AuthorsPage.jsx`, `src/utils/useScan.js` (delete).

1. **CR-1** `useScan.js:312-347`: if the rescan scan call threw, do NOT run the group-replacement setGroups; return `{success: false, error}` and surface a toast from the caller if one exists. Groups and staged edits must survive a failed rescan.
2. **CR-3** `abs-client.js:168-174`: give every ABS file a stable id (`` `${item.id}-f${index}` ``) and a `changes: {}` object. In `useTagOperations.js:62` and anywhere doing `selectedFiles.has(file.id)`, skip files with a null/undefined id defensively.
3. **L-12** `useFileSelection.js:125, 131`: guard `Object.keys(f.changes || {})`.
4. **L-11** `useScan.js:264-266`: compute the parent dir with `Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))`.
5. **L-10** `useScan.js:647-730`: move `unlisten()` into a finally block (match the other handlers).
6. **L-13** delete the dead broken fragment `src/utils/useScan.js` (verify zero importers first).
7. **M-4/L-14** `abs-client.js:161`: also set `year` (same value) so rescan payloads carry it; parse tagDate defensively: only take the first 4 chars when they are 4 digits, else try `new Date(tagDate).getFullYear()`, else null.
8. **H5/M-8** `useAuthors.js:362-389` pushToAbs: on partial failure, keep the staged entries that failed (remove only succeeded ones from pendingChanges/pendingMerges) and return the summary; `AuthorsPage.jsx:151-154` must show a toast with succeeded/failed counts.
9. **CR-7** `AuthorsPage.jsx:468-471`: export a `updateDetail(field, value)` from useAuthors (or export setDetail) and use it; the current code references an undefined `setDetail`.
10. **L1(pages)** `useScan.js:434-436`: before wholesale replacing groups on Pull-from-ABS, if any existing group has staged changes (`total_changes > 0` or non-empty file.changes), merge instead of replace: keep unmatched local groups, replace only ABS-sourced ones.

---

## Task 5: ScannerPage crash + data-loss paths

Files: `src/pages/ScannerPage.jsx` only (plus tests where a seam exists).

1. **CR-2** lines ~756-768 (Fix Titles) and ~1315-1328 (Fix Series): the rejected/error branch returns `{groupId, error}`; the setGroups updater must guard: `const { result } = batchResult.value; if (!result) { mark failed via lastError, count failure, return group unchanged; }`. No throw inside updaters. Count rejected books as failures.
2. **H1** line ~2280-2285: guard tags like genres: only replace `updatedMeta.tags` when the AI returned a non-empty `r.tags`; when only dna/age tags came back, merge them additively into existing tags (preserve curated tags, strip stale `dna:`/`age:` prefixed ones being replaced).
3. **M3** move success/failed counting out of setGroups updaters (compute from the results array before calling setGroups) at lines ~771/798, ~1330/1348, ~1415/1445, ~1532/1547.
4. **M8** lines ~1088-1091: the pub-tag-only branch must add 'tags' to changedFields and bump total_changes.
5. **M14** scrollToFirstErrorGroup calls (lines ~1007, 1142, 1730, 1827, 2332): compute the updated groups array first (build `nextGroups` from prev inside the updater is not accessible; instead derive the error group ids directly from the handler results and pass those ids), or simplest: change `scrollToFirstErrorGroup` usage to pass the results array (it only needs the first failed book id). Adjust `src/lib/batchToast.js` signature accordingly and update its tests.
6. **M2** clear `gatheredDataRef.current = null` at the end of every standalone flow that populated it (fix metadata, fix years, isbn lookup), not just Run All.
7. **M1** line ~566-568: pass the user-chosen `scanMode` to `handleRescanAbsImports` instead of hardcoded 'force_fresh'.
8. **M5/M7** undo (lines ~71-78): after successful `undo_last_write`, revert UI: clear fileStatuses for the undone files and re-run the backend `read_tags`/rescan for the affected paths when available; if no cheap path exists, set those groups' status to 'undone' and show a toast telling the user the files were reverted and the list may be stale. Undo failure must show an error toast.
9. **M6** lines ~3234-3243: after rename confirm, do NOT call `handleScan()` (opens a picker). Update each renamed file's `path`/`filename` in state from the rename result mapping instead.
10. **H3** Run All stale groups (lines ~1889-1895): add a `groupsRef` (`useRef`) kept in sync via `useEffect(() => { groupsRef.current = groups }, [groups])`; every step handler computes `const currentGroups = groupsRef.current` instead of closing over `groups` when building its book payloads (touch each handler's selectedGroups derivation). Verify Run All step N sees step N-1's merged results.

---

## Task 6: ScannerPage selection + write path

Files: `src/pages/ScannerPage.jsx`, `src/hooks/useTagOperations.js`, `src/hooks/useFileSelection.js`, `src/components/WritePreviewModal.jsx` (wire in).

1. **H4** `handleSelectFiltered` (~237-249): also add every file id of the filtered groups to `selectedFiles` (use the same mechanism as group click-select) so Write/Rename/Rescan work with filtered selection.
2. **H2/H6 write-path gap (the design decision, locked in):** add a helper `applyMetadataToGroup(group, updates, changedFieldNames)` in ScannerPage (or a small lib file) that (a) merges updates into `group.metadata`, (b) for each changed field, writes a `file.changes[field] = { old, new }` entry on EVERY file of the group (old = previous metadata value), (c) updates total_changes/changedFields. Use it in the merge blocks of: Fix Authors, Fix Titles, Fix Years, Fix Series, Metadata Resolution, Classification (tags/genres), Description processing, and the MetadataPanel inline-edit handler (~3044-3049). Result: Write Tags actually writes enrichment output. MetadataPanel "Save Local" may keep its current behavior since inline edits now stage real changes.
3. **H3(components)** wire `WritePreviewModal` into the write flow: Write button opens it (pass the pending per-file changes); its confirm calls `writeSelectedTags(fileIds, { backup, excludedChanges })`. Extend `writeSelectedTags` to accept backup flag (default true now) and an exclusion set (`fileId:field` keys removed from the payload). Delete the `false /* no backup for speed */` call.
4. **M12** edit-modal save handler (~260-334): rebuild diffs from actual current metadata (old = `group.metadata[field]`), include cleared fields (old set, new ''), and map ALL modal fields (subtitle, isbn, asin, language, age_rating, abridged, runtime) into file.changes via the same helper from item 2. Preserve unrelated staged changes (merge, do not rebuild from scratch).
5. **M13** shift-click (~166-180): store `lastSelectedIndex` together with a fingerprint of the list it indexed (e.g. the filtered list's ids array length + first/last id); when the fingerprint differs, treat the shift-click as a plain click.
6. **M15** push modal (~2891-2920): local branch must use the snapshot taken at modal open (mirror the ABS branch), not live selection.

---

## Task 7: components + modals

Files: `src/components/*.jsx`, `src/components/scanner/*.jsx`, `src/components/scanner/performLookup.js`, tests where seams exist.

1. **CR-5** `ValidationIssueModal.jsx:57-59`: `selectedBooks` contains file ids; compute target groups by checking whether any of the group's file ids is selected (`g.files.some(f => selectedBooks.has(f.id))`), matching how ScannerPage selects.
2. **CR-6a** `RenamePreviewModal.jsx` + `ScannerPage.jsx:3234`: pass the chosen template through `onConfirm(template)` and thread it to `renameFiles(files, template)` -> `rename_files` backend arg (check backend accepts a template param; if not, generate the target names frontend-side from the previews already computed and send explicit old->new pairs).
3. **CR-6b** preview metadata: `RenamePreviewModal` must preview each file with its OWN group's metadata (pass groups or a fileId->metadata map, not `selectedGroup?.metadata`).
4. **H1** `BulkEditModal.jsx:62-65`: only apply sub-fields with non-empty input: checked Series with a name but blank number updates the name only; add an explicit "clear" checkbox per field for intentional clearing.
5. **H2** JSON import: implement the stubbed full-import branch (`ScannerPage.jsx:432-437`): replace groups with the imported ones after a ConfirmModal warning (mention current groups will be replaced).
6. **H4** `BulkCoverAssignment.jsx:13-15`: substring rule must require the shorter string to be >= 80% the length of the longer (so "harrypotter" vs "harrypotter2" no longer scores 0.9); prefer exact normalized equality (1.0) and best-scoring assignment: score all image/book pairs, assign greedily by descending score instead of book order.
7. **H5** `BulkCoverAssignment.jsx:128-133, 177-181`: re-running auto-match must preserve existing manual assignments (only match unassigned books/images).
8. **M1** `EditMetadataModal.jsx:24-27, 324`: keep genres as a raw string in state while typing; parse to array only on save/blur. Guard `(editedMetadata.genres || [])`.
9. **M3** `SeriesIssueModal.jsx:120-123`: key the fix map by fix index, not `bookId-field`.
10. **M4** convert the three `useState(initializer, deps)` misuses to `useEffect` (`SeriesIssueModal.jsx:31`, `ValidationIssueModal.jsx:130`, `AuthorAnalysisModal.jsx:89`).
11. **M5** `performLookup.js:48-59`: verify candidate docs: require normalized title match (contains or Levenshtein-lite: startsWith either way) and, when the book has an author, an author_name overlap, before taking an ISBN; same guard for the ASIN `products[0]` fallback. Update `performLookup.test.js`.
12. **M8** `BulkCoverAssignment.jsx:240-263`: on partial failure keep the modal open, list failed books, report `{succeeded, failed}` to the parent toast.
13. **M9** cover cache invalidation: after cover assignment, clear the affected ids from BookList's coverCache (lift an `invalidateCovers(ids)` callback) and bump MetadataPanel's `refreshTrigger`.
14. **M10** `BulkEditModal` common values: prefill the input `value` with the common value instead of showing it as placeholder.
15. **L4** `UndoToast.jsx:5`: default `ageSeconds = 0`; fix the progress bar to track the 30s auto-dismiss it claims; fix invalid `bg-blue-900/300` class.
16. **L5** `RescanModal.jsx:121-131`: replace runtime-built Tailwind classes with a static class map per color.
17. **L6** `ErrorPill.jsx:28`: guard missing `detail.message` (fallback '').
18. **L7** `BookList.jsx`: expanded rows: give expanded items a larger computed height in the virtualizer (itemSize callback) or auto-collapse the previously expanded row; totalHeight must account for it.
19. **L8** `EditMetadataModal.jsx:122-141`: map backend `age_category` values (Middle Grade, Teen 13-17, etc.) onto the select vocabulary; enforce the max-3 genre limit when inserting.
20. **L9** `RenamePreviewModal.jsx:35-39`: debounce (300ms) + cancellation token for preview generation; if templates list is empty, stop the spinner and show "no templates".
21. **L10** `BookList.jsx:115-124` ChangePreviewTooltip: aggregate changes across all files of the group (union of fields, per-field first old/new).

---

## Task 8: Settings, AppContext, App shell

Files: `src/pages/SettingsPage.jsx`, `src/context/AppContext.jsx`, `src/App.jsx`.

1. **H6** `SettingsPage.jsx:390-397`: `handleSave` must check the `{success}` result from saveConfig; on failure show an error toast, never "Saved!". Same for Clear All Keys (~1285-1292): await the save, confirm success before the "Keys Cleared" toast.
2. **M9** `AppContext.jsx:43-62`: auto-enable Local AI only when `use_local_ai === undefined` (never seen), not when the user explicitly saved it false. Persist `use_local_ai: false` as an explicit choice.
3. **M10** `SettingsPage.jsx:199-232`: fix the 5s poll: include needed deps or use functional/ref reads; do not `setSelectedPreset` if the user has already selected one (only initialize when empty); auto-enable saves must merge into the LATEST config (functional update or ref), not the first-render snapshot.
4. **M11** `SettingsPage.jsx:308, 333`: whisper install/uninstall must persist the `use_local_whisper`/model changes via saveConfig, not just setLocalConfig.
5. **L3** `SettingsPage.jsx:135, 575`: guard null config (render an error/retry state instead of dereferencing); sync localConfig when context config changes while the page is mounted and the user has no unsaved edits (dirty flag).
6. **M7(pages)** `App.jsx:66-81`: keep ScannerPage mounted across tab switches (render all pages, toggle visibility with CSS `hidden`) so in-flight batch state, progress bars, and undo toasts survive navigation. Verify no duplicate event subscriptions result.

---

## Task 9: Rust backend

Files: `src-tauri/src/scanner.rs`, `whisper.rs`, `whisper_local.rs`, `ollama.rs`, `lib.rs`. `cargo test` green + `cargo check` no new warnings. Add unit tests for every scanner change.

1. **CR-8** `scanner.rs:111-132`: fix tag lookup: for MP4, freeform atoms arrive as `ItemKey::Unknown("----:com.apple.iTunes:SERIES")`: match the key case-insensitively on its trailing segment after the last ':' as well as the bare name. For mp3, also check the known keys `ItemKey::Movement` (series) and `ItemKey::MovementNumber` (sequence). Tests with synthetic lofty tags.
2. **Chapter folders** `scanner.rs:199, 542-568`: `is_chapter_folder` must NOT match "NN - Title" folders: require a chapter keyword (chapter, ch, disc, disk, cd, part, track) or a pure-number name; "01 - The Way of Kings" is a book folder. Additionally, when chapter-folder climbing produces the same parent for multiple file sets, merge them into ONE BookGroup (key groups by the climbed folder, not the literal parent), fixing multi-disc duplication. Fix the hierarchy so a file in `Author/Book/Disc 1/` yields author/title correctly with no series (`scanner.rs:296-314` disc-aware: skip chapter-like dirs when walking up).
3. **Root markers** `scanner.rs:269`: exact match only (drop `ends_with`); optionally add plural/singular variants explicitly to the marker list.
4. **Deep paths** `scanner.rs:296-309`: when assigning author from `relevant_parts[n-3]`, skip components that look like mounts/junk (single all-caps token, "Volumes", "Users", drive letters, dot-prefixed) and require `folder_looks_like_author_name`; otherwise leave author empty for tags/AI to fill.
5. **Catch-22** `scanner.rs:440-454`: the bare `"Name NN"` pattern must additionally require the name part to contain at least 2 words. Keep existing tests green; add "Catch 22", "Mila 18", "Harry Potter 3" cases.
6. **Seq zero** `scanner.rs:362-367`: empty-after-trim sequence -> keep "0" (mirror the other branch).
7. **First-file tags** `scanner.rs:488`: pick the first file that HAS a non-empty tag set (fall back across files) instead of only `raw_files.first()`.
8. **Blocking** `scanner.rs:607`: wrap the walk+probe in `tauri::async_runtime::spawn_blocking` (or `tokio::task::spawn_blocking`).
9. **UTF-8** `whisper.rs:627`: replace byte slicing with a char-boundary-safe truncate helper; use it for every transcript truncation.
10. **Failure caching** `whisper.rs:202-211, 76`: never cache empty/error results; add `force: Option<bool>` to `extract_audio_intro` to bypass the cache.
11. **Temp cleanup** `whisper.rs:575-589`: only delete files this process created: track created temp paths in a static registry (Mutex<HashSet>) and remove exactly those, not glob `.tmp*` in the shared dir.
12. **Counts** `whisper.rs:141`: separate `failed_count` from `skipped_count` in progress/completion messages.
13. **Names** `whisper.rs:835`: `clean_person_name` must not split on ". " when the preceding token is a single letter (initials): use a regex that only truncates at sentence-like boundaries (". " followed by a capitalized word of 3+ letters and only when the prefix already has 2+ words).
14. **whisper_local install** `whisper_local.rs:280-301, 450-479`: resolve brew via absolute paths (`/opt/homebrew/bin/brew`, `/usr/local/bin/brew`) before PATH lookup; REMOVE the xcframework download path entirely: when brew is unavailable on macOS, return an actionable error ("Install Homebrew or install whisper-cpp manually, then restart the app"); the binary-walk fallback must only accept files that pass an executability sanity check (Mach-O/ELF magic bytes), never headers/dylibs; give Linux its own error message (package manager instructions) instead of the brew one. This also removes the unreachable line 301 dead code.
15. **Model downloads** `whisper_local.rs:512-543`: download to `<path>.partial`, verify size within 20% of the expected `size_mb` when known, then rename; the exists-check must ignore/clean `.partial` files and re-download when the final file is absurdly small (< 1MB).
16. **Language** `whisper_local.rs:668-671`: parse only the 2-letter code (split on ':', trim, take the token before " (").
17. **ollama PATH** `ollama.rs:82`: add `/opt/homebrew/bin/ollama`.
18. **Ollama kill scope** `ollama.rs:241-243` + `lib.rs:32-37`: kill ONLY the child PID this app spawned (stored on start); never `pkill -f "ollama serve"`; if the app did not start Ollama, do nothing on close.
19. **ollama_start remote** `ollama.rs:188-221`: when the effective base URL is not localhost, do not spawn a local server: return an error/no-op ("configured Ollama is remote; start it on the remote host").
20. **Model names** `ollama.rs:375`: allow `/`, `.`, `:`, `-`, `_`, alphanumerics in model names (still reject whitespace/shell metacharacters).
21. **Buffer** `ollama.rs:405-407`: when trimming the >1MB pull buffer, cut at the last newline so the next chunk parses.
22. **lib.rs Destroyed handler**: replace the fresh-Runtime block_on with `tauri::async_runtime::block_on` or a bounded (500ms) best-effort kill of the tracked PID only.

---

## Task 9b: Rust local-file write backend (discovered gap)

Discovery during Task 6: `write_tags`, `rename_files`, `preview_rename`, `undo_last_write`, and `get_undo_status` have NO backend in v2 (not in TAURI_COMMANDS, not in HANDLERS, no Rust command): the entire local-file write/rename/undo UI surface silently returned stubs. The frontend (Tasks 5-6) now fails safely against stubs, but the feature needs a real backend. Files: new `src-tauri/src/writer.rs`, `src-tauri/src/lib.rs`, `src/api.js` (TAURI_COMMANDS additions only).

1. **write_tags**: Tauri command taking the `filesMap`/`file_ids` payload `buildWritePayload` produces (read `src/lib/buildWritePayload.js` and `useTagOperations.js:write` for the exact shape). For each file: optional backup copy (`<name>.bak` alongside, only when `backup: true`), then apply `changes` via lofty (title, artist/author, album, albumartist, narrator->Composer, series/series-part via the same freeform keys scanner.rs reads, genre, year/date, track). Unknown/ABS-only fields (dna/abs tags) are skipped silently. Return `{ success: <n>, failed: <n>, errors: [{path, error}], results: [{path, status}] }` matching what ScannerPage/useTagOperations consume.
2. **undo_last_write / get_undo_status**: persist an undo journal (JSON in app data dir) written by write_tags (original path + backup path + timestamp). `get_undo_status` returns `{ available, count, ageSeconds }`; `undo_last_write` restores backups (rename .bak back), returns `{ success: <n>, failed: <n>, results: [{old_path, new_path}] }` consistent with ScannerPage's undo consumption (read the Task 5 wiring for exact field reads). Journal cleared after undo; backups without `backup: true` mean undo unavailable (get_undo_status reflects it).
3. **preview_rename / rename_files**: `preview_rename` takes `{filePath, metadata, template}` and returns the formatted name (template vars: {title}, {author}, {series}, {sequence}, {year}, {narrator}; sanitize path-illegal chars). `rename_files` takes explicit old->new pairs (the shape RenamePreviewModal/`renameFiles` sends after Task 7) and performs `fs::rename`, refusing to overwrite existing targets, returning `{ renamed: <n>, failed: <n>, results: [{old_path, new_path, status}] }` matching the Task 5 rename consumption in ScannerPage.
4. Register all commands in lib.rs `generate_handler` and add them to `TAURI_COMMANDS` in `src/api.js` (no HANDLERS fallback: browser build keeps the stub behavior, which the frontend already reports as a visible failure).
5. Unit tests (cargo) for: tag write round-trip on a generated file (lofty write then read back), backup+undo restore round-trip, rename collision refusal, template formatting incl. sequence 0 and missing fields. JS side: no changes beyond TAURI_COMMANDS, existing suite must stay green.
6. Verify against the shapes ScannerPage consumes (Task 5 wiring) and adjust ScannerPage field reads ONLY if a mismatch is found (document it).

## Task 10 (final): whole-branch verification

- Full `npm run test:run` + `cargo test` + `cargo check` + `npm run build` (vite) green.
- Final whole-branch code review (requesting-code-review template) on the diff `main..HEAD`.
- Fix findings, update `docs/AUDIT-2026-07-21.md` with a status column (FIXED/DEFERRED per finding) and PROJECT_CONTEXT.md in v1.
