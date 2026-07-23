import { describe, it, expect } from 'vitest';
import { mapAgeCategory } from './ageCategory';

describe('mapAgeCategory (L8: backend age_category -> select vocabulary)', () => {
  it('maps middle-grade / children variants onto Childrens', () => {
    expect(mapAgeCategory('Middle Grade')).toBe('Childrens');
    expect(mapAgeCategory("Children's")).toBe('Childrens');
    expect(mapAgeCategory('Early Reader')).toBe('Childrens');
  });

  it('maps teen variants onto Teens', () => {
    expect(mapAgeCategory('Teen 13-17')).toBe('Teens');
    expect(mapAgeCategory('Teen')).toBe('Teens');
  });

  it('passes through already-valid options (case-insensitive)', () => {
    expect(mapAgeCategory('Young Adult')).toBe('Young Adult');
    expect(mapAgeCategory('young adult')).toBe('Young Adult');
    expect(mapAgeCategory('Adult')).toBe('Adult');
  });

  it('returns null for empty/unknown values so the caller can keep the prior value', () => {
    expect(mapAgeCategory('')).toBeNull();
    expect(mapAgeCategory(null)).toBeNull();
    expect(mapAgeCategory('Something Weird')).toBeNull();
  });
});
