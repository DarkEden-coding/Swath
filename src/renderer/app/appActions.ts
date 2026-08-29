import type {
  AppConfig,
  AppSettings,
  PaneKind,
  ShellProfile,
  SplitDirection,
} from "../../shared/types";
import { collectPanes, findPane } from "../domain/layout/layoutTree";
import * as paneActions from "../domain/panes/paneActions";
import * as settingsActions from "../domain/settings/settingsActions";
import * as viewActions from "../domain/views/viewActions";
import * as groupActions from "../domain/workspaces/groupActions";
import * as workspaceActions from "../domain/workspaces/workspaceActions";
import { configClient } from "../services/configClient";
import { dialogClient } from "../services/dialogClient";
import { useConfigStore } from "../state/configStore";
import { useUiStore } from "../state/uiStore";
import { getTabType } from "../features/tabTypes/registry";
import {
  createPiAgentView,
  type PiAgentStartOptions,
} from "../features/tabTypes/piAgent/piAgentTabType";
import { prewarmPiAgent } from "../features/tabTypes/piAgent/usePiAgent";
import { reportError } from "../lib/errorLog";

/** Commits configuration state and schedules persistence. */
function commit(config: AppConfig, activePaneId?: string | null): void {
  useConfigStore.getState().setConfig(config);
  if (activePaneId !== undefined) useUiStore.getState().setActivePaneId(activePaneId);
  void configClient.save(config);
}

/** Applies a mutation to a cloned current configuration. */
function withConfig(
  mutator: (config: AppConfig) => { config: AppConfig; activePaneId?: string | null } | AppConfig,
): void {
  const current = useConfigStore.getState().config;
  if (!current) return;
  const result = mutator(structuredClone(current));
  if ("config" in result) commit(result.config, result.activePaneId);
  else commit(result);
}

/** Collects all panes belonging to a workspace. */
function panesForWorkspace(
  config: AppConfig,
  workspaceId: string,
): ReturnType<typeof collectPanes> {
  const workspace = config.workspaces.find((item) => item.id === workspaceId);
  return workspace?.views.flatMap((view) => collectPanes(view.layout)) ?? [];
}

/**
 * Checks whether any registered pane is busy.
 *
 * A pane whose kind is no longer registered counts as idle: it owns nothing that could be running,
 * and a failed lookup here must never stop a close.
 */
async function anyBusyRegisteredPane(
  panes: ReturnType<typeof viewActions.panesForView>,
): Promise<boolean> {
  const statuses = await Promise.all(
    panes.map((pane) => isPaneBusy(pane.kind, pane.id).catch(() => false)),
  );
  return statuses.some(Boolean);
}

async function isPaneBusy(kind: PaneKind, paneId: string): Promise<boolean> {
  return (await getTabType(kind)?.isBusy?.(paneId)) ?? false;
}

/**
 * Notifies registered tab types that panes are closing.
 *
 * Teardown is best effort per pane: one tab type that throws (or one kind that no longer exists)
 * must not abort the close, or the pane stays on screen and its close button appears dead.
 */
function closeRegisteredPanes(panes: ReturnType<typeof viewActions.panesForView>): void {
  panes.forEach((pane) => {
    try {
      getTabType(pane.kind)?.closePane?.(pane.id);
    } catch (error) {
      reportError(`Closing pane "${pane.title ?? pane.kind}"`, error);
    }
  });
}

/** Hydrates configuration and restores the active pane. */
export async function hydrateApp(): Promise<void> {
  const config = await useConfigStore.getState().hydrate();
  useUiStore.getState().setActivePaneId(workspaceActions.getActivePaneIdForConfig(config));
}

/** Persists the current application configuration. */
export async function persistAppConfig(): Promise<void> {
  await useConfigStore.getState().save();
}

/** Updates the sidebar search query. */
export function setSidebarQuery(query: string): void {
  useUiStore.getState().setSidebarQuery(query);
}

/** Opens the settings interface. */
export function openSettings(): void {
  useUiStore.getState().openSettings();
}

/** Closes the settings interface. */
export function closeSettings(): void {
  useUiStore.getState().closeSettings();
}

/** Prompts for a folder and adds it as a workspace. */
export async function addWorkspaceFromFolder(): Promise<void> {
  const result = await dialogClient.selectFolder();
  withConfig((config) => {
    const next = workspaceActions.addWorkspaceFromFolder(config, result);
    return { config: next, activePaneId: workspaceActions.getActivePaneIdForConfig(next) };
  });
}

/**
 * Commits a workspace mutation, tearing down the panes of every workspace it removed.
 *
 * Dissolving a group deletes its root, and the root owns real running panes (pi children), so the
 * teardown cannot be attached to the explicit remove path alone.
 */
function commitDroppingWorkspaces(config: AppConfig, next: AppConfig): void {
  const survivors = new Set(next.workspaces.map((workspace) => workspace.id));
  const dropped = config.workspaces.filter((workspace) => !survivors.has(workspace.id));
  dropped.forEach((workspace) => closeRegisteredPanes(panesForWorkspace(config, workspace.id)));
  commit(next, workspaceActions.getActivePaneIdForConfig(next));
}

/** Confirms and removes a workspace and its panes. */
export async function removeWorkspace(workspaceId: string): Promise<void> {
  const config = useConfigStore.getState().config;
  if (!config) return;
  const workspace = config.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return;
  const panes = panesForWorkspace(config, workspaceId);
  if (panes.length > 0) {
    const confirmed = await dialogClient.confirm({
      message: groupActions.isGroupRoot(workspace) ? "Remove this group?" : "Remove this project?",
      detail: groupActions.isGroupRoot(workspace)
        ? `This removes the group “${workspace.name}” and closes its shared agents. Its projects stay in Swath.`
        : `This removes “${workspace.name}” from Swath and closes its panes. Files on disk are not deleted.`,
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
  }
  commitDroppingWorkspaces(config, workspaceActions.removeWorkspace(config, workspaceId));
}

/** Confirms a group mutation that would close shared agents, then applies it. */
async function applyGroupChange(mutate: (config: AppConfig) => AppConfig): Promise<void> {
  const config = useConfigStore.getState().config;
  if (!config) return;
  const next = mutate(config);
  if (next === config) return;

  const survivors = new Set(next.workspaces.map((workspace) => workspace.id));
  const losing = config.workspaces.filter(
    (workspace) =>
      !survivors.has(workspace.id) && panesForWorkspace(config, workspace.id).length > 0,
  );
  if (losing.length > 0) {
    const confirmed = await dialogClient.confirm({
      message: "Break up this group?",
      detail: `A group needs at least two projects, so “${losing[0]!.name}” and its shared agents close. The projects themselves stay in Swath.`,
      confirmLabel: "Break up",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
  }
  commitDroppingWorkspaces(config, next);
}

/** Groups two projects into a new group, and opens its shared agents surface. */
export function createGroupWith(workspaceId: string, otherWorkspaceId: string): void {
  withConfig((config) => {
    const result = groupActions.createGroup(config, [workspaceId, otherWorkspaceId]);
    if (!result.rootId) return config;
    const next = { ...result.config, activeWorkspaceId: result.rootId };
    return { config: next, activePaneId: workspaceActions.getActivePaneIdForConfig(next) };
  });
}

/** Moves a project into an existing group. */
export function addWorkspaceToGroup(workspaceId: string, rootId: string): void {
  withConfig((config) => groupActions.addToGroup(config, workspaceId, rootId));
}

/** Takes a project back out of its group. */
export function ungroupWorkspace(workspaceId: string): void {
  void applyGroupChange((config) => groupActions.detachFromGroup(config, workspaceId)).catch(
    (error: unknown) => reportError("Ungrouping project", error),
  );
}

/** Shows or hides a group's members in the sidebar. */
export function setGroupCollapsed(rootId: string, collapsed: boolean): void {
  withConfig((config) => groupActions.setGroupCollapsed(config, rootId, collapsed));
}

/** Renames a workspace. */
export function renameWorkspace(workspaceId: string, name: string): void {
  withConfig((config) => workspaceActions.renameWorkspace(config, workspaceId, name));
}

/** Selects a workspace and its active pane. */
export function selectWorkspace(workspaceId: string): void {
  withConfig((config) => {
    const next = workspaceActions.selectWorkspace(config, workspaceId);
    return { config: next, activePaneId: workspaceActions.getActivePaneIdForConfig(next) };
  });
}

/** Moves a workspace between list positions. */
export function moveWorkspace(fromIndex: number, toIndex: number): void {
  withConfig((config) => workspaceActions.moveWorkspace(config, fromIndex, toIndex));
}

/** Creates a view in a workspace. */
export function createView(workspaceId?: string, kind: PaneKind = "terminal"): void {
  withConfig((config) => viewActions.addView(config, workspaceId, kind));
}

/** Adds an independent Pi agent tab without taking focus from its caller. */
export function createPiAgentTab(
  workspaceId: string,
  title: string,
  start: PiAgentStartOptions,
): void {
  let launch: { paneId: string; cwd: string; groupPaths: string[] } | undefined;
  withConfig((config) => ({
    ...config,
    workspaces: config.workspaces.map((workspace) => {
      if (workspace.id !== workspaceId) return workspace;
      const view = createPiAgentView(title, workspace.path, config.settings, start);
      launch = {
        paneId: view.activePaneId,
        cwd: workspace.path,
        groupPaths: groupActions.groupPathsFor(config, workspaceId),
      };
      return {
        ...workspace,
        views: [...workspace.views, view],
        updatedAt: Date.now(),
      };
    }),
  }));
  if (!launch) return;
  prewarmPiAgent(launch.paneId, launch.cwd, launch.groupPaths, {
    task: start.prompt,
    title: start.title,
    model: start.model,
    reasoningLevel: start.thinkingLevel,
  });
}

/** Closes a view after any required confirmation. */
export function closeView(workspaceId: string, viewId: string): void {
  void (async () => {
    const config = useConfigStore.getState().config;
    if (!config) return;
    const panes = viewActions.panesForView(config, workspaceId, viewId);
    if (
      config.settings.confirmBeforeClosingPane &&
      panes.length > 0 &&
      (await anyBusyRegisteredPane(panes)) &&
      !window.confirm("Close this view and close its running panes?")
    )
      return;
    closeRegisteredPanes(panes);
    const result = viewActions.closeView(config, workspaceId, viewId);
    commit(result.config, result.activePaneId);
  })().catch((error: unknown) => reportError("Closing tab", error));
}

/** Selects a workspace view. */
export function selectView(workspaceId: string, viewId: string): void {
  withConfig((config) => viewActions.selectView(config, workspaceId, viewId));
}

/** Renames a workspace view. */
export function renameView(workspaceId: string, viewId: string, title: string): void {
  withConfig((config) => viewActions.renameView(config, workspaceId, viewId, title));
}

/** Moves a view between list positions. */
export function moveView(workspaceId: string, fromIndex: number, toIndex: number): void {
  withConfig((config) => viewActions.moveView(config, workspaceId, fromIndex, toIndex));
}

/** Splits a pane and generates an identifier for the new pane. */
export function splitPane(
  workspaceId: string,
  viewId: string,
  paneId: string,
  direction: SplitDirection,
  kind?: PaneKind,
): void {
  withConfig((config) =>
    paneActions.splitPane(config, workspaceId, viewId, paneId, direction, kind),
  );
}

/** Removes a pane while preserving a valid layout root. */
export function closePane(workspaceId: string, viewId: string, paneId: string): void {
  void (async () => {
    const config = useConfigStore.getState().config;
    if (!config) return;
    const view = config.workspaces
      .find((workspace) => workspace.id === workspaceId)
      ?.views.find((item) => item.id === viewId);
    const pane = view ? findPane(view.layout, paneId) : null;
    if (!pane) return;
    if (
      config.settings.confirmBeforeClosingPane &&
      (await isPaneBusy(pane.kind, paneId).catch(() => false)) &&
      !window.confirm("Close this running pane?")
    )
      return;
    closeRegisteredPanes([pane]);
    const result = paneActions.closePane(config, workspaceId, viewId, paneId);
    commit(result.config, result.activePaneId);
  })().catch((error: unknown) => reportError("Closing pane", error));
}

/** Sets the active pane for a view. */
export function setActivePane(workspaceId: string, viewId: string, paneId: string): void {
  withConfig((config) => ({
    config: paneActions.setActivePane(config, workspaceId, viewId, paneId),
    activePaneId: paneId,
  }));
}

/** Updates a split ratio in a view. */
export function setSplitRatio(
  workspaceId: string,
  viewId: string,
  splitId: string,
  ratio: number,
): void {
  withConfig((config) => paneActions.setSplitRatio(config, workspaceId, viewId, splitId, ratio));
}

/** Updates a split ratio in memory only, for drag previews that persist on release. */
export function previewSplitRatio(
  workspaceId: string,
  viewId: string,
  splitId: string,
  ratio: number,
): void {
  const current = useConfigStore.getState().config;
  if (!current) return;
  useConfigStore
    .getState()
    .setConfig(
      paneActions.setSplitRatio(structuredClone(current), workspaceId, viewId, splitId, ratio),
    );
}

/** Renames a pane. */
export function renamePane(
  workspaceId: string,
  viewId: string,
  paneId: string,
  title: string,
): void {
  withConfig((config) => paneActions.renamePane(config, workspaceId, viewId, paneId, title));
}

/** Sets a pane’s initial working directory. */
export function setPaneInitialCwd(
  workspaceId: string,
  viewId: string,
  paneId: string,
  cwd: string,
): void {
  withConfig((config) => paneActions.setPaneInitialCwd(config, workspaceId, viewId, paneId, cwd));
}

/** Records the Pi session file that a pane should reopen. */
export function setPanePiSessionFile(
  workspaceId: string,
  viewId: string,
  paneId: string,
  sessionFile: string,
): void {
  withConfig((config) =>
    paneActions.setPanePiSessionFile(config, workspaceId, viewId, paneId, sessionFile),
  );
}

/** Determines whether pane closure requires confirmation. */
export function shouldConfirmClosePane(workspaceId: string, viewId: string): boolean {
  const config = useConfigStore.getState().config;
  const paneIds = config ? viewActions.paneIdsForView(config, workspaceId, viewId) : [];
  return Boolean(config?.settings.confirmBeforeClosingPane && paneIds.length > 1);
}

/** Updates application settings. */
export function updateSettings(settings: Partial<AppSettings>): void {
  withConfig((config) => settingsActions.updateSettings(config, settings));
}

/** Adds a shell profile. */
export function addShellProfile(profile: Omit<ShellProfile, "id">): void {
  withConfig((config) => settingsActions.addShellProfile(config, profile));
}

/** Removes a shell profile. */
export function removeShellProfile(profileId: string): void {
  withConfig((config) => settingsActions.removeShellProfile(config, profileId));
}
