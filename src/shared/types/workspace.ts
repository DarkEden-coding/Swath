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
  /** Connection that owns this project. Missing means this machine. */
  remoteConnectionId?: string;
  /** True when the stored folder path is currently unavailable. */
  isMissing?: boolean;
  /**
   * Id of the group root workspace this project belongs to.
   *
   * A group is not a separate entity: its root *is* a workspace, so every view, pane and tab
   * operation keyed by workspace id works on the group's shared surface unchanged.
   */
  groupId?: string;
  /** True when this workspace is a group's shared surface rather than a project folder. */
  isGroupRoot?: boolean;
  /** Group root only: hides the member rows in the sidebar. */
  groupCollapsed?: boolean;
  views: WorkspaceView[];
  activeViewId: string;
  createdAt: number;
  updatedAt: number;
  /** @deprecated use views */
  tabs?: WorkspaceView[];
  /** @deprecated use activeTabId */
  activeTabId?: string;
}
