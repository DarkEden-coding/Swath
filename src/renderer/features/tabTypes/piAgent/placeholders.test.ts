import { describe, expect, it } from "vitest";
import {
  PASTE_THRESHOLD,
  expandPastes,
  makePastes,
  tokenSpanAfter,
  tokenSpanBefore,
} from "./placeholders";

describe("makePastes", () => {
  it("numbers blocks and reports their character count", () => {
    const pastes = makePastes([], ["abc", "hello world"]);
    expect(pastes.map((paste) => paste.placeholder)).toEqual([
      "[Pasted 1: 3 chars]",
      "[Pasted 2: 11 chars]",
    ]);
    expect(pastes.map((paste) => paste.text)).toEqual(["abc", "hello world"]);
  });

  it("keeps numbering unique after older blocks were deleted", () => {
    const first = makePastes([], ["a".repeat(300)])[0]!;
    const second = makePastes([first], ["b"]);
    expect(second[0]!.placeholder).toBe("[Pasted 2: 1 chars]");
  });
});

describe("expandPastes", () => {
  it("restores the full text on send", () => {
    const pastes = makePastes([], ["one\ntwo\nthree"]);
    expect(expandPastes(`before ${pastes[0]!.placeholder} after`, pastes)).toBe(
      "before one\ntwo\nthree after",
    );
  });

  it("leaves text alone once the placeholder was edited away", () => {
    const pastes = makePastes([], ["body"]);
    expect(expandPastes("no blocks here", pastes)).toBe("no blocks here");
  });
});

describe("tokenSpanBefore", () => {
  const text = "hi [Image 1] and [Pasted 1: 250 chars]";

  it("spans a token ending at the caret, trimming the joining space", () => {
    expect(tokenSpanBefore(text, text.length)).toEqual({
      start: 16,
      end: text.length,
      token: "[Pasted 1: 250 chars]",
    });
    expect(tokenSpanBefore(text, 12)).toEqual({ start: 2, end: 12, token: "[Image 1]" });
  });

  it("spans a token the caret sits inside", () => {
    expect(tokenSpanBefore(text, 5)?.token).toBe("[Image 1]");
  });

  it("returns nothing when the caret is outside any token", () => {
    expect(tokenSpanBefore(text, 14)).toBeNull();
    expect(tokenSpanBefore("plain text", 10)).toBeNull();
  });
});

describe("tokenSpanAfter", () => {
  const text = "hi [Image 1] and [Pasted 2: 9 chars]";

  it("spans a token starting at the caret", () => {
    expect(tokenSpanAfter(text, 3)).toEqual({ start: 3, end: 12, token: "[Image 1]" });
    expect(tokenSpanAfter(text, 17)?.token).toBe("[Pasted 2: 9 chars]");
  });

  it("spans a token the caret sits inside, for a forward delete", () => {
    expect(tokenSpanAfter(text, 8)?.token).toBe("[Image 1]");
  });

  it("returns nothing when the caret is past every token", () => {
    expect(tokenSpanAfter(text, text.length)).toBeNull();
  });
});

describe("PASTE_THRESHOLD", () => {
  it("only flags genuinely large pastes", () => {
    expect(PASTE_THRESHOLD).toBeGreaterThanOrEqual(100);
  });
});
