import { useEffect, useRef, useState } from "react";
import type { ViewHealth, Workspace } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { IconChevronsLeft, IconClose, IconPlus, IconTerminal } from "../../shell/icons";

interface ViewTabBarProps {
  workspace: Workspace;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

function healthClass(health: ViewHealth | undefined): string {
  const base = "h-2 w-2 shrink-0 rounded-full";
  if (health === "warning") return `${base} bg-swath-warn shadow-[0_0_8px_rgba(210,153,34,0.45)]`;
  if (health === "idle") return `${base} bg-swath-muted-2`;
  return `${base} bg-swath-good shadow-[0_0_8px_rgba(63,185,80,0.45)]`;
}

export function ViewTabBar({ workspace, sidebarCollapsed, onToggleSidebar }: ViewTabBarProps): JSX.Element {
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (selectorRef.current && !selectorRef.current.contains(event.target as Node)) {
        setShowTypeSelector(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div
      className={`flex h-9 items-stretch border-b border-swath-border bg-swath-panel [-webkit-app-region:drag] [app-region:drag] ${sidebarCollapsed ? "pl-0" : "pl-1.5"}`}
    >
      {sidebarCollapsed ? (
        <>
          <div
            className="min-h-0 w-0 shrink-0 self-stretch [html.platform-darwin_&]:w-[76px] [-webkit-app-region:drag] [app-region:drag]"
            aria-hidden="true"
          />
          <button
            type="button"
            className="grid w-[38px] shrink-0 cursor-pointer place-items-center border-0 border-r border-swath-border bg-swath-panel text-swath-accent-strong [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-swath-bg hover:text-swath-accent"
            title="Expand sidebar"
            onClick={onToggleSidebar}
          >
            <IconChevronsLeft width={16} height={16} className="block" />
          </button>
        </>
      ) : null}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [-webkit-app-region:no-drag] [app-region:no-drag]">
        {workspace.views.map((tab) => (
          <WorkspaceViewButton
            key={tab.id}
            title={tab.title}
            health={tab.health}
            active={workspace.activeViewId === tab.id}
            canClose={workspace.views.length > 1}
            onSelect={() => appActions.selectTab(workspace.id, tab.id)}
            onClose={() => appActions.closeTab(workspace.id, tab.id)}
            onRename={(nextTitle) => appActions.renameTab(workspace.id, tab.id, nextTitle)}
          />
        ))}
      </div>
      <div className="relative flex items-center [-webkit-app-region:no-drag] [app-region:no-drag]" ref={selectorRef}>
        <button
          className="grid h-full w-9 min-h-0 cursor-pointer place-items-center border-0 border-l border-swath-border bg-swath-panel text-swath-accent-strong [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-[#161b22]"
          type="button"
          onClick={() => appActions.addTab(workspace.id)}
          title="New tab"
          onContextMenu={(e) => {
            e.preventDefault();
            setShowTypeSelector(!showTypeSelector);
          }}
        >
          <IconPlus width={16} height={16} className="block" />
        </button>
        {showTypeSelector && (
          <div className="absolute right-0 top-full z-[100] mt-1 flex min-w-[140px] flex-col gap-0.5 rounded-md border border-swath-border bg-[#1a1a1a] p-1 shadow-swath-float">
            <button
              type="button"
              className="flex cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#2a2a2a]"
              onClick={() => {
                appActions.addTab(workspace.id);
                setShowTypeSelector(false);
              }}
            >
              <IconTerminal width={16} height={16} className="block" />
              <span>Terminal</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface WorkspaceViewButtonProps {
  title: string;
  health?: ViewHealth;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
}

function WorkspaceViewButton({ title, health, active, canClose, onSelect, onClose, onRename }: WorkspaceViewButtonProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const tabActive = active
    ? "bg-swath-bg text-[#f0f6fc] shadow-[inset_0_3px_0_#58a6ff]"
    : "bg-transparent text-swath-muted";

  return (
    <button
      type="button"
      className={`flex min-w-[140px] max-w-[240px] shrink-0 cursor-pointer items-center gap-2 border-0 border-r border-swath-border py-0 pl-3 pr-2.5 [-webkit-app-region:no-drag] [app-region:no-drag] ${tabActive}`}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
    >
      <span className={healthClass(health)} title={health ?? "healthy"} aria-hidden />
      {editing ? (
        <input
          className="h-[26px] w-[120px] rounded-lg border border-swath-border bg-swath-bg px-[7px] py-0.5 text-swath-text outline-none [-webkit-app-region:no-drag] [app-region:no-drag] focus:border-swath-accent focus:shadow-[0_0_0_2px_rgba(56,139,253,0.15)]"
          value={draft}
          autoFocus
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            onRename(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
      )}
      {canClose ? (
        <span
          className="ml-auto grid size-[18px] cursor-pointer place-items-center rounded-md text-swath-muted-2 [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#303847] hover:text-white"
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onClose();
            }
          }}
        >
          <IconClose width={14} height={14} className="block" />
        </span>
      ) : null}
    </button>
  );
}
