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

const primaryBtn =
  "cursor-pointer rounded-lg border border-[#1f6feb] bg-gradient-to-b from-[#238636] to-[#196c2e] px-3.5 py-2 font-semibold text-[#f6fff8] [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-[#161b22]";

export function TerminalWorkspace({ workspace, settings, sidebarCollapsed, onToggleSidebar }: TerminalWorkspaceProps): JSX.Element {
  const activeView = workspace.views.find((tab) => tab.id === workspace.activeViewId) ?? workspace.views[0];

  return (
    <div className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_1fr] bg-swath-bg">
      <ViewTabBar workspace={workspace} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} />

      <div className="min-h-0 min-w-0 px-3 pb-2 pl-2 pt-2">
        {activeView ? (
          <LayoutRenderer workspace={workspace} view={activeView} settings={settings} node={activeView.layout} />
        ) : (
          <div className="grid h-full place-items-center">
            <button type="button" className={primaryBtn} onClick={() => appActions.addTab(workspace.id)}>
              Create terminal tab
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
