import { describe, expect, it } from "vitest";
import { parsePartialJson, readableArgs } from "./partialJson";

describe("parsePartialJson", () => {
  it("parses a complete object unchanged", () => {
    expect(parsePartialJson('{"path":"a.ts","limit":10}')).toEqual({ path: "a.ts", limit: 10 });
  });

  it("returns undefined for nothing, whitespace, or a non-object", () => {
    expect(parsePartialJson(undefined)).toBeUndefined();
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson("   ")).toBeUndefined();
    expect(parsePartialJson("[1,2]")).toBeUndefined();
    expect(parsePartialJson('"just a string"')).toBeUndefined();
  });

  it("recovers the fields settled before the truncation point", () => {
    expect(parsePartialJson('{"path":"a.ts","content":"cons')).toEqual({
      path: "a.ts",
      content: "cons",
    });
  });

  it("keeps a partial string value, since that is the value being typed", () => {
    expect(parsePartialJson('{"command":"npm run bui')).toEqual({ command: "npm run bui" });
  });

  it("drops a dangling key that has no value yet", () => {
    expect(parsePartialJson('{"path":"a.ts","content')).toEqual({ path: "a.ts" });
    expect(parsePartialJson('{"path":"a.ts","content"')).toEqual({ path: "a.ts" });
    expect(parsePartialJson('{"path":"a.ts","content":')).toEqual({ path: "a.ts" });
  });

  it("drops a truncated literal rather than guessing at it", () => {
    expect(parsePartialJson('{"path":"a.ts","literal":tru')).toEqual({ path: "a.ts" });
    expect(parsePartialJson('{"path":"a.ts","limit":1')).toEqual({ path: "a.ts", limit: 1 });
  });

  it("closes nested arrays and objects", () => {
    expect(parsePartialJson('{"path":"a.ts","edits":[{"oldText":"one","newText":"tw')).toEqual({
      path: "a.ts",
      edits: [{ oldText: "one", newText: "tw" }],
    });
  });

  it("keeps completed array elements when the newest one is unusable", () => {
    expect(parsePartialJson('{"edits":[{"oldText":"a","newText":"b"},{"oldTe')).toEqual({
      edits: [{ oldText: "a", newText: "b" }],
    });
  });

  it("survives a truncation inside an escape sequence", () => {
    expect(parsePartialJson('{"content":"line one\\')).toEqual({ content: "line one" });
    expect(parsePartialJson('{"content":"tab\\u00')).toEqual({ content: "tab" });
  });

  it("preserves escapes that did complete", () => {
    expect(parsePartialJson('{"content":"line one\\nline tw')).toEqual({
      content: "line one\nline tw",
    });
  });

  it("does not mistake JSON punctuation inside a string for structure", () => {
    expect(parsePartialJson('{"command":"echo \\"{[,:\\" && ls')).toEqual({
      command: 'echo "{[,:" && ls',
    });
  });

  it("handles the very first delta of a call", () => {
    expect(parsePartialJson("{")).toEqual({});
    expect(parsePartialJson('{"')).toEqual({});
  });

  it("recovers a deeply truncated nested structure", () => {
    expect(parsePartialJson('{"changes":[{"path":"a.ts","action":"update","oldText":')).toEqual({
      changes: [{ path: "a.ts", action: "update" }],
    });
  });
});

describe("readableArgs", () => {
  it("prefers the settled arguments once pi has parsed them", () => {
    expect(readableArgs({ args: { path: "final.ts" }, partialArgs: '{"path":"par' })).toEqual({
      path: "final.ts",
    });
  });

  it("falls back to the streaming buffer", () => {
    expect(readableArgs({ partialArgs: '{"path":"par' })).toEqual({ path: "par" });
  });

  it("returns undefined when there is nothing to read", () => {
    expect(readableArgs({})).toBeUndefined();
  });
});
