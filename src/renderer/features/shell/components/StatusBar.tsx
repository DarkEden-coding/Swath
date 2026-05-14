import type { AppSettings, LayoutNode, Workspace, WorkspaceView } from "../../../../shared/types";
import { collectPaneIds } from "../../../domain/layout/layoutTree";
import * as appActions from "../../../app/appActions";
import { useConfigStore } from "../../../state/configStore";
import { IconSettings } from "../icons";

function shellLabel(settings: AppSettings): string {
  const profile =
    settings.shellProfiles.find((item) => item.id === settings.defaultShellProfileId) ?? settings.shellProfiles[0];
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
    config.workspaces.find((item) => item.id === config.activeWorkspaceId) ?? config.workspaces[0] ?? null;
  const view: WorkspaceView | null =
    workspace?.views.find((item) => item.id === workspace.activeViewId) ?? workspace?.views[0] ?? null;
  const panes = view ? countPanes(view.layout) : 0;
  const shell = shellLabel(config.settings);

  return (
    <footer className="status-bar" role="contentinfo">
      <div className="status-bar-left">
        <span className="status-kv">
          <span className="status-key">Project</span>
          <span className="status-val">{workspace?.name ?? "—"}</span>
        </span>
        <span className="status-divider" aria-hidden />
        <span className="status-kv">
          <span className="status-key">View</span>
          <span className="status-val">{view?.title ?? "—"}</span>
        </span>
      </div>
      <div className="status-bar-right">
        <span className="status-chip">{panes} panes</span>
        <span className="status-chip mono">{shell}</span>
        <span className="status-chip status-online">
          <span className="status-dot-inline" aria-hidden />
          Connected
        </span>
        <button type="button" className="status-icon-btn" title="Settings" onClick={() => appActions.openSettings()}>
          <IconSettings width={17} height={17} strokeWidth={1.35} />
        </button>
      </div>
    </footer>
  );
}
