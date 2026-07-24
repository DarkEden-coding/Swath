import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface TerminalScrollState {
  distanceFromBottom: number;
  followOutput: boolean;
}

export interface TerminalCacheEntry {
  terminal: Terminal;
  fit: FitAddon;
  disposeResources: () => void;
  stopped: boolean;
  scrollState?: TerminalScrollState;
  scrollRevision?: number;
  outputWritePending?: boolean;
  outputWriteQueue?: string[];
  restoringScroll?: boolean;
  userScrollCapturePending?: boolean;
}

export const terminalCache = new Map<string, TerminalCacheEntry>();
export const startedSessions = new Set<string>();
export const exitStateSetters = new Map<string, (exited: boolean) => void>();

function terminalViewport(entry: TerminalCacheEntry): HTMLElement | null {
  return entry.terminal.element?.querySelector<HTMLElement>(".xterm-viewport") ?? null;
}

/** Capture a logical scroll anchor measured from the live bottom of xterm's buffer. */
export function captureTerminalScrollState(entry: TerminalCacheEntry, userInitiated = false): void {
  const buffer = entry.terminal.buffer.active;
  const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
  entry.scrollState = {
    distanceFromBottom,
    followOutput: distanceFromBottom === 0,
  };
  if (userInitiated) entry.scrollRevision = (entry.scrollRevision ?? 0) + 1;
}

/** Restore a logical anchor after output, resize, or DOM reattachment. */
export function restoreTerminalScrollState(entry: TerminalCacheEntry): void {
  const scrollState = entry.scrollState;
  if (!scrollState) return;

  entry.restoringScroll = true;
  if (scrollState.followOutput) {
    entry.terminal.scrollToBottom();
    // A detached xterm viewport can retain scrollTop=0 despite its logical
    // buffer being at the bottom. Repair that browser state after reattachment.
    const viewport = terminalViewport(entry);
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  } else {
    const targetLine = Math.max(
      0,
      entry.terminal.buffer.active.baseY - scrollState.distanceFromBottom,
    );
    entry.terminal.scrollToLine(targetLine);
  }

  requestAnimationFrame(() => {
    entry.restoringScroll = false;
  });
}

/**
 * Serialize terminal output and preserve the user's bottom-relative anchor.
 * A user scroll made while xterm parses a large write supersedes the old anchor.
 */
export function writeTerminalOutput(entry: TerminalCacheEntry, data: string): void {
  if (!data) return;
  (entry.outputWriteQueue ??= []).push(data);
  if (entry.outputWritePending) return;

  const writeNext = (): void => {
    const chunk = entry.outputWriteQueue?.shift();
    if (chunk === undefined) {
      entry.outputWritePending = false;
      return;
    }

    entry.outputWritePending = true;
    // Keep the durable user anchor rather than recapturing transient positions
    // produced while xterm is parsing or rendering previous output.
    if (!entry.scrollState) captureTerminalScrollState(entry);
    const revision = entry.scrollRevision ?? 0;
    entry.terminal.write(chunk, () => {
      if ((entry.scrollRevision ?? 0) === revision) restoreTerminalScrollState(entry);
      writeNext();
    });
  };

  writeNext();
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
