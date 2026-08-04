// Regression tests for the title-branch counterpart of GitHub issue #57:
// ABS also falls back title to a placeholder ("Unknown") for unmatched books,
// and the audio-check smart-skip gate's title branch only tested `!m.title`,
// so a placeholder title counted as "present" the same way a placeholder
// author did.
import { describe, it, expect } from "vitest";
import { isPlaceholderTitle } from "./normalize.js";

describe("isPlaceholderTitle", () => {
  it("treats null/undefined/empty/whitespace as placeholder", () => {
    expect(isPlaceholderTitle(null)).toBe(true);
    expect(isPlaceholderTitle(undefined)).toBe(true);
    expect(isPlaceholderTitle("")).toBe(true);
    expect(isPlaceholderTitle("   ")).toBe(true);
    expect(isPlaceholderTitle("\t\n")).toBe(true);
  });

  it("treats the known placeholder strings as placeholder, case-insensitively", () => {
    const placeholders = ["Unknown", "Unknown Title", "Untitled"];
    for (const p of placeholders) {
      expect(isPlaceholderTitle(p)).toBe(true);
      expect(isPlaceholderTitle(p.toUpperCase())).toBe(true);
      expect(isPlaceholderTitle(p.toLowerCase())).toBe(true);
    }
  });

  it("trims padded whitespace around placeholder strings", () => {
    expect(isPlaceholderTitle("  Unknown  ")).toBe(true);
    expect(isPlaceholderTitle("\tUntitled\n")).toBe(true);
  });

  it("does not match a real title that merely contains a placeholder word", () => {
    expect(isPlaceholderTitle("The Untitled Project")).toBe(false);
    expect(isPlaceholderTitle("Unknown Pleasures")).toBe(false);
  });

  it("does not match ordinary titles", () => {
    expect(isPlaceholderTitle("Dune")).toBe(false);
    expect(isPlaceholderTitle("The Hobbit")).toBe(false);
  });

  it("does not treat author-only placeholders as title placeholders unless shared", () => {
    // "N/A" and "None" are author/narrator placeholders, not part of the
    // title vocabulary - keeping the lists distinct per field.
    expect(isPlaceholderTitle("N/A")).toBe(false);
    expect(isPlaceholderTitle("None")).toBe(false);
  });

  it("handles non-string input without throwing", () => {
    expect(isPlaceholderTitle(42)).toBe(false);
    expect(isPlaceholderTitle({})).toBe(false);
  });
});
