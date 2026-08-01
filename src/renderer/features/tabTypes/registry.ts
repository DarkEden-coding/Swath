import type { AppSettings, PaneKind, PaneLeaf, WorkspaceView } from "../../../shared/types";
import { createPaneMeta, createPaneView } from "../../domain/panes/paneMetadata";
import { terminalTabType } from "./terminal/terminalTabType";
import { gitManagerTabType } from "./gitManager/gitManagerTabType";
import { imagePreviewTabType } from "./imagePreview/imagePreviewTabType";
import type { TabTypeRegistration } from "./types";

const tabTypes: Record<PaneKind, TabTypeRegistration> = {
  terminal: terminalTabType,
  gitManager: gitManagerTabType,
  imagePreview: imagePreviewTabType,
};

export function getTabType(kind: PaneKind): TabTypeRegistration {
  return tabTypes[kind];
}

export function getTabTypes(): TabTypeRegistration[] {
  return Object.values(tabTypes);
}

export function createTabTypePaneMeta(
  kind: PaneKind,
  settings: AppSettings,
  cwd?: string,
): Partial<Omit<PaneLeaf, "type" | "id">> {
  return createPaneMeta(kind, settings, cwd);
}

export function createTabTypeView(
  kind: PaneKind,
  title: string,
  cwd: string | undefined,
  settings: AppSettings,
): WorkspaceView {
  return createPaneView(kind, title, cwd, settings);
}
