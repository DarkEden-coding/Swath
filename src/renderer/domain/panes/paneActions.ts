import type { AppConfig, PaneKind, SplitDirection } from "../../../shared/types";
import { createId } from "../../utils/ids";
import { createTabTypePaneMeta } from "../../features/tabTypes/registry";
import { closePane as closePaneNode, collectPaneIds, findPane, splitPaneWithId, updateSplitRatio } from "../layout/layoutTree";

export function splitPane(config: AppConfig, workspaceId: string, viewId: string, paneId: string, direction: SplitDirection, kind?: PaneKind): { config: AppConfig; activePaneId: string | null } {
  const newPaneId = createId("pane");
  return {
    activePaneId: newPaneId,
    config: updateView(config, workspaceId, viewId, (view, workspace) => {
      const sourcePane = findPane(view.layout, paneId);
      const targetKind = kind ?? sourcePane?.kind;
      const meta = kind && kind !== sourcePane?.kind ? createTabTypePaneMeta(kind, config.settings, workspace.path) : undefined;
      return {
        ...view,
        layout: splitPaneWithId(view.layout, paneId, direction, newPaneId, targetKind, meta),
        activePaneId: newPaneId
      };
    })
  };
}

export function closePane(config: AppConfig, workspaceId: string, viewId: string, paneId: string): { config: AppConfig; activePaneId: string | null } {
  let activePaneId: string | null = null;
  const next = updateView(config, workspaceId, viewId, (view) => {
    if (collectPaneIds(view.layout).length <= 1) return view;
    const layout = closePaneNode(view.layout, paneId);
    const paneIds = collectPaneIds(layout);
    activePaneId = paneIds.includes(view.activePaneId) ? view.activePaneId : paneIds[0] ?? null;
    return { ...view, layout, activePaneId: activePaneId ?? view.activePaneId };
  });
  return { config: next, activePaneId };
}

export function setActivePane(config: AppConfig, workspaceId: string, viewId: string, paneId: string): AppConfig {
  return updateView(config, workspaceId, viewId, (view) => ({ ...view, activePaneId: paneId }));
}

export function setSplitRatio(config: AppConfig, workspaceId: string, viewId: string, splitId: string, ratio: number): AppConfig {
  return updateView(config, workspaceId, viewId, (view) => ({ ...view, layout: updateSplitRatio(view.layout, splitId, ratio) }));
}

export function renamePane(config: AppConfig, workspaceId: string, viewId: string, paneId: string, title: string): AppConfig {
  const normalized = title.trim();
  if (!normalized) return config;
  return updateView(config, workspaceId, viewId, (view) => {
    const layout = structuredClone(view.layout);
    const pane = findPane(layout, paneId);
    if (!pane) return view;
    pane.title = normalized;
    pane.metadata = { ...(pane.metadata ?? {}), title: normalized };
    pane.promptLabel = normalized;
    return { ...view, layout };
  });
}

export function setPaneInitialCwd(config: AppConfig, workspaceId: string, viewId: string, paneId: string, cwd: string): AppConfig {
  const normalized = cwd.trim();
  if (!normalized) return config;
  return updateView(config, workspaceId, viewId, (view) => {
    const layout = structuredClone(view.layout);
    const pane = findPane(layout, paneId);
    if (!pane) return view;
    pane.cwd = normalized;
    pane.metadata = { ...(pane.metadata ?? {}), cwd: normalized };
    return { ...view, layout };
  });
}

function updateView(config: AppConfig, workspaceId: string, viewId: string, updater: (view: AppConfig["workspaces"][number]["views"][number], workspace: AppConfig["workspaces"][number]) => AppConfig["workspaces"][number]["views"][number]): AppConfig {
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) => workspace.id !== workspaceId ? workspace : {
      ...workspace,
      views: workspace.views.map((view) => view.id === viewId ? updater(view, workspace) : view),
      updatedAt: Date.now()
    })
  };
}
