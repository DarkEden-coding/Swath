import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface TerminalScrollState {
  viewportY: number;
  atBottom: boolean;
}

export interface TerminalCacheEntry {
  terminal: Terminal;
  fit: FitAddon;
  disposeResources: () => void;
  stopped: boolean;
  scrollState?: TerminalScrollState;
}

export const terminalCache = new Map<string, TerminalCacheEntry>();
export const startedSessions = new Set<string>();
export const exitStateSetters = new Map<string, (exited: boolean) => void>();

export function captureTerminalScrollState(entry: TerminalCacheEntry): void {
  const buffer = entry.terminal.buffer.active;
  entry.scrollState = {
    viewportY: buffer.viewportY,
    atBottom: buffer.viewportY >= buffer.baseY - 1,
  };
}

export function restoreTerminalScrollState(entry: TerminalCacheEntry): void {
  const scrollState = entry.scrollState;
  if (!scrollState) return;
  if (scrollState.atBottom) {
    entry.terminal.scrollToBottom();
  } else {
    entry.terminal.scrollToLine(scrollState.viewportY);
  }
}

export function detachCachedTerminalElement(entry: TerminalCacheEntry, host?: HTMLElement | null): void {
  const element = entry.terminal.element;
  if (!element) return;
  if (host && element.parentElement !== host) return;
  element.parentElement?.removeChild(element);
}

/** Drop renderer-side xterm resources while keeping the main-process PTY session (for replay). */
export function evictCachedTerminal(paneId: string): void {
  const entry = terminalCache.get(paneId);
  if (!entry) return;
  detachCachedTerminalElement(entry);
  entry.disposeResources();
  terminalCache.delete(paneId);
}

/** Fully tear down a pane terminal, including session tracking. */
export function disposeCachedTerminal(paneId: string): void {
  evictCachedTerminal(paneId);
  startedSessions.delete(paneId);
  exitStateSetters.delete(paneId);
}
