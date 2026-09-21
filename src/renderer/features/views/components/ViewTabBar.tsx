import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { PaneKind, ViewHealth, Workspace } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import {
  IconChevronsLeft,
  IconClose,
  IconFolder,
  IconGitBranch,
  IconPlus,
  IconSparkle,
  IconTerminal,
} from "../../shell/icons";
import { getTabTypes } from "../../tabTypes/registry";
import { piPaneIdsOfView, usePiActivityStore } from "../../tabTypes/piAgent/piActivity";
import { GROUP_VIEW_KINDS, isGroupRoot } from "../../../domain/workspaces/groupActions";
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

/** Ring size constants for the working spinner (r = 6.5 on a 16px viewBox). */
const TAB_RING_RADIUS = 6.5;
const TAB_RING_CIRCUMFERENCE = 2 * Math.PI * TAB_RING_RADIUS;

/**
 * A pi tab's status glyph: spinner around the green bubble while an agent is working, a pulsing
 * green checkmark once a run finished unseen, and the plain bubble otherwise.
 */
function PiTabIndicator({ paneIds }: { paneIds: string[] }): JSX.Element {
  const working = usePiActivityStore((state) =>
    paneIds.some((id) => state.activity[id] === "running"),
  );
  const finished = usePiActivityStore((state) =>
    paneIds.some((id) => state.activity[id] === "done"),
  );

  if (working) {
    return (
      <span
        className="relative grid size-4 shrink-0 place-items-center"
        title="Agent working"
        aria-hidden
      >
        <svg
          viewBox="0 0 16 16"
          className="absolute inset-0 size-4 animate-spin text-swath-good"
          fill="none"
        >
          <circle
            cx="8"
            cy="8"
            r={TAB_RING_RADIUS}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={`${TAB_RING_CIRCUMFERENCE * 0.75} ${TAB_RING_CIRCUMFERENCE * 0.25}`}
          />
        </svg>
        <span className="size-2 rounded-full bg-swath-good shadow-[0_0_8px_rgba(63,185,80,0.45)]" />
      </span>
    );
  }
  if (finished) {
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-4 shrink-0 animate-pulse text-swath-good"
        fill="none"
        aria-hidden
      >
        <path
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return <span className={healthClass(undefined)} title="healthy" aria-hidden />;
}

function tabTypeIcon(kind: PaneKind): JSX.Element {
  if (kind === "gitManager")
    return <IconGitBranch width={16} height={16} className="block shrink-0 text-swath-accent" />;
  if (kind === "fileBrowser")
    return <IconFolder width={16} height={16} className="block shrink-0 text-swath-accent" />;
  if (kind === "piAgent")
    return <IconSparkle width={16} height={16} className="block shrink-0 text-swath-accent" />;
  return <IconTerminal width={16} height={16} className="block shrink-0 text-swath-accent" />;
}

/** Task catalog top bar. Unlike legacy views, selecting history is intentionally non-executing. */
export function TaskTabBar({
  tasks,
  activeTaskId,
  views,
  activeViewId,
  onSelect,
  onSelectView,
  onReorderView,
  onCreatePane,
  piOnly = false,
  onCreate,
  onHistory,
}: {
  tasks: Array<{
    id: string;
    title: string;
    lifecycle: "active" | "completed";
    panes: Array<{ id: string; kind: string; title: string | null }>;
  }>;
  activeTaskId: string | null;
  views: Array<{ id: string; title: string }>;
  activeViewId: string | null;
  onSelect: (id: string) => void;
  onSelectView: (id: string) => void;
  onReorderView: (fromIndex: number, toIndex: number) => void;
  onCreatePane: (taskId: string, kind: string) => void;
  piOnly?: boolean;
  onCreate: () => void;
  onHistory: () => void;
}): JSX.Element {
  const [titleBarTarget, setTitleBarTarget] = useState<HTMLElement | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(activeTaskId);
  const [paneMenuTaskId, setPaneMenuTaskId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const viewStripRef = useRef<HTMLDivElement>(null);
  const viewReorder = useReorderDrag({
    axis: "horizontal",
    itemCount: views.length,
    getElements: () =>
      Array.from(viewStripRef.current?.querySelectorAll<HTMLElement>("[data-task-view-id]") ?? []),
    findIndexById: (id) => views.findIndex((view) => view.id === id),
    onMove: onReorderView,
  });

  useEffect(() => {
    setTitleBarTarget(document.getElementById("swath-titlebar-tasks"));
  }, []);
  useEffect(() => {
    if (activeTaskId) setExpandedTaskId(activeTaskId);
  }, [activeTaskId]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node))
        setPaneMenuTaskId(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (!titleBarTarget) return <></>;

  return createPortal(
    <div
      className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2"
      role="tablist"
      aria-label="Tasks in this project"
    >
      <div ref={menuRef} className="flex h-full items-center gap-1">
        {tasks
          // Keep the currently-mounted task visible through completion so running processes and
          // their output are not orphaned from the tab strip. History remains separately listed.
          .filter((task) => task.lifecycle === "active" || task.id === activeTaskId)
          .map((task) => {
            const piIds = task.panes
              .filter((pane) => pane.kind === "piAgent")
              .map((pane) => pane.id);
            return (
              <div
                key={task.id}
                className={`relative flex shrink-0 items-center transition-colors ${
                  expandedTaskId === task.id
                    ? "h-[calc(100%-6px)] rounded-lg border border-swath-accent/70 bg-swath-accent/[0.04] px-0.5 shadow-[0_0_0_1px_rgba(56,139,253,0.06)]"
                    : "h-full"
                }`}
              >
                <button
                  role="tab"
                  aria-selected={task.id === activeTaskId}
                  aria-expanded={expandedTaskId === task.id}
                  onClick={() => {
                    onSelect(task.id);
                    setExpandedTaskId(task.id);
                    setPaneMenuTaskId(null);
                  }}
                  className={`flex max-w-48 items-center gap-2 rounded px-3 py-1 text-sm ${task.id === activeTaskId ? "bg-swath-bg text-swath-text" : "text-swath-muted hover:bg-swath-bg"}`}
                >
                  {piIds.length ? <PiTabIndicator paneIds={piIds} /> : null}
                  <span className="truncate">{task.title}</span>
                </button>
                {expandedTaskId === task.id ? (
                  <div
                    ref={task.id === activeTaskId ? viewStripRef : undefined}
                    className="ml-1 flex h-full items-center gap-1 border-l border-swath-border pl-1"
                    onDragOver={
                      task.id === activeTaskId ? viewReorder.handleNativeDragOver : undefined
                    }
                    onDrop={task.id === activeTaskId ? viewReorder.handleNativeDrop : undefined}
                  >
                    {(task.id === activeTaskId
                      ? views
                      : task.panes.map((pane, index) => ({
                          id: `task-view:${pane.id}`,
                          title: pane.title ?? `${pane.kind} ${index + 1}`,
                        }))
                    ).map((view, viewIndex) => {
                      const pane = task.panes.find((item) => view.id.endsWith(item.id));
                      return (
                        <div key={view.id} className="flex shrink-0 items-center">
                          <button
                            draggable={task.id === activeTaskId}
                            data-task-view-id={task.id === activeTaskId ? view.id : undefined}
                            aria-grabbed={viewReorder.draggedId === view.id}
                            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                            title="Alt+Left / Alt+Right to reorder tab"
                            onKeyDown={(event) => {
                              if (task.id !== activeTaskId || !event.altKey) return;
                              const from = views.findIndex((item) => item.id === view.id);
                              const direction =
                                event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
                              const to = from + direction;
                              if (direction && from >= 0 && to >= 0 && to < views.length) {
                                event.preventDefault();
                                onReorderView(from, to);
                              }
                            }}
                            onDragStart={(event) => {
                              if (task.id === activeTaskId)
                                viewReorder.startNativeDrag(
                                  event,
                                  view.id,
                                  views.findIndex((item) => item.id === view.id),
                                );
                            }}
                            onDragEnd={viewReorder.finishDrag}
                            onMouseDown={(event) => {
                              if (task.id === activeTaskId)
                                viewReorder.startPointerDrag(event, view.id);
                            }}
                            onClick={() => {
                              onSelect(task.id);
                              onSelectView(view.id);
                            }}
                            className={`flex max-w-44 shrink-0 items-center gap-2 rounded px-2.5 py-1 text-left text-xs ${task.id === activeTaskId && view.id === activeViewId ? "bg-swath-accent/15 text-swath-text" : "text-swath-muted hover:bg-swath-bg"}`}
                          >
                            {pane?.kind === "piAgent" ? (
                              <PiTabIndicator paneIds={[pane.id]} />
                            ) : null}
                            <span className="truncate">{view.title}</span>
                          </button>
                          {task.id === activeTaskId && views.length > 1 ? (
                            <span className="flex items-center text-swath-muted">
                              <button
                                type="button"
                                aria-label={`Move ${view.title} left`}
                                title="Move tab left"
                                disabled={viewIndex === 0}
                                onClick={() => onReorderView(viewIndex, viewIndex - 1)}
                                className="grid size-6 place-items-center rounded text-base [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-swath-bg hover:text-swath-text disabled:opacity-25"
                              >
                                ‹
                              </button>
                              <button
                                type="button"
                                aria-label={`Move ${view.title} right`}
                                title="Move tab right"
                                disabled={viewIndex === views.length - 1}
                                onClick={() => onReorderView(viewIndex, viewIndex + 1)}
                                className="grid size-6 place-items-center rounded text-base [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-swath-bg hover:text-swath-text disabled:opacity-25"
                              >
                                ›
                              </button>
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                    <div className="relative flex h-full items-center">
                      <button
                        aria-label={`Add tab to ${task.title}`}
                        aria-expanded={paneMenuTaskId === task.id}
                        onClick={() =>
                          setPaneMenuTaskId((current) => (current === task.id ? null : task.id))
                        }
                        className="grid size-7 shrink-0 place-items-center rounded text-base text-swath-accent hover:bg-swath-bg"
                      >
                        <IconPlus width={15} height={15} />
                      </button>
                      {paneMenuTaskId === task.id ? (
                        <div className="absolute right-0 top-[calc(100%+4px)] z-[150] min-w-44 rounded-md border border-swath-border bg-swath-panel p-1 shadow-swath-float">
                          {(
                            (piOnly
                              ? [["piAgent", "Pi Agent"]]
                              : [
                                  ["terminal", "Terminal"],
                                  ["piAgent", "Pi Agent"],
                                  ["gitManager", "Source Control"],
                                  ["fileBrowser", "Files"],
                                ]) as readonly (readonly [PaneKind, string])[]
                          ).map(([kind, label]) => (
                            <button
                              key={kind}
                              onClick={() => {
                                onCreatePane(task.id, kind);
                                setPaneMenuTaskId(null);
                              }}
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-swath-muted hover:bg-swath-bg hover:text-swath-text"
                            >
                              {tabTypeIcon(kind)} {label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
      </div>
      <button
        onClick={onCreate}
        className="ml-auto shrink-0 rounded px-2 py-1 text-swath-accent hover:bg-swath-bg"
        aria-label="Create task"
      >
        +
      </button>
      <button
        onClick={onHistory}
        className="shrink-0 rounded px-2 py-1 text-swath-muted hover:bg-swath-bg"
      >
        History
      </button>
    </div>,
    titleBarTarget,
  );
}

export function ViewTabBar({
  workspace,
  sidebarCollapsed,
  onToggleSidebar,
}: ViewTabBarProps): JSX.Element {
  // A group's surface is for agents that span its folders; per-folder work stays in the projects,
  // so the group tab bar offers only the kinds that make sense across several paths.
  const group = isGroupRoot(workspace);
  const tabTypes = getTabTypes().filter(
    (tabType) => !group || (GROUP_VIEW_KINDS as readonly string[]).includes(tabType.kind),
  );
  const defaultKind = tabTypes[0]?.kind ?? "terminal";
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
  const acknowledgePanes = usePiActivityStore((state) => state.acknowledgePanes);

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
              piPaneIds={piPaneIdsOfView(tab)}
              active={workspace.activeViewId === tab.id}
              canClose={workspace.views.length > 1}
              dragging={draggedViewId === tab.id}
              onSelect={() => {
                acknowledgePanes(piPaneIdsOfView(tab));
                appActions.selectView(workspace.id, tab.id);
              }}
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
            appActions.createView(workspace.id, group ? defaultKind : undefined);
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
            {tabTypes.map((tabType) => (
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
  /** Pi agent panes in this tab; non-empty tabs get the agent lifecycle indicator. */
  piPaneIds: string[];
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
  piPaneIds,
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
      {piPaneIds.length > 0 ? (
        <PiTabIndicator paneIds={piPaneIds} />
      ) : (
        <span className={healthClass(health)} title={health ?? "healthy"} aria-hidden />
      )}
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
