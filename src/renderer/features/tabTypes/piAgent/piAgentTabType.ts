import { lazy } from "react";
import type { AppSettings, PaneLeaf, WorkspaceView } from "../../../../shared/types";
import { createPaneNode } from "../../../domain/layout/layoutTree";
import { createId } from "../../../utils/ids";
import type { TabTypeRegistration } from "../types";
import { disposePiPane } from "./piPaneCache";

const PiAgentPane = lazy(() =>
  import("./PiAgentPane").then((module) => ({ default: module.PiAgentPane })),
);

/** Default metadata for a new pi agent pane. */
export function createPiAgentPaneMeta(
  settings: AppSettings,
  cwd?: string,
): Partial<Omit<PaneLeaf, "type" | "id">> {
  void settings;
  return {
    kind: "piAgent",
    cwd,
    title: "pi",
    metadata: { cwd, title: "pi" },
  };
}

/** Creates a workspace view whose root pane runs pi. */
export function createPiAgentView(
  title: string,
  cwd: string | undefined,
  settings: AppSettings,
): WorkspaceView {
  const pane = createPaneNode(undefined, createPiAgentPaneMeta(settings, cwd));
  return {
    id: createId("view"),
    type: "workspace-view",
    title,
    layout: pane,
    activePaneId: pane.id,
  };
}

export const piAgentTabType: TabTypeRegistration = {
  kind: "piAgent",
  label: "Pi Agent",
  Component: PiAgentPane,
  createPaneMeta: createPiAgentPaneMeta,
  createView: (title, cwd, settings) => createPiAgentView(title, cwd, settings),
  closePane: (paneId) => disposePiPane(paneId),
};
