// Regression tests for GitHub issue #57: placeholder authors ("Unknown", set by
// ABS for unmatched books) counted as a "present" value in the audio-check
// smart-skip gate, so books needing audio extraction were silently skipped
// with "All selected books already have an author".
import { describe, it, expect } from "vitest";
import { isPlaceholderAuthor } from "./normalize.js";

describe("isPlaceholderAuthor", () => {
  it("treats null/undefined/empty/whitespace as placeholder", () => {
    expect(isPlaceholderAuthor(null)).toBe(true);
    expect(isPlaceholderAuthor(undefined)).toBe(true);
    expect(isPlaceholderAuthor("")).toBe(true);
    expect(isPlaceholderAuthor("   ")).toBe(true);
    expect(isPlaceholderAuthor("\t\n")).toBe(true);
  });

  it("treats the known placeholder strings as placeholder, case-insensitively", () => {
    const placeholders = ["Unknown", "Author Unknown", "Unknown Author", "Unknown Narrator", "N/A", "None"];
    for (const p of placeholders) {
      expect(isPlaceholderAuthor(p)).toBe(true);
      expect(isPlaceholderAuthor(p.toUpperCase())).toBe(true);
      expect(isPlaceholderAuthor(p.toLowerCase())).toBe(true);
    }
  });

  it("trims padded whitespace around placeholder strings", () => {
    expect(isPlaceholderAuthor("  Unknown  ")).toBe(true);
    expect(isPlaceholderAuthor("\tN/A\n")).toBe(true);
  });

  it("does not match a real name that merely contains a placeholder word", () => {
    // "Unknown Soldier" is a real (if unusual) author/pen name - substring
    // matching against "Unknown" would incorrectly flag it.
    expect(isPlaceholderAuthor("Unknown Soldier")).toBe(false);
    expect(isPlaceholderAuthor("Nonesuch")).toBe(false);
  });

  it("does not match ordinary author names", () => {
    expect(isPlaceholderAuthor("Stephen King")).toBe(false);
    expect(isPlaceholderAuthor("J.R.R. Tolkien")).toBe(false);
  });

  it("handles non-string input without throwing", () => {
    expect(isPlaceholderAuthor(42)).toBe(false);
    expect(isPlaceholderAuthor({})).toBe(false);
  });
});
