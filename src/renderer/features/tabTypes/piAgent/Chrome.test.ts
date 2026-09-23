import { describe, expect, it } from "vitest";
import { isCodexEverywhereEnabled, isEmptyCounterChip, supportsCodexEverywhere } from "./Chrome";

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

  it("shows Codex Everywhere only for Codex models", () => {
    expect(
      supportsCodexEverywhere({
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        provider: "openai-codex",
      }),
    ).toBe(true);
    expect(
      supportsCodexEverywhere({
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: "anthropic",
      }),
    ).toBe(false);
    expect(supportsCodexEverywhere(null)).toBe(false);
    expect(isCodexEverywhereEnabled({ "codex-everywhere": "Codex Everywhere: on" })).toBe(true);
    expect(isCodexEverywhereEnabled({ "codex-everywhere": "Codex Everywhere: off" })).toBe(false);
  });
});
