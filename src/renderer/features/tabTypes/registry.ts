import type { AppSettings, PaneKind, PaneLeaf, WorkspaceView } from "../../../shared/types";
import { isPaneKind } from "../../../shared/types";
import { createPaneMeta, createPaneView } from "../../domain/panes/paneMetadata";
import { terminalTabType } from "./terminal/terminalTabType";
import { gitManagerTabType } from "./gitManager/gitManagerTabType";
import { fileBrowserTabType } from "./fileBrowser/fileBrowserTabType";
import { piAgentTabType } from "./piAgent/piAgentTabType";
import type { TabTypeRegistration } from "./types";

const tabTypes: Record<PaneKind, TabTypeRegistration> = {
  terminal: terminalTabType,
  gitManager: gitManagerTabType,
  fileBrowser: fileBrowserTabType,
  piAgent: piAgentTabType,
};

/** Returns undefined for a kind this build no longer registers, e.g. one left in an old config. */
export function getTabType(kind: PaneKind): TabTypeRegistration | undefined {
  return isPaneKind(kind) ? tabTypes[kind] : undefined;
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
