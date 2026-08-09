import { describe, expect, it, vi } from "vitest";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  captureTerminalScrollState,
  restoreTerminalScrollState,
  type TerminalCacheEntry,
  writeTerminalOutput,
} from "./terminalCache";

interface FakeTerminalState {
  baseY: number;
  viewportY: number;
  write: ReturnType<typeof vi.fn>;
  scrollToBottom: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
  scrollToTop: ReturnType<typeof vi.fn>;
  scrollLines: ReturnType<typeof vi.fn>;
}

/** Create the minimal xterm surface needed by the scroll-state tests. */
function createEntry(
  baseY: number,
  viewportY: number,
): {
  entry: TerminalCacheEntry;
  terminal: FakeTerminalState;
} {
  const terminal: FakeTerminalState = {
    baseY,
    viewportY,
    write: vi.fn((_data: string, callback?: () => void) => callback?.()),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    scrollToTop: vi.fn(),
    scrollLines: vi.fn(),
  };
  const xterm = {
    buffer: {
      active: {
        get baseY(): number {
          return terminal.baseY;
        },
        get viewportY(): number {
          return terminal.viewportY;
        },
      },
    },
    element: undefined,
    write: terminal.write,
    scrollToBottom: terminal.scrollToBottom,
    scrollToLine: terminal.scrollToLine,
    scrollToTop: terminal.scrollToTop,
    scrollLines: terminal.scrollLines,
  } as unknown as Terminal;

  return {
    entry: {
      terminal: xterm,
      fit: {} as FitAddon,
      disposeResources: vi.fn(),
      stopped: false,
    },
    terminal,
  };
}

describe("terminal scroll ownership", () => {
  it("does not restore or snap the viewport after output", () => {
    const { entry, terminal } = createEntry(100, 100);
    captureTerminalScrollState(entry);

    terminal.viewportY = 65;
    writeTerminalOutput(entry, "agent output");

    expect(terminal.write).toHaveBeenCalledWith("agent output");
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("restores the same bottom-relative history position after reattachment", () => {
    const { entry, terminal } = createEntry(100, 60);
    captureTerminalScrollState(entry);

    terminal.baseY = 120;
    terminal.viewportY = 120;
    restoreTerminalScrollState(entry);

    // 40 rows above the bottom of a buffer that grew to 120 while detached.
    expect(terminal.scrollToLine).toHaveBeenCalledWith(80);
    expect(terminal.scrollToTop).not.toHaveBeenCalled();
  });

  it("restores follow mode by scrolling to the live bottom", () => {
    const { entry, terminal } = createEntry(100, 100);
    captureTerminalScrollState(entry);

    terminal.baseY = 120;
    terminal.viewportY = 0;
    restoreTerminalScrollState(entry);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(120);
    expect(terminal.scrollToTop).not.toHaveBeenCalled();
  });

  it("treats a viewport one row short of the bottom as still following", () => {
    const { entry, terminal } = createEntry(100, 99);
    captureTerminalScrollState(entry);

    terminal.baseY = 140;
    restoreTerminalScrollState(entry);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(140);
  });

  it("defaults to the bottom when no anchor was captured", () => {
    const { entry, terminal } = createEntry(100, 20);

    restoreTerminalScrollState(entry);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(100);
  });

  it("nudges the viewport so a reattached element resyncs its scroll offset", () => {
    const { entry, terminal } = createEntry(100, 100);
    captureTerminalScrollState(entry);

    // Buffer position is unchanged after reattach, so xterm would skip its DOM sync.
    restoreTerminalScrollState(entry);

    expect(terminal.scrollLines).toHaveBeenCalledWith(-1);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(100);
  });
});
