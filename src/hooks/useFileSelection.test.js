// src/hooks/useFileSelection.test.js
// Regression tests for the 2026-07-22 audit (task 4, items 2/3):
// L-12 (guard Object.keys(f.changes || {})) and the CR-3 companion guard in
// isGroupSelected for files with a null/undefined id.
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileSelection } from './useFileSelection';

describe('useFileSelection', () => {
  describe('isGroupSelected (CR-3 defensive id guard)', () => {
    it('treats a group as selected when all id-bearing files are selected, even if one file has no id', () => {
      const { result } = renderHook(() => useFileSelection());
      const group = {
        id: 'g1',
        files: [{ id: 'f1' }, { id: undefined }],
      };

      act(() => {
        result.current.toggleFile('f1');
      });

      expect(result.current.isGroupSelected('g1', group)).toBe(true);
    });

    it('is not selected when an id-bearing file is not selected', () => {
      const { result } = renderHook(() => useFileSelection());
      const group = {
        id: 'g1',
        files: [{ id: 'f1' }, { id: 'f2' }],
      };

      act(() => {
        result.current.toggleFile('f1');
      });

      expect(result.current.isGroupSelected('g1', group)).toBe(false);
    });
  });

  describe('getFilesWithChanges (L-12)', () => {
    it('does not throw when a file has no changes object at all', () => {
      const { result } = renderHook(() => useFileSelection());
      const groups = [{
        id: 'g1',
        files: [{ id: 'f1' }, { id: 'f2', changes: { title: 'New' } }],
      }];

      act(() => {
        result.current.toggleFile('f1');
        result.current.toggleFile('f2');
      });

      let ids;
      expect(() => { ids = result.current.getFilesWithChanges(groups); }).not.toThrow();
      expect(ids).toEqual(['f2']);
    });

    it('does not throw in allSelected mode when a file has no changes object', () => {
      const { result } = renderHook(() => useFileSelection());
      const groups = [{
        id: 'g1',
        files: [{ id: 'f1' }, { id: 'f2', changes: { title: 'New' } }],
      }];

      act(() => {
        result.current.selectAll(groups);
      });

      let ids;
      expect(() => { ids = result.current.getFilesWithChanges(groups); }).not.toThrow();
      expect(ids).toEqual(['f2']);
    });
  });
});
