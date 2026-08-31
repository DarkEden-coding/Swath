/**
 * Tracks pi agent lifecycle per pane so surfaces that outlive a pane's mount — the tab strip and
 * the sidebar — can show what its agents are doing without subscribing to the RPC stream.
 *
 * Lifecycle: "idle" until the agent's first run, "running" while streaming, and "done" once a run
 * finishes. "done" is an attention flag: selecting the owning tab or project acknowledges it,
 * returning the pane to "idle" until it runs again.
 */

import { create } from "zustand";
import type { WorkspaceView } from "../../../../shared/types";
import { collectPanes } from "../../../domain/layout/layoutTree";

export type PiPaneActivity = "running" | "done" | "idle";

export interface PiAgentCounts {
  running: number;
  /** Finished a run since the owning tab or project was last selected. */
  done: number;
}

interface PiActivityState {
  activity: Record<string, PiPaneActivity>;
  reportStreaming: (paneId: string, streaming: boolean) => void;
  acknowledgePanes: (paneIds: readonly string[]) => void;
  disposePane: (paneId: string) => void;
}

export const usePiActivityStore = create<PiActivityState>((set) => ({
  activity: {},
  reportStreaming: (paneId, streaming) =>
    set((state) => {
      const previous = state.activity[paneId] ?? "idle";
      const next: PiPaneActivity = streaming
        ? "running"
        : previous === "running"
          ? "done"
          : previous;
      if (previous === next) return state;
      return { activity: { ...state.activity, [paneId]: next } };
    }),
  acknowledgePanes: (paneIds) =>
    set((state) => {
      const relevant = paneIds.filter((id) => state.activity[id] === "done");
      if (relevant.length === 0) return state;
      const activity = { ...state.activity };
      for (const id of relevant) activity[id] = "idle";
      return { activity };
    }),
  disposePane: (paneId) =>
    set((state) => {
      if (!(paneId in state.activity)) return state;
      const activity = { ...state.activity };
      delete activity[paneId];
      return { activity };
    }),
}));

/** Records a streaming transition from anywhere (mounted pane or hidden-pane event cache). */
export function reportStreaming(paneId: string, streaming: boolean): void {
  usePiActivityStore.getState().reportStreaming(paneId, streaming);
}

/** The pi agent panes inside one tab (a view may hold several after splits). */
export function piPaneIdsOfView(view: WorkspaceView): string[] {
  return collectPanes(view.layout)
    .filter((pane) => pane.kind === "piAgent")
    .map((pane) => pane.id);
}

/** The pi agent panes across every tab of a workspace (a group root counts only its own tabs). */
export function piPaneIdsOfWorkspace(workspace: { views: WorkspaceView[] }): string[] {
  return workspace.views.flatMap(piPaneIdsOfView);
}

/** Aggregates pane lifecycle states into running/finished counts for an indicator. */
export function countPiAgents(
  activity: Record<string, PiPaneActivity>,
  paneIds: readonly string[],
): PiAgentCounts {
  const counts: PiAgentCounts = { running: 0, done: 0 };
  for (const id of paneIds) {
    if (activity[id] === "running") counts.running += 1;
    else if (activity[id] === "done") counts.done += 1;
  }
  return counts;
}
