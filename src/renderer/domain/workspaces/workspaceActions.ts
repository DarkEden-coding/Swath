import type { AppConfig, FolderSelectResult, Workspace } from "../../../shared/types";
import { createId } from "../../utils/ids";
import { createWorkspaceView } from "../views/viewActions";
import { dissolveGroup, isGroupRoot, membersOf, reflowGroups } from "./groupActions";

export function getActiveWorkspace(config: AppConfig): Workspace | null {
  return (
    config.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId) ??
    config.workspaces[0] ??
    null
  );
}

export function getActiveWorkspaceId(config: AppConfig): string | null {
  return getActiveWorkspace(config)?.id ?? null;
}

export function getActivePaneIdForConfig(config: AppConfig): string | null {
  const workspace = getActiveWorkspace(config);
  const view =
    workspace?.views.find((item) => item.id === workspace.activeViewId) ?? workspace?.views[0];
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
    updatedAt: Date.now(),
  };
  return {
    ...config,
    workspaces: [...config.workspaces, workspace],
    activeWorkspaceId: workspace.id,
  };
}

export function removeWorkspace(config: AppConfig, workspaceId: string): AppConfig {
  // Removing a group root removes the group, not the folders that were in it.
  const target = config.workspaces.find((workspace) => workspace.id === workspaceId);
  if (isGroupRoot(target)) return dissolveGroup(config, workspaceId);

  const workspaces = config.workspaces.filter((workspace) => workspace.id !== workspaceId);
  return reflowGroups({
    ...config,
    workspaces,
    activeWorkspaceId:
      config.activeWorkspaceId === workspaceId
        ? (workspaces[0]?.id ?? null)
        : config.activeWorkspaceId,
  });
}

export function renameWorkspace(config: AppConfig, workspaceId: string, name: string): AppConfig {
  const normalized = name.trim();
  if (!normalized) return config;
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? { ...workspace, name: normalized, updatedAt: Date.now() }
        : workspace,
    ),
  };
}

export function selectWorkspace(config: AppConfig, workspaceId: string): AppConfig {
  return config.workspaces.some((workspace) => workspace.id === workspaceId)
    ? { ...config, activeWorkspaceId: workspaceId }
    : config;
}

/**
 * Reorders the sidebar.
 *
 * Sidebar rows and `config.workspaces` share one order, so indices map straight through. Two group
 * rules ride along: dragging a group header carries its members with it, and dropping a project
 * inside a group's block moves it into that group (dropping it outside every block takes it out).
 */
export function moveWorkspace(config: AppConfig, fromIndex: number, toIndex: number): AppConfig {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= config.workspaces.length ||
    toIndex >= config.workspaces.length
  )
    return config;
  const moved = config.workspaces[fromIndex];
  if (!moved) return config;

  const block = isGroupRoot(moved) ? [moved, ...membersOf(config, moved.id)] : [moved];
  const blockIds = new Set(block.map((workspace) => workspace.id));
  const rest = config.workspaces.filter((workspace) => !blockIds.has(workspace.id));

  // `toIndex` addresses the list as it was; translate it to an insertion point in `rest`.
  const insertAt = Math.min(
    rest.length,
    config.workspaces
      .slice(0, toIndex + (fromIndex < toIndex ? 1 : 0))
      .filter((workspace) => !blockIds.has(workspace.id)).length,
  );

  let placed = block;
  if (!isGroupRoot(moved)) {
    const previous = rest[insertAt - 1];
    const adoptedGroupId = isGroupRoot(previous)
      ? previous.id
      : previous?.groupId !== undefined
        ? previous.groupId
        : undefined;
    if (adoptedGroupId !== moved.groupId)
      placed = [{ ...moved, groupId: adoptedGroupId, updatedAt: Date.now() }];
  }

  const workspaces = [...rest.slice(0, insertAt), ...placed, ...rest.slice(insertAt)];
  return reflowGroups({ ...config, workspaces });
}
