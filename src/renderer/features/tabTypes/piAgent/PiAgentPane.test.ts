import { describe, expect, it } from "vitest";
import { followStateAfterScroll } from "./PiAgentPane";

describe("followStateAfterScroll", () => {
  it("ignores programmatic movement, unpins for user movement, and re-pins at the bottom", () => {
    expect(followStateAfterScroll(true, false, 100)).toBe(true);
    expect(followStateAfterScroll(true, true, 100)).toBe(false);
    expect(followStateAfterScroll(false, true, 2)).toBe(true);
  });
});
