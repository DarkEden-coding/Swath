import type { AppSettings, Workspace } from "../../main/sharedTypes";
import { LayoutRenderer } from "./LayoutRenderer";
import { TabBar } from "./TabBar";
import { GitBrowser } from "./GitBrowser";
import { useAppStore } from "../state/appStore";

interface TerminalWorkspaceProps {
  workspace: Workspace;
  settings: AppSettings;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function TerminalWorkspace({
  workspace,
  settings,
  sidebarCollapsed,
  onToggleSidebar
}: TerminalWorkspaceProps): JSX.Element {
  const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? workspace.tabs[0];
  const addTab = useAppStore((state) => state.addTab);

  return (
    <div className="terminal-workspace">
      <TabBar workspace={workspace} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} />

      <div className="terminal-stage">
        {activeTab ? (
          activeTab.type === "git" ? (
            <GitBrowser workspace={workspace} />
          ) : (
            <LayoutRenderer workspace={workspace} tab={activeTab} settings={settings} node={activeTab.layout} />
          )
        ) : (
          <div className="empty-tab">
            <button className="primary-button" onClick={() => addTab(workspace.id)}>
              Create terminal tab
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
