import { describe, expect, it } from "vitest";
import { expandMentions, mentionLabels, mentionSpanAfter, mentionSpanBefore } from "./mentions";

const roots = ["/work/api", "/mnt/Fast Files/Projects/FIRST-Note-Detection"];
const sibling = "/mnt/Fast Files/Projects/FIRST-Note-Detection/ROADMAP.md";

describe("@file mentions", () => {
  it("labels a file by its own project's root, not the whole path", () => {
    const labels = mentionLabels(roots, ["src/main.rs", sibling]);
    expect([...labels.keys()]).toEqual(["src/main.rs", "FIRST-Note-Detection/ROADMAP.md"]);
    expect(labels.get("FIRST-Note-Detection/ROADMAP.md")).toBe(sibling);
  });

  it("keeps the absolute path for a label two folders would both claim", () => {
    const collide = ["/a/shared/x.ts", "/b/shared/x.ts"];
    const labels = mentionLabels(["/root", "/a/shared", "/b/shared"], collide);
    expect(labels.get("shared/x.ts")).toBe("/a/shared/x.ts");
    expect(labels.get("/b/shared/x.ts")).toBe("/b/shared/x.ts");
  });

  it("sends pi the path it can resolve", () => {
    const paths = new Map([["FIRST-Note-Detection/ROADMAP.md", sibling]]);
    expect(expandMentions("read @FIRST-Note-Detection/ROADMAP.md now", paths)).toBe(
      `read @${sibling} now`,
    );
    // A file in the working directory already resolves, so it is left alone.
    expect(expandMentions("read @src/main.rs", new Map([["src/main.rs", "src/main.rs"]]))).toBe(
      "read @src/main.rs",
    );
  });

  it("expands a mention at the very end of the prompt", () => {
    const paths = new Map([["web/index.ts", "/work/web/index.ts"]]);
    expect(expandMentions("check @web/index.ts", paths)).toBe("check @/work/web/index.ts");
  });

  it("deletes a whole mention, and its padding space, on one Backspace", () => {
    const labels = ["FIRST-Note-Detection/ROADMAP.md"];
    const text = "read @FIRST-Note-Detection/ROADMAP.md ";
    expect(mentionSpanBefore(text, text.length, labels)).toEqual({ start: 5, end: text.length });
    // And without the padding space, once the user has typed on.
    const tight = "read @FIRST-Note-Detection/ROADMAP.md";
    expect(mentionSpanBefore(tight, tight.length, labels)).toEqual({ start: 5, end: tight.length });
  });

  it("deletes a hand-typed mention as one object too", () => {
    expect(mentionSpanBefore("read @src/main.rs", 17, [])).toEqual({ start: 5, end: 17 });
  });

  it("leaves ordinary text to the ordinary editing keys", () => {
    expect(mentionSpanBefore("read the file", 13, [])).toBeNull();
    expect(mentionSpanBefore("", 0, [])).toBeNull();
  });

  it("deletes forward from the start of a mention", () => {
    const text = "read @web/index.ts now";
    expect(mentionSpanAfter(text, 5, ["web/index.ts"])).toEqual({ start: 5, end: 19 });
    expect(mentionSpanAfter(text, 6, ["web/index.ts"])).toBeNull();
  });

  it("handles a label containing spaces as one object", () => {
    const labels = ["Fast Files/notes.md"];
    const text = "see @Fast Files/notes.md ";
    expect(mentionSpanBefore(text, text.length, labels)).toEqual({ start: 4, end: text.length });
  });
});
