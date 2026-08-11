import { describe, expect, it } from "vitest";
import {
  baseName,
  canDropInto,
  isImagePath,
  isMarkdownPath,
  isValidName,
  joinPath,
  parentPath,
} from "./fileBrowserUtils";

describe("path helpers", () => {
  it("joins, splits, and names relative paths", () => {
    expect(joinPath("", "src")).toBe("src");
    expect(joinPath("src", "app.ts")).toBe("src/app.ts");
    expect(parentPath("src/app.ts")).toBe("src");
    expect(parentPath("app.ts")).toBe("");
    expect(baseName("src/app.ts")).toBe("app.ts");
  });
});

describe("canDropInto", () => {
  it("rejects moves into a directory's own subtree", () => {
    expect(canDropInto("src", "src")).toBe(false);
    expect(canDropInto("src", "src/nested")).toBe(false);
  });

  it("rejects a move into the current parent", () => {
    expect(canDropInto("src/app.ts", "src")).toBe(false);
    expect(canDropInto("app.ts", "")).toBe(false);
  });

  it("allows moves elsewhere, including to the root", () => {
    expect(canDropInto("src/app.ts", "lib")).toBe(true);
    expect(canDropInto("src/app.ts", "")).toBe(true);
    expect(canDropInto("lib", "src")).toBe(true);
  });
});

describe("isValidName", () => {
  it("rejects traversal and empty names", () => {
    expect(isValidName("app.ts")).toBe(true);
    expect(isValidName("  ")).toBe(false);
    expect(isValidName("..")).toBe(false);
    expect(isValidName("a/b")).toBe(false);
    expect(isValidName("a\\b")).toBe(false);
  });
});

describe("previewable paths", () => {
  it("matches supported image and Markdown extensions", () => {
    expect(isImagePath("assets/logo.PNG")).toBe(true);
    expect(isImagePath("notes.md")).toBe(false);
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/guide.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("notes.txt")).toBe(false);
    expect(isImagePath(".gitignore")).toBe(false);
  });
});
