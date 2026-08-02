/**
 * Keeps a pi pane's conversation alive across tab switches.
 *
 * Only the active view is mounted (`TerminalWorkspace`), so without this the pane would kill its
 * `pi --mode rpc` child on every switch and replay the whole startup handshake on return. The
 * process now outlives the unmount and the last rendered state is restored synchronously; the
 * pane resyncs from pi for anything streamed while it was hidden.
 */

import type { PiImageContent } from "../../../../shared/ipc/piRpc";
import type { PiPaneState } from "./eventReducer";

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

export function disposePiPane(paneId: string): void {
  piPaneCache.delete(paneId);
  spawnedPanes.delete(paneId);
  void window.swath.pi.rpc({ op: "kill", paneId });
}
