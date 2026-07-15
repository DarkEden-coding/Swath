import type { AppSettings, LayoutNode, Workspace, WorkspaceView } from "../../../../shared/types";
import { collectPaneIds } from "../../../domain/layout/layoutTree";
import * as appActions from "../../../app/appActions";
import { useConfigStore } from "../../../state/configStore";
import { IconSettings } from "../icons";

function shellLabel(settings: AppSettings): string {
  const profile =
    settings.shellProfiles.find((item) => item.id === settings.defaultShellProfileId) ??
    settings.shellProfiles[0];
  if (!profile) return "shell";
  const base = profile.command.split(/[/\\]/).pop() ?? profile.command;
  return base.replace(/\.exe$/i, "");
}

function countPanes(node: LayoutNode): number {
  return collectPaneIds(node).length;
}

export function StatusBar(): JSX.Element | null {
  const config = useConfigStore((state) => state.config);

  if (!config) return null;

  const workspace: Workspace | null =
    config.workspaces.find((item) => item.id === config.activeWorkspaceId) ??
    config.workspaces[0] ??
    null;
  const view: WorkspaceView | null =
    workspace?.views.find((item) => item.id === workspace.activeViewId) ??
    workspace?.views[0] ??
    null;
  const panes = view ? countPanes(view.layout) : 0;
  const shell = shellLabel(config.settings);

  return (
    <footer
      className="flex min-h-8 shrink-0 items-center justify-between gap-5 overflow-hidden border-t border-swath-border bg-swath-panel px-4 py-1.5 pl-4 text-xs text-swath-muted md:pr-5"
      role="contentinfo"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3.5 overflow-hidden">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-swath-muted-2">
            Project
          </span>
          <span className="max-w-[min(420px,52vw)] truncate font-semibold text-swath-text">
            {workspace?.name ?? "—"}
          </span>
        </span>
        <span className="h-3.5 w-px shrink-0 bg-swath-border" aria-hidden />
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-swath-muted-2">
            View
          </span>
          <span className="max-w-[min(420px,52vw)] truncate font-semibold text-swath-text">
            {view?.title ?? "—"}
          </span>
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-swath-border bg-swath-bg px-2.5 py-0.5 text-[11px] leading-tight text-swath-muted">
          {panes} panes
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-swath-border bg-swath-bg px-2.5 py-0.5 font-mono text-[11px] leading-tight text-swath-muted">
          {shell}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(63,185,80,0.35)] bg-swath-bg px-2.5 py-0.5 text-[11px] leading-tight text-swath-good">
          <span
            className="size-[7px] shrink-0 rounded-full bg-swath-good shadow-[0_0_8px_rgba(63,185,80,0.5)]"
            aria-hidden
          />
          Connected
        </span>
        <button
          type="button"
          className="grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-swath-muted-2 [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-swath-panel-2 hover:text-swath-text last-of-type:hover:text-swath-accent-strong"
          title="Settings"
          onClick={() => appActions.openSettings()}
        >
          <IconSettings width={17} height={17} strokeWidth={1.35} className="block" />
        </button>
      </div>
    </footer>
  );
}
