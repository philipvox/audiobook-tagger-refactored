// Task 3 regression tests: genres.js items H-3, M-5, L-4, L-5
// per .superpowers/sdd/task-3-brief.md
import { describe, it, expect } from "vitest";
import {
  mapTag,
  mapGenre,
  areTagsComplete,
  getMissingTagCategories,
  splitCombinedGenres,
} from "./genres.js";

describe("H-3: forward containment only (approved tag's tokens subset of input's)", () => {
  it("does not map a short input up into a longer approved tag via partial match", () => {
    // "fantasy" isn't itself an approved tag - it must not be swallowed by
    // "fantasy-romance" just because the input token is a prefix run of the
    // approved tag's tokens (the old bidirectional check let this happen).
    expect(mapTag("fantasy")).not.toBe("fantasy-romance");
    expect(mapTag("fantasy")).toBeNull();
  });

  it("still maps a verbose input down to the correct approved tag (forward containment)", () => {
    // approved "epic-fantasy" tokens are all present in the input's tokens
    expect(mapTag("epic fantasy novel")).toBe("epic-fantasy");
  });

  it("keeps an exact approved tag (regression, must still pass)", () => {
    expect(mapTag("war")).toBe("war");
  });
  it("does not map 'warrior' to 'war' (regression, must still pass)", () => {
    expect(mapTag("warrior")).not.toBe("war");
  });
  it("does not map 'classic rock' to 'class' (regression, must still pass)", () => {
    expect(mapTag("classic rock")).not.toBe("class");
  });

  it("mapGenre: keeps an exact approved genre (regression, must still pass)", () => {
    expect(mapGenre("Art")).toBe("Art");
  });
  it("mapGenre: does not map 'Article' to 'Art' (regression, must still pass)", () => {
    expect(mapGenre("Article")).not.toBe("Art");
  });
  it("mapGenre: still maps a verbose input down to an approved genre", () => {
    expect(mapGenre("Women's Fiction Novel")).toBe("Women's Fiction");
  });
});

describe("M-5: age-rec-0 and age-rec-3 count toward the reading-age requirement", () => {
  it("areTagsComplete treats age-rec-0 as satisfying the reading-age category", () => {
    const tags = ["age-adult", "rated-pg", "age-rec-0"];
    expect(areTagsComplete(tags)).toBe(true);
  });
  it("areTagsComplete treats age-rec-3 as satisfying the reading-age category", () => {
    const tags = ["age-adult", "rated-pg", "age-rec-3"];
    expect(areTagsComplete(tags)).toBe(true);
  });
  it("getMissingTagCategories does not flag reading age missing when age-rec-0 present", () => {
    const tags = ["age-adult", "rated-pg", "age-rec-0"];
    expect(getMissingTagCategories(tags)).not.toContain("reading age");
  });
  it("getMissingTagCategories does not flag reading age missing when age-rec-3 present", () => {
    const tags = ["age-adult", "rated-pg", "age-rec-3"];
    expect(getMissingTagCategories(tags)).not.toContain("reading age");
  });
});

describe("L-4: singularize tokens before matching", () => {
  it("maps 'Thrillers' to Thriller", () => {
    expect(mapGenre("Thrillers")).toBe("Thriller");
  });
  it("maps 'Mysteries' to Mystery", () => {
    expect(mapGenre("Mysteries")).toBe("Mystery");
  });
});

describe("L-5: splitCombinedGenres splits on all separators in one pass", () => {
  it("splits a genre combining slash and comma in one string", () => {
    const result = splitCombinedGenres(["Fiction / Thrillers, Suspense"]);
    expect(result).toEqual(["Fiction", "Thrillers", "Suspense"]);
  });
  it("splits a genre combining ampersand and comma", () => {
    const result = splitCombinedGenres(["Mystery & Thriller, Crime"]);
    expect(result).toEqual(["Mystery", "Thriller", "Crime"]);
  });
  it("splits on the word ' and ' too", () => {
    const result = splitCombinedGenres(["Mystery and Thriller"]);
    expect(result).toEqual(["Mystery", "Thriller"]);
  });
});
