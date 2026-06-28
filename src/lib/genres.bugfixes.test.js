// Regression tests for the substring-matching bug in tag/genre mapping
// found in the 2026-06-28 v2 audit. The partial-match fallback used
// `includes`, so short approved values swallowed unrelated inputs
// (e.g. "warrior" -> "war", "classic rock" -> "class").
import { describe, it, expect } from "vitest";
import { mapTag, mapGenre } from "./genres.js";

describe("mapTag — token-boundary fallback, not substring", () => {
  // Exact-match path must still work (these are approved values per the audit)
  it("keeps an exact approved tag", () => {
    expect(mapTag("war")).toBe("war");
  });

  // Bug: substring fallback mapped unrelated longer inputs to short approved tags
  it("does not map 'warrior' to 'war'", () => {
    expect(mapTag("warrior")).not.toBe("war");
  });
  it("does not map 'classic rock' to 'class'", () => {
    expect(mapTag("classic rock")).not.toBe("class");
  });
});

describe("mapGenre — token-boundary fallback, not substring", () => {
  it("keeps an exact approved genre", () => {
    expect(mapGenre("Art")).toBe("Art");
  });

  // Bug: "Article" matched approved "Art" via substring
  it("does not map 'Article' to 'Art'", () => {
    expect(mapGenre("Article")).not.toBe("Art");
  });
});
