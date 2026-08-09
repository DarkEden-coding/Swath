import { describe, expect, it } from "vitest";
import { isEmptyCounterChip } from "./Chrome";

const dim = (text: string): string => `[2m${text}[0m`;

describe("isEmptyCounterChip", () => {
  it("hides zero counters, keeps everything else", () => {
    expect(isEmptyCounterChip("background terminals: 0")).toBe(true);
    expect(isEmptyCounterChip(dim("background terminals: 0"))).toBe(true);
    expect(isEmptyCounterChip("   ")).toBe(true);
    expect(isEmptyCounterChip("background terminals: 2")).toBe(false);
    expect(isEmptyCounterChip("Context7 extension loaded")).toBe(false);
    expect(isEmptyCounterChip("errors: 10")).toBe(false);
  });
});
