import type { AppConfig, FolderSelectResult, Workspace } from "../../../shared/types";
import { createId } from "../../utils/ids";
import { createWorkspaceView } from "../views/viewActions";

export function getActiveWorkspace(config: AppConfig): Workspace | null {
  return config.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId) ?? config.workspaces[0] ?? null;
}

export function getActiveWorkspaceId(config: AppConfig): string | null {
  return getActiveWorkspace(config)?.id ?? null;
}

export function getActivePaneIdForConfig(config: AppConfig): string | null {
  const workspace = getActiveWorkspace(config);
  const view = workspace?.views.find((item) => item.id === workspace.activeViewId) ?? workspace?.views[0];
  return view?.activePaneId ?? null;
}

export function addWorkspaceFromFolder(config: AppConfig, result: FolderSelectResult): AppConfig {
  if (result.canceled || !result.path) return config;
  const view = createWorkspaceView("Terminal 1", result.path, config.settings);
  const workspace: Workspace = {
    id: createId("workspace"),
    name: result.name ?? result.path,
    path: result.path,
    views: [view],
    activeViewId: view.id,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  return { ...config, workspaces: [...config.workspaces, workspace], activeWorkspaceId: workspace.id };
}

export function removeWorkspace(config: AppConfig, workspaceId: string): AppConfig {
  const workspaces = config.workspaces.filter((workspace) => workspace.id !== workspaceId);
  return {
    ...config,
    workspaces,
    activeWorkspaceId: config.activeWorkspaceId === workspaceId ? workspaces[0]?.id ?? null : config.activeWorkspaceId
  };
}

export function renameWorkspace(config: AppConfig, workspaceId: string, name: string): AppConfig {
  const normalized = name.trim();
  if (!normalized) return config;
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) =>
      workspace.id === workspaceId ? { ...workspace, name: normalized, updatedAt: Date.now() } : workspace
    )
  };
}

export function selectWorkspace(config: AppConfig, workspaceId: string): AppConfig {
  return config.workspaces.some((workspace) => workspace.id === workspaceId)
    ? { ...config, activeWorkspaceId: workspaceId }
    : config;
}

export function moveWorkspace(config: AppConfig, fromIndex: number, toIndex: number): AppConfig {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= config.workspaces.length || toIndex >= config.workspaces.length) return config;
  const workspaces = [...config.workspaces];
  const [workspace] = workspaces.splice(fromIndex, 1);
  if (!workspace) return config;
  workspaces.splice(toIndex, 0, workspace);
  return { ...config, workspaces };
}
