// v2.2.3: commands with no implementation must throw, not return a stub that
// callers mistook for success (rescan_abs_imports, analyze_authors_from_abs,
// analyze_series_comprehensive, apply_series_fixes all "succeeded" silently).
import { describe, it, expect } from 'vitest';
import { callBackend } from './api.js';

describe('callBackend with an unimplemented command', () => {
  for (const cmd of ['rescan_abs_imports', 'analyze_authors_from_abs', 'analyze_series_comprehensive', 'apply_series_fixes']) {
    it(`${cmd} rejects with NOT_IMPLEMENTED`, async () => {
      await expect(callBackend(cmd, {})).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED', command: cmd });
    });
  }
});
