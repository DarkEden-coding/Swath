import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

export interface TerminalCacheEntry {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  dispose: () => void;
  disposeTimer: number | null;
}

export const terminalCache = new Map<string, TerminalCacheEntry>();
export const startedSessions = new Set<string>();
export const exitStateSetters = new Map<string, (exited: boolean) => void>();
