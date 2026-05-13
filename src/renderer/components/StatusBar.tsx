import type { AppSettings, LayoutNode, TerminalTab, Workspace } from "../../main/sharedTypes";
import { collectPaneIds } from "../utils/layout";
import { useAppStore } from "../state/appStore";
import { IconSettings } from "./icons";

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
  const config = useAppStore((state) => state.config);
  const openSettings = useAppStore((state) => state.openSettings);

  if (!config) return null;

  const workspace: Workspace | null =
    config.workspaces.find((item) => item.id === config.activeWorkspaceId) ?? config.workspaces[0] ?? null;
  const tab: TerminalTab | null =
    workspace?.tabs.find((item) => item.id === workspace.activeTabId) ?? workspace?.tabs[0] ?? null;
  const panes = tab ? countPanes(tab.layout) : 0;
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
          <span className="status-key">Tab</span>
          <span className="status-val">{tab?.title ?? "—"}</span>
        </span>
      </div>
      <div className="status-bar-right">
        <span className="status-chip">{panes} panes</span>
        <span className="status-chip mono">{shell}</span>
        <span className="status-chip status-online">
          <span className="status-dot-inline" aria-hidden />
          Connected
        </span>
        <button type="button" className="status-icon-btn" title="Settings" onClick={openSettings}>
          <IconSettings width={17} height={17} strokeWidth={1.35} />
        </button>
      </div>
    </footer>
  );
}
