/**
 * Repairs a persisted configuration against what this build actually supports.
 *
 * Config outlives code: a tab type removed by an update stays in every stored layout that used it,
 * and every lookup keyed by pane kind then resolves to nothing. Before the update that removed the
 * image preview panes, one such tab was enough to crash the whole window on start and to make its
 * close button throw, so the tab could not even be removed. Panes of unknown kind are dropped here,
 * on load, so the rest of the app only ever sees kinds it can render.
 */

import type { AppConfig, LayoutNode, Workspace, WorkspaceView } from "../../../shared/types";
import { isPaneKind } from "../../../shared/types";
import { collectPaneIds } from "../layout/layoutTree";

export interface SanitizeConfigResult {
  config: AppConfig;
  /** True when anything was dropped or repaired, i.e. the result is worth persisting. */
  changed: boolean;
  /** Unsupported pane kinds that were removed, for the diagnostics log. */
  removedKinds: string[];
}

/** Drops panes of unsupported kind, collapsing splits that lose a side. */
function pruneLayout(node: LayoutNode, removed: string[]): LayoutNode | null {
  if (node.type === "pane") {
    if (isPaneKind(node.kind)) return node;
    removed.push(String(node.kind));
    return null;
  }

  const first = pruneLayout(node.first, removed);
  const second = pruneLayout(node.second, removed);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

/** Repairs a view, returning null when nothing renderable is left in it. */
function sanitizeView(view: WorkspaceView, removed: string[]): WorkspaceView | null {
  const layout = pruneLayout(view.layout, removed);
  if (!layout) return null;

  const paneIds = collectPaneIds(layout);
  const activePaneId = paneIds.includes(view.activePaneId) ? view.activePaneId : paneIds[0]!;
  if (layout === view.layout && activePaneId === view.activePaneId) return view;
  return { ...view, layout, activePaneId };
}

function sanitizeWorkspace(workspace: Workspace, removed: string[]): Workspace {
  const views = workspace.views
    .map((view) => sanitizeView(view, removed))
    .filter((view): view is WorkspaceView => view !== null);

  const unchanged =
    views.length === workspace.views.length &&
    views.every((view, index) => view === workspace.views[index]);

  const activeViewId = views.some((view) => view.id === workspace.activeViewId)
    ? workspace.activeViewId
    : (views[0]?.id ?? "");

  if (unchanged && activeViewId === workspace.activeViewId) return workspace;
  return { ...workspace, views, activeViewId };
}

/** Returns a configuration containing only pane kinds this build can render. */
export function sanitizeConfig(config: AppConfig): SanitizeConfigResult {
  const removedKinds: string[] = [];
  const workspaces = config.workspaces.map((workspace) =>
    sanitizeWorkspace(workspace, removedKinds),
  );
  const changed = workspaces.some((workspace, index) => workspace !== config.workspaces[index]);
  if (!changed) return { config, changed: false, removedKinds: [] };
  return {
    config: { ...config, workspaces },
    changed: true,
    removedKinds: [...new Set(removedKinds)],
  };
}
