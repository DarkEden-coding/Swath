import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface TerminalScrollState {
  viewportY: number;
  atBottom: boolean;
  scrollTop: number;
  scrollHeight: number;
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

function syncViewportDomScroll(entry: TerminalCacheEntry): void {
  const viewport = terminalViewport(entry);
  const scrollState = entry.scrollState;
  if (!viewport || !scrollState) return;

  if (scrollState.atBottom) {
    viewport.scrollTop = viewport.scrollHeight;
    return;
  }

  if (scrollState.scrollHeight > 0) {
    viewport.scrollTop = Math.round((scrollState.scrollTop / scrollState.scrollHeight) * viewport.scrollHeight);
  }
}

export function captureTerminalScrollState(entry: TerminalCacheEntry): void {
  const buffer = entry.terminal.buffer.active;
  const viewport = terminalViewport(entry);
  entry.scrollState = {
    viewportY: buffer.viewportY,
    atBottom: buffer.viewportY >= buffer.baseY - 1,
    scrollTop: viewport?.scrollTop ?? 0,
    scrollHeight: viewport?.scrollHeight ?? 0,
  };
}

export function restoreTerminalScrollState(entry: TerminalCacheEntry): void {
  const scrollState = entry.scrollState;
  if (!scrollState) return;

  if (scrollState.atBottom) {
    // Detaching/re-attaching the xterm DOM can reset the native viewport's
    // scrollTop to 0 even when xterm's buffer still thinks it is at bottom.
    // Force a line change first so xterm recalculates, then sync the DOM
    // viewport too; otherwise the next wheel event starts from the top.
    entry.terminal.scrollToTop();
    entry.terminal.scrollToBottom();
  } else {
    entry.terminal.scrollToLine(scrollState.viewportY);
  }

  syncViewportDomScroll(entry);
  requestAnimationFrame(() => syncViewportDomScroll(entry));
  window.setTimeout(() => syncViewportDomScroll(entry), 0);
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
