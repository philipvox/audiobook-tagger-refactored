// Regression tests for data-corruption bugs found in the 2026-06-28 v2 audit.
import { describe, it, expect } from "vitest";
import { removeJunkSuffixes, cleanAuthorName } from "./normalize.js";

describe("removeJunkSuffixes — only strips trailing junk, not mid-title", () => {
  // Existing, intended behavior (must keep passing)
  it("removes a trailing parenthetical descriptor", () => {
    expect(removeJunkSuffixes("The Hobbit (Unabridged)")).toBe("The Hobbit");
  });
  it("removes multiple trailing junk tokens", () => {
    expect(removeJunkSuffixes("1984 [Audiobook] 320kbps")).toBe("1984");
  });

  // Bug: lastIndexOf removed junk-looking words from the MIDDLE of real titles
  it("preserves a descriptor word that is part of the title (not a suffix)", () => {
    expect(removeJunkSuffixes("The (Complete) Idiot's Guide")).toBe(
      "The (Complete) Idiot's Guide"
    );
  });
  it("does not strip (HQ) from the middle of a title", () => {
    expect(removeJunkSuffixes("Live in (HQ) Studio")).toBe("Live in (HQ) Studio");
  });
});

describe("cleanAuthorName — no embedded comma left behind", () => {
  // Existing, intended behavior (must keep passing)
  it("reorders Last, First", () => {
    expect(cleanAuthorName("King, Stephen")).toBe("Stephen King");
  });
  it("handles initials", () => {
    expect(cleanAuthorName("tolkien, j.r.r.")).toBe("J.R.R. Tolkien");
  });

  // Bug: 3-part "Last, First, Suffix" left a comma that downstream author-splitting breaks on
  it("handles Last, First, Suffix without leaving a comma", () => {
    const result = cleanAuthorName("King, Stephen, Jr.");
    expect(result).not.toContain(",");
    expect(result).toBe("Stephen King Jr.");
  });
});
