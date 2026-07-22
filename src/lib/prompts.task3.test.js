// Task 3 regression tests: prompts.js items L-6, L-7
// per .superpowers/sdd/task-3-brief.md
import { describe, it, expect } from "vitest";
import {
  buildMetadataPrompt,
  buildClassificationPrompt,
  buildBatchMetadataPrompt,
  buildDescriptionPrompt,
  buildDnaPrompt,
} from "./prompts.js";

describe("L-6: ambiguous-candidate block emits title, author, year, publisher, narrator", () => {
  it("includes title, author, year, publisher, and narrator for a full candidate", () => {
    const prompt = buildMetadataPrompt({
      current_title: "Dune",
      current_author: "Unknown",
      audible_candidates: [
        { title: "Dune", author: "Frank Herbert", year: 1965, publisher: "Ace", narrator: "Simon Vance" },
      ],
    });
    expect(prompt).toMatch(/title=Dune/);
    expect(prompt).toMatch(/author=Frank Herbert/);
    expect(prompt).toMatch(/year=1965/);
    expect(prompt).toMatch(/publisher=Ace/);
    expect(prompt).toMatch(/narrator=Simon Vance/);
  });

  it("omits narrator when absent instead of emitting a blank field", () => {
    const prompt = buildMetadataPrompt({
      current_title: "Dune",
      current_author: "Unknown",
      audible_candidates: [
        { title: "Dune", author: "Frank Herbert", year: 1965, publisher: "Ace" },
      ],
    });
    expect(prompt).not.toMatch(/narrator=/);
  });
});

describe("L-7: sequence 0 is real data, not falsy-checked away", () => {
  it("buildMetadataPrompt includes current_sequence when it is 0", () => {
    const prompt = buildMetadataPrompt({
      current_title: "Prequel",
      current_author: "Someone",
      current_sequence: 0,
    });
    expect(prompt).toMatch(/Current sequence:\s*"?0"?/);
  });

  it("buildClassificationPrompt includes book.sequence when it is 0", () => {
    const prompt = buildClassificationPrompt({ title: "Prequel", sequence: 0 });
    expect(prompt).toMatch(/Book #:\s*"?0"?/);
  });

  it("buildBatchMetadataPrompt includes current_sequence when it is 0", () => {
    const prompt = buildBatchMetadataPrompt([
      { id: "b1", current_title: "Prequel", current_author: "Someone", current_sequence: 0 },
    ]);
    expect(prompt).toMatch(/Sequence:\s*"?0"?/);
  });

  it("buildDescriptionPrompt shows sequence 0, not '?'", () => {
    const prompt = buildDescriptionPrompt({
      title: "Prequel",
      author: "Someone",
      series: "The Saga",
      sequence: 0,
      description: "",
    });
    expect(prompt).toMatch(/Series:\s*"The Saga"\s*#0(?!\d)/);
    expect(prompt).not.toMatch(/#\?/);
  });

  it("buildDnaPrompt includes sequence 0", () => {
    const prompt = buildDnaPrompt({
      title: "Prequel",
      author: "Someone",
      series: "The Saga",
      sequence: 0,
    });
    expect(prompt).toMatch(/#0/);
  });
});
