import type { AppConfig, AppSettings, ShellProfile, WorkspaceView } from "../../../shared/types";
import { createId } from "../../utils/ids";
import { collectPaneIds, createPaneNode } from "../layout/layoutTree";

function shellFor(settings: AppSettings): ShellProfile | null {
  return settings.shellProfiles.find((profile) => profile.id === settings.defaultShellProfileId) ?? settings.shellProfiles[0] ?? null;
}

export function paneMeta(settings: AppSettings, cwd?: string) {
  const shellProfile = shellFor(settings);
  return { cwd, shellProfile, env: { ...(settings.globalEnv ?? {}) }, metadata: { cwd, shellProfileId: shellProfile?.id, shellProfile, env: { ...(settings.globalEnv ?? {}) } } };
}

export function createWorkspaceView(title = "Terminal", cwd?: string, settings?: AppSettings): WorkspaceView {
  const pane = createPaneNode(undefined, settings ? paneMeta(settings, cwd) : {});
  return { id: createId("view"), type: "workspace-view", title, layout: pane, activePaneId: pane.id };
}

export function addView(config: AppConfig, workspaceId?: string): { config: AppConfig; activePaneId: string | null } {
  let activePaneId: string | null = null;
  const targetWorkspaceId = workspaceId ?? config.activeWorkspaceId ?? config.workspaces[0]?.id;
  if (!targetWorkspaceId) return { config, activePaneId };
  const workspaces = config.workspaces.map((workspace) => {
    if (workspace.id !== targetWorkspaceId) return workspace;
    const view = createWorkspaceView(`Terminal ${workspace.views.length + 1}`, workspace.path, config.settings);
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
