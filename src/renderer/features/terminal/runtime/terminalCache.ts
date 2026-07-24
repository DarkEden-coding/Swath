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

function terminalViewport(entry: TerminalCacheEntry): HTMLElement | null {
  return entry.terminal.element?.querySelector<HTMLElement>(".xterm-viewport") ?? null;
}

/** Capture xterm's absolute viewport for a later detach/reattach cycle. */
export function captureTerminalScrollState(entry: TerminalCacheEntry): void {
  const buffer = entry.terminal.buffer.active;
  entry.scrollState = {
    viewportY: buffer.viewportY,
    atBottom: buffer.viewportY === buffer.baseY,
  };
}

/** Restore a viewport after its cached xterm element has been reattached. */
export function restoreTerminalScrollState(entry: TerminalCacheEntry): void {
  const scrollState = entry.scrollState;
  if (!scrollState) return;

  if (scrollState.atBottom) {
    // Detaching the xterm DOM can leave the native viewport at scrollTop=0
    // while the logical buffer remains at the bottom. Force xterm to resync.
    entry.terminal.scrollToTop();
    entry.terminal.scrollToBottom();
    const viewport = terminalViewport(entry);
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    return;
  }

  entry.terminal.scrollToLine(Math.min(scrollState.viewportY, entry.terminal.buffer.active.baseY));
}

/** Write output without overriding xterm's native user-scrolling behavior. */
export function writeTerminalOutput(
  entry: TerminalCacheEntry,
  data: string,
  onParsed?: () => void,
): void {
  if (!data) return;
  if (onParsed) entry.terminal.write(data, onParsed);
  else entry.terminal.write(data);
}

export function detachCachedTerminalElement(
  entry: TerminalCacheEntry,
  host?: HTMLElement | null,
): void {
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
