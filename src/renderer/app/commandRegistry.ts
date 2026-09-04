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
  | "terminal:paste"
  | "settings:open";

export interface CommandContext {
  activeWorkspace: Workspace | null;
  activeView: WorkspaceView | null;
  activePaneId: string | null;
  addWorkspaceFromFolder: () => void | Promise<void>;
  createView: (workspaceId?: string) => void;
  closeView: (workspaceId: string, viewId: string) => void;
  splitPane: (
    workspaceId: string,
    viewId: string,
    paneId: string,
    direction: SplitDirection,
  ) => void;
  closePane: (workspaceId: string, viewId: string, paneId: string) => void;
  openSettings: () => void;
}

/** Maps a shortcut to an app command. macOS keeps native menu accelerators. */
export function commandFromKeyboardEvent(
  event: KeyboardEvent,
  platform: string,
): AppCommand | null {
  const modifier = event.metaKey || event.ctrlKey;
  if (!modifier || event.altKey) return null;
  if (event.key === ",") return "settings:open";
  if (platform === "darwin") return null;

  const key = event.key.toLowerCase();
  if (key === "o" && event.shiftKey) return "workspace:add";
  if (key === "t" && !event.shiftKey) return "view:new";
  if (key === "w") return event.shiftKey ? "pane:close" : "view:close";
  if (event.code === "Backslash") return event.shiftKey ? "pane:split-down" : "pane:split-right";
  return null;
}

export function runAppCommand(command: string, context: CommandContext): void {
  const workspace = context.activeWorkspace;
  const view = context.activeView;
  if (command === "terminal:paste") {
    if (pasteIntoFocusedField()) return;
    window.dispatchEvent(new Event("swath:terminal-paste"));
  }
  if (command === "workspace:add") void context.addWorkspaceFromFolder();
  if (command === "view:new" || command === "tab:new") context.createView();
  if ((command === "view:close" || command === "tab:close") && workspace && view)
    context.closeView(workspace.id, view.id);
  runPaneCommand(command, context, workspace, view);
  if (command === "settings:open") context.openSettings();
}

/** Native macOS menu accelerators bypass the WebView's ordinary paste command. */
function pasteIntoFocusedField(): boolean {
  const target = document.activeElement;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false;
  if (target.classList.contains("xterm-helper-textarea")) return false;
  if (target.disabled || target.readOnly) return false;
  void window.swath.clipboard.readForTerminal().then(({ text }) => {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const next = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
    const prototype =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, next);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.setSelectionRange(start + text.length, start + text.length);
  });
  return true;
}

function runPaneCommand(
  command: string,
  context: CommandContext,
  workspace: Workspace | null,
  view: WorkspaceView | null,
): void {
  if (!workspace || !view || !context.activePaneId) return;
  if (command === "pane:split-right")
    context.splitPane(workspace.id, view.id, context.activePaneId, "vertical");
  if (command === "pane:split-down")
    context.splitPane(workspace.id, view.id, context.activePaneId, "horizontal");
  if (command === "pane:close") context.closePane(workspace.id, view.id, context.activePaneId);
}
