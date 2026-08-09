import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface TerminalScrollState {
  /** Rows between the captured viewport and the bottom of the buffer. */
  distanceFromBottom: number;
  followOutput: boolean;
}

/**
 * xterm converts DOM scroll offsets back into rows with `Math.round`, so a
 * viewport the user dragged fully to the bottom can report one row short.
 * Treat that as "at the bottom" rather than demoting the pane out of follow.
 */
const BOTTOM_TOLERANCE_ROWS = 1;

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

/**
 * Move the viewport to `targetLine`, guaranteeing xterm resyncs the DOM.
 *
 * Detaching the xterm element resets the native viewport's `scrollTop` to 0
 * while xterm's buffer position is untouched, and xterm skips its DOM sync when
 * a scroll request produces no row change. Nudge by a row first so the reattached
 * element actually gets its scroll offset back; both calls land in the same frame,
 * so only the final position is ever painted.
 */
function scrollToLineWithResync(terminal: Terminal, targetLine: number): void {
  if (terminal.buffer.active.viewportY === targetLine && terminal.buffer.active.baseY > 0) {
    terminal.scrollLines(targetLine > 0 ? -1 : 1);
  }
  terminal.scrollToLine(targetLine);
}

/** Capture a bottom-relative anchor for a later detach/reattach cycle. */
export function captureTerminalScrollState(entry: TerminalCacheEntry): void {
  const buffer = entry.terminal.buffer.active;
  const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
  entry.scrollState = {
    distanceFromBottom,
    followOutput: distanceFromBottom <= BOTTOM_TOLERANCE_ROWS,
  };
}

/**
 * Restore a viewport after its cached xterm element has been reattached.
 * With no captured anchor the pane defaults to the bottom, never the top.
 */
export function restoreTerminalScrollState(entry: TerminalCacheEntry): void {
  const scrollState = entry.scrollState;
  const baseY = entry.terminal.buffer.active.baseY;

  if (!scrollState || scrollState.followOutput) {
    // Routing through scrollToLine(baseY) also clears xterm's isUserScrolling
    // latch, which is what actually re-enables follow-the-output.
    scrollToLineWithResync(entry.terminal, baseY);
    return;
  }

  scrollToLineWithResync(entry.terminal, Math.max(0, baseY - scrollState.distanceFromBottom));
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
