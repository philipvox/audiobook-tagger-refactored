// Final review recommendation: every event name the UI subscribes to has an
// emitter, in src/ (emitEvent) or src-tauri/ (window.emit). Two of the scan
// bar's events had none, so the import and push bars never moved (I-1, I-2).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e)) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

const read = (list) => list.map((f) => [path.relative(root, f), fs.readFileSync(f, 'utf8')]);
const ui = read(files(path.join(root, 'src'), ['.js', '.jsx']));
const rust = read(files(path.join(root, 'src-tauri', 'src'), ['.rs']));

const subscribed = new Map();
for (const [file, text] of ui) {
  const patterns = [
    /\bsubscribe\(\s*'([A-Za-z_-]+)'/g,
    /\bopSubscribe\(\s*'[A-Za-z_]+',\s*'([A-Za-z_-]+)'/g,
    /\blisten\(\s*'([A-Za-z_-]+)'/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) subscribed.set(m[1], file);
}
const emitted = new Set();
for (const [, text] of ui) for (const m of text.matchAll(/\bemitEvent\(\s*'([A-Za-z_-]+)'/g)) emitted.add(m[1]);
for (const [, text] of rust) for (const m of text.matchAll(/\bemit(?:_all|_to)?\(\s*"([A-Za-z_-]+)"/g)) emitted.add(m[1]);

// Subscriptions that sit behind controls the app does not render (the plan
// keeps those handlers unwired) or a single backend call with no progress
// events. Each must still have no emitter, so this list cannot go stale.
const KNOWN_WITHOUT_EMITTER = {
  rescan_progress: 'useScan handleRescanAbsImports: no Rescan control is rendered',
  validation_progress: 'AppContext runValidation: the Validation modal is unwired',
  series_analysis_progress: 'AppContext runSeriesAnalysis: the Series modal is unwired',
  authors_progress: 'useAuthors: the Authors page is not a tab in App.jsx',
  write_progress: 'write_tags is one Rust call with no per-file events; the write bar is indeterminate until it returns',
};

describe('event wiring', () => {
  it('finds the subscriptions and emitters it checks', () => {
    expect(subscribed.size).toBeGreaterThan(5);
    expect(emitted.has('batch-progress')).toBe(true);
  });

  it('every subscribed event has an emitter', () => {
    const missing = [...subscribed.keys()].filter((name) => !emitted.has(name) && !(name in KNOWN_WITHOUT_EMITTER));
    expect(missing).toEqual([]);
  });

  it('import_progress and push_progress are emitted', () => {
    expect(emitted.has('import_progress')).toBe(true);
    expect(emitted.has('push_progress')).toBe(true);
  });

  it('the known list holds only names that really have no emitter', () => {
    for (const name of Object.keys(KNOWN_WITHOUT_EMITTER)) expect(emitted.has(name)).toBe(false);
  });
});
