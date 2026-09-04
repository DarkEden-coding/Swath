import { afterEach, describe, expect, it, vi } from "vitest";
import { pasteIntoFocusedField } from "./commandRegistry";

class FakeInput {}

class FakeTextArea {
  classList = { contains: (_name: string) => false };
  dataset: Record<string, string> = {};
}

afterEach(() => vi.unstubAllGlobals());

describe("pasteIntoFocusedField", () => {
  it("lets terminal and Pi paste handlers process the native menu command", () => {
    vi.stubGlobal("HTMLInputElement", FakeInput);
    vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);

    const piComposer = new FakeTextArea();
    piComposer.dataset.swathPasteHandler = "true";
    vi.stubGlobal("document", { activeElement: piComposer });
    expect(pasteIntoFocusedField()).toBe(false);

    const terminal = new FakeTextArea();
    terminal.classList.contains = (name) => name === "xterm-helper-textarea";
    vi.stubGlobal("document", { activeElement: terminal });
    expect(pasteIntoFocusedField()).toBe(false);
  });
});
