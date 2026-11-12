import { describe, it, expect, beforeEach } from 'vitest';
import { getLocalConfig } from './api.js';

const KEY = 'audiobook_tagger_config';
beforeEach(() => localStorage.clear());

describe('genres default v2 migration', () => {
  it('flips a stored false to true once and persists the marker', () => {
    localStorage.setItem(KEY, JSON.stringify({ preserve_existing_genres: false, abs_base_url: 'x' }));
    const cfg = getLocalConfig();
    expect(cfg.preserve_existing_genres).toBe(true);
    expect(cfg.genres_default_v2).toBe(true);
    const saved = JSON.parse(localStorage.getItem(KEY));
    expect(saved.preserve_existing_genres).toBe(true);
    expect(saved.genres_default_v2).toBe(true);
    expect(saved.abs_base_url).toBe('x');
  });

  it('leaves a config that already has the marker alone', () => {
    localStorage.setItem(KEY, JSON.stringify({ preserve_existing_genres: false, genres_default_v2: true }));
    expect(getLocalConfig().preserve_existing_genres).toBe(false);
  });

  it('does not migrate fresh installs', () => {
    const cfg = getLocalConfig();
    expect(cfg.preserve_existing_genres).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
