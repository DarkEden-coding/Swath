/**
 * Project groups: several folders that belong to one logical project.
 *
 * A group is not a parallel entity to a workspace — its root *is* a workspace. The root owns the
 * group's shared views (the agents surface) and its members keep their own views untouched, so
 * every view, pane and tab operation keyed by workspace id keeps working with no special case.
 *
 * The flat `config.workspaces` order stays authoritative for the sidebar: a root is always
 * immediately followed by its members, which `reflowGroups` restores after any mutation.
 */

import type { AppConfig, Workspace } from "../../../shared/types";
import { createId } from "../../utils/ids";
import { createWorkspaceView } from "../views/viewActions";

/** Views a group root opens with, and the only kinds its tab bar offers. */
export const GROUP_VIEW_KINDS = ["piAgent"] as const;

/** Read-only helpers only need the project list, not a whole configuration. */
type WorkspaceList = Pick<AppConfig, "workspaces">;

export function isGroupRoot(workspace: Workspace | null | undefined): boolean {
  return workspace?.isGroupRoot === true;
}

export function findWorkspace(config: WorkspaceList, workspaceId: string): Workspace | null {
  return config.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

/** Members of a group, in sidebar order. Excludes the root itself. */
export function membersOf(config: WorkspaceList, rootId: string): Workspace[] {
  return config.workspaces.filter(
    (workspace) => !isGroupRoot(workspace) && workspace.groupId === rootId,
  );
}

/** The group root a workspace belongs to, whether it is the root or a member. */
export function groupRootOf(config: WorkspaceList, workspaceId: string): Workspace | null {
  const workspace = findWorkspace(config, workspaceId);
  if (!workspace) return null;
  if (isGroupRoot(workspace)) return workspace;
  return workspace.groupId ? findWorkspace(config, workspace.groupId) : null;
}

/**
 * Every folder an agent on this workspace should be able to reach.
 *
 * A member project stays single-folder on purpose: only the group's shared surface spans them.
 */
export function groupPathsFor(config: WorkspaceList, workspaceId: string): string[] {
  const workspace = findWorkspace(config, workspaceId);
  if (!isGroupRoot(workspace)) return [];
  return membersOf(config, workspaceId).map((member) => member.path);
}

/** Groups whose root a workspace could join, for the "Group with…" menu. */
export function groupableTargets(config: WorkspaceList, workspaceId: string): Workspace[] {
  const workspace = findWorkspace(config, workspaceId);
  if (!workspace || isGroupRoot(workspace)) return [];
  return config.workspaces.filter(
    (candidate) => isGroupRoot(candidate) && candidate.id !== workspace.groupId,
  );
}

/** Projects a workspace could be paired with into a brand new group. */
export function pairableProjects(config: WorkspaceList, workspaceId: string): Workspace[] {
  return config.workspaces.filter(
    (candidate) =>
      !isGroupRoot(candidate) && candidate.id !== workspaceId && candidate.groupId === undefined,
  );
}

function defaultGroupName(members: Workspace[]): string {
  const names = members.slice(0, 2).map((member) => member.name);
  const suffix = members.length > 2 ? ` +${members.length - 2}` : "";
  return names.length > 0 ? `${names.join(" + ")}${suffix}` : "Group";
}

/**
 * Restores the invariants the sidebar and the drag reorder both rely on:
 * roots directly followed by their members, no orphaned membership, root path tracking the
 * primary member, and no group left too small to mean anything.
 */
export function reflowGroups(config: AppConfig): AppConfig {
  const roots = new Set(
    config.workspaces.filter((workspace) => isGroupRoot(workspace)).map((root) => root.id),
  );

  // Membership pointing at something that is no longer a group root is dropped.
  let workspaces = config.workspaces.map((workspace) =>
    !isGroupRoot(workspace) && workspace.groupId !== undefined && !roots.has(workspace.groupId)
      ? { ...workspace, groupId: undefined }
      : workspace,
  );

  // A group needs at least two folders to be a group; below that it dissolves into plain projects.
  const doomed = new Set(
    [...roots].filter(
      (rootId) =>
        workspaces.filter((workspace) => !isGroupRoot(workspace) && workspace.groupId === rootId)
          .length < 2,
    ),
  );
  if (doomed.size > 0) {
    workspaces = workspaces
      .filter((workspace) => !doomed.has(workspace.id))
      .map((workspace) =>
        workspace.groupId !== undefined && doomed.has(workspace.groupId)
          ? { ...workspace, groupId: undefined }
          : workspace,
      );
  }

  // Rebuild the flat order as contiguous blocks, preserving the order roots and loose projects
  // already have.
  const ordered: Workspace[] = [];
  const emitted = new Set<string>();
  for (const workspace of workspaces) {
    if (emitted.has(workspace.id)) continue;
    if (isGroupRoot(workspace)) {
      const members = workspaces.filter(
        (item) => !isGroupRoot(item) && item.groupId === workspace.id,
      );
      // The root borrows the primary member's folder so its agents start somewhere real.
      const primary = members[0];
      ordered.push(
        primary && primary.path !== workspace.path
          ? { ...workspace, path: primary.path }
          : workspace,
      );
      emitted.add(workspace.id);
      for (const member of members) {
        ordered.push(member);
        emitted.add(member.id);
      }
      continue;
    }
    if (workspace.groupId !== undefined) continue; // emitted with its root
    ordered.push(workspace);
    emitted.add(workspace.id);
  }
  // Members whose root sorts after them are emitted by the root pass above; anything still
  // missing (a cycle-free impossibility, but cheap to guard) is appended verbatim.
  for (const workspace of workspaces) {
    if (!emitted.has(workspace.id)) ordered.push(workspace);
  }

  const activeWorkspaceId = ordered.some((workspace) => workspace.id === config.activeWorkspaceId)
    ? config.activeWorkspaceId
    : (ordered[0]?.id ?? null);

  return { ...config, workspaces: ordered, activeWorkspaceId };
}

/** Creates a group root owning a shared agents view, and moves the members into it. */
export function createGroup(
  config: AppConfig,
  memberIds: string[],
  name?: string,
): { config: AppConfig; rootId: string | null } {
  const members = memberIds
    .map((id) => findWorkspace(config, id))
    .filter((workspace): workspace is Workspace => workspace !== null && !isGroupRoot(workspace));
  if (members.length < 2) return { config, rootId: null };

  const rootId = createId("workspace");
  const view = createWorkspaceView("Agent 1", members[0]!.path, config.settings, "piAgent");
  const root: Workspace = {
    id: rootId,
    name: name?.trim() || defaultGroupName(members),
    path: members[0]!.path,
    isGroupRoot: true,
    views: [view],
    activeViewId: view.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const memberIdSet = new Set(members.map((member) => member.id));
  const firstIndex = config.workspaces.findIndex((workspace) => memberIdSet.has(workspace.id));
  const workspaces = config.workspaces.map((workspace) =>
    memberIdSet.has(workspace.id) ? { ...workspace, groupId: rootId } : workspace,
  );
  workspaces.splice(Math.max(0, firstIndex), 0, root);

  return { config: reflowGroups({ ...config, workspaces }), rootId };
}

/** Moves a project into an existing group. */
export function addToGroup(config: AppConfig, workspaceId: string, rootId: string): AppConfig {
  const workspace = findWorkspace(config, workspaceId);
  const root = findWorkspace(config, rootId);
  if (!workspace || isGroupRoot(workspace) || !isGroupRoot(root)) return config;
  return reflowGroups({
    ...config,
    workspaces: config.workspaces.map((item) =>
      item.id === workspaceId ? { ...item, groupId: rootId, updatedAt: Date.now() } : item,
    ),
  });
}

/** Detaches one project; `reflowGroups` dissolves the group if too little is left of it. */
export function detachFromGroup(config: AppConfig, workspaceId: string): AppConfig {
  const workspace = findWorkspace(config, workspaceId);
  if (!workspace || workspace.groupId === undefined) return config;
  return reflowGroups({
    ...config,
    workspaces: config.workspaces.map((item) =>
      item.id === workspaceId ? { ...item, groupId: undefined, updatedAt: Date.now() } : item,
    ),
  });
}

/** Dissolves a whole group, keeping its members as plain projects. */
export function dissolveGroup(config: AppConfig, rootId: string): AppConfig {
  if (!isGroupRoot(findWorkspace(config, rootId))) return config;
  return reflowGroups({
    ...config,
    workspaces: config.workspaces
      .filter((workspace) => workspace.id !== rootId)
      .map((workspace) =>
        workspace.groupId === rootId ? { ...workspace, groupId: undefined } : workspace,
      ),
  });
}

export function setGroupCollapsed(
  config: AppConfig,
  rootId: string,
  collapsed: boolean,
): AppConfig {
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) =>
      workspace.id === rootId && isGroupRoot(workspace)
        ? { ...workspace, groupCollapsed: collapsed }
        : workspace,
    ),
  };
}
