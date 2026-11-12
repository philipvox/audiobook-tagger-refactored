// Task 4 (C-4): Fix Authors must not rewrite names that are already correct.
import { describe, it, expect } from "vitest";
import { cleanAuthorName, cleanNarratorName, splitAuthors } from "./normalize.js";

describe("C-4: cleanAuthorName keeps mixed-case names", () => {
  const unchanged = [
    "Don DeLillo", "Tim O'Brien", "Mary McCarthy", "Ta-Nehisi Coates",
    "CS Lewis", "J.R.R. Tolkien", "Ursula K. Le Guin",
  ];
  for (const name of unchanged) {
    it(`leaves "${name}" unchanged`, () => {
      expect(cleanAuthorName(name)).toBe(name);
    });
  }

  it("title-cases an all-caps name", () => {
    expect(cleanAuthorName("STEPHEN KING")).toBe("Stephen King");
  });

  it("title-cases an all-lowercase name", () => {
    expect(cleanAuthorName("bell hooks")).toBe("Bell Hooks");
  });

  it("inverts a lowercase Last, First pair and title-cases it", () => {
    expect(cleanAuthorName("king, stephen")).toBe("Stephen King");
  });

  it("does not invert a co-author pair", () => {
    expect(cleanAuthorName("Homer, Emily Wilson")).toBe("Homer, Emily Wilson");
  });

  it("keeps mixed-case names inside a co-author list", () => {
    expect(cleanAuthorName("Don DeLillo, Mary McCarthy")).toBe("Don DeLillo, Mary McCarthy");
  });
});

describe("C-4: cleanNarratorName keeps mixed-case names", () => {
  it("leaves a mixed-case narrator unchanged", () => {
    expect(cleanNarratorName("Narrated by Don DeLillo")).toBe("Don DeLillo");
    expect(cleanNarratorName("Robert Glenister")).toBe("Robert Glenister");
  });
  it("title-cases an all-caps narrator", () => {
    expect(cleanNarratorName("JIM DALE")).toBe("Jim Dale");
  });
});

describe("C-4: splitAuthors only inverts single-word Last, First", () => {
  it("keeps Homer and Emily Wilson as two authors", () => {
    expect(splitAuthors("Homer, Emily Wilson")).toEqual(["Homer", "Emily Wilson"]);
  });
  it("inverts King, Stephen", () => {
    expect(splitAuthors("King, Stephen")).toEqual(["Stephen King"]);
  });
  it("inverts a surname with initials", () => {
    expect(splitAuthors("Tolkien, J. R. R.")).toEqual(["J. R. R. Tolkien"]);
  });
});
