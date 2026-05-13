import { useState, useRef, useEffect } from "react";
import type { TabHealth, Workspace } from "../../main/sharedTypes";
import { useAppStore } from "../state/appStore";
import { IconChevronsLeft, IconClose, IconPlus, IconTerminal } from "./icons";

interface TabBarProps {
  workspace: Workspace;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

function healthClass(health: TabHealth | undefined): string {
  if (health === "warning") return "tab-health tab-health-warning";
  if (health === "idle") return "tab-health tab-health-idle";
  return "tab-health tab-health-healthy";
}

export function TabBar({ workspace, sidebarCollapsed, onToggleSidebar }: TabBarProps): JSX.Element {
  const selectTab = useAppStore((state) => state.selectTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const renameTab = useAppStore((state) => state.renameTab);
  const addTab = useAppStore((state) => state.addTab);
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
        {workspace.tabs.map((tab) => (
          <TerminalTabButton
            key={tab.id}
            title={tab.title}
            health={tab.health}
            active={workspace.activeTabId === tab.id}
            canClose={workspace.tabs.length > 1}
            onSelect={() => selectTab(workspace.id, tab.id)}
            onClose={() => closeTab(workspace.id, tab.id)}
            onRename={(nextTitle) => renameTab(workspace.id, tab.id, nextTitle)}
          />
        ))}
      </div>
      <div className="tab-add-container" ref={selectorRef}>
        <button className="tab-add" type="button" onClick={() => addTab(workspace.id)} title="New tab" onContextMenu={(e) => { e.preventDefault(); setShowTypeSelector(!showTypeSelector); }}>
          <IconPlus width={16} height={16} />
        </button>
        {showTypeSelector && (
          <div className="tab-type-selector">
            <button className="tab-type-btn" onClick={() => { addTab(workspace.id, "terminal"); setShowTypeSelector(false); }}>
              <IconTerminal width={16} height={16} />
              <span>Terminal</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface TerminalTabButtonProps {
  title: string;
  health?: TabHealth;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
}

function TerminalTabButton({ title, health, active, canClose, onSelect, onClose, onRename }: TerminalTabButtonProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  return (
    <button
      type="button"
      className={`terminal-tab ${active ? "active" : ""}`}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
    >
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
