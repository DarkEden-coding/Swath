import { lazy } from "react";
import type { AppSettings, PaneLeaf, WorkspaceView } from "../../../../shared/types";
import { createPaneNode } from "../../../domain/layout/layoutTree";
import { createId } from "../../../utils/ids";
import type { TabTypeRegistration } from "../types";

const ImagePreviewPane = lazy(() =>
  import("./ImagePreviewPane").then((module) => ({ default: module.ImagePreviewPane })),
);

/** Default metadata for a new imagePreview pane (path filled in later via upsert). */
export function createImagePreviewPaneMeta(
  settings: AppSettings,
  cwd?: string,
): Partial<Omit<PaneLeaf, "type" | "id">> {
  void settings;
  return {
    kind: "imagePreview",
    cwd,
    title: "Image Preview",
    metadata: { cwd, title: "Image Preview" },
  };
}

/** Creates a workspace view whose root pane is an image preview. */
export function createImagePreviewView(
  title: string,
  cwd: string | undefined,
  settings: AppSettings,
): WorkspaceView {
  const pane = createPaneNode(undefined, createImagePreviewPaneMeta(settings, cwd));
  return {
    id: createId("view"),
    type: "workspace-view",
    title,
    layout: pane,
    activePaneId: pane.id,
  };
}

export const imagePreviewTabType: TabTypeRegistration = {
  kind: "imagePreview",
  label: "Image Preview",
  Component: ImagePreviewPane,
  createPaneMeta: createImagePreviewPaneMeta,
  createView: (title, cwd, settings) => createImagePreviewView(title, cwd, settings),
};
