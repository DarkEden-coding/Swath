import * as appActions from "../../../app/appActions";
import { IconChevronsLeft } from "../icons";

interface EmptyStateProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

const primaryBtn =
  "cursor-pointer rounded-lg border border-[#1f6feb] bg-gradient-to-b from-[#238636] to-[#196c2e] px-3.5 py-2 font-semibold text-[#f6fff8] [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-[#161b22]";

export function EmptyState({ sidebarCollapsed, onToggleSidebar }: EmptyStateProps): JSX.Element {
  return (
    <>
      {sidebarCollapsed ? (
        <div className="flex h-9 shrink-0 items-stretch border-b border-swath-border bg-swath-panel [-webkit-app-region:drag] [app-region:drag]">
          <div
            className="min-h-0 w-0 shrink-0 self-stretch [html.platform-darwin_&]:w-[76px] [-webkit-app-region:drag] [app-region:drag]"
            aria-hidden="true"
          />
          <button
            type="button"
            className="grid w-[38px] shrink-0 cursor-pointer place-items-center border-0 border-r-0 bg-swath-panel text-swath-accent-strong [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-swath-bg hover:text-swath-accent"
            title="Expand sidebar"
            onClick={onToggleSidebar}
          >
            <IconChevronsLeft width={16} height={16} className="block" />
          </button>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 place-items-center">
        <div className="w-[min(460px,calc(100%-48px))] rounded-xl border border-swath-border bg-swath-panel p-7 shadow-swath-lg">
          <div className="text-xs font-semibold uppercase tracking-wide text-swath-accent">
            Swath
          </div>
          <h1 className="mt-2 text-[28px] font-semibold">Add a project</h1>
          <p className="my-3 leading-relaxed text-swath-muted">
            Projects map to local folders. Tabs, splits, and shell sessions are tracked per project.
            Pick a folder to get started, or keep the built-in demo workspaces from a fresh install.
          </p>
          <button
            type="button"
            className={primaryBtn}
            onClick={() => void appActions.addWorkspaceFromFolder()}
          >
            Choose Folder
          </button>
        </div>
      </div>
    </>
  );
}
