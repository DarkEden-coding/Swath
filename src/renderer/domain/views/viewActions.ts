import type { AppConfig, AppSettings, PaneKind, WorkspaceView } from "../../../shared/types";
import { collectPaneIds, collectPanes } from "../layout/layoutTree";
import { createTabTypeView, getTabType } from "../../features/tabTypes/registry";

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

export function createWorkspaceView(title = "Terminal", cwd?: string, settings?: AppSettings, kind: PaneKind = "terminal"): WorkspaceView {
  return createTabTypeView(kind, title, cwd, settings ?? fallbackSettings);
}

export function addView(config: AppConfig, workspaceId?: string, kind: PaneKind = "terminal"): { config: AppConfig; activePaneId: string | null } {
  let activePaneId: string | null = null;
  const targetWorkspaceId = workspaceId ?? config.activeWorkspaceId ?? config.workspaces[0]?.id;
  if (!targetWorkspaceId) return { config, activePaneId };
  const workspaces = config.workspaces.map((workspace) => {
    if (workspace.id !== targetWorkspaceId) return workspace;
    const tabLabel = getTabType(kind).label;
    const view = createWorkspaceView(`${tabLabel} ${workspace.views.length + 1}`, workspace.path, config.settings, kind);
    activePaneId = view.activePaneId;
    return { ...workspace, views: [...workspace.views, view], activeViewId: view.id, updatedAt: Date.now() };
  });
  return { config: { ...config, workspaces }, activePaneId };
}

export function closeView(config: AppConfig, workspaceId: string, viewId: string): { config: AppConfig; activePaneId: string | null } {
  let activePaneId: string | null = null;
  const workspaces = config.workspaces.map((workspace) => {
    if (workspace.id !== workspaceId || workspace.views.length <= 1) return workspace;
    const index = workspace.views.findIndex((view) => view.id === viewId);
    if (index === -1) return workspace;
    const views = workspace.views.filter((view) => view.id !== viewId);
    const activeViewId = workspace.activeViewId === viewId ? views[Math.max(0, index - 1)]?.id ?? views[0]!.id : workspace.activeViewId;
    const activeView = views.find((view) => view.id === activeViewId) ?? views[0]!;
    activePaneId = activeView.activePaneId;
    return { ...workspace, views, activeViewId, updatedAt: Date.now() };
  });
  return { config: { ...config, workspaces }, activePaneId };
}

export function selectView(config: AppConfig, workspaceId: string, viewId: string): { config: AppConfig; activePaneId: string | null } {
  let activePaneId: string | null = null;
  const workspaces = config.workspaces.map((workspace) => {
    const view = workspace.id === workspaceId ? workspace.views.find((item) => item.id === viewId) : null;
    if (!view) return workspace;
    activePaneId = view.activePaneId;
    return { ...workspace, activeViewId: view.id };
  });
  return { config: { ...config, workspaces }, activePaneId };
}

export function renameView(config: AppConfig, workspaceId: string, viewId: string, title: string): AppConfig {
  const normalized = title.trim();
  if (!normalized) return config;
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) => workspace.id !== workspaceId ? workspace : {
      ...workspace,
      views: workspace.views.map((view) => view.id === viewId ? { ...view, title: normalized } : view),
      updatedAt: Date.now()
    })
  };
}

export function paneIdsForView(config: AppConfig, workspaceId: string, viewId: string): string[] {
  const view = config.workspaces.find((workspace) => workspace.id === workspaceId)?.views.find((item) => item.id === viewId);
  return view ? collectPaneIds(view.layout) : [];
}

export function panesForView(config: AppConfig, workspaceId: string, viewId: string) {
  const view = config.workspaces.find((workspace) => workspace.id === workspaceId)?.views.find((item) => item.id === viewId);
  return view ? collectPanes(view.layout) : [];
}
