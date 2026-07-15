import type {
  AppConfig,
  AppSettings,
  PaneKind,
  PaneNode,
  WorkspaceView,
} from "../../../shared/types";
import { collectPaneIds, collectPanes } from "../layout/layoutTree";
import { createPaneView, getPaneKindMetadata } from "../panes/paneMetadata";

const fallbackSettings: AppSettings = {
  fontFamily: "",
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: "block",
  defaultShellProfileId: "",
  shellProfiles: [],
  globalEnv: {},
  confirmBeforeClosingPane: true,
};

/** Creates a workspace view containing an initial pane. */
export function createWorkspaceView(
  title = "Terminal",
  cwd?: string,
  settings?: AppSettings,
  kind: PaneKind = "terminal",
): WorkspaceView {
  return createPaneView(kind, title, cwd, settings ?? fallbackSettings);
}

/** Adds and activates a view in the target workspace. */
export function addView(
  config: AppConfig,
  workspaceId?: string,
  kind: PaneKind = "terminal",
): { config: AppConfig; activePaneId: string | null } {
  let activePaneId: string | null = null;
  const targetWorkspaceId = workspaceId ?? config.activeWorkspaceId ?? config.workspaces[0]?.id;
  if (!targetWorkspaceId) return { config, activePaneId };
  const workspaces = config.workspaces.map((workspace) => {
    if (workspace.id !== targetWorkspaceId) return workspace;
    const tabLabel = getPaneKindMetadata(kind).label;
    const view = createWorkspaceView(
      `${tabLabel} ${workspace.views.length + 1}`,
      workspace.path,
      config.settings,
      kind,
    );
    activePaneId = view.activePaneId;
    return {
      ...workspace,
      views: [...workspace.views, view],
      activeViewId: view.id,
      updatedAt: Date.now(),
    };
  });
  return { config: { ...config, workspaces }, activePaneId };
}

/** Closes a view after any required confirmation. */
export function closeView(
  config: AppConfig,
  workspaceId: string,
  viewId: string,
): { config: AppConfig; activePaneId: string | null } {
  let activePaneId: string | null = null;
  const workspaces = config.workspaces.map((workspace) => {
    if (workspace.id !== workspaceId || workspace.views.length <= 1) return workspace;
    const index = workspace.views.findIndex((view) => view.id === viewId);
    if (index === -1) return workspace;
    const views = workspace.views.filter((view) => view.id !== viewId);
    const activeViewId =
      workspace.activeViewId === viewId
        ? (views[Math.max(0, index - 1)]?.id ?? views[0]!.id)
        : workspace.activeViewId;
    const activeView = views.find((view) => view.id === activeViewId) ?? views[0]!;
    activePaneId = activeView.activePaneId;
    return { ...workspace, views, activeViewId, updatedAt: Date.now() };
  });
  return { config: { ...config, workspaces }, activePaneId };
}

/** Selects a workspace view. */
export function selectView(
  config: AppConfig,
  workspaceId: string,
  viewId: string,
): { config: AppConfig; activePaneId: string | null } {
  let activePaneId: string | null = null;
  const workspaces = config.workspaces.map((workspace) => {
    const view =
      workspace.id === workspaceId ? workspace.views.find((item) => item.id === viewId) : null;
    if (!view) return workspace;
    activePaneId = view.activePaneId;
    return { ...workspace, activeViewId: view.id };
  });
  return { config: { ...config, workspaces }, activePaneId };
}

/** Renames a workspace view. */
export function renameView(
  config: AppConfig,
  workspaceId: string,
  viewId: string,
  title: string,
): AppConfig {
  const normalized = title.trim();
  if (!normalized) return config;
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) =>
      workspace.id !== workspaceId
        ? workspace
        : {
            ...workspace,
            views: workspace.views.map((view) =>
              view.id === viewId ? { ...view, title: normalized } : view,
            ),
            updatedAt: Date.now(),
          },
    ),
  };
}

/** Moves a view between list positions. */
export function moveView(
  config: AppConfig,
  workspaceId: string,
  fromIndex: number,
  toIndex: number,
): AppConfig {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return config;
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) => {
      if (workspace.id !== workspaceId) return workspace;
      if (fromIndex >= workspace.views.length || toIndex >= workspace.views.length)
        return workspace;
      const views = [...workspace.views];
      const [view] = views.splice(fromIndex, 1);
      if (!view) return workspace;
      views.splice(toIndex, 0, view);
      return { ...workspace, views, updatedAt: Date.now() };
    }),
  };
}

/** Collects pane identifiers for a workspace view. */
export function paneIdsForView(config: AppConfig, workspaceId: string, viewId: string): string[] {
  const view = config.workspaces
    .find((workspace) => workspace.id === workspaceId)
    ?.views.find((item) => item.id === viewId);
  return view ? collectPaneIds(view.layout) : [];
}

/** Collects pane nodes for a workspace view. */
export function panesForView(config: AppConfig, workspaceId: string, viewId: string): PaneNode[] {
  const view = config.workspaces
    .find((workspace) => workspace.id === workspaceId)
    ?.views.find((item) => item.id === viewId);
  return view ? collectPanes(view.layout) : [];
}
