import { describe, expect, it } from "vitest";
import { getTerminalKeyAction, isTerminalPasteShortcut, shouldXtermHandleKeyEvent } from "./terminalKeyboard";

describe("getTerminalKeyAction", () => {
  it("handles terminal copy shortcuts when text is selected", () => {
    expect(getTerminalKeyAction({ key: "c", ctrlKey: true }, true)).toBe("copy");
    expect(getTerminalKeyAction({ key: "Insert", ctrlKey: true }, true)).toBe("copy");
  });

  it("does not handle paste shortcuts on keydown so clipboard history can dispatch paste events", () => {
    expect(getTerminalKeyAction({ key: "v", ctrlKey: true }, false)).toBe("none");
    expect(getTerminalKeyAction({ key: "v", metaKey: true }, false)).toBe("none");
    expect(getTerminalKeyAction({ key: "Insert", shiftKey: true }, false)).toBe("none");
  });

  it("keeps find on keydown", () => {
    expect(getTerminalKeyAction({ key: "f", ctrlKey: true }, false)).toBe("find");
  });
});

describe("isTerminalPasteShortcut", () => {
  it("detects paste shortcuts xterm must leave to the browser paste event", () => {
    expect(isTerminalPasteShortcut({ key: "v", ctrlKey: true })).toBe(true);
    expect(isTerminalPasteShortcut({ key: "v", metaKey: true })).toBe(true);
    expect(isTerminalPasteShortcut({ key: "Insert", shiftKey: true })).toBe(true);
  });

  it("does not treat Alt-modified shortcuts as paste", () => {
    expect(isTerminalPasteShortcut({ key: "v", ctrlKey: true, altKey: true })).toBe(false);
  });
});

describe("shouldXtermHandleKeyEvent", () => {
  it("lets the browser handle paste keydowns so real paste events can carry history clipboard data", () => {
    expect(shouldXtermHandleKeyEvent({ type: "keydown", key: "v", ctrlKey: true })).toBe(false);
    expect(shouldXtermHandleKeyEvent({ type: "keydown", key: "Insert", shiftKey: true })).toBe(false);
  });

  it("leaves paste keyup and non-paste keydown events with xterm", () => {
    expect(shouldXtermHandleKeyEvent({ type: "keyup", key: "v", ctrlKey: true })).toBe(true);
    expect(shouldXtermHandleKeyEvent({ type: "keydown", key: "a" })).toBe(true);
  });
});
