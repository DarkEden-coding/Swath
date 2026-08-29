/**
 * Keeps a pi pane's conversation alive across tab switches.
 *
 * Only the active view is mounted (`TerminalWorkspace`), so without this the pane would kill its
 * `pi --mode rpc` child on every switch and replay the whole startup handshake on return. The
 * process now outlives the unmount and the last rendered state is restored synchronously; the
 * pane resyncs from pi for anything streamed while it was hidden.
 */

import { parsePiLine, type PiImageContent } from "../../../../shared/ipc/piRpc";
import { reducePiEvent, type PiPaneState } from "./eventReducer";

export interface AttachedImage extends PiImageContent {
  /** `[Image N]` marker mirroring the pi clipboard-image-paste extension. */
  placeholder: string;
}

export interface PiPaneCacheEntry {
  state: PiPaneState;
  draft: string;
  images: AttachedImage[];
}

export const piPaneCache = new Map<string, PiPaneCacheEntry>();
/** Panes whose pi process is already running, so a remount reattaches instead of respawning. */
export const spawnedPanes = new Set<string>();
let eventCacheStarted = false;
const mountedPanes = new Set<string>();

/** Keeps events received while a project or tab is unmounted for its next render. */
export function mountPiPaneEventCache(paneId: string): () => void {
  mountedPanes.add(paneId);
  if (!eventCacheStarted) {
    eventCacheStarted = true;
    window.swath.pi.onEvent(cacheHiddenPaneEvent);
  }
  return () => mountedPanes.delete(paneId);
}

/** Applies an event only when React is not mounted to handle it itself. */
function cacheHiddenPaneEvent(paneId: string, line?: string, exited?: boolean): void {
  if (mountedPanes.has(paneId)) return;
  const entry = piPaneCache.get(paneId);
  if (!entry) return;
  const state = exited
    ? { ...entry.state, exited: true, isStreaming: false }
    : line
      ? (() => {
          const event = parsePiLine(line);
          return event ? reducePiEvent(entry.state, event) : entry.state;
        })()
      : entry.state;
  piPaneCache.set(paneId, { ...entry, state });
}
/**
 * Session files adopted through `/resume`, so a restarted pane reopens the resumed conversation
 * rather than its own `--session-id`.
 *
 * ponytail: in-memory, so a resumed pane reverts to its own session when the app restarts.
 * Persist it in pane metadata if that becomes annoying.
 */
export const resumedSessions = new Map<string, string>();

/**
 * `@file` mentions the composer inserted, mapped to the path pi resolves them by.
 *
 * Kept per pane rather than in component state so a tab switch does not turn a mention back into
 * ordinary text the editing keys no longer treat as one object.
 */
const paneMentions = new Map<string, Map<string, string>>();

export function rememberMention(paneId: string, label: string, path: string): void {
  const mentions = paneMentions.get(paneId) ?? new Map<string, string>();
  mentions.set(label, path);
  paneMentions.set(paneId, mentions);
}

export function mentionsForPane(paneId: string): ReadonlyMap<string, string> {
  return paneMentions.get(paneId) ?? new Map<string, string>();
}

export function disposePiPane(paneId: string): void {
  piPaneCache.delete(paneId);
  spawnedPanes.delete(paneId);
  resumedSessions.delete(paneId);
  paneMentions.delete(paneId);
  void window.swath.pi.rpc({ op: "kill", paneId });
}
