import { IconChevronsLeft } from "./icons";
import { useAppStore } from "../state/appStore";

interface EmptyStateProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function EmptyState({ sidebarCollapsed, onToggleSidebar }: EmptyStateProps): JSX.Element {
  const addWorkspaceFromFolder = useAppStore((state) => state.addWorkspaceFromFolder);

  return (
    <>
      {sidebarCollapsed ? (
        <div className="empty-topbar">
          <div className="window-traffic-lead" aria-hidden="true" />
          <button type="button" className="tabbar-sidebar-reveal" title="Expand sidebar" onClick={onToggleSidebar}>
            <IconChevronsLeft width={16} height={16} />
          </button>
        </div>
      ) : null}
      <div className="empty-state">
      <div className="empty-card">
        <div className="empty-kicker">Swath</div>
        <h1>Add a project</h1>
        <p>
          Projects map to local folders. Tabs, splits, and shell sessions are tracked per project. Pick a folder to get
          started, or keep the built-in demo workspaces from a fresh install.
        </p>
        <button className="primary-button" onClick={() => void addWorkspaceFromFolder()}>
          Choose Folder
        </button>
      </div>
    </div>
    </>
  );
}
