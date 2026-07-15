import { lazy } from "react";
import type { AppSettings, PaneLeaf, ShellProfile, WorkspaceView } from "../../../../shared/types";
import { createPaneNode } from "../../../domain/layout/layoutTree";
import { disposeCachedTerminal } from "../../terminal/runtime/terminalCache";
import { terminalClient } from "../../../services/terminalClient";
import { createId } from "../../../utils/ids";
import type { TabTypeRegistration } from "../types";

const TerminalPane = lazy(() =>
  import("./TerminalPane").then((module) => ({ default: module.TerminalPane })),
);

function shellFor(settings: AppSettings): ShellProfile | null {
  return (
    settings.shellProfiles.find((profile) => profile.id === settings.defaultShellProfileId) ??
    settings.shellProfiles[0] ??
    null
  );
}

export function createTerminalPaneMeta(
  settings: AppSettings,
  cwd?: string,
): Partial<Omit<PaneLeaf, "type" | "id">> {
  const shellProfile = shellFor(settings);
  return {
    kind: "terminal",
    cwd,
    shellProfile,
    env: { ...(settings.globalEnv ?? {}) },
    metadata: {
      cwd,
      shellProfileId: shellProfile?.id,
      shellProfile,
      env: { ...(settings.globalEnv ?? {}) },
    },
  };
}

export function createTerminalView(
  title = "Terminal",
  cwd?: string,
  settings?: AppSettings,
): WorkspaceView {
  const pane = createPaneNode(
    undefined,
    settings ? createTerminalPaneMeta(settings, cwd) : { kind: "terminal" },
  );
  return {
    id: createId("view"),
    type: "workspace-view",
    title,
    layout: pane,
    activePaneId: pane.id,
  };
}

export const terminalTabType: TabTypeRegistration = {
  kind: "terminal",
  label: "Terminal",
  Component: TerminalPane,
  createPaneMeta: createTerminalPaneMeta,
  createView: (title, cwd, settings) => createTerminalView(title, cwd, settings),
  isBusy: (paneId) => terminalClient.isBusy(paneId),
  closePane: (paneId) => {
    terminalClient.kill(paneId);
    disposeCachedTerminal(paneId);
  },
};
