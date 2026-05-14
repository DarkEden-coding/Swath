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
  if (health === "warning") return "tab-health tab-health-warning";
  if (health === "idle") return "tab-health tab-health-idle";
  return "tab-health tab-health-healthy";
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
    <div className="tabbar">
      {sidebarCollapsed ? (
        <>
          <div className="window-traffic-lead" aria-hidden="true" />
          <button type="button" className="tabbar-sidebar-reveal" title="Expand sidebar" onClick={onToggleSidebar}>
            <IconChevronsLeft width={16} height={16} />
          </button>
        </>
      ) : null}
      <div className="tab-scroll">
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
      <div className="tab-add-container" ref={selectorRef}>
        <button
          className="tab-add"
          type="button"
          onClick={() => appActions.addTab(workspace.id)}
          title="New tab"
          onContextMenu={(e) => {
            e.preventDefault();
            setShowTypeSelector(!showTypeSelector);
          }}
        >
          <IconPlus width={16} height={16} />
        </button>
        {showTypeSelector && (
          <div className="tab-type-selector">
            <button
              className="tab-type-btn"
              onClick={() => {
                appActions.addTab(workspace.id);
                setShowTypeSelector(false);
              }}
            >
              <IconTerminal width={16} height={16} />
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

  return (
    <button type="button" className={`terminal-tab ${active ? "active" : ""}`} onClick={onSelect} onDoubleClick={() => setEditing(true)}>
      <span className={healthClass(health)} title={health ?? "healthy"} aria-hidden />
      {editing ? (
        <input
          className="tab-input"
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
        <span className="tab-title">{title}</span>
      )}
      {canClose ? (
        <span
          className="tab-close"
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
          <IconClose width={14} height={14} />
        </span>
      ) : null}
    </button>
  );
}
