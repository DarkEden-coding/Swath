import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

export interface TerminalCacheEntry {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  dispose: () => void;
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

export function disposeCachedTerminal(paneId: string): void {
  const entry = terminalCache.get(paneId);
  if (!entry) return;
  detachCachedTerminalElement(entry);
  entry.dispose();
  terminalCache.delete(paneId);
  exitStateSetters.delete(paneId);
}
