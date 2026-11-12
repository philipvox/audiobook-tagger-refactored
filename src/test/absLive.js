// Shared ABS push test helpers (Task 5). Every push GETs the live item
// (GET /api/items/:id?expanded=1) before its PATCH; these serve one from a
// mocked absApi.

/** A live ABS item as returned by GET /api/items/:id?expanded=1. */
export const liveItem = (tags = [], genres = []) => ({ media: { tags, metadata: { genres } } });

/**
 * Make `absApi` (a vi.fn) answer the GET with `live` (or throw `getError`) and
 * the PATCH with {} (or throw `patchError`).
 */
export function mockAbs(absApi, { live, getError, patchError } = {}) {
  absApi.mockImplementation(async (_base, _token, _path, opts) => {
    if (opts?.method === 'PATCH') {
      if (patchError) throw patchError;
      return {};
    }
    if (getError) throw getError;
    return live;
  });
}

/** Serve a live item whose lists are `live.tags` / `live.genres` (default empty). */
export function serveLive(absApi, live = {}) {
  mockAbs(absApi, { live: liveItem(live.tags || [], live.genres || []) });
}
