import type { SplitDirection, Workspace, WorkspaceView } from "../../shared/types";

export type AppCommand =
  | "workspace:add"
  | "view:new"
  | "view:close"
  | "tab:new"
  | "tab:close"
  | "pane:split-right"
  | "pane:split-down"
  | "pane:close"
  | "settings:open";

export interface CommandContext {
  activeWorkspace: Workspace | null;
  activeView: WorkspaceView | null;
  activePaneId: string | null;
  addWorkspaceFromFolder: () => void | Promise<void>;
  addTab: (workspaceId?: string) => void;
  closeTab: (workspaceId: string, viewId: string) => void;
  splitPane: (workspaceId: string, viewId: string, paneId: string, direction: SplitDirection) => void;
  closePane: (workspaceId: string, viewId: string, paneId: string) => void;
  openSettings: () => void;
}

export function runAppCommand(command: string, context: CommandContext): void {
  const workspace = context.activeWorkspace;
  const view = context.activeView;
  if (command === "workspace:add") void context.addWorkspaceFromFolder();
  if (command === "view:new" || command === "tab:new") context.addTab();
  if ((command === "view:close" || command === "tab:close") && workspace && view) context.closeTab(workspace.id, view.id);
  runPaneCommand(command, context, workspace, view);
  if (command === "settings:open") context.openSettings();
}

function runPaneCommand(command: string, context: CommandContext, workspace: Workspace | null, view: WorkspaceView | null): void {
  if (!workspace || !view || !context.activePaneId) return;
  if (command === "pane:split-right") context.splitPane(workspace.id, view.id, context.activePaneId, "vertical");
  if (command === "pane:split-down") context.splitPane(workspace.id, view.id, context.activePaneId, "horizontal");
  if (command === "pane:close") context.closePane(workspace.id, view.id, context.activePaneId);
}
