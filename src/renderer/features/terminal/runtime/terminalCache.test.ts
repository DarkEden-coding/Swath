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

  it("restores the same absolute history line after reattachment", () => {
    const { entry, terminal } = createEntry(100, 60);
    captureTerminalScrollState(entry);

    terminal.baseY = 120;
    terminal.viewportY = 120;
    restoreTerminalScrollState(entry);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(60);
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("restores follow mode only when the detached viewport was exactly at the bottom", () => {
    const { entry, terminal } = createEntry(100, 100);
    captureTerminalScrollState(entry);

    terminal.baseY = 120;
    terminal.viewportY = 0;
    restoreTerminalScrollState(entry);

    expect(terminal.scrollToTop).toHaveBeenCalledOnce();
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });
});
