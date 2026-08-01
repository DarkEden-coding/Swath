import { describe, expect, it } from "vitest";
import { activeToken } from "./Composer";

/** Places the caret at the end of `text`. */
function at(text: string) {
  return activeToken(text, text.length);
}

describe("activeToken", () => {
  it("returns nothing for plain text", () => {
    expect(at("hello world")).toBeNull();
  });

  it("detects an @file token at the start", () => {
    expect(at("@src/ma")).toEqual({ kind: "@", query: "src/ma", start: 0 });
  });

  it("detects an @file token mid-message", () => {
    expect(at("look at @src/app")).toEqual({ kind: "@", query: "src/app", start: 8 });
  });

  it("detects a bare @ with no query yet", () => {
    expect(at("check @")).toEqual({ kind: "@", query: "", start: 6 });
  });

  it("opens the command palette only at the start of the message", () => {
    expect(at("/tod")).toEqual({ kind: "/", query: "tod", start: 0 });
    // A slash mid-sentence is a path separator or prose, not a command.
    expect(at("run /usr/bin")).toBeNull();
  });

  it("closes the token once whitespace follows", () => {
    expect(at("@src/app.ts ")).toBeNull();
    expect(at("/todo ")).toBeNull();
  });

  it("uses the token at the caret, not the end of the text", () => {
    const text = "@one @two";
    expect(activeToken(text, 4)).toEqual({ kind: "@", query: "one", start: 0 });
  });

  it("ignores an @ embedded in a word", () => {
    expect(at("email me@example")).toBeNull();
  });

  it("computes a start offset that replaces the sigil too", () => {
    const text = "see @src";
    const token = activeToken(text, text.length);
    expect(text.slice(token?.start)).toBe("@src");
  });
});
