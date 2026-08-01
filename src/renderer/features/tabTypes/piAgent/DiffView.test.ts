import { describe, expect, it } from "vitest";
import { hasDiff } from "./DiffView";
import type { PiToolEntry } from "./eventReducer";

function tool(details: Record<string, unknown> | undefined): PiToolEntry {
  return {
    kind: "tool",
    id: "t1",
    toolCallId: "t1",
    toolName: "edit",
    output: "",
    startedAt: 0,
    isError: false,
    details,
  };
}

/** Captured verbatim from `tool_execution_end` with the pi-diff package loaded. */
const editInfo = {
  _type: "editInfo",
  summary: "+1 -1 at line 2",
  filePath: "sample.txt",
  editLine: 2,
  diff: {
    lines: [
      { type: "sep", oldNum: null, newNum: null, content: "" },
      { type: "del", oldNum: 1, newNum: null, content: "line two" },
      { type: "add", oldNum: null, newNum: 1, content: "line TWO changed" },
    ],
    added: 1,
    removed: 1,
    chars: 24,
  },
};

/** Captured verbatim from baseline pi, without the pi-diff package. */
const plainPatch = {
  diff: " 1 line one\n-2 line two\n+2 line TWO changed\n 3 line three",
  patch: "--- sample.txt\n+++ sample.txt\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n line three\n",
  firstChangedLine: 2,
};

describe("hasDiff", () => {
  it("detects the structured pi-diff payload", () => {
    expect(hasDiff(tool(editInfo))).toBe(true);
  });

  it("detects the baseline patch payload", () => {
    expect(hasDiff(tool(plainPatch))).toBe(true);
  });

  it("ignores tools with no details", () => {
    expect(hasDiff(tool(undefined))).toBe(false);
  });

  it("ignores read-style results whose details are unrelated", () => {
    expect(hasDiff(tool({ truncation: null, fullOutputPath: null }))).toBe(false);
  });

  it("ignores an empty diff string", () => {
    expect(hasDiff(tool({ diff: "   " }))).toBe(false);
  });

  it("does not mistake a details.diff object without lines for a diff", () => {
    expect(hasDiff(tool({ diff: { added: 1, removed: 0 } }))).toBe(false);
  });
});
