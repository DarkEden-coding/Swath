import { describe, expect, it } from "vitest";
import { collapseOutput } from "./Transcript";

describe("collapseOutput", () => {
  it("keeps short output whole and reports nothing hidden", () => {
    expect(collapseOutput("one\ntwo\n", false)).toEqual({
      text: "one\ntwo",
      hidden: 0,
      empty: false,
    });
  });

  it("shows the first eight lines and counts the rest", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const { text, hidden } = collapseOutput(output, false);
    expect(text.split("\n")).toHaveLength(8);
    expect(hidden).toBe(12);
  });

  it("returns everything once expanded", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    expect(collapseOutput(output, true)).toEqual({ text: output, hidden: 0, empty: false });
  });

  it("distinguishes no output from blank output", () => {
    expect(collapseOutput("", false).empty).toBe(true);
    expect(collapseOutput("\n", false).empty).toBe(false);
  });
});
