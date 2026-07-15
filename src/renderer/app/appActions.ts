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
import * as workspaceActions from "../domain/workspaces/workspaceActions";
import { configClient } from "../services/configClient";
import { dialogClient } from "../services/dialogClient";
import { useConfigStore } from "../state/configStore";
import { useUiStore } from "../state/uiStore";
import { getTabType } from "../features/tabTypes/registry";

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

/** Checks whether any registered pane is busy. */
async function anyBusyRegisteredPane(
  panes: ReturnType<typeof viewActions.panesForView>,
): Promise<boolean> {
  const statuses = await Promise.all(
    panes.map((pane) => getTabType(pane.kind).isBusy?.(pane.id) ?? Promise.resolve(false)),
  );
  return statuses.some(Boolean);
}

/** Notifies registered tab types that panes are closing. */
function closeRegisteredPanes(panes: ReturnType<typeof viewActions.panesForView>): void {
  panes.forEach((pane) => getTabType(pane.kind).closePane?.(pane.id));
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

/** Confirms and removes a workspace and its panes. */
export async function removeWorkspace(workspaceId: string): Promise<void> {
  const config = useConfigStore.getState().config;
  if (!config) return;
  const workspace = config.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return;
  const panes = panesForWorkspace(config, workspaceId);
  if (panes.length > 0) {
    const confirmed = await dialogClient.confirm({
      message: "Remove this project?",
      detail: `This removes “${workspace.name}” from Swath and closes its panes. Files on disk are not deleted.`,
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
  }
  closeRegisteredPanes(panes);
  const next = workspaceActions.removeWorkspace(config, workspaceId);
  commit(next, workspaceActions.getActivePaneIdForConfig(next));
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
  })();
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
    const tabType = getTabType(pane.kind);
    if (
      config.settings.confirmBeforeClosingPane &&
      (await tabType.isBusy?.(paneId)) &&
      !window.confirm("Close this running pane?")
    )
      return;
    tabType.closePane?.(paneId);
    const result = paneActions.closePane(config, workspaceId, viewId, paneId);
    commit(result.config, result.activePaneId);
  })();
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
