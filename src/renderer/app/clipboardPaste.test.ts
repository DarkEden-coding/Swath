import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFocusedSelection, listenForPaste, pasteIntoFocusedField } from "./clipboardPaste";

class Editor extends EventTarget {
  isConnected = true;
  isContentEditable = false;
  disabled = false;
  readOnly = false;
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  text = "";
  classList = { contains: () => false };
  hasAttribute = () => false;
  focus(): void {
    documentStub.activeElement = this;
  }
  getClientRects(): object[] {
    return [{}];
  }
  get value(): string {
    return this.text;
  }
  set value(value: string) {
    this.text = value;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}
class Input extends Editor {}

const clipboard = { readForTerminal: vi.fn() };
let documentStub: { activeElement: Editor; body: Editor; querySelector: ReturnType<typeof vi.fn> };

beforeEach(() => {
  documentStub = { activeElement: new Editor(), body: new Editor(), querySelector: vi.fn() };
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("HTMLElement", Editor);
  vi.stubGlobal("HTMLTextAreaElement", Editor);
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { swath: { clipboard } }));
  clipboard.readForTerminal.mockReset().mockResolvedValue({ text: "paste", hasImage: false });
});
afterEach(() => vi.unstubAllGlobals());

describe("focused clipboard routing", () => {
  it("copies Ctrl+C selections through native Copy and leaves unselected Ctrl+C alone", () => {
    const execCommand = vi.fn().mockReturnValue(true);
    Object.assign(documentStub, { execCommand });
    const field = documentStub.activeElement;
    field.value = "selected text";
    field.setSelectionRange(0, 8);
    const event = {
      key: "c",
      ctrlKey: true,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    copyFocusedSelection(event);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    execCommand.mockClear();
    field.setSelectionRange(0, 0);
    copyFocusedSelection(event);
    copyFocusedSelection({ ...event, defaultPrevented: true });
    copyFocusedSelection({ ...event, metaKey: true });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("copies content selections without requiring async browser clipboard permission", () => {
    const execCommand = vi.fn().mockReturnValue(true);
    Object.assign(documentStub, { execCommand });
    documentStub.activeElement = documentStub.body;
    vi.stubGlobal("HTMLTextAreaElement", Input);
    Object.assign(window, { getSelection: () => ({ toString: () => "remote output" }) });
    const event = {
      key: "c",
      ctrlKey: true,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    copyFocusedSelection(event);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it("uses the same focused terminal/composer handler for local and host payloads", async () => {
    const target = documentStub.activeElement;
    const paste = vi.fn();
    const hiddenPaste = vi.fn();
    const stop = listenForPaste(target as unknown as HTMLElement, paste);
    listenForPaste(new Editor() as unknown as HTMLElement, hiddenPaste);
    await pasteIntoFocusedField();
    await pasteIntoFocusedField({ text: "remote host", hasImage: false });
    expect(paste.mock.calls.map(([payload]) => payload.text)).toEqual(["paste", "remote host"]);
    expect(clipboard.readForTerminal).toHaveBeenCalledTimes(1);
    expect(hiddenPaste).not.toHaveBeenCalled();
    expect(target.value).toBe("");
    stop();
  });

  it("restores only the explicitly addressed visible terminal when DOM focus is lost", async () => {
    const terminal = documentStub.activeElement;
    const paste = vi.fn();
    listenForPaste(terminal as unknown as HTMLElement, paste);
    documentStub.activeElement = documentStub.body;
    documentStub.querySelector.mockImplementation((selector: string) =>
      selector.includes('data-terminal-pane-id="active"') ? terminal : null,
    );
    await pasteIntoFocusedField({ text: "focused fallback", hasImage: false }, "active");
    expect(paste).toHaveBeenCalledTimes(1);
    documentStub.activeElement = documentStub.body;
    terminal.getClientRects = () => [];
    await pasteIntoFocusedField({ text: "hidden", hasImage: false }, "active");
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it("inserts into ordinary fields once and emits input for React", async () => {
    const field = documentStub.activeElement;
    field.value = "abcd";
    field.setSelectionRange(1, 3);
    const input = vi.fn();
    field.addEventListener("input", input);
    await pasteIntoFocusedField();
    expect(field.value).toBe("apasted");
    expect(field.selectionStart).toBe(6);
    expect(input).toHaveBeenCalledTimes(1);
  });

  it.each(["blur", "window blur", "detach", "edit", "selection"])(
    "cancels an in-flight read after %s",
    async (change) => {
      let resolve!: (value: { text: string; hasImage: boolean }) => void;
      clipboard.readForTerminal.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const field = documentStub.activeElement;
      const paste = vi.fn();
      listenForPaste(field as unknown as HTMLElement, paste);
      const pending = pasteIntoFocusedField();
      if (change === "blur") field.dispatchEvent(new Event("blur"));
      if (change === "window blur") window.dispatchEvent(new Event("blur"));
      if (change === "detach") field.isConnected = false;
      if (change === "edit") field.value = "typed while reading";
      if (change === "selection") field.setSelectionRange(1, 1);
      resolve({ text: "stale", hasImage: false });
      await pending;
      expect(paste).not.toHaveBeenCalled();
      expect(field.value).not.toContain("stale");
    },
  );

  it("reports clipboard permission failures to the owning editor without pasting", async () => {
    const failure = new Error("Clipboard permission denied");
    clipboard.readForTerminal.mockRejectedValue(failure);
    const paste = vi.fn();
    const onError = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      listenForPaste(documentStub.activeElement as unknown as HTMLElement, paste, onError);
      await pasteIntoFocusedField();
      expect(onError).toHaveBeenCalledWith(failure);
      expect(paste).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("does not read for a disabled field or insert into an unclaimed custom editor", async () => {
    documentStub.activeElement.disabled = true;
    await pasteIntoFocusedField();
    expect(clipboard.readForTerminal).not.toHaveBeenCalled();
    documentStub.activeElement.disabled = false;
    documentStub.activeElement.hasAttribute = () => true;
    await pasteIntoFocusedField();
    expect(documentStub.activeElement.value).toBe("");
  });
});
