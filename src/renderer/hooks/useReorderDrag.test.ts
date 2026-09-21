import { describe, expect, it } from "vitest";
import { finalReorderIndex } from "./useReorderDrag";

describe("finalReorderIndex", () => {
  it("converts insertion points to final indices in either direction", () => {
    expect(finalReorderIndex(0, 3, 4)).toBe(2);
    expect(finalReorderIndex(3, 0, 4)).toBe(0);
  });

  it("ignores no-op and out-of-range insertions", () => {
    expect(finalReorderIndex(1, 2, 3)).toBeNull();
    expect(finalReorderIndex(1, 1, 3)).toBeNull();
    expect(finalReorderIndex(0, -1, 3)).toBeNull();
    expect(finalReorderIndex(2, 4, 3)).toBeNull();
  });
});
