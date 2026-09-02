import { describe, expect, it } from "vitest";
import {
  activeToken,
  attachImages,
  clipboardImageFiles,
  imagePreviewSource,
  imagesForText,
} from "./Composer";
import { makePastes, tokenSpanAfter, tokenSpanBefore } from "./placeholders";
import type { AttachedImage } from "./piPaneCache";

const png = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });

describe("image placeholders", () => {
  it("appends a numbered placeholder per attachment", () => {
    const first = attachImages("look at", [], [png("a"), png("b")]);
    expect(first.text).toBe("look at [Image 1] [Image 2]");
    expect(first.images.map((image) => image.placeholder)).toEqual(["[Image 1]", "[Image 2]"]);
  });

  it("never collides with a placeholder still in the prompt", () => {
    const first = attachImages("", [], [png("a"), png("b")]);
    const removed = tokenSpanBefore(first.text, first.text.length);
    expect(removed?.token).toBe("[Image 2]");
    // Reusing the number just freed is safe; nothing references it any more.
    const second = attachImages(
      "[Image 1]",
      first.images.slice(0, 1),
      [png("c")],
    );
    expect(second.text).toBe("[Image 1] [Image 2]");
    expect(second.images.map((image) => image.data)).toEqual(["a", "c"]);
  });

  it("caps attachments at the per-message maximum", () => {
    const many = attachImages(
      "",
      [],
      Array.from({ length: 12 }, (_, index) => png(String(index))),
    );
    expect(many.images).toHaveLength(8);
  });

  it("locates a trailing placeholder for one-press removal", () => {
    const images: AttachedImage[] = [{ ...png("a"), placeholder: "[Image 1]" }];
    const span = tokenSpanBefore("hi [Image 1]", "hi [Image 1]".length);
    expect(span).toEqual({ start: 2, end: 12, token: "[Image 1]" });
    // "hi [Image 1] tail" keeps the token when the caret is past it.
    expect(tokenSpanBefore("[Image 1] tail", 12)).toBeNull();
    expect(imagesForText("only [Image 2]", images)).toHaveLength(0);
  });

  it("drops images whose placeholder the user deleted", () => {
    const images: AttachedImage[] = [
      { ...png("a"), placeholder: "[Image 1]" },
      { ...png("b"), placeholder: "[Image 2]" },
    ];
    expect(imagesForText("only [Image 2]", images)).toEqual([images[1]]);
  });
});

/** Places the caret at the end of `text`. */
function at(text: string) {
  return activeToken(text, text.length);
}

describe("imagePreviewSource", () => {
  it("builds a renderable data URL without attachment text", () => {
    expect(imagePreviewSource({ type: "image", data: "abc", mimeType: "image/png" })).toBe(
      "data:image/png;base64,abc",
    );
  });
});

describe("clipboardImageFiles", () => {
  it("uses clipboard items when WebKit leaves files empty", () => {
    const image = { type: "image/png" } as File;
    const data = {
      files: [],
      items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
    } as unknown as Pick<DataTransfer, "files" | "items">;

    expect(clipboardImageFiles(data)).toEqual([image]);
  });
});

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
