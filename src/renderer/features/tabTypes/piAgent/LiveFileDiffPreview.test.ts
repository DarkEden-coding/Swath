import { describe, expect, it } from "vitest";
import { buildContextualDiff } from "./LiveFileDiffPreview";

describe("buildContextualDiff", () => {
  it("locates an edit and returns numbered context while arguments stream", () => {
    expect(
      buildContextualDiff("one\ntwo\nthree\nfour\nfive\n", "three\nfour", "THREE", "a.ts"),
    ).toEqual({
      filePath: "a.ts",
      added: 1,
      removed: 2,
      lines: [
        { type: "ctx", content: "one", oldNum: 1, newNum: 1 },
        { type: "ctx", content: "two", oldNum: 2, newNum: 2 },
        { type: "del", content: "three", oldNum: 3, newNum: null },
        { type: "del", content: "four", oldNum: 4, newNum: null },
        { type: "add", content: "THREE", oldNum: null, newNum: 3 },
        { type: "ctx", content: "five", oldNum: 5, newNum: 4 },
        { type: "ctx", content: "", oldNum: 6, newNum: 5 },
      ],
    });
  });

  it("returns null until the streamed old text matches the file", () => {
    expect(buildContextualDiff("const answer = 42;", "missing", "new")).toBeNull();
  });
});
