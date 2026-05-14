import type { AppSettings, Workspace } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { LayoutRenderer } from "../../panes/components/LayoutRenderer";
import { ViewTabBar } from "../../views/components/ViewTabBar";

interface TerminalWorkspaceProps {
  workspace: Workspace;
  settings: AppSettings;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function TerminalWorkspace({ workspace, settings, sidebarCollapsed, onToggleSidebar }: TerminalWorkspaceProps): JSX.Element {
  const activeView = workspace.views.find((tab) => tab.id === workspace.activeViewId) ?? workspace.views[0];

  return (
    <div className="terminal-workspace">
      <ViewTabBar workspace={workspace} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} />

      <div className="terminal-stage">
        {activeView ? (
          <LayoutRenderer workspace={workspace} view={activeView} settings={settings} node={activeView.layout} />
        ) : (
          <div className="empty-tab">
            <button className="primary-button" onClick={() => appActions.addTab(workspace.id)}>
              Create terminal tab
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
