import { describe, expect, it, vi } from "vitest";
import { createTerminalInputController } from "./terminalInputController";

function createPasteEvent(text: string, files: Array<{ path?: string }> = []): Event & {
  clipboardData: { getData: (type: string) => string; files: Array<{ path?: string }> };
  preventDefault: () => void;
  stopPropagation: () => void;
  stopImmediatePropagation: () => void;
} {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData: { getData: (type: string) => string; files: Array<{ path?: string }> };
    preventDefault: () => void;
    stopPropagation: () => void;
    stopImmediatePropagation: () => void;
  };
  event.clipboardData = {
    getData: (type: string) => (type === "text/plain" ? text : ""),
    files,
  };
  event.preventDefault = vi.fn();
  event.stopPropagation = vi.fn();
  event.stopImmediatePropagation = vi.fn();
  return event;
}

function createFakeTerminal() {
  let selection = "";
  const selectionListeners = new Set<() => void>();
  const terminal = {
    textarea: new EventTarget() as HTMLElement,
    element: new EventTarget() as HTMLElement,
    focus: vi.fn(),
    paste: vi.fn(),
    getSelection: vi.fn(() => selection),
    onSelectionChange: vi.fn((listener: () => void) => {
      selectionListeners.add(listener);
      return { dispose: () => selectionListeners.delete(listener) };
    }),
    attachCustomKeyEventHandler: vi.fn(),
    setSelection: (value: string) => {
      selection = value;
      for (const listener of selectionListeners) listener();
    },
  };

  return terminal;
}

describe("createTerminalInputController", () => {
  it("handles native paste events on xterm's textarea before xterm can consume them", () => {
    const terminal = createFakeTerminal();
    createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
    });

    const event = createPasteEvent("historical clipboard text");
    terminal.textarea.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalled();
    expect(terminal.paste).toHaveBeenCalledWith("historical clipboard text");
  });

  it("formats pasted files for the configured shell", () => {
    const terminal = createFakeTerminal();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: { id: "pwsh", name: "PowerShell", command: "pwsh.exe", args: [] },
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
    });

    controller.handlePasteEvent(createPasteEvent("", [{ path: "C:\\Temp\\it's here.txt" }]));

    expect(terminal.paste).toHaveBeenCalledWith("'C:\\Temp\\it''s here.txt'");
  });

  it("uses current clipboard reads only for explicit context-menu paste", async () => {
    const terminal = createFakeTerminal();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "current clipboard",
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
    });

    await controller.pasteFromClipboard();

    expect(terminal.paste).toHaveBeenCalledWith("current clipboard");
  });

  it("copies current and recent terminal selections through the injected clipboard writer", async () => {
    let now = 1000;
    const terminal = createFakeTerminal();
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText,
      openSearch: vi.fn(),
      now: () => now,
    });

    terminal.setSelection("selected terminal text");
    await controller.copy(false);
    expect(writeClipboardText).toHaveBeenLastCalledWith("selected terminal text");

    terminal.setSelection("");
    now = 2500;
    await controller.copy(true);
    expect(writeClipboardText).toHaveBeenLastCalledWith("selected terminal text");
  });

  it("keeps paste and selected-copy shortcuts out of xterm's keydown handler and handles app shortcuts itself", () => {
    const terminal = createFakeTerminal();
    const openSearch = vi.fn();
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText,
      openSearch,
    });
    const xtermKeyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
    expect(xtermKeyHandler({ type: "keydown", key: "v", ctrlKey: true })).toBe(false);

    terminal.setSelection("selected terminal text");
    const copyEvent = { type: "keydown", key: "c", ctrlKey: true, preventDefault: vi.fn() };
    expect(xtermKeyHandler(copyEvent)).toBe(false);
    expect(copyEvent.preventDefault).toHaveBeenCalled();
    expect(writeClipboardText).toHaveBeenCalledWith("selected terminal text");

    const terminalWithoutSelection = createFakeTerminal();
    createTerminalInputController({
      terminal: terminalWithoutSelection,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
    });
    const xtermKeyHandlerWithoutSelection = terminalWithoutSelection.attachCustomKeyEventHandler.mock.calls[0][0];
    expect(xtermKeyHandlerWithoutSelection({ type: "keydown", key: "c", ctrlKey: true, preventDefault: vi.fn() })).toBe(true);

    const preventDefault = vi.fn();
    controller.handleKeyDown({ key: "f", ctrlKey: true, preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(openSearch).toHaveBeenCalled();
  });

  it("sends a distinct CSI-u sequence for Shift+Enter instead of letting xterm submit Enter", () => {
    const terminal = createFakeTerminal();
    const writeTerminalData = vi.fn();
    createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      writeTerminalData,
      openSearch: vi.fn(),
    });
    const xtermKeyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
    const shiftEnterEvent = { type: "keydown", key: "Enter", shiftKey: true, preventDefault: vi.fn() };

    expect(xtermKeyHandler(shiftEnterEvent)).toBe(false);
    expect(shiftEnterEvent.preventDefault).toHaveBeenCalled();
    expect(writeTerminalData).toHaveBeenCalledWith("\x1b[13;2u");
  });

  it("removes paste listeners and restores xterm key handling on dispose", () => {
    const terminal = createFakeTerminal();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
    });

    controller.dispose();
    terminal.textarea.dispatchEvent(createPasteEvent("after dispose"));
    const restoredKeyHandler = terminal.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];

    expect(terminal.paste).not.toHaveBeenCalled();
    expect(restoredKeyHandler({ type: "keydown", key: "v", ctrlKey: true })).toBe(true);
  });
});
