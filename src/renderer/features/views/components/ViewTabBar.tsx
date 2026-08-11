import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { PaneKind, ViewHealth, Workspace } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import {
  IconChevronsLeft,
  IconClose,
  IconFolder,
  IconGitBranch,
  IconImage,
  IconPlus,
  IconSparkle,
  IconTerminal,
} from "../../shell/icons";
import { getTabTypes } from "../../tabTypes/registry";
import { useReorderDrag } from "../../../hooks/useReorderDrag";

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

function tabTypeIcon(kind: PaneKind): JSX.Element {
  if (kind === "gitManager")
    return <IconGitBranch width={16} height={16} className="block shrink-0 text-swath-accent" />;
  if (kind === "fileBrowser")
    return <IconFolder width={16} height={16} className="block shrink-0 text-swath-accent" />;
  if (kind === "imagePreview")
    return <IconImage width={16} height={16} className="block shrink-0 text-swath-accent" />;
  if (kind === "piAgent")
    return <IconSparkle width={16} height={16} className="block shrink-0 text-swath-accent" />;
  return <IconTerminal width={16} height={16} className="block shrink-0 text-swath-accent" />;
}

export function ViewTabBar({
  workspace,
  sidebarCollapsed,
  onToggleSidebar,
}: ViewTabBarProps): JSX.Element {
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const reorder = useReorderDrag({
    axis: "horizontal",
    itemCount: workspace.views.length,
    getElements: () =>
      Array.from(tabStripRef.current?.querySelectorAll<HTMLElement>("[data-view-id]") ?? []),
    findIndexById: (id) => workspace.views.findIndex((view) => view.id === id),
    onMove: (fromIndex, toIndex) => appActions.moveView(workspace.id, fromIndex, toIndex),
  });
  const { draggedId: draggedViewId, dropIndex } = reorder;

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
      <div
        ref={tabStripRef}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [-webkit-app-region:no-drag] [app-region:no-drag]"
      >
        {workspace.views.map((tab, index) => (
          <Fragment key={tab.id}>
            {dropIndex === index ? <TabDropIndicator /> : null}
            <WorkspaceViewButton
              id={tab.id}
              title={tab.title}
              health={tab.health}
              active={workspace.activeViewId === tab.id}
              canClose={workspace.views.length > 1}
              dragging={draggedViewId === tab.id}
              onSelect={() => appActions.selectView(workspace.id, tab.id)}
              onClose={() => appActions.closeView(workspace.id, tab.id)}
              onRename={(nextTitle) => appActions.renameView(workspace.id, tab.id, nextTitle)}
              onMouseDragStart={(event) => reorder.startPointerDrag(event, tab.id)}
            />
          </Fragment>
        ))}
        {dropIndex === workspace.views.length ? <TabDropIndicator /> : null}
      </div>
      <div
        className="relative flex items-center [-webkit-app-region:no-drag] [app-region:no-drag]"
        ref={selectorRef}
      >
        <button
          className="grid h-full w-9 min-h-0 cursor-pointer place-items-center border-0 border-l border-swath-border bg-swath-panel text-swath-accent-strong [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-[#161b22]"
          type="button"
          onClick={(event) => {
            if (event.shiftKey) {
              event.preventDefault();
              setShowTypeSelector((open) => !open);
              return;
            }
            appActions.createView(workspace.id);
          }}
          title="New tab (Shift+click to pick type; right-click for menu)"
          onContextMenu={(e) => {
            e.preventDefault();
            setShowTypeSelector(!showTypeSelector);
          }}
        >
          <IconPlus width={16} height={16} className="block" />
        </button>
        {showTypeSelector && (
          <div className="absolute right-0 top-full z-[100] mt-1 flex min-w-[140px] flex-col gap-0.5 rounded-md border border-swath-border bg-[#1a1a1a] p-1 shadow-swath-float">
            {getTabTypes().map((tabType) => (
              <button
                key={tabType.kind}
                type="button"
                className="flex cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#2a2a2a]"
                onClick={() => {
                  appActions.createView(workspace.id, tabType.kind);
                  setShowTypeSelector(false);
                }}
              >
                {tabTypeIcon(tabType.kind)}
                <span>{tabType.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TabDropIndicator(): JSX.Element {
  return (
    <div className="relative z-10 w-0 shrink-0" aria-hidden>
      <div className="absolute inset-y-1 left-[-1.5px] w-[3px] rounded-full bg-[#58a6ff] shadow-[0_0_8px_rgba(88,166,255,0.65)]" />
    </div>
  );
}

interface WorkspaceViewButtonProps {
  id: string;
  title: string;
  health?: ViewHealth;
  active: boolean;
  canClose: boolean;
  dragging: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  onMouseDragStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

function WorkspaceViewButton({
  id,
  title,
  health,
  active,
  canClose,
  dragging,
  onSelect,
  onClose,
  onRename,
  onMouseDragStart,
}: WorkspaceViewButtonProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const tabActive = active
    ? "bg-swath-bg text-[#f0f6fc] shadow-[inset_0_3px_0_#58a6ff]"
    : "bg-transparent text-swath-muted";

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-grabbed={dragging}
      data-view-id={id}
      className={`flex min-w-[140px] max-w-[240px] shrink-0 cursor-grab items-center gap-2 border-0 border-r border-swath-border py-0 pl-3 pr-2.5 [-webkit-app-region:no-drag] [app-region:no-drag] active:cursor-grabbing ${dragging ? "opacity-60" : ""} ${tabActive}`}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      onMouseDown={onMouseDragStart}
    >
      <span className={healthClass(health)} title={health ?? "healthy"} aria-hidden />
      {editing ? (
        <input
          className="h-[26px] w-[120px] rounded-lg border border-swath-border bg-swath-bg px-[7px] py-0.5 text-swath-text outline-none [-webkit-app-region:no-drag] [app-region:no-drag] focus:border-swath-accent focus:shadow-[0_0_0_2px_rgba(56,139,253,0.15)]"
          value={draft}
          autoFocus
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
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
        <button
          type="button"
          aria-label={`Close ${title}`}
          className="ml-auto grid size-[18px] cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-swath-muted-2 [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#303847] hover:text-white"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <IconClose width={14} height={14} className="block" />
        </button>
      ) : null}
    </div>
  );
}
