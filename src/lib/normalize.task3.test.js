// Task 3 regression tests: normalize.js items H-2, M-1, M-2, M-9, L-1, L-2, L-3
// per .superpowers/sdd/task-3-brief.md
import { describe, it, expect } from "vitest";
import {
  cleanAuthorName,
  stripTrackSuffixes,
  toTitleCase,
  removeJunkSuffixes,
  extractSubtitle,
  validateYear,
} from "./normalize.js";

describe("H-2: cleanAuthorName — co-author corruption", () => {
  it("still swaps a plain Last, First", () => {
    expect(cleanAuthorName("King, Stephen")).toBe("Stephen King");
  });

  it("still swaps Last, First Middle (2-word first name)", () => {
    expect(cleanAuthorName("King, Stephen Edwin")).toBe("Stephen Edwin King");
  });

  it("still handles Last, First, Suffix", () => {
    expect(cleanAuthorName("King, Stephen, Jr.")).toBe("Stephen King Jr.");
  });

  it("does NOT corrupt two multi-word co-authors into a mangled single name", () => {
    const result = cleanAuthorName("Stephen King, Peter Straub");
    expect(result).toBe("Stephen King, Peter Straub");
  });

  it("does not corrupt three multi-word co-authors", () => {
    const result = cleanAuthorName("Stephen King, Peter Straub, Neil Gaiman");
    expect(result).toBe("Stephen King, Peter Straub, Neil Gaiman");
  });
});

describe("L-2: suffix casing", () => {
  it("keeps PhD casing after a comma-suffix swap", () => {
    expect(cleanAuthorName("King, PhD")).toBe("King PhD");
  });
  it("keeps M.D. casing", () => {
    expect(cleanAuthorName("King, M.D.")).toBe("King M.D.");
  });
  it("keeps Ph.D. casing", () => {
    expect(cleanAuthorName("King, Ph.D.")).toBe("King Ph.D.");
  });
  it("normalizes lowercase phd to canonical PhD", () => {
    expect(cleanAuthorName("King, phd")).toBe("King PhD");
  });
});

describe("M-1: stripTrackSuffixes requires a digit for the trailing keyword", () => {
  it("does not strip a title that legitimately ends in 'Chapter'", () => {
    expect(stripTrackSuffixes("The Final Chapter")).toBe("The Final Chapter");
  });
  it("still strips a numbered trailing chapter marker", () => {
    expect(stripTrackSuffixes("My Book - Chapter 5")).toBe("My Book");
  });
});

describe("M-2: looksLikeAcronym allows up to 6 chars, &, digits; toTitleCase strips trailing punctuation for the check", () => {
  it("preserves FBI: with trailing punctuation", () => {
    expect(toTitleCase("the FBI: files")).toBe("The FBI: Files");
  });
  it("preserves AT&T", () => {
    expect(toTitleCase("the AT&T story")).toBe("The AT&T Story");
  });
  it("preserves WWIII (5 chars)", () => {
    expect(toTitleCase("WWIII begins")).toBe("WWIII Begins");
  });
});

describe("M-9: removeJunkSuffixes parenthesized combos, bracketed bitrates, iteration", () => {
  it("strips (Unabridged Edition)", () => {
    expect(removeJunkSuffixes("Title (Unabridged Edition)")).toBe("Title");
  });
  it("strips (Unabridged Audiobook)", () => {
    expect(removeJunkSuffixes("Title (Unabridged Audiobook)")).toBe("Title");
  });
  it("strips a bracketed bitrate like [64kbps]", () => {
    expect(removeJunkSuffixes("Title [64kbps]")).toBe("Title");
  });
  it("strips a bracketed bitrate like [320kbps]", () => {
    expect(removeJunkSuffixes("Title [320kbps]")).toBe("Title");
  });
  it("iteratively strips stacked known junk suffixes", () => {
    expect(removeJunkSuffixes("Title (Unabridged) [64kbps]")).toBe("Title");
  });
});

describe("L-1: extractSubtitle rejects narrator credits after a colon too", () => {
  it("does not treat a narrator credit after a colon as a subtitle", () => {
    const result = extractSubtitle("Dune: Narrated by Someone");
    expect(result.subtitle).toBeNull();
    expect(result.title).toBe("Dune: Narrated by Someone");
  });
  it("still extracts a real colon subtitle", () => {
    const result = extractSubtitle("Dune: The Desert Planet");
    expect(result).toEqual({ title: "Dune", subtitle: "The Desert Planet" });
  });
});

describe("L-3: validateYear range + word boundary", () => {
  it("accepts a year as early as 1000", () => {
    expect(validateYear("1000")).toBe("1000");
  });
  it("accepts current year + 2", () => {
    const y = new Date().getFullYear() + 2;
    expect(validateYear(String(y))).toBe(String(y));
  });
  it("rejects current year + 3", () => {
    const y = new Date().getFullYear() + 3;
    expect(validateYear(String(y))).toBeNull();
  });
  it("does not extract a year from an ISBN digit run via word boundary", () => {
    // "9782012345678" contains "2012" as a substring but it's not a
    // word-bounded year token - it's embedded in a longer digit run.
    expect(validateYear("9782012345678")).toBeNull();
  });
  it("still extracts a real embedded year", () => {
    expect(validateYear("Released in 2015")).toBe("2015");
  });
});
