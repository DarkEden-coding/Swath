import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

export interface TerminalCacheEntry {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  disposeResources: () => void;
  stopped: boolean;
}

export const terminalCache = new Map<string, TerminalCacheEntry>();
export const startedSessions = new Set<string>();
export const exitStateSetters = new Map<string, (exited: boolean) => void>();

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
