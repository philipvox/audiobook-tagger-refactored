// Task 3 regression test: errorDetail.js item L-8
// per .superpowers/sdd/task-3-brief.md
import { describe, it, expect } from "vitest";
import { errorDetailFromException } from "./errorDetail.js";

describe("L-8: auth-shaped messages classify as kind 'http', not the network fallback", () => {
  it("classifies an 'Invalid API key' message as http", () => {
    const detail = errorDetailFromException(new Error("Invalid API key provided"), {
      stage: "classify",
    });
    expect(detail.kind).toBe("http");
  });

  it("classifies an 'Invalid key' message as http", () => {
    const detail = errorDetailFromException(new Error("Invalid key"), { stage: "classify" });
    expect(detail.kind).toBe("http");
  });

  it("classifies an 'unauthorized' message as http", () => {
    const detail = errorDetailFromException(new Error("Request unauthorized"), {
      stage: "classify",
    });
    expect(detail.kind).toBe("http");
  });

  it("still falls back to network for an unrelated message", () => {
    const detail = errorDetailFromException(new Error("Failed to fetch"), { stage: "classify" });
    expect(detail.kind).toBe("network");
  });
});
