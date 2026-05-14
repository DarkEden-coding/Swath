import { lazy } from "react";
import type { AppSettings, PaneLeaf, WorkspaceView } from "../../../../shared/types";
import { createPaneNode } from "../../../domain/layout/layoutTree";
import { createId } from "../../../utils/ids";
import type { TabTypeRegistration } from "../types";

const GitManagerPane = lazy(() => import("./GitManagerPane").then((module) => ({ default: module.GitManagerPane })));

export function createGitManagerPaneMeta(settings: AppSettings, cwd?: string): Partial<Omit<PaneLeaf, "type" | "id">> {
  void settings;
  return { kind: "gitManager", cwd, title: "Source Control", metadata: { cwd, title: "Source Control" } };
}

export function createGitManagerView(title = "Source Control", cwd?: string, settings?: AppSettings): WorkspaceView {
  const pane = createPaneNode(undefined, settings ? createGitManagerPaneMeta(settings, cwd) : { kind: "gitManager" });
  return { id: createId("view"), type: "workspace-view", title, layout: pane, activePaneId: pane.id };
}

export const gitManagerTabType: TabTypeRegistration = {
  kind: "gitManager",
  label: "Source Control",
  Component: GitManagerPane,
  createPaneMeta: createGitManagerPaneMeta,
  createView: (title, cwd, settings) => createGitManagerView(title, cwd, settings),
};
