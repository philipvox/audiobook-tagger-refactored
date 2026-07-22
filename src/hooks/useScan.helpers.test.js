// src/hooks/useScan.helpers.test.js
// Regression tests for the 2026-07-22 audit (task 4, items 1/4/10) against the
// pure helpers extracted from useScan.js. These are unit-tested directly
// instead of through renderHook(useScan) because src/hooks/useScan.test.js is
// entirely describe.skip'd (see that file's header comment for the jsdom
// pickPath landmine), extracting pure logic gives these fixes a real,
// non-hanging test seam.
import { describe, it, expect } from 'vitest';
import { getParentDir, buildRescanGroups, mergeAbsPullGroups } from './useScan.js';

describe('getParentDir (L-11)', () => {
  it('returns the parent directory for a POSIX path', () => {
    expect(getParentDir('/library/Author/Book/file.m4b')).toBe('/library/Author/Book');
  });

  it('returns the parent directory for a Windows path', () => {
    expect(getParentDir('C:\\library\\Author\\Book\\file.m4b')).toBe('C:\\library\\Author\\Book');
  });

  it('picks whichever separator appears last when a path mixes them', () => {
    // e.g. a path recorded with forward slashes but a trailing Windows-style segment
    expect(getParentDir('/library/Author\\Book\\file.m4b')).toBe('/library/Author\\Book');
    expect(getParentDir('C:\\library/Author/Book/file.m4b')).toBe('C:\\library/Author/Book');
  });

  it('returns null when there is no directory separator', () => {
    expect(getParentDir('file.m4b')).toBeNull();
  });

  it('returns null for a root-level path (separator at index 0)', () => {
    expect(getParentDir('/file.m4b')).toBeNull();
  });

  it('returns null for empty/falsy input', () => {
    expect(getParentDir('')).toBeNull();
    expect(getParentDir(null)).toBeNull();
    expect(getParentDir(undefined)).toBeNull();
  });
});

describe('buildRescanGroups (CR-1 support)', () => {
  it('drops groups containing a selected file and appends the new groups', () => {
    const prevGroups = [
      { id: 'g1', files: [{ path: '/a/1.m4b' }] },
      { id: 'g2', files: [{ path: '/b/2.m4b' }] },
    ];
    const selectedFilePaths = new Set(['/a/1.m4b']);
    const newGroups = [{ id: 'g1-new', files: [{ path: '/a/1.m4b' }] }];

    const result = buildRescanGroups(prevGroups, selectedFilePaths, newGroups);

    expect(result).toEqual([
      { id: 'g2', files: [{ path: '/b/2.m4b' }] },
      { id: 'g1-new', files: [{ path: '/a/1.m4b' }] },
    ]);
  });

  it('keeps all groups untouched when nothing is selected', () => {
    const prevGroups = [
      { id: 'g1', files: [{ path: '/a/1.m4b' }] },
      { id: 'g2', files: [{ path: '/b/2.m4b' }] },
    ];
    const result = buildRescanGroups(prevGroups, new Set(), []);
    expect(result).toEqual(prevGroups);
  });

  it('demonstrates why the hook must not call this with an empty newGroups on failure: a selected group with no replacement simply disappears', () => {
    const prevGroups = [{ id: 'g1', files: [{ path: '/a/1.m4b' }] }];
    const selectedFilePaths = new Set(['/a/1.m4b']);

    const result = buildRescanGroups(prevGroups, selectedFilePaths, []);

    // This is exactly the CR-1 failure mode this helper does NOT protect
    // against on its own, handleRescan is responsible for skipping this
    // call entirely when the scan errored (see the `if (scanError) return`
    // guard in handleRescan).
    expect(result).toEqual([]);
  });
});

describe('mergeAbsPullGroups (L1/pages)', () => {
  it('fully replaces when no local group has staged changes', () => {
    const prevGroups = [
      { id: 'g1', total_changes: 0, files: [{ changes: {} }] },
    ];
    const newGroups = [{ id: 'g1', total_changes: 0, files: [] }, { id: 'g2', files: [] }];

    const result = mergeAbsPullGroups(prevGroups, newGroups);
    expect(result).toBe(newGroups);
  });

  it('keeps a local group with staged changes (total_changes) instead of clobbering it with the ABS result', () => {
    const staged = { id: 'g1', total_changes: 2, files: [] };
    const prevGroups = [staged, { id: 'g2', total_changes: 0, files: [] }];
    const newGroups = [
      { id: 'g1', total_changes: 0, files: [] }, // fresh ABS data, would overwrite staged edits
      { id: 'g2', total_changes: 0, files: [] },
    ];

    const result = mergeAbsPullGroups(prevGroups, newGroups);

    expect(result.find(g => g.id === 'g1')).toBe(staged); // preserved, not overwritten
    expect(result.find(g => g.id === 'g2')).toBe(newGroups[1]); // no staged edits, replaced
  });

  it('keeps a local group with staged file-level changes even if total_changes is 0', () => {
    const staged = { id: 'g1', total_changes: 0, files: [{ changes: { title: 'New Title' } }] };
    const prevGroups = [staged];
    const newGroups = [{ id: 'g1', total_changes: 0, files: [] }];

    const result = mergeAbsPullGroups(prevGroups, newGroups);
    expect(result.find(g => g.id === 'g1')).toBe(staged);
  });

  it('keeps unmatched local groups that are absent from the new ABS result', () => {
    const staged = { id: 'g1', total_changes: 1, files: [] };
    const localOnly = { id: 'local-only', total_changes: 0, files: [] };
    const prevGroups = [staged, localOnly];
    const newGroups = [{ id: 'g1', total_changes: 0, files: [] }];

    const result = mergeAbsPullGroups(prevGroups, newGroups);
    expect(result).toContainEqual(localOnly);
  });

  it('appends brand-new ABS groups not previously known', () => {
    const staged = { id: 'g1', total_changes: 1, files: [] };
    const prevGroups = [staged];
    const brandNew = { id: 'g-new', total_changes: 0, files: [] };
    const newGroups = [{ id: 'g1', total_changes: 0, files: [] }, brandNew];

    const result = mergeAbsPullGroups(prevGroups, newGroups);
    expect(result).toContainEqual(brandNew);
    expect(result.find(g => g.id === 'g1')).toBe(staged);
  });
});
