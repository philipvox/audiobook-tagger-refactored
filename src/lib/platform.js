/**
 * Platform detection for Tauri vs browser.
 * Tauri 2 injects window.__TAURI_INTERNALS__ at startup.
 */

export function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

let _tauriFetch = null;

/**
 * Get the Tauri HTTP plugin's fetch function (CORS-free).
 * Returns native fetch as fallback in browser.
 */
export async function getTauriFetch() {
  if (!isTauri()) return globalThis.fetch.bind(globalThis);
  if (_tauriFetch) return _tauriFetch;

  const { fetch: tFetch } = await import('@tauri-apps/plugin-http');
  _tauriFetch = tFetch;
  return _tauriFetch;
}
