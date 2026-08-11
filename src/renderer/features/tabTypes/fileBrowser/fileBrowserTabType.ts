import { lazy } from "react";
import type { AppSettings, PaneLeaf, WorkspaceView } from "../../../../shared/types";
import { createPaneNode } from "../../../domain/layout/layoutTree";
import { createId } from "../../../utils/ids";
import type { TabTypeRegistration } from "../types";

const FileBrowserPane = lazy(() =>
  import("./FileBrowserPane").then((module) => ({ default: module.FileBrowserPane })),
);

export function createFileBrowserPaneMeta(
  settings: AppSettings,
  cwd?: string,
): Partial<Omit<PaneLeaf, "type" | "id">> {
  void settings;
  return {
    kind: "fileBrowser",
    cwd,
    title: "Files",
    metadata: { cwd, title: "Files" },
  };
}

/** Creates a workspace view whose root pane is a file browser. */
export function createFileBrowserView(
  title = "Files",
  cwd?: string,
  settings?: AppSettings,
): WorkspaceView {
  const pane = createPaneNode(
    undefined,
    settings ? createFileBrowserPaneMeta(settings, cwd) : { kind: "fileBrowser" },
  );
  return {
    id: createId("view"),
    type: "workspace-view",
    title,
    layout: pane,
    activePaneId: pane.id,
  };
}

export const fileBrowserTabType: TabTypeRegistration = {
  kind: "fileBrowser",
  label: "Files",
  Component: FileBrowserPane,
  createPaneMeta: createFileBrowserPaneMeta,
  createView: (title, cwd, settings) => createFileBrowserView(title, cwd, settings),
};
