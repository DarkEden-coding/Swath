import { lazy } from "react";
import type { AppSettings, PaneLeaf, WorkspaceView } from "../../../../shared/types";
import type { PiThinkingLevel } from "../../../../shared/ipc/piRpc";
import { createPaneNode } from "../../../domain/layout/layoutTree";
import { createId } from "../../../utils/ids";
import type { TabTypeRegistration } from "../types";
import { disposePiPane } from "./piPaneCache";

const PiAgentPane = lazy(() =>
  import("./PiAgentPane").then((module) => ({ default: module.PiAgentPane })),
);

/** Initial configuration for a fresh, independent Pi agent pane. */
export interface PiAgentStartOptions {
  prompt: string;
  title?: string;
  model?: string;
  thinkingLevel?: PiThinkingLevel;
}

/** Default metadata for a new pi agent pane. */
export function createPiAgentPaneMeta(
  settings: AppSettings,
  cwd?: string,
  start?: PiAgentStartOptions,
): Partial<Omit<PaneLeaf, "type" | "id">> {
  void settings;
  return {
    kind: "piAgent",
    cwd,
    title: "pi",
    metadata: {
      cwd,
      title: "pi",
      ...(start
        ? {
            piInitialPrompt: start.prompt,
            ...(start.title ? { title: start.title } : {}),
            piModel: start.model,
            piThinkingLevel: start.thinkingLevel,
          }
        : {}),
    },
  };
}

/** Creates a workspace view whose root pane runs pi. */
export function createPiAgentView(
  title: string,
  cwd: string | undefined,
  settings: AppSettings,
  start?: PiAgentStartOptions,
): WorkspaceView {
  const pane = createPaneNode(undefined, createPiAgentPaneMeta(settings, cwd, start));
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
