import type { LayoutNode } from "./panes";

export type ViewHealth = "healthy" | "warning" | "idle";
export type TabHealth = ViewHealth;

export interface WorkspaceView {
  id: string;
  type?: "workspace-view" | "terminal";
  title: string;
  layout: LayoutNode;
  activePaneId: string;
  health?: ViewHealth;
}

// Backward-compatible alias while UI naming is migrated.
export type TerminalTab = WorkspaceView;

export interface Workspace {
  id: string;
  name: string;
  path: string;
  /** True when the stored folder path is currently unavailable. */
  isMissing?: boolean;
  views: WorkspaceView[];
  activeViewId: string;
  createdAt: number;
  updatedAt: number;
  /** @deprecated use views */
  tabs?: WorkspaceView[];
  /** @deprecated use activeTabId */
  activeTabId?: string;
}
