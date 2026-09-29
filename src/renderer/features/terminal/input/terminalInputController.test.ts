import { describe, expect, it, vi } from "vitest";
import { createTerminalInputController } from "./terminalInputController";

function createPasteEvent(
  text: string,
  files: Array<{ path?: string }> = [],
): Event & {
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

  it("forwards confirmed image paste as Ctrl+V so local terminal apps can read the clipboard", async () => {
    const terminal = createFakeTerminal();
    const writeTerminalData = vi.fn();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      writeTerminalData,
      openSearch: vi.fn(),
    });

    controller.pastePayload({ text: "", hasImage: true });
    expect(writeTerminalData).toHaveBeenCalledWith("\x16");
  });

  it("forwards empty image paste as Alt+V on native Windows", () => {
    const terminal = createFakeTerminal();
    const writeTerminalData = vi.fn();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      writeTerminalData,
      openSearch: vi.fn(),
      platform: "win32",
    });

    controller.pastePayload({ text: "", hasImage: true });

    expect(writeTerminalData).toHaveBeenCalledWith("\x1bv");
  });

  it("reports native clipboard read failures without injecting a shortcut", async () => {
    const terminal = createFakeTerminal();
    const writeTerminalData = vi.fn();
    const onPasteError = vi.fn();
    const failure = new Error("clipboard unavailable");
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => Promise.reject(failure),
      writeClipboardText: async () => {},
      writeTerminalData,
      openSearch: vi.fn(),
      onPasteError,
    });

    await controller.pasteFromClipboard();

    expect(onPasteError).toHaveBeenCalledWith(failure);
    expect(writeTerminalData).not.toHaveBeenCalled();
  });

  it("does not inject a shortcut when the native clipboard is empty", async () => {
    const terminal = createFakeTerminal();
    const writeTerminalData = vi.fn();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      writeTerminalData,
      openSearch: vi.fn(),
    });

    await controller.pasteFromClipboard();

    expect(writeTerminalData).not.toHaveBeenCalled();
  });

  it("uses native copy event data without requiring browser clipboard permission", () => {
    const terminal = createFakeTerminal();
    terminal.setSelection("copied remotely");
    const writeClipboardText = vi.fn();
    const setData = vi.fn();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      writeClipboardText,
      openSearch: vi.fn(),
    });
    controller.handleCopyEvent({
      clipboardData: { getData: () => "", setData },
      preventDefault: vi.fn(),
    });
    expect(setData).toHaveBeenCalledWith("text/plain", "copied remotely");
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("uses the native copy event for keyboard copy in an embedded webview", () => {
    const terminal = createFakeTerminal();
    terminal.setSelection("remote terminal selection");
    const writeClipboardText = vi.fn().mockRejectedValue(new Error("permission denied"));
    const setData = vi.fn();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      writeClipboardText,
      openSearch: vi.fn(),
    });
    const execCommand = vi.fn(() => {
      controller.handleCopyEvent({
        clipboardData: { getData: () => "", setData },
        preventDefault: vi.fn(),
      });
      return true;
    });
    vi.stubGlobal("document", { execCommand });
    try {
      const handler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
      expect(handler({ type: "keydown", key: "c", ctrlKey: true, preventDefault: vi.fn() })).toBe(
        false,
      );
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(setData).toHaveBeenCalledWith("text/plain", "remote terminal selection");
      expect(writeClipboardText).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      controller.dispose();
    }
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
    controller.handleKeyDown({ ...copyEvent, defaultPrevented: true });
    expect(writeClipboardText).toHaveBeenCalledTimes(1);

    const terminalWithoutSelection = createFakeTerminal();
    createTerminalInputController({
      terminal: terminalWithoutSelection,
      shellProfile: null,
      readClipboardText: async () => "",
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
    });
    const xtermKeyHandlerWithoutSelection =
      terminalWithoutSelection.attachCustomKeyEventHandler.mock.calls[0][0];
    expect(
      xtermKeyHandlerWithoutSelection({
        type: "keydown",
        key: "c",
        ctrlKey: true,
        preventDefault: vi.fn(),
      }),
    ).toBe(true);

    const preventDefault = vi.fn();
    controller.handleKeyDown({ key: "f", ctrlKey: true, preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(openSearch).toHaveBeenCalled();
  });

  it.each(["dispose", "blur"])("drops a pending clipboard read after %s", async (change) => {
    const terminal = createFakeTerminal();
    let resolve!: (text: string) => void;
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboardText: () =>
        new Promise((done) => {
          resolve = done;
        }),
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
    });
    const pending = controller.pasteFromClipboard();
    if (change === "dispose") controller.dispose();
    else terminal.textarea.dispatchEvent(new Event("blur"));
    resolve("stale clipboard");
    await pending;
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("does not send image shortcuts to a remote machine's unrelated clipboard", () => {
    const terminal = createFakeTerminal();
    const writeTerminalData = vi.fn();
    const onPasteError = vi.fn();
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
      writeTerminalData,
      onPasteError,
      isLocalSession: false,
    });
    controller.pastePayload({ text: "", hasImage: true });
    controller.pastePaths(["/local-only/file.png"]);
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(writeTerminalData).not.toHaveBeenCalled();
    expect(onPasteError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Remote terminal image paste") }),
    );
  });

  it("confirms empty DOM events before injecting any terminal shortcut", async () => {
    const terminal = createFakeTerminal();
    const writeTerminalData = vi.fn();
    const readClipboard = vi.fn().mockResolvedValue({ text: "", hasImage: false });
    const controller = createTerminalInputController({
      terminal,
      shellProfile: null,
      readClipboard,
      writeClipboardText: async () => {},
      openSearch: vi.fn(),
      writeTerminalData,
    });
    controller.handlePasteEvent(createPasteEvent(""));
    await Promise.resolve();
    expect(readClipboard).toHaveBeenCalledTimes(1);
    expect(writeTerminalData).not.toHaveBeenCalled();
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
