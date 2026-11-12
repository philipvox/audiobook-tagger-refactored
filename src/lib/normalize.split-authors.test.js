// Regression tests for the 2026-07-21 audit (item K): author splitting on "," mangled
// suffixes like "Martin Luther King, Jr." into two authors.
import { describe, it, expect } from "vitest";
import { splitAuthors } from "./normalize.js";

describe("splitAuthors: suffix-aware comma splitting", () => {
  it("does not split a name from its Jr. suffix", () => {
    expect(splitAuthors("Martin Luther King, Jr.")).toEqual(["Martin Luther King, Jr."]);
  });

  it("does not split a name from a bare Jr suffix", () => {
    expect(splitAuthors("Sammy Davis, Jr")).toEqual(["Sammy Davis, Jr"]);
  });

  it("does not split a name from Sr., II, III, IV suffixes", () => {
    expect(splitAuthors("Cornelius Vanderbilt, Sr.")).toEqual(["Cornelius Vanderbilt, Sr."]);
    expect(splitAuthors("Robert Downey, II")).toEqual(["Robert Downey, II"]);
    expect(splitAuthors("Robert Downey, III")).toEqual(["Robert Downey, III"]);
    expect(splitAuthors("Robert Downey, IV")).toEqual(["Robert Downey, IV"]);
  });

  it("does not split a name from PhD/MD/M.D./Ph.D. suffixes", () => {
    expect(splitAuthors("Jane Doe, PhD")).toEqual(["Jane Doe, PhD"]);
    expect(splitAuthors("Jane Doe, MD")).toEqual(["Jane Doe, MD"]);
    expect(splitAuthors("Jane Doe, M.D.")).toEqual(["Jane Doe, M.D."]);
    expect(splitAuthors("Jane Doe, Ph.D.")).toEqual(["Jane Doe, Ph.D."]);
  });

  it("splits two real authors joined by a comma", () => {
    expect(splitAuthors("Stephen King, John Grisham")).toEqual(["Stephen King", "John Grisham"]);
  });

  it("splits on &", () => {
    expect(splitAuthors("Stephen King & John Grisham")).toEqual(["Stephen King", "John Grisham"]);
  });

  it("splits on ' and '", () => {
    expect(splitAuthors("Stephen King and John Grisham")).toEqual(["Stephen King", "John Grisham"]);
  });

  it("combines suffix-aware comma handling with & splitting", () => {
    expect(splitAuthors("Martin Luther King, Jr. & Maya Angelou")).toEqual([
      "Martin Luther King, Jr.",
      "Maya Angelou",
    ]);
  });

  it("handles three authors joined by commas with a trailing suffix", () => {
    expect(splitAuthors("Stephen King, John Grisham, Martin Luther King, Jr.")).toEqual([
      "Stephen King",
      "John Grisham",
      "Martin Luther King, Jr.",
    ]);
  });

  it("trims whitespace and drops empty segments", () => {
    expect(splitAuthors("  Stephen King ,  , John Grisham  ")).toEqual(["Stephen King", "John Grisham"]);
  });

  it("returns an empty array for falsy input", () => {
    expect(splitAuthors("")).toEqual([]);
    expect(splitAuthors(null)).toEqual([]);
    expect(splitAuthors(undefined)).toEqual([]);
  });
});

describe("splitAuthors: single names that must not be split (v2.2.3)", () => {
  it("keeps a single 'Last, First' name together, in First Last order", () => {
    expect(splitAuthors("King, Stephen")).toEqual(["Stephen King"]);
    expect(splitAuthors("Tolkien, J. R. R.")).toEqual(["J. R. R. Tolkien"]);
  });

  it("does not split ' and ' when either side is not a full name", () => {
    expect(splitAuthors("Rodgers and Hammerstein")).toEqual(["Rodgers and Hammerstein"]);
    expect(splitAuthors("Stephen King and Owen")).toEqual(["Stephen King and Owen"]);
  });

  it("still splits ' and ' between two full names", () => {
    expect(splitAuthors("Stephen King and Owen King")).toEqual(["Stephen King", "Owen King"]);
  });

  it("keeps a suffix name intact next to another author", () => {
    expect(splitAuthors("Martin Luther King, Jr. and Coretta Scott King")).toEqual([
      "Martin Luther King, Jr.",
      "Coretta Scott King",
    ]);
  });
});
