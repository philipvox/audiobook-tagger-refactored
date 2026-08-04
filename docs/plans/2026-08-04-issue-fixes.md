# Issue Fix Plan - 2026-08-04 (v2.2.1)

Fixes the four remaining open GitHub issues: #57 (Unknown-author skip), #56 (Windows unzip), #54 (keep existing genres + tag casing), #58 (session persistence + persistent logs). Branch: `fix/issues-2026-08-04`. Repo: audiobook-tagger-v2.

## Global Constraints

- TDD where a unit seam exists; UI wiring without a seam gets build verification + manual-verification notes in the commit message.
- Data-preservation default: never destroy user data; failures are visible and truthful.
- After each task: `npm run test:run` fully green (baseline 409 pass / 22 skipped) and, for Rust tasks, `cargo test --manifest-path src-tauri/Cargo.toml` green (baseline 52 pass) with `cargo check` zero warnings. `npm run build` green.
- Never weaken an existing test. Conventional commits ending with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do not push.
- No em dashes anywhere. No cosmetic sweeps of untouched code.
- Default-off for new behavior toggles so existing users see no change unless they opt in (exception: bug fixes are unconditional).

---

## Task 1: #57 - placeholder authors block audio extraction

Files: `src/pages/ScannerPage.jsx` (smart-skip gate ~line 1293), `src/lib/normalize.js` or a small new lib file, tests.

1. Add an exported helper `isPlaceholderAuthor(value)` (put it in `src/lib/normalize.js`): returns true for null/undefined/empty/whitespace and for the placeholder strings, case-insensitive after trimming: "Unknown", "Author Unknown", "Unknown Author", "N/A", "None". Check `src/api.js` fix_authors_batch for an existing bad-author predicate first; if one exists, extract/reuse it rather than writing a second copy (single source of truth).
2. Use it in the audio-check smart-skip gate: `if (field === 'author') return isPlaceholderAuthor(m.author);` and in the 'all' branch's author term. Narrator placeholders: apply the same helper to narrator ("Unknown Narrator" included in the list) for the narrator branch.
3. Also check the inline gather trigger in ScannerPage (~line 1767 comment mentions "missing/Unknown author") uses consistent placeholder logic; unify on the helper if it has its own ad-hoc list.
4. Unit tests for the helper (placeholders, mixed case, padded whitespace, real names incl. an author literally named "Unknown Soldier" must NOT match).

## Task 2: #56 - Windows whisper/ffmpeg install fails without unzip

Files: `src-tauri/src/whisper_local.rs`, `src-tauri/Cargo.toml`, tests.

1. Add the `zip` crate (pick the current maintained version compatible with the pinned toolchain). Replace BOTH `std::process::Command::new("unzip")` call sites (whisper binary zip ~line 484, ffmpeg zip ~line 399) with in-process extraction: a helper `extract_zip(archive: &Path, dest: &Path) -> Result<(), String>` that iterates entries, sanitizes paths (reject entries that escape dest via `..` or absolute paths - zip-slip guard), creates dirs, writes files, and preserves the executable bit on Unix.
2. Keep the error messages actionable but remove the "ensure 'unzip' is available" guidance (no longer relevant).
3. Unit tests: build a small zip in-memory/tempdir (using the same crate's writer), extract it, assert contents; a zip-slip entry (`../evil.txt`) is rejected; executable-bit preservation on Unix.
4. Verify no other `Command::new("unzip")`/`"tar"` shell-outs remain for archives this app downloads on Windows paths (grep; the macOS ffmpeg zip goes through the same helper).

## Task 3: #54 - keep existing genres option + tag casing preservation

Files: `src/lib/mergeClassifyTags.js` (or sibling new lib), `src/pages/ScannerPage.jsx` classify merge block, `src/pages/SettingsPage.jsx`, `src/api.js` (DEFAULT_CONFIG), `src/components/EditMetadataModal.jsx`, tests.

1. New config flag `preserve_existing_genres` (default false; absent key means false). Settings: a checkbox in the AI/Enrichment section: "Supplement genres instead of replacing (keep existing genres, add AI suggestions)". Persist via the existing persistConfig path.
2. Classification merge: when the flag is on, genres become a case-insensitive-deduped union of existing genres + AI genres, existing first, preserving the EXISTING items' original casing; cap at the app's existing genre-count policy if one exists (check `enforceGenrePolicyWithSplit` in genres.js for the cap; respect it, favoring existing genres when trimming). When off, current behavior (replace when AI returns non-empty) is unchanged. Implement as a pure function (`mergeGenres(existing, aiGenres, {preserve})` in a lib file) with tests; wire into the classify merge block in ScannerPage.
3. Tag casing (#54's second ask): existing tags kept by `mergeClassifyTags` must retain their original casing (verify: if it already does, add a regression test proving it). Find where the tag editor forces lowercase (grep `toLowerCase` in EditMetadataModal.jsx and the tags input handling): stop lowercasing EXISTING/user-typed tags on edit; only newly added AI vocabulary tags stay normalized. Dedup comparisons stay case-insensitive so "Fantasy" and "fantasy" don't duplicate.
4. Tests: mergeGenres matrix (off=replace, on=union, dedup case-insensitive keeps existing casing, cap trimming favors existing); mergeClassifyTags casing regression; editor no longer lowercases (component test if feasible, else document manual verification).

## Task 4: #58 - session persistence + persistent operation log

Files: new `src-tauri/src/session.rs`, `src-tauri/src/lib.rs`, `src/api.js` (TAURI_COMMANDS + browser fallbacks), `src/context/AppContext.jsx` or `src/hooks/` (autosave + restore), `src/pages/ScannerPage.jsx` (restore prompt wiring), `src/pages/SettingsPage.jsx` (Open logs folder button), tests.

Session persistence:
1. Rust commands `save_session(json: String)`, `load_session() -> Option<String>`, `clear_session()`: store as `session.json` in the app data dir (same dir convention as writer.rs's undo journal); atomic write (tmp + rename). Size guard: refuse > 100MB with a truthful error.
2. Frontend: debounced (2-3s) autosave of the working state (groups + selected library id + savedAt timestamp) whenever groups change and are non-empty. In Tauri, via the commands; in browser, best-effort localStorage with try/catch size guard (quota errors logged, never thrown to the UI).
3. On startup with a non-empty saved session: non-blocking prompt ("Restore previous session? N books, saved <relative time>. Restore / Discard"). Restore sets groups; Discard clears the saved session. Never auto-restore silently; never auto-discard.
4. Clear the saved session on explicit user resets (new scan replacing groups after confirm, full import replace) AFTER the new state's own autosave lands; do not clear on app close.

Persistent log:
5. Rust command `append_log(line: String)`: appends timestamped lines to `session.log` in the app data dir; rotate at 5MB (rename to `session.log.1`, start fresh, keep one rotation). Command `get_log_path() -> String`.
6. Frontend: a tiny `logEvent(category, message, detail?)` helper in `src/lib/` used at batch operation start/end (with counts) and for every per-book errorDetail that gets set (one line each, JSON-compact detail). Tauri-only; browser build no-ops silently.
7. Settings: "Open logs folder" button (use the existing shell/opener plugin if present in Cargo.toml/capabilities; if none is configured, show the path in a copyable field instead of adding a new plugin).
8. Tests: Rust session save/load/clear round-trip + atomicity (tmp file cleaned) + log rotation at threshold; JS logEvent formatting + autosave debounce logic (pure helpers extracted and tested); restore-prompt wiring build-verified.

## Task 5 (final): verify, release 2.2.1, close issues

- Full suites + `cargo check` warnings-free + build; final review of the branch diff (task-scoped reviews already ran per task).
- Merge to main (ff), bump version to 2.2.1 in all five version files, push, tag `v2.2.1`, CI green, publish release as Latest with notes covering the four issues.
- GitHub: close #57, #56 (fixed); comment + close #54 (tag preservation shipped in 2.2.0 by default, genre supplement + casing in 2.2.1); comment + close #58 (settings-tab loss and crash class fixed in 2.2.0; session restore + persistent log shipped in 2.2.1).
- Update PROJECT_CONTEXT.md (v1 repo) and the SDD ledger.
